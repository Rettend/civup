/* eslint-disable no-console */
import type { Database } from '@civup/db'
import type { CivLeaderboardBackfillCommand, CivLeaderboardBackfillSource } from './civ-leaderboard-backfill-shared.ts'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { createDb } from '@civup/db'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { runCivLeaderboardBackfill } from './civ-leaderboard-backfill-shared.ts'

type Command = 'estimate' | 'preview' | 'apply' | 'help'
type Target = 'local' | 'remote'

interface Options {
  command: Command
  source: CivLeaderboardBackfillSource
  execute: boolean
  json: boolean
  target: Target
  config: string
  database: string
}

interface Runtime {
  db: Database
  d1: D1Database
  kv: KVNamespace
  close?: () => void
}

interface WranglerQueryEnvelope<T> {
  results?: T[]
  success?: boolean
  errors?: Array<{ message?: string }>
}

interface CountRow {
  count: number
}

interface ScopeCountRow {
  modeScope: string
  count: number
}

interface EstimateResult {
  target: Target
  config: string
  database: string
  contributionRows: number
  eligibleContributionRows: number
  betaEligibleContributionRows: number
  legacyArrayPayloadRows: number
  contributionRowsByScope: Record<string, number>
  schema: {
    contributionMetadataColumnsPresent: boolean
    poolTotalsTablePresent: boolean
    civStatsRows: number
    civStatPoolTotalRows: number
  }
  estimatedTwoX: {
    estimateCommandRowsRead: number
    repairRowsRead: number
    repairRowsWritten: number
    migrationRowsReadIfNotApplied: number
    migrationRowsWrittenIfNotApplied: number
    migrationPlusRepairRowsReadIfNotApplied: number
    migrationPlusRepairRowsWrittenIfNotApplied: number
  }
  notes: string[]
}

const botRoot = resolve(import.meta.dir, '..')
const MAX_D1_COMMAND_LENGTH = 1800

const usage = [
  'Usage:',
  '  bun run bot:backfill:civ-leaderboard:prod:estimate',
  '  bun run bot:backfill:civ-leaderboard:prod:preview',
  '  bun run bot:backfill:civ-leaderboard:prod:apply',
  '  bun scripts/backfill-civ-leaderboard.ts estimate --local --repair',
  '',
  'Options:',
  '  --local          Use local dev D1/KV (default)',
  '  --remote         Use Cloudflare D1/KV from --config; default config matches deploy:prod test server',
  '  --repair         Rebuild aggregates/KV from existing contribution rows; no match history scan',
  '  --execute        Required with apply; mutates selected D1 and KV',
  '  --config <path>  Wrangler config relative to apps/bot (default: wrangler.jsonc)',
  '  --database <n>   D1 database name (default: civup)',
  '  --json           Print machine-readable JSON only',
  '',
  'The --remote target uses the same default config as deploy:prod: apps/bot/wrangler.jsonc.',
].join('\n')

const options = parseOptions(Bun.argv.slice(2))

if (options.command === 'help') {
  console.log(usage)
  process.exit(0)
}

const runtime = createRuntime(options)

try {
  if (options.command === 'estimate') {
    await runEstimate(options, runtime.d1)
  }
  else {
    const progress = options.json ? null : new Progress(options.command === 'apply' ? 6 : 1, 'civ-leaderboard')
    await runCivLeaderboardBackfill({
      command: options.command as CivLeaderboardBackfillCommand,
      source: options.source,
      execute: options.execute,
      json: options.json,
      target: options.target,
      config: displayConfigPath(options.config),
      database: options.database,
      db: runtime.db,
      kv: runtime.kv,
      applyHint: applyHint(options),
      includeHistoricalPreview: false,
      onProgress: progress ? label => progress.step(label) : undefined,
    })
  }
}
finally {
  runtime.close?.()
}

