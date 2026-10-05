import { Database } from 'bun:sqlite'
/* eslint-disable no-console */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { resolveCloudflareStorage } from '../../../config/cloudflare-targets.ts'
import { localResourcePaths } from './local-storage.ts'

interface KvEntryRow {
  key: string
  blob_id: string
  expiration: number | null
  metadata: string | null
}

const usage = [
  'Usage: bun scripts/kv-local.ts <command> [arg]',
  '',
  'Flags:',
  '  --all           Include expired keys',
  '  --target <name> Select standard or ppl local namespace (default: CIVUP_TARGET or standard)',
  '',
  'Commands:',
  '  list [prefix]   List keys and expiration timestamps',
  '  get <key>       Print one key value',
  '  dump [prefix]   Print key=value for matching keys',
].join('\n')

const args = Bun.argv.slice(2)
const includeExpired = args.includes('--all')
const targetIndex = args.indexOf('--target')
if (targetIndex >= 0 && (!args[targetIndex + 1] || args[targetIndex + 1]!.startsWith('--')))
  throw new Error('Missing value for --target.')
const target = targetIndex >= 0 ? args[targetIndex + 1] : (process.env.CIVUP_TARGET ?? 'standard')
const positionalArgs = args.filter(
  (arg, index) => !arg.startsWith('--') && (targetIndex < 0 || index !== targetIndex + 1),
)
const command = positionalArgs[0] ?? 'list'
const arg = positionalArgs[1]

const selection = resolveCloudflareStorage(target, 'local')
const paths = localResourcePaths(selection)
const sqlitePath = paths.kvSqlite
const blobsDir = paths.kvBlobs
if (!existsSync(sqlitePath))
  throw new Error(`Local KV for ${selection.target} (${selection.kv.id}) was not found at ${sqlitePath}.`)

const db = new Database(sqlitePath, { readonly: true })

switch (command) {
  case 'list': {
    const rows = selectRows(arg)
    if (rows.length === 0) {
      console.log('No keys found.')
      break
    }

    for (const row of rows) {
      const expiration = row.expiration ? new Date(row.expiration).toISOString() : 'no-expiry'
      const summary = summarizeRow(row, blobsDir)
      console.log(`${row.key}\t${expiration}${summary ? `\t${summary}` : ''}`)
    }
    break
  }

  case 'get': {
    if (!arg) {
      console.error('Missing key.')
      console.log(usage)
      process.exit(1)
    }

    const row = db
      .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key = ? LIMIT 1')
      .get(arg) as KvEntryRow | null

    if (!row) {
      console.log(`Key not found: ${arg}`)
      process.exit(1)
    }

    const value = readBlobValue(blobsDir, row.blob_id)
    console.log(value)
    break
  }

  case 'dump': {
    const rows = selectRows(arg)
    if (rows.length === 0) {
      console.log('No keys found.')
      break
    }

    for (const row of rows) {
      const value = readBlobValue(blobsDir, row.blob_id)
      console.log(`${row.key}=${value}`)
    }
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    console.log(usage)
    process.exit(1)
}

db.close()

function selectRows(prefix?: string): KvEntryRow[] {
  const now = Date.now()

  if (!prefix) {
    if (includeExpired) {
      return db.query('SELECT key, blob_id, expiration, metadata FROM _mf_entries ORDER BY key').all() as KvEntryRow[]
    }

    return db
      .query(
        'SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE expiration IS NULL OR expiration > ?1 ORDER BY key',
      )
      .all(now) as KvEntryRow[]
  }

  if (includeExpired) {
    return db
      .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key LIKE ?1 ORDER BY key')
      .all(`${prefix}%`) as KvEntryRow[]
  }

  return db
    .query(
      'SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key LIKE ?1 AND (expiration IS NULL OR expiration > ?2) ORDER BY key',
    )
    .all(`${prefix}%`, now) as KvEntryRow[]
}

function readBlobValue(blobRoot: string, blobId: string): string {
  const blobPath = resolve(blobRoot, blobId)
  const bytes = readFileSync(blobPath)
  return new TextDecoder().decode(bytes)
}

function summarizeRow(row: KvEntryRow, blobRoot: string): string | null {
  if (!row.key.startsWith('lobby:mode:')) {
    return null
  }

  const value = readBlobValue(blobRoot, row.blob_id)

  if (!row.key.startsWith('lobby:mode:')) return null

  try {
    const parsed = JSON.parse(value) as { matchId?: unknown; status?: unknown }
    const matchId = typeof parsed.matchId === 'string' ? parsed.matchId : null
    const status = typeof parsed.status === 'string' ? parsed.status : null
    const parts = [matchId ? `matchId=${matchId}` : null, status ? `status=${status}` : null].filter(
      (part): part is string => part !== null,
    )
    return parts.length > 0 ? parts.join(' ') : null
  } catch {
    return null
  }
}
