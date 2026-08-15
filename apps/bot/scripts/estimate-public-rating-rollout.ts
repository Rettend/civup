/* eslint-disable no-console */
import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import process from 'node:process'
import { PUBLIC_RATING_BACKFILL_MODES } from './public-rating-backfill-shared.ts'

type Source = 'legacy-export' | 'scoped-export' | 'legacy-remote' | 'scoped-remote'

interface Options {
  exportPath: string | null
  remote: boolean
  config: string
  database: string
  primaryGuildId: string
  dailyWriteBudget: number
}

interface ModeCounts {
  eventRows: number
  eventChains: number
  primaryEventRows: number
  primaryEventChains: number
  missingSummaryChains: number
}

interface SourceCounts {
  source: Source
  modes: Record<string, ModeCounts>
}

interface WranglerEnvelope<T> {
  success?: boolean
  results?: T[]
  errors?: Array<{ message?: string }>
}

interface RemoteModeRow {
  mode: string
  eventRows: number
  eventChains: number
  primaryEventRows: number
  primaryEventChains: number
  missingSummaryChains: number
}

const D1_FREE_DAILY_WRITE_LIMIT = 100_000
const DEFAULT_DAILY_WRITE_BUDGET = 60_000
const botRoot = resolve(import.meta.dir, '..')
const usage = [
  'Usage:',
  '  bun scripts/estimate-public-rating-rollout.ts --export <d1-export.sql> [options]',
  '  bun scripts/estimate-public-rating-rollout.ts --remote [options]',
  '',
  'Options:',
  '  --export <path>             Inspect an existing D1 SQL export without network access',
  '  --remote                    Explicitly allow read-only aggregate queries against D1',
  '  --config <path>             Wrangler config relative to apps/bot (default: wrangler.ppl.jsonc)',
  '  --database <name>           D1 database name (default: civup)',
  '  --primary-guild-id <id>     Override ALLOWED_DISCORD_GUILD_ID from the config',
  '  --daily-write-budget <n>    Backfill write budget below the 100,000/day free limit (default: 60000)',
  '',
  'The script never writes D1. Remote reads are impossible unless --remote is present.',
].join('\n')

const options = parseOptions(Bun.argv.slice(2))
const counts = options.remote ? await inspectRemote(options) : await inspectExport(options)
console.log(JSON.stringify(buildEstimate(options, counts), null, 2))

