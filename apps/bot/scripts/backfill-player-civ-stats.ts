/* eslint-disable no-console */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { buildPlayerCivBackfillEstimateQueries, buildPlayerCivBackfillSql, buildPlayerCivBackfillValidationQueries } from './player-civ-backfill-shared.ts'
import { createStatsContext } from '../src/services/stats/context.ts'

type Command = 'preview' | 'apply'
type Target = 'local' | 'remote'

interface Options {
  command: Command
  target: Target
  execute: boolean
  yes: boolean
  json: boolean
  config: string
  database: string
  guildId: string
  primaryGuildId: string
}

interface WranglerEnvelope {
  success?: boolean
  results?: Array<{ count?: number }>
  errors?: Array<{ message?: string }>
}

const botRoot = resolve(import.meta.dir, '..')
const usage = [
  'Usage: bun scripts/backfill-player-civ-stats.ts <preview|apply> [flags]',
  '',
  'Flags:',
  '  --local                    Use local D1 storage (default)',
  '  --remote                   Use remote D1 from --config',
  '  --config <path>            Wrangler config relative to apps/bot (default: wrangler.jsonc)',
  '  --database <name>          D1 database name (default: civup)',
  '  --guild-id <id>            Stats server (defaults to primary)',
  '  --primary-guild-id <id>    Override ALLOWED_DISCORD_GUILD_ID from config',
  '  --execute                  Required to mutate with apply',
  '  --yes                      Also required for remote apply',
  '  --json                     Print machine-readable output',
].join('\n')

const options = parseOptions(Bun.argv.slice(2))
const statsContext = createStatsContext(options.guildId, options.primaryGuildId)
const before = await readCounts(options, buildPlayerCivBackfillEstimateQueries(statsContext))
print({ mode: options.command, target: options.target, statsKey: statsContext.statsKey, before }, options.json)

if (options.command === 'apply') {
  if (!options.execute) {
    if (!options.json) console.log('Dry run only. Add --execute to rebuild this scoped player-leader stats set.')
    process.exit(0)
  }
  if (options.target === 'remote' && !options.yes) throw new Error('Remote apply requires --yes in addition to --execute.')
  await applySql(options, buildPlayerCivBackfillSql(statsContext, Date.now()))
  const after = await readCounts(options, buildPlayerCivBackfillEstimateQueries(statsContext))
  const validation = await readCounts(options, buildPlayerCivBackfillValidationQueries(statsContext))
  print({ mode: 'apply-result', target: options.target, statsKey: statsContext.statsKey, after, validation }, options.json)
  const failures = Object.entries(validation).filter(([, count]) => count > 0)
  if (failures.length > 0) throw new Error(`Player-leader backfill validation failed: ${failures.map(([name, count]) => `${name}=${count}`).join(', ')}`)
}

function parseOptions(args: string[]): Options {
  const command = args[0]
  if (command == null || command === '--help' || command === '-h') {
    console.log(usage)
    process.exit(0)
  }
  if (command !== 'preview' && command !== 'apply') throw new Error(`Unknown command: ${command}`)
  let target: Target = 'local'
  let execute = false
  let yes = false
  let json = false
  let config = 'wrangler.jsonc'
  let database = 'civup'
  let guildId: string | null = null
  let primaryGuildId: string | null = null

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--local') target = 'local'
    else if (arg === '--remote') target = 'remote'
    else if (arg === '--execute') execute = true
    else if (arg === '--yes') yes = true
    else if (arg === '--json') json = true
    else if (arg === '--config' || arg === '--database' || arg === '--guild-id' || arg === '--primary-guild-id') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${arg}`)
      if (arg === '--config') config = value
      else if (arg === '--database') database = value
      else if (arg === '--guild-id') guildId = value
      else primaryGuildId = value
    }
    else throw new Error(`Unknown flag: ${arg}`)
  }

  const configPath = resolve(botRoot, config)
  const configText = readFileSync(configPath, 'utf8')
  primaryGuildId ??= new RegExp('["\']ALLOWED_DISCORD_GUILD_ID["\']\\s*:\\s*["\'](\\d{17,20})["\']').exec(configText)?.[1] ?? null
  if (!primaryGuildId) throw new Error('Primary server ID is missing from config and --primary-guild-id.')
  return { command, target, execute, yes, json, config: configPath, database, guildId: guildId ?? primaryGuildId, primaryGuildId }
}

async function readCounts(options: Options, queries: Record<string, string>): Promise<Record<string, number>> {
  if (options.target === 'local') {
    const db = openLocalD1(true)
    try {
      return Object.fromEntries(Object.entries(queries).map(([name, query]) => [name, normalizeCount((db.query(query).get() as { count?: number } | null)?.count)]))
    }
    finally {
      db.close()
    }
  }
  const result: Record<string, number> = {}
  for (const [name, query] of Object.entries(queries)) result[name] = normalizeCount((await runWrangler(options, ['--command', normalizeSql(query)]))[0]?.results?.[0]?.count)
  return result
}

async function applySql(options: Options, sql: string): Promise<void> {
  if (options.target === 'local') {
    const db = openLocalD1(false)
    try {
      db.exec(sql)
    }
    finally {
      db.close()
    }
    return
  }
  const file = resolve(tmpdir(), `civup-player-civ-backfill-${Date.now()}.sql`)
  try {
    await Bun.write(file, sql)
    await runWrangler(options, ['--file', file])
  }
  finally {
    rmSync(file, { force: true })
  }
}

async function runWrangler(options: Options, queryArgs: string[]): Promise<WranglerEnvelope[]> {
  const proc = Bun.spawn(['bun', 'x', 'wrangler', 'd1', 'execute', options.database, '--remote', '--config', options.config, ...queryArgs, '--json'], { cwd: botRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `wrangler exited ${code}`)
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error(`Wrangler returned non-JSON output: ${stdout.trim()}`)
  const parsed = JSON.parse(stdout.slice(start)) as WranglerEnvelope[]
  const failed = parsed.find(item => item.success === false)
  if (failed) throw new Error(failed.errors?.map(error => error.message).filter(Boolean).join('; ') || 'Wrangler D1 execution failed')
  return parsed
}

function openLocalD1(readonly: boolean): SqliteDatabase {
  const directory = resolve(botRoot, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(directory)) throw new Error(`Local D1 directory not found: ${directory}`)
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const path = resolve(directory, file)
    const probe = new SqliteDatabase(path, { readonly: true })
    try {
      const tables = new Set((probe.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(row => row.name))
      if (tables.has('matches') && tables.has('scoped_player_civ_stats') && tables.has('scoped_match_player_civ_stat_contributions')) return readonly ? new SqliteDatabase(path, { readonly: true }) : new SqliteDatabase(path)
    }
    finally {
      probe.close()
    }
  }
  throw new Error(`Could not find the migrated local D1 database in ${directory}`)
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function print(value: unknown, json: boolean): void {
  console.log(JSON.stringify(value, null, json ? 0 : 2))
}
