// Narrow Node-only fallback for typed local D1 bindings and complete SQL-script results.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCloudflareExecutable } from '../cloudflare-client.ts'
import { countSqlBindings, splitSqlScript } from './sql-bindings.ts'

const require = createRequire(import.meta.url)
const cfRequire = createRequire(require.resolve('cf/package.json'))
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(cfRequire.resolve('miniflare')).href)
// Use the installed SQLite-aware splitter, including CREATE TRIGGER bodies and transaction wrappers.
const wranglerRequire = createRequire(resolveCloudflareExecutable('wrangler').entryPoint)
const { unstable_splitSqlQuery: splitSqlQuery } = wranglerRequire('wrangler')
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
if (typeof input.databaseId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.databaseId))
  throw new Error('Pass a D1 database ID.')
if (typeof input.persistenceDirectory !== 'string' || !isAbsolute(input.persistenceDirectory))
  throw new Error('Pass an absolute local persistence directory.')
if (!Array.isArray(input.statements) || input.statements.length === 0)
  throw new Error('Pass at least one D1 statement.')

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: '',
    resourcePersistencePath: join(input.persistenceDirectory, 'v3'),
    d1Databases: { DATABASE: input.databaseId },
  }),
)
try {
  const database = await mf.getD1Database('DATABASE')
  const prepared = input.statements.flatMap((statement: { sql: string; params?: (string | number | null)[] }) => {
    const parts = splitSqlScript(statement.sql, splitSqlQuery)
    const params = statement.params ?? []
    if (parts.length === 1) return [database.prepare(parts[0]).bind(...params)]
    // Script bindings follow SQL statement order. Named/numbered slots reset per statement,
    // as they do when the statements are supplied explicitly in d1Batch.
    const counts = parts.map(countSqlBindings)
    const expected = counts.reduce((sum, count) => sum + count, 0)
    if (params.length !== expected)
      throw new Error(`The SQL script has ${expected} binding slots but received ${params.length} values.`)
    let offset = 0
    return parts.map((sql, index) => {
      const count = counts[index]!
      const values = params.slice(offset, offset + count)
      offset += count
      return database.prepare(sql).bind(...values)
    })
  })
  // A single SDK batch preserves all statement metadata and the D1 transaction boundary.
  const results = await database.batch(prepared)
  process.stdout.write(`${JSON.stringify({ success: true, result: results, statement_count: prepared.length })}\n`)
} catch (error) {
  // A rejected SDK batch exposes no committed per-statement successes. Do not invent them.
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${JSON.stringify({ success: false, result: null, errors: [{ message }] })}\n`)
  process.exitCode = 1
} finally {
  await mf.dispose()
}
