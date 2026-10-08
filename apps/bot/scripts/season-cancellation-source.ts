import type { CloudflareD1Statement } from '../../../scripts/cloudflare-client.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createDb } from '../../../packages/db/src/index.ts'
import { createMaintenanceClient } from './maintenance-cloudflare.ts'

export async function writeCancellationAudit(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

/** Reads use D1's raw response so duplicate SQL column names keep their positions. */
export function createCancellationSource(target: 'standard' | 'ppl', directory: string) {
  const runtime = createMaintenanceClient({ target }, 'remote')
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('Load the selected account’s Cloudflare API token.')
  let number = 0
  let rowsRead = 0
  const captures: Array<{ statement: CloudflareD1Statement; columns: string[]; rows: unknown[][] }> = []

  async function read(sql: string, params: readonly (string | number | null)[] = []) {
    if (!/^select\b/i.test(sql.trim()) || sql.includes(';'))
      throw new Error('Capture accepts single SELECT statements only.')
    const statement = { sql, params: [...params] }
    const path = join(directory, `${++number}.json`)
    await writeCancellationAudit(path, statement)
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${runtime.selection.accountId}/d1/database/${runtime.selection.d1.id}/raw`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(statement),
        signal: AbortSignal.timeout(120_000),
      },
    )
    const payload = (await response.json()) as {
      success?: boolean
      result?: Array<{
        success: boolean
        results: { columns: string[]; rows: unknown[][] }
        meta: { rows_read: number; rows_written: number }
      }>
    }
    await writeCancellationAudit(`${path}.result.json`, { status: response.status, payload })
    const result = payload.result?.[0]
    if (!response.ok || !payload.success || !result?.success || result.meta.rows_written !== 0) {
      throw new Error(`Capture failed. Inspect ${path}.result.json.`)
    }
    rowsRead += result.meta.rows_read
    captures.push({ statement, ...result.results })
    return result
  }

  function prepare(sql: string, params: readonly (string | number | null)[] = []) {
    const all = async () => {
      const result = await read(sql, params)
      return {
        ...result,
        results: result.results.rows.map(row =>
          Object.fromEntries(result.results.columns.map((column, i) => [column, row[i]])),
        ),
      }
    }
    return {
      bind: (...bound: (string | number | null)[]) => prepare(sql, bound),
      all,
      raw: async () => (await read(sql, params)).results.rows,
      first: async (column?: string) => {
        const result = (await all()).results[0]
        return column ? (result?.[column] ?? null) : (result ?? null)
      },
      run: () => {
        throw new Error('Capture cannot write to the database.')
      },
    }
  }
  const db = createDb({
    prepare,
    batch: () => {
      throw new Error('Capture cannot write to the database.')
    },
  } as unknown as D1Database)
  return { ...runtime, db, read, captures, usage: () => ({ requests: number, rowsRead, rowsWritten: 0 }) }
}

export function cancellationMaintenanceGuard(generation: number): CloudflareD1Statement {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid maintenance generation.')
  return {
    sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM rating_maintenance WHERE id=1 AND state='paused' AND generation=?) AND NOT EXISTS(SELECT 1 FROM rating_mutation_leases) THEN 1 ELSE json_extract('Cancellation maintenance changed','$') END AS valid`,
    params: [generation],
  }
}
