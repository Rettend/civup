/* eslint-disable no-console */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { buildMultiServerBackfillPreviewQueries, buildMultiServerBackfillSql, buildMultiServerValidationQueries } from './multi-server-backfill-shared.ts'

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
  cutoff: number
  primaryGuildId: string
  allowedGuildIds: string[]
  guildMappings: Map<string, string>
}

interface WranglerEnvelope {
  success?: boolean
  results?: Array<{ count?: number }>
  errors?: Array<{ message?: string }>
}

const botRoot = resolve(import.meta.dir, '..')
const usage = [
  'Usage: bun scripts/backfill-multi-server.ts <preview|apply> --cutoff <ISO-or-ms> [flags]',
  '',
  'Flags:',
  '  --local                         Use local D1 storage (default)',
  '  --remote                        Use remote D1 from --config',
  '  --config <path>                 Wrangler config relative to apps/bot (default: wrangler.jsonc)',
  '  --database <name>               D1 database name (default: civup)',
  '  --primary-guild-id <id>         Override ALLOWED_DISCORD_GUILD_ID from config',
  '  --allowed-guild-ids <id,...>    Override the configured supported-server list',
  '  --map-guild <old:new>           Map one legacy server ID; may be repeated',
  '  --execute                       Required to mutate with apply',
  '  --yes                           Also required for remote apply',
  '  --json                          Print machine-readable output',
  '',
  'The cutoff must be the recorded scoped-write deployment cutoff. Preview performs no writes.',
].join('\n')

const options = await parseOptions(Bun.argv.slice(2))
const config = {
  primaryGuildId: options.primaryGuildId,
  allowedGuildIds: options.allowedGuildIds,
  cutoff: options.cutoff,
  guildMappings: options.guildMappings,
}

const preview = await readCounts(options, buildMultiServerBackfillPreviewQueries(config))
const before = await readCounts(options, buildMultiServerValidationQueries(config))
print({ mode: options.command, target: options.target, cutoff: options.cutoff, preview, validationBefore: before }, options.json)

if (options.command === 'apply') {
  if (!options.execute) {
    if (!options.json) console.log('Dry run only. Add --execute to apply the idempotent backfill.')
    process.exit(0)
  }
  if (options.target === 'remote' && !options.yes) throw new Error('Remote apply requires --yes in addition to --execute.')

  await applySql(options, buildMultiServerBackfillSql(config))
  const after = await readCounts(options, buildMultiServerValidationQueries(config))
  print({ mode: 'apply-result', target: options.target, cutoff: options.cutoff, validationAfter: after }, options.json)
  const unresolved = Object.entries(after).filter(([, count]) => count > 0)
  if (unresolved.length > 0) {
    throw new Error(`Backfill validation still has unresolved rows: ${unresolved.map(([name, count]) => `${name}=${count}`).join(', ')}`)
  }
}

async function parseOptions(args: string[]): Promise<Options> {
  const command = args[0]
  if (command === '--help' || command === '-h' || command == null) {
    console.log(usage)
    process.exit(0)
  }
  if (command !== 'preview' && command !== 'apply') throw new Error(`Unknown command: ${command}`)

  let target: Target = 'local'
  let execute = false
  let yes = false
  let json = false
  let configPath = 'wrangler.jsonc'
  let database = 'civup'
  let cutoff: number | null = null
  let primaryOverride: string | null = null
  let allowedOverride: string[] | null = null
  const guildMappings = new Map<string, string>()

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--local') target = 'local'
    else if (arg === '--remote') target = 'remote'
    else if (arg === '--execute') execute = true
    else if (arg === '--yes') yes = true
    else if (arg === '--json') json = true
    else if (arg === '--config' || arg === '--database' || arg === '--cutoff' || arg === '--primary-guild-id' || arg === '--allowed-guild-ids' || arg === '--map-guild') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${arg}`)
      if (arg === '--config') configPath = value
      else if (arg === '--database') database = value
      else if (arg === '--cutoff') cutoff = parseCutoff(value)
      else if (arg === '--primary-guild-id') primaryOverride = value
      else if (arg === '--allowed-guild-ids') allowedOverride = value.split(',').map(item => item.trim()).filter(Boolean)
      else {
        const [from, to, extra] = value.split(':')
        if (!from || !to || extra) throw new Error('--map-guild must use old:new')
        guildMappings.set(from, to)
      }
    }
    else throw new Error(`Unknown flag: ${arg}`)
  }

  if (cutoff == null) throw new Error('--cutoff is required')
  const configFile = resolve(botRoot, configPath)
  const configText = await Bun.file(configFile).text()
  const primaryGuildId = primaryOverride ?? readConfigValue(configText, 'ALLOWED_DISCORD_GUILD_ID')
  if (!primaryGuildId) throw new Error('Primary server ID is missing from config and --primary-guild-id.')
  const configuredAllowed = readConfigValue(configText, 'ALLOWED_DISCORD_GUILD_IDS')?.split(',').map(item => item.trim()).filter(Boolean) ?? []
  const allowedGuildIds = [...new Set([primaryGuildId, ...(allowedOverride ?? configuredAllowed)])]

  return {
    command,
    target,
    execute,
    yes,
    json,
    config: configFile,
    database,
    cutoff,
    primaryGuildId,
    allowedGuildIds,
    guildMappings,
  }
}

async function readCounts(options: Options, queries: Record<string, string>): Promise<Record<string, number>> {
  if (options.target === 'local') {
    const db = openLocalD1(true)
    try {
      return Object.fromEntries(Object.entries(queries).map(([name, query]) => {
        const row = db.query(query).get() as { count?: number } | null
        return [name, normalizeCount(row?.count)]
      }))
    }
    finally {
      db.close()
    }
  }

  const counts: Record<string, number> = {}
  for (const [name, query] of Object.entries(queries)) {
    const envelopes = await runWrangler(options, ['--command', normalizeSql(query)])
    counts[name] = normalizeCount(envelopes[0]?.results?.[0]?.count)
  }
  return counts
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

  const filePath = resolve(tmpdir(), `civup-multi-server-backfill-${Date.now()}.sql`)
  try {
    await Bun.write(filePath, sql)
    await runWrangler(options, ['--file', filePath])
  }
  finally {
    rmSync(filePath, { force: true })
  }
}

async function runWrangler(options: Options, queryArgs: string[]): Promise<WranglerEnvelope[]> {
  const proc = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', options.database,
    '--remote', '--config', options.config, ...queryArgs, '--json',
  ], { cwd: botRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `wrangler exited ${exitCode}`)
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
      if (tables.has('matches') && tables.has('match_repairs') && tables.has('scoped_player_rating_events')) {
        return readonly ? new SqliteDatabase(path, { readonly: true }) : new SqliteDatabase(path)
      }
    }
    finally {
      probe.close()
    }
  }
  throw new Error(`Could not find the migrated local D1 database in ${directory}`)
}

function readConfigValue(text: string, name: string): string | null {
  return new RegExp(`["']${name}["']\\s*:\\s*["']([^"']*)["']`).exec(text)?.[1]?.trim() || null
}

function parseCutoff(value: string): number {
  const numeric = Number(value)
  const parsed = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--cutoff must be a positive millisecond timestamp or ISO date')
  return parsed
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value))
  else console.log(JSON.stringify(value, null, 2))
}