function parseOptions(values: string[]): Options {
  let command: Command = 'preview'
  let source: CivLeaderboardBackfillSource = 'history'
  let execute = false
  let json = false
  let target: Target = 'local'
  let config = 'wrangler.jsonc'
  let database = 'civup'
  const rest = [...values]
  const first = rest[0]

  if (first === 'estimate' || first === 'preview' || first === 'apply') {
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
    if (current === '--local') {
      target = 'local'
      continue
    }
    if (current === '--remote' || current === '--prod') {
      target = 'remote'
      continue
    }
    if (current === '--repair' || current === '--from-contributions') {
      source = 'contributions'
      continue
    }
    if (current === '--config') {
      const value = rest[index + 1]
      if (!value) throw new Error('Missing value for --config.')
      config = value
      index += 1
      continue
    }
    if (current === '--database') {
      const value = rest[index + 1]
      if (!value) throw new Error('Missing value for --database.')
      database = value
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${current}`)
  }

  return { command, source, execute, json, target, config, database }
}

function createRuntime(options: Options): Runtime {
  if (options.target === 'local') {
    const sqlite = openLocalD1Sqlite(options.config)
    const d1 = createLocalD1(sqlite)
    return {
      db: createDb(d1),
      d1,
      kv: createLocalKv(options.config),
      close: () => sqlite.close(),
    }
  }

  const d1 = createRemoteD1(options)
  return {
    db: createDb(d1),
    d1,
    kv: createRemoteKv(options.config),
  }
}

async function runEstimate(options: Options, d1: D1Database): Promise<void> {
  const progress = options.json ? null : new Progress(6, 'civ-estimate')
  progress?.step('counting contribution rows')
  const contributionRows = await readCount(d1, 'select count(*) as count from match_civ_stat_contributions')

  progress?.step('counting eligible contribution rows')
  const eligibleContributionRows = await readCount(d1, `
    select count(*) as count
    from match_civ_stat_contributions c
    where ${eligibleContributionSql('c')}
  `)
  const betaEligibleContributionRows = await readCount(d1, `
    select count(*) as count
    from match_civ_stat_contributions c
    where ${eligibleContributionSql('c')}
      and exists (
        select 1 from matches m
        where m.id = c.match_id
          and json_valid(m.draft_data)
          and json_extract(m.draft_data, '$.leaderDataVersion') = 'beta'
      )
  `)

  progress?.step('counting legacy contribution payloads')
  const legacyArrayPayloadRows = await readCount(d1, `
    select count(*) as count
    from match_civ_stat_contributions
    where json_valid(contributions_json)
      and json_type(contributions_json) = 'array'
  `)

  progress?.step('counting contribution scopes')
  const scopeRows = await readRows<ScopeCountRow>(d1, `
    select
      case
        when m.game_mode = '1v1' then 'duel'
        when m.game_mode = '2v2' then 'duo'
        when m.game_mode in ('3v3', '4v4', '5v5', '6v6') then 'squad'
        else 'all'
      end as modeScope,
      count(*) as count
    from match_civ_stat_contributions c
    inner join matches m on m.id = c.match_id
    where ${eligibleContributionSql('c')}
    group by modeScope
    order by modeScope
  `)

  progress?.step('checking civ aggregate schema')
  const contributionColumns = await readRows<{ name: string }>(d1, 'pragma table_info(match_civ_stat_contributions)')
  const contributionMetadataColumnsPresent = ['source', 'mode_scope', 'completed_at', 'visible'].every(column => contributionColumns.some(row => row.name === column))
  const poolTotalsTablePresent = await hasTable(d1, 'civ_stat_pool_totals')
  const civStatsRows = await hasTable(d1, 'civ_stats') ? await readCount(d1, 'select count(*) as count from civ_stats') : 0
  const civStatPoolTotalRows = poolTotalsTablePresent ? await readCount(d1, 'select count(*) as count from civ_stat_pool_totals') : 0

  progress?.step('building capacity estimate')
  const repairRowsRead = Math.ceil(contributionRows * 10 + civStatsRows + civStatPoolTotalRows + 5000)
  const repairRowsWritten = Math.ceil(2 * (eligibleContributionRows + civStatsRows + civStatPoolTotalRows + 1500))
  const migrationRowsReadIfNotApplied = contributionMetadataColumnsPresent ? 0 : Math.ceil(contributionRows * 4 + 5000)
  const migrationRowsWrittenIfNotApplied = contributionMetadataColumnsPresent ? 0 : Math.ceil(2 * (contributionRows + civStatsRows + 10))
  printEstimate({
    target: options.target,
    config: displayConfigPath(options.config),
    database: options.database,
    contributionRows,
    eligibleContributionRows,
    betaEligibleContributionRows,
    legacyArrayPayloadRows,
    contributionRowsByScope: Object.fromEntries(scopeRows.map(row => [row.modeScope, normalizeCount(row.count)])),
    schema: {
      contributionMetadataColumnsPresent,
      poolTotalsTablePresent,
      civStatsRows,
      civStatPoolTotalRows,
    },
    estimatedTwoX: {
      estimateCommandRowsRead: Math.ceil(contributionRows * 8 + 5000),
      repairRowsRead,
      repairRowsWritten,
      migrationRowsReadIfNotApplied,
      migrationRowsWrittenIfNotApplied,
      migrationPlusRepairRowsReadIfNotApplied: migrationRowsReadIfNotApplied + repairRowsRead,
      migrationPlusRepairRowsWrittenIfNotApplied: migrationRowsWrittenIfNotApplied + repairRowsWritten,
    },
    notes: [
      'contributionRows is N: existing match_civ_stat_contributions rows.',
      'Estimates are intentionally doubled and rounded up.',
      'Repair reads existing contribution rows and rebuilds civ aggregate/KV state; it does not read match_participants or rewrite matches.',
      'Repair write estimate assumes every eligible contribution has a unique pool; repeated pools will write less.',
    ],
  }, options.json)
}

function createLocalD1(db: SqliteDatabase): D1Database {
  return {
    prepare(query: string) {
      return createLocalPreparedStatement(db, query, [])
    },
  } as D1Database
}

function createLocalPreparedStatement(db: SqliteDatabase, query: string, values: unknown[]): D1PreparedStatement {
  return {
    bind(...nextValues: unknown[]) {
      return createLocalPreparedStatement(db, query, nextValues)
    },
    async all<T>() {
      return { results: runLocalQuery<T>(db, query, values), success: true, meta: {} } as D1Result<T>
    },
    async first<T>(column?: string) {
      const rows = runLocalQuery<Record<string, unknown>>(db, query, values)
      const first = rows[0] ?? null
      if (!first || !column) return first as T | null
      return first[column] as T | null
    },
    async run<T>() {
      const statement = db.query(query)
      if (values.length > 0) statement.run(...values as never[])
      else statement.run()
      return { success: true, meta: {} } as D1Result<T>
    },
    async raw<T>() {
      const rows = runLocalQuery<Record<string, unknown>>(db, query, values)
      return rows.map(row => Object.values(row)) as T[]
    },
  } as D1PreparedStatement
}

function runLocalQuery<T>(db: SqliteDatabase, query: string, values: unknown[]): T[] {
  const statement = db.query(query)
  if (values.length > 0) return statement.all(...values as never[]) as T[]
  return statement.all() as T[]
}

function createRemoteD1(options: Options): D1Database {
  return {
    prepare(query: string) {
      return createRemotePreparedStatement(options, query, [])
    },
  } as D1Database
}

function createRemotePreparedStatement(options: Options, query: string, values: unknown[]): D1PreparedStatement {
  return {
    bind(...nextValues: unknown[]) {
      return createRemotePreparedStatement(options, query, nextValues)
    },
    async all<T>() {
      return { results: await runRemoteD1Query<T>(options, interpolateSql(query, values)), success: true, meta: {} } as D1Result<T>
    },
    async first<T>(column?: string) {
      const rows = await runRemoteD1Query<Record<string, unknown>>(options, interpolateSql(query, values))
      const first = rows[0] ?? null
      if (!first || !column) return first as T | null
      return first[column] as T | null
    },
    async run<T>() {
      await runRemoteD1Query<T>(options, interpolateSql(query, values))
      return { success: true, meta: {} } as D1Result<T>
    },
    async raw<T>() {
      const rows = await runRemoteD1Query<Record<string, unknown>>(options, interpolateSql(query, values))
      return rows.map(row => Object.values(row)) as T[]
    },
  } as D1PreparedStatement
}

function createLocalKv(config: string): KVNamespace {
  return createWranglerKv(config, false)
}

function createRemoteKv(config: string): KVNamespace {
  return createWranglerKv(config, true)
}

function createWranglerKv(config: string, remote: boolean): KVNamespace {
  return {
    async get(key: string, type?: string) {
      const output = runWrangler(['kv', 'key', 'get', key, '--binding', 'KV', remote ? '--remote' : '--local', '--config', config, '--text'], { allowNotFound: true })
      if (output == null) return null
      const trimmed = output.trim()
      if (trimmed.length === 0) return null
      if (type !== 'json') return trimmed
      return JSON.parse(trimmed)
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      await withTempValueFile(value, (filePath) => {
        const args = ['kv', 'key', 'put', key, '--path', filePath, '--binding', 'KV', remote ? '--remote' : '--local', '--config', config]
        if (options?.expirationTtl != null) args.push('--ttl', String(options.expirationTtl))
        runWrangler(args)
      })
    },
    async delete(key: string) {
      runWrangler(['kv', 'key', 'delete', key, '--binding', 'KV', remote ? '--remote' : '--local', '--config', config])
    },
    async list(options?: { prefix?: string }) {
      const args = ['kv', 'key', 'list', '--binding', 'KV', remote ? '--remote' : '--local', '--config', config]
      if (options?.prefix) args.push('--prefix', options.prefix)
      const output = runWrangler(args)
      const parsed = parseWranglerJson<unknown>(output?.trim() ?? '')
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

async function runRemoteD1Query<T>(options: Options, sql: string): Promise<T[]> {
  const normalizedSql = normalizeWranglerSqlCommand(sql)
  if (normalizedSql.length > MAX_D1_COMMAND_LENGTH) {
    return await withTempValueFile(`${normalizedSql};\n`, filePath => runRemoteD1QueryCommand<T>(options, ['--file', filePath]))
  }

  return runRemoteD1QueryCommand<T>(options, ['--command', normalizedSql])
}

function runRemoteD1QueryCommand<T>(options: Options, queryArgs: string[]): T[] {
  const output = runWrangler(['d1', 'execute', options.database, '--remote', '--config', options.config, ...queryArgs, '--json'])
  const parsed = parseWranglerJson<WranglerQueryEnvelope<T>[]>(output?.trim() ?? '')
  const first = parsed[0]
  if (!first?.success) throw new Error(first?.errors?.map(error => error.message).filter(Boolean).join('; ') || 'unknown wrangler D1 error')
  return first.results ?? []
}

function runWrangler(args: string[], options: { allowNotFound?: boolean } = {}): string | null {
  const result = Bun.spawnSync({
    cmd: ['bun', 'x', 'wrangler', ...args],
    cwd: botRoot,
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
  const d1Dir = resolve(botRoot, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(d1Dir)) throw new Error(`Local D1 directory not found: ${d1Dir}. Run wrangler with ${config} first.`)

  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const sqlitePath = resolve(d1Dir, file)
    const db = new SqliteDatabase(sqlitePath, { readonly: true })
    try {
      const tables = new Set((db.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(row => row.name))
      if (tables.has('matches') && tables.has('match_participants') && tables.has('match_civ_stat_contributions')) return new SqliteDatabase(sqlitePath)
    }
    finally {
      db.close()
    }
  }

  throw new Error(`Could not find a local CivUp D1 SQLite file in ${d1Dir}`)
}

function eligibleContributionSql(alias: string): string {
  return `${alias}.completed_match_count > 0
    and exists (
      select 1 from matches m
      where m.id = ${alias}.match_id
        and m.status = 'completed'
        and not coalesce(json_valid(m.draft_data) and json_extract(m.draft_data, '$.redDeath') = true, false)
        and not coalesce(json_valid(m.draft_data) and json_extract(m.draft_data, '$.civBlitz') = true, false)
    )
    and not exists (
      select 1 from tournament_matches t
      where t.match_id = ${alias}.match_id
         or t.session_id = ${alias}.match_id
    )`
}

async function hasTable(d1: D1Database, tableName: string): Promise<boolean> {
  const escaped = tableName.replaceAll('\'', '\'\'')
  return await readCount(d1, `select count(*) as count from sqlite_master where type = 'table' and name = '${escaped}'`) > 0
}

async function readCount(d1: D1Database, query: string): Promise<number> {
  const [row] = await readRows<CountRow>(d1, query)
  return normalizeCount(row?.count)
}

async function readRows<T>(d1: D1Database, query: string): Promise<T[]> {
  const result = await d1.prepare(query).all<T>()
  return result.results ?? []
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function normalizeWranglerSqlCommand(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function interpolateSql(query: string, values: unknown[]): string {
  let index = 0
  return query.replace(/\?/g, () => sqlValue(values[index++]))
}

function sqlValue(value: unknown): string {
  if (value == null) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll('\'', '\'\'')}'`
}

async function withTempValueFile<T>(value: string, run: (filePath: string) => T | Promise<T>): Promise<T> {
  const tempFile = resolve(tmpdir(), `civup-civ-leaderboard-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  try {
    await Bun.write(tempFile, value)
    return await run(tempFile)
  }
  finally {
    rmSync(tempFile, { force: true })
  }
}

function parseWranglerJson<T>(output: string): T {
  const jsonStart = output.indexOf('[')
  const jsonEnd = output.lastIndexOf(']')
  if (jsonStart >= 0 && jsonEnd >= jsonStart) return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as T

  const objectStart = output.indexOf('{')
  const objectEnd = output.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd >= objectStart) return JSON.parse(output.slice(objectStart, objectEnd + 1)) as T

  throw new Error(`Could not parse Wrangler JSON output: ${output}`)
}

function printEstimate(result: EstimateResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('Estimate:')
  console.log(`  target: ${result.target}`)
  console.log(`  config: ${result.config}`)
  console.log(`  database: ${result.database}`)
  console.log(`  contributionRows (N): ${result.contributionRows}`)
  console.log(`  eligibleContributionRows: ${result.eligibleContributionRows}`)
  console.log(`  betaEligibleContributionRows: ${result.betaEligibleContributionRows}`)
  console.log(`  legacyArrayPayloadRows: ${result.legacyArrayPayloadRows}`)
  console.log('  contributionRowsByScope:')
  for (const [scope, count] of Object.entries(result.contributionRowsByScope)) console.log(`    ${scope}: ${count}`)
  console.log('  schema:')
  for (const [key, value] of Object.entries(result.schema)) console.log(`    ${key}: ${String(value)}`)
  console.log('  estimatedTwoX:')
  for (const [key, value] of Object.entries(result.estimatedTwoX)) console.log(`    ${key}: ${String(value)}`)
  console.log('  notes:')
  for (const note of result.notes) console.log(`    - ${note}`)
}

function displayConfigPath(config: string): string {
  return config.includes('/') || config.includes('\\') ? config : `apps/bot/${config}`
}

function applyHint(options: Options): string {
  const targetFlag = options.target === 'remote' ? ' --remote' : ' --local'
  const sourceFlag = options.source === 'contributions' ? ' --repair' : ''
  return `bun run --filter civup-bot backfill:civ-leaderboard apply${targetFlag}${sourceFlag} --execute`
}

class Progress {
  private current = 0

  constructor(private readonly total: number, private readonly label: string) {}

  step(message: string): void {
    this.current = Math.min(this.current + 1, this.total)
    const width = 20
    const filled = Math.round((this.current / this.total) * width)
    const bar = `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
    console.log(`[${this.label}] [${bar}] ${this.current}/${this.total} ${message}`)
  }
}
