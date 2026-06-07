/* eslint-disable no-console */
import type { Database } from '@civup/db'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { schema } from '@civup/db'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runCivLeaderboardBackfill, type CivLeaderboardBackfillCommand } from './civ-leaderboard-backfill-shared.ts'

type Command = 'preview' | 'apply' | 'help'

interface Options {
  command: Command
  execute: boolean
  json: boolean
  config: string
}

const usage = [
  'Usage:',
  '  bun scripts/backfill-civ-leaderboard.ts preview',
  '  bun scripts/backfill-civ-leaderboard.ts apply --execute',
  '',
  'Options:',
  '  --execute        Required with apply; mutates local D1 and local KV',
  '  --config <path>  Wrangler config (default: wrangler.jsonc)',
  '  --json           Print machine-readable JSON only',
  '',
  'This script is local-dev only. PPL production uses the local-only ppl/backfill-civ-leaderboard.ts helper.',
].join('\n')

const options = parseOptions(Bun.argv.slice(2))

if (options.command === 'help') {
  console.log(usage)
  process.exit(0)
}

const sqlite = openLocalD1Sqlite(options.config)
const db = drizzle(sqlite, { schema }) as unknown as Database
const kv = createLocalKv(options.config)

try {
  await runCivLeaderboardBackfill({
    command: options.command as CivLeaderboardBackfillCommand,
    execute: options.execute,
    json: options.json,
    target: 'local',
    config: options.config,
    database: 'civup',
    db,
    kv,
    applyHint: 'bun run --filter civup-bot backfill:civ-leaderboard apply --execute',
  })
}
finally {
  sqlite.close()
}

function parseOptions(values: string[]): Options {
  let command: Command = 'preview'
  let execute = false
  let json = false
  let config = 'wrangler.jsonc'
  const rest = [...values]
  const first = rest[0]

  if (first === 'preview' || first === 'apply') {
    command = first
    rest.shift()
  }
  else if (first === 'help' || first === '--help' || first === '-h') {
    command = 'help'
    rest.shift()
  }

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]
    if (current === '--execute') {
      execute = true
      continue
    }
    if (current === '--json') {
      json = true
      continue
    }
    if (current === '--config') {
      const value = rest[index + 1]
      if (!value) throw new Error('Missing value for --config.')
      config = value
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${current}`)
  }

  return { command, execute, json, config }
}

function createLocalKv(config: string): KVNamespace {
  return {
    async get(key: string, type?: string) {
      const output = runWrangler(['kv', 'key', 'get', key, '--binding', 'KV', '--local', '--config', config, '--text'], { allowNotFound: true })
      if (output == null) return null
      const trimmed = output.trim()
      if (trimmed.length === 0) return null
      if (type !== 'json') return trimmed
      return JSON.parse(trimmed)
    },
    async put(key: string, value: string) {
      const tempFile = resolve(tmpdir(), `civup-civ-leaderboard-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
      try {
        await Bun.write(tempFile, value)
        runWrangler(['kv', 'key', 'put', key, '--path', tempFile, '--binding', 'KV', '--local', '--config', config])
      }
      finally {
        rmSync(tempFile, { force: true })
      }
    },
    async delete(key: string) {
      runWrangler(['kv', 'key', 'delete', key, '--binding', 'KV', '--local', '--config', config])
    },
    async list(options?: { prefix?: string }) {
      const args = ['kv', 'key', 'list', '--binding', 'KV', '--local', '--config', config]
      if (options?.prefix) args.push('--prefix', options.prefix)
      const output = runWrangler(args)
      const parsed = JSON.parse(output) as unknown
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { keys?: unknown[] } | null)?.keys)
          ? (parsed as { keys: unknown[] }).keys
          : []

      return {
        keys: entries.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const name = (entry as { name?: unknown }).name
          return typeof name === 'string' ? [{ name }] : []
        }),
        list_complete: true,
        cursor: '',
      } as KVNamespaceListResult<unknown, string>
    },
  } as KVNamespace
}

function runWrangler(args: string[], options: { allowNotFound?: boolean } = {}): string | null {
  const result = Bun.spawnSync({
    cmd: ['bun', 'x', 'wrangler', ...args],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'inherit',
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode === 0) return stdout
  if (options.allowNotFound && stderr.includes('404: Not Found')) return null
  if (stderr.trim()) console.error(stderr.trim())
  if (stdout.trim()) console.error(stdout.trim())
  throw new Error(`wrangler ${args.join(' ')} failed with exit code ${result.exitCode}`)
}

function openLocalD1Sqlite(config: string): SqliteDatabase {
  const d1Dir = resolve(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(d1Dir)) throw new Error(`Local D1 directory not found: ${d1Dir}. Run wrangler with ${config} first.`)

  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const sqlitePath = resolve(d1Dir, file)
    const db = new SqliteDatabase(sqlitePath, { readonly: true })
    try {
      const tables = new Set((db
        .query("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>).map(row => row.name))
      if (tables.has('matches') && tables.has('match_participants') && tables.has('civ_stats')) {
        return new SqliteDatabase(sqlitePath)
      }
    }
    finally {
      db.close()
    }
  }

  throw new Error(`Could not find a local CivUp D1 SQLite file in ${d1Dir}`)
}
