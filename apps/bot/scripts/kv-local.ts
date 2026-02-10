import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'

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
  '',
  'Commands:',
  '  list [prefix]   List keys and expiration timestamps',
  '  get <key>       Print one key value',
  '  dump [prefix]   Print key=value for matching keys',
].join('\n')

const args = Bun.argv.slice(2)
const includeExpired = args.includes('--all')
const positionalArgs = args.filter(arg => !arg.startsWith('--'))
const command = positionalArgs[0] ?? 'list'
const arg = positionalArgs[1]

const kvRoot = resolve(import.meta.dir, '../.wrangler/state/v3/kv')
const sqlitePath = resolveLatestKvSqlite(resolve(kvRoot, 'miniflare-KVNamespaceObject'))
const blobsDir = resolveBlobsDir(kvRoot)

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
      return db
        .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries ORDER BY key')
        .all() as KvEntryRow[]
    }

    return db
      .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE expiration IS NULL OR expiration > ?1 ORDER BY key')
      .all(now) as KvEntryRow[]
  }

  if (includeExpired) {
    return db
      .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key LIKE ?1 ORDER BY key')
      .all(`${prefix}%`) as KvEntryRow[]
  }

  return db
    .query('SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key LIKE ?1 AND (expiration IS NULL OR expiration > ?2) ORDER BY key')
    .all(`${prefix}%`, now) as KvEntryRow[]
}

function readBlobValue(blobRoot: string, blobId: string): string {
  const blobPath = resolve(blobRoot, blobId)
  const bytes = readFileSync(blobPath)
  return new TextDecoder().decode(bytes)
}

function summarizeRow(row: KvEntryRow, blobRoot: string): string | null {
  if (
    !row.key.startsWith('lobby:mode:')
    && !row.key.startsWith('activity:')
    && !row.key.startsWith('activity-match:')
    && !row.key.startsWith('activity-user:')
  ) {
    return null
  }

  const value = readBlobValue(blobRoot, row.blob_id)

  if (row.key.startsWith('activity-match:')) return `channelId=${value}`
  if (row.key.startsWith('activity:') || row.key.startsWith('activity-user:')) return `matchId=${value}`

  if (!row.key.startsWith('lobby:mode:')) return null

  try {
    const parsed = JSON.parse(value) as { matchId?: unknown, status?: unknown }
    const matchId = typeof parsed.matchId === 'string' ? parsed.matchId : null
    const status = typeof parsed.status === 'string' ? parsed.status : null
    const parts = [matchId ? `matchId=${matchId}` : null, status ? `status=${status}` : null]
      .filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(' ') : null
  }
  catch {
    return null
  }
}

function resolveLatestKvSqlite(sqliteDir: string): string {
  if (!existsSync(sqliteDir)) {
    throw new Error(`Missing local KV sqlite directory: ${sqliteDir}`)
  }

  const sqliteFiles = readdirSync(sqliteDir)
    .filter(file => file.endsWith('.sqlite'))
    .map((file) => {
      const filePath = resolve(sqliteDir, file)
      return {
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const latest = sqliteFiles[0]
  if (!latest) {
    throw new Error(`No sqlite files found in ${sqliteDir}`)
  }

  return latest.filePath
}

function resolveBlobsDir(kvBaseDir: string): string {
  const candidates = readdirSync(kvBaseDir)
    .filter(name => name !== 'miniflare-KVNamespaceObject')
    .map(name => resolve(kvBaseDir, name, 'blobs'))
    .filter(path => existsSync(path))

  const first = candidates[0]
  if (!first) {
    throw new Error(`No KV blobs directory found under ${kvBaseDir}`)
  }

  return first
}