function parseOptions(args: string[]): Options {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage)
    process.exit(0)
  }

  let exportPath: string | null = null
  let remote = false
  let config = 'wrangler.ppl.jsonc'
  let database = 'civup'
  let primaryGuildId: string | null = null
  let dailyWriteBudget = DEFAULT_DAILY_WRITE_BUDGET

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--remote') {
      remote = true
      continue
    }
    if (arg === '--export' || arg === '--config' || arg === '--database' || arg === '--primary-guild-id' || arg === '--daily-write-budget') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${arg}`)
      if (arg === '--export') exportPath = resolve(value)
      else if (arg === '--config') config = value
      else if (arg === '--database') database = value
      else if (arg === '--primary-guild-id') primaryGuildId = value
      else dailyWriteBudget = parseDailyWriteBudget(value)
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  if (remote === (exportPath != null)) throw new Error('Choose exactly one source: --export <path> or --remote.')
  const configText = readFileSync(resolve(botRoot, config), 'utf8')
  primaryGuildId ??= readConfigValue(configText, 'ALLOWED_DISCORD_GUILD_ID')
  if (!primaryGuildId) throw new Error('Primary server ID is missing; use --primary-guild-id or configure ALLOWED_DISCORD_GUILD_ID.')
  if (!/^\d{17,20}$/.test(primaryGuildId)) throw new Error('--primary-guild-id must be a Discord server ID.')

  return { exportPath, remote, config, database, primaryGuildId, dailyWriteBudget }
}

async function inspectExport(options: Options): Promise<SourceCounts> {
  if (!options.exportPath) throw new Error('--export is required for offline inspection.')
  const scoped = createExportAccumulator(`server:${options.primaryGuildId}`, true)
  const legacy = createExportAccumulator(`server:${options.primaryGuildId}`, false)
  let hasScopedSchema = false
  const lines = createInterface({ input: createReadStream(options.exportPath), crlfDelay: Infinity })

  for await (const line of lines) {
    if (line.startsWith('CREATE TABLE `scoped_player_rating_events`')) hasScopedSchema = true
    if (!line.startsWith('INSERT INTO "')) continue
    const parsed = parseInsert(line)
    if (!parsed) continue
    if (parsed.table === 'scoped_player_rating_events' || parsed.table === 'scoped_player_ratings') scoped.accept(parsed.table, parsed.row)
    else if (parsed.table === 'player_rating_events' || parsed.table === 'player_ratings') legacy.accept(parsed.table, parsed.row)
  }

  return hasScopedSchema
    ? { source: 'scoped-export', modes: scoped.finish() }
    : { source: 'legacy-export', modes: legacy.finish() }
}

function createExportAccumulator(primaryStatsKey: string, scoped: boolean) {
  const eventRowsByMode = new Map<string, number>()
  const primaryEventRowsByMode = new Map<string, number>()
  const eventChains = new Map<string, Set<string>>()
  const primaryEventChains = new Map<string, Set<string>>()
  const summaryChains = new Set<string>()

  return {
    accept(table: string, row: Map<string, string | null>) {
      const mode = row.get('mode')
      const playerId = row.get('player_id')
      const statsKey = scoped ? row.get('stats_key') : primaryStatsKey
      if (!mode || !playerId || !statsKey || !isBackfillMode(mode)) return
      const chain = `${statsKey}\0${playerId}\0${mode}`
      if (table.endsWith('rating_events')) {
        increment(eventRowsByMode, mode)
        addToSet(eventChains, mode, chain)
        if (statsKey === primaryStatsKey) {
          increment(primaryEventRowsByMode, mode)
          addToSet(primaryEventChains, mode, chain)
        }
      }
      else {
        summaryChains.add(chain)
      }
    },
    finish(): Record<string, ModeCounts> {
      return Object.fromEntries(PUBLIC_RATING_BACKFILL_MODES.map((mode) => {
        const chains = eventChains.get(mode) ?? new Set<string>()
        return [mode, {
          eventRows: eventRowsByMode.get(mode) ?? 0,
          eventChains: chains.size,
          primaryEventRows: primaryEventRowsByMode.get(mode) ?? 0,
          primaryEventChains: primaryEventChains.get(mode)?.size ?? 0,
          missingSummaryChains: [...chains].filter(chain => !summaryChains.has(chain)).length,
        }]
      }))
    },
  }
}

async function inspectRemote(options: Options): Promise<SourceCounts> {
  const tableRows = await runRemoteQuery<{ name: string }>(options, `
    select name from sqlite_master
    where type = 'table' and name in ('scoped_player_rating_events', 'scoped_player_ratings')
  `)
  const hasScopedSchema = tableRows.some(row => row.name === 'scoped_player_rating_events')
    && tableRows.some(row => row.name === 'scoped_player_ratings')
  const rows = await runRemoteQuery<RemoteModeRow>(options, hasScopedSchema
    ? scopedEstimateSql(`server:${options.primaryGuildId}`)
    : legacyEstimateSql())
  const byMode = new Map(rows.map(row => [row.mode, normalizeModeCounts(row)]))
  return {
    source: hasScopedSchema ? 'scoped-remote' : 'legacy-remote',
    modes: Object.fromEntries(PUBLIC_RATING_BACKFILL_MODES.map(mode => [mode, byMode.get(mode) ?? emptyModeCounts()])),
  }
}

function scopedEstimateSql(primaryStatsKey: string): string {
  return `with event_chains as (
    select stats_key, player_id, mode, count(*) as event_rows
    from scoped_player_rating_events
    where mode in (${modeSql()})
    group by stats_key, player_id, mode
  )
  select
    c.mode as mode,
    sum(c.event_rows) as eventRows,
    count(*) as eventChains,
    sum(case when c.stats_key = ${sqlString(primaryStatsKey)} then c.event_rows else 0 end) as primaryEventRows,
    sum(case when c.stats_key = ${sqlString(primaryStatsKey)} then 1 else 0 end) as primaryEventChains,
    sum(case when exists (
      select 1 from scoped_player_ratings r
      where r.stats_key = c.stats_key and r.player_id = c.player_id and r.mode = c.mode
    ) then 0 else 1 end) as missingSummaryChains
  from event_chains c
  group by c.mode
  order by c.mode`
}

function legacyEstimateSql(): string {
  return `with event_chains as (
    select player_id, mode, count(*) as event_rows
    from player_rating_events
    where mode in (${modeSql()})
    group by player_id, mode
  )
  select
    c.mode as mode,
    sum(c.event_rows) as eventRows,
    count(*) as eventChains,
    sum(c.event_rows) as primaryEventRows,
    count(*) as primaryEventChains,
    sum(case when exists (
      select 1 from player_ratings r where r.player_id = c.player_id and r.mode = c.mode
    ) then 0 else 1 end) as missingSummaryChains
  from event_chains c
  group by c.mode
  order by c.mode`
}

function buildEstimate(options: Options, counts: SourceCounts) {
  const totals = Object.values(counts.modes).reduce((sum, mode) => ({
    eventRows: sum.eventRows + mode.eventRows,
    eventChains: sum.eventChains + mode.eventChains,
    primaryEventRows: sum.primaryEventRows + mode.primaryEventRows,
    primaryEventChains: sum.primaryEventChains + mode.primaryEventChains,
    missingSummaryChains: sum.missingSummaryChains + mode.missingSummaryChains,
  }), emptyModeCounts())
  const writes = {
    scopedEventRows: totals.eventRows,
    scopedSummaryRows: totals.eventChains,
    primaryLegacyEventRows: totals.primaryEventRows,
    primaryLegacySummaryRows: totals.primaryEventChains,
    stagingRows: 0,
  }
  const totalRows = Object.values(writes).reduce((sum, value) => sum + value, 0)
  const safeSourceEventsPerDay = totalRows === 0 ? 0 : Math.floor(options.dailyWriteBudget * totals.eventRows / totalRows)

  return {
    readOnly: true,
    source: counts.source,
    primaryStatsKey: `server:${options.primaryGuildId}`,
    modes: counts.modes,
    totals,
    estimatedRowsWritten: { ...writes, totalRows },
    dailyPlan: {
      freeTierWriteLimit: D1_FREE_DAILY_WRITE_LIMIT,
      backfillWriteBudget: options.dailyWriteBudget,
      reservedHeadroom: D1_FREE_DAILY_WRITE_LIMIT - options.dailyWriteBudget,
      safeSourceEventsPerDay,
      minimumRolloutDays: totalRows === 0 ? 0 : Math.ceil(totalRows / options.dailyWriteBudget),
    },
    canBackfill: totals.missingSummaryChains === 0,
    notes: [
      'The estimate assumes complete scoped chains are replayed and only the primary stats scope is mirrored to legacy tables.',
      'The remote rollout path should update rows directly; no production staging-table writes are budgeted.',
      'Migration writes, normal production traffic, retries, and the final leaderboard KV rebuild are excluded.',
      'Stop before applying if missingSummaryChains is non-zero; those chains require a full hidden-rating replay first.',
    ],
  }
}

async function runRemoteQuery<T>(options: Options, sql: string): Promise<T[]> {
  const proc = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', options.database,
    '--remote', '--config', options.config, '--command', normalizeSql(sql), '--json',
  ], { cwd: botRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `wrangler exited ${exitCode}`)
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error(`Wrangler returned non-JSON output: ${stdout.trim()}`)
  const envelopes = JSON.parse(stdout.slice(start)) as Array<WranglerEnvelope<T>>
  const failed = envelopes.find(item => item.success === false)
  if (failed) throw new Error(failed.errors?.map(error => error.message).filter(Boolean).join('; ') || 'Wrangler D1 query failed')
  return envelopes.flatMap(envelope => envelope.results ?? [])
}

function parseInsert(line: string): { table: string, row: Map<string, string | null> } | null {
  const match = /^INSERT INTO "([^"]+)" \((.+)\) VALUES\((.*)\);$/.exec(line)
  if (!match) return null
  const columns = match[2]!.split(',').map(value => value.slice(1, -1))
  const values = parseSqlValues(match[3]!)
  if (columns.length !== values.length) throw new Error(`Could not parse ${match[1]} export row: column/value count differs.`)
  return { table: match[1]!, row: new Map(columns.map((column, index) => [column, values[index] ?? null])) }
}

function parseSqlValues(input: string): Array<string | null> {
  const values: Array<string | null> = []
  let index = 0
  while (index < input.length) {
    if (input[index] === '\'') {
      let value = ''
      index += 1
      while (index < input.length) {
        if (input[index] !== '\'') {
          value += input[index++]
          continue
        }
        if (input[index + 1] === '\'') {
          value += '\''
          index += 2
          continue
        }
        index += 1
        break
      }
      values.push(value)
    }
    else {
      const end = input.indexOf(',', index)
      const token = input.slice(index, end < 0 ? input.length : end).trim()
      values.push(token.toUpperCase() === 'NULL' ? null : token)
      index = end < 0 ? input.length : end
    }
    if (input[index] === ',') index += 1
  }
  return values
}

function normalizeModeCounts(row: RemoteModeRow): ModeCounts {
  return {
    eventRows: normalizeCount(row.eventRows),
    eventChains: normalizeCount(row.eventChains),
    primaryEventRows: normalizeCount(row.primaryEventRows),
    primaryEventChains: normalizeCount(row.primaryEventChains),
    missingSummaryChains: normalizeCount(row.missingSummaryChains),
  }
}

function emptyModeCounts(): ModeCounts {
  return { eventRows: 0, eventChains: 0, primaryEventRows: 0, primaryEventChains: 0, missingSummaryChains: 0 }
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1)
}

function addToSet(values: Map<string, Set<string>>, key: string, value: string): void {
  const set = values.get(key) ?? new Set<string>()
  set.add(value)
  values.set(key, set)
}

function isBackfillMode(mode: string): boolean {
  return PUBLIC_RATING_BACKFILL_MODES.includes(mode as typeof PUBLIC_RATING_BACKFILL_MODES[number])
}

function modeSql(): string {
  return PUBLIC_RATING_BACKFILL_MODES.map(sqlString).join(', ')
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

function readConfigValue(text: string, name: string): string | null {
  return new RegExp(`["']${name}["']\\s*:\\s*["']([^"']*)["']`).exec(text)?.[1]?.trim() || null
}

function parseDailyWriteBudget(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > D1_FREE_DAILY_WRITE_LIMIT) {
    throw new Error(`--daily-write-budget must be an integer from 1 to ${D1_FREE_DAILY_WRITE_LIMIT}.`)
  }
  return parsed
}
