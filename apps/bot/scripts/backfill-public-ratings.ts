/* eslint-disable no-console */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { applyPublicRatingBackfillBatch, calculatePublicRatingBackfill, PUBLIC_RATING_BACKFILL_MODES, type PublicRatingBackfillEvent, type PublicRatingBackfillResult } from './public-rating-backfill-shared.ts'

interface ChainRow {
  stats_key: string
  player_id: string
  mode: string
}

interface StoredEventRow extends ChainRow {
  match_id: string
  match_created_at: number
  rating_before_mu: number
  rating_after_mu: number
  imported_games_delta: number
  effective_games_delta: number
  public_rating_before: number | null
  public_rating_after: number | null
}

const botRoot = resolve(import.meta.dir, '..')
const args = Bun.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun scripts/backfill-public-ratings.ts [--execute] [--batch-size N] [--primary-guild-id ID]',
    '       bun scripts/backfill-public-ratings.ts --remote [--execute --yes] [options]',
    '',
    'Options:',
    '  --remote                 Use D1 from --config; remote dry-run only counts pending chains',
    '  --execute                Apply the backfill instead of previewing it',
    '  --yes                    Required with --remote --execute',
    '  --max-writes N           Stop a remote invocation before this many D1 row updates (default: 60000)',
    '  --batch-size N           Number of complete chains loaded per batch (default: 50)',
    '  --config PATH            Wrangler config relative to apps/bot (default: wrangler.jsonc)',
    '  --database NAME          D1 database name (default: civup)',
    '  --primary-guild-id ID    Primary scope mirrored to legacy rating tables',
    '',
    'Remote writes require all three flags: --remote --execute --yes.',
  ].join('\n'))
  process.exit(0)
}
const execute = args.includes('--execute')
const remote = args.includes('--remote')
const yes = args.includes('--yes')
const batchSize = readIntegerFlag(args, '--batch-size', 50)
const maxWrites = readIntegerFlag(args, '--max-writes', 60_000, 100_000)
const config = readStringFlag(args, '--config') ?? 'wrangler.jsonc'
const database = readStringFlag(args, '--database') ?? 'civup'
const primaryGuildId = readStringFlag(args, '--primary-guild-id') ?? await readPrimaryGuildId(config)
const primaryStatsKey = primaryGuildId ? `server:${primaryGuildId}` : null

if (remote) {
  if (execute && !yes) throw new Error('Remote execution requires --yes in addition to --remote --execute.')
  await runRemoteBackfill({ execute, batchSize, maxWrites, config, database, primaryStatsKey })
}
else {
  const sqlite = openLocalD1(!execute)
  try {
    const pendingBefore = countPendingChains(sqlite)
    const missingSummaryChains = countMissingSummaryChains(sqlite)
    console.log(JSON.stringify({ target: 'local', execute, pendingChains: pendingBefore, missingSummaryChains, batchSize, primaryStatsKey }, null, 2))
    if (!execute) process.exit(0)
    if (missingSummaryChains > 0) throw new Error('Mode event chains without summary rows require a full rating replay before public rating backfill.')

    let processedChains = 0
    let processedEvents = 0
    while (true) {
      const chains = listPendingChains(sqlite, batchSize)
      if (chains.length === 0) break
      const events = listEventsForChains(sqlite, chains)
      const updates = calculatePublicRatingBackfill(events.map(toBackfillEvent))
      applyPublicRatingBackfillBatch(sqlite, updates, primaryStatsKey)
      processedChains += updates.summaries.length
      processedEvents += updates.events.length
    }

    console.log(JSON.stringify({ processedChains, processedEvents, pendingChains: countPendingChains(sqlite) }, null, 2))
  }
  finally {
    sqlite.close()
  }
}

interface RemoteOptions {
  execute: boolean
  batchSize: number
  maxWrites: number
  config: string
  database: string
  primaryStatsKey: string | null
}

interface WranglerEnvelope<T> {
  success?: boolean
  results?: T[]
  errors?: Array<{ message?: string }>
}

async function runRemoteBackfill(options: RemoteOptions): Promise<void> {
  const pendingBefore = await countPendingChainsRemote(options)
  const missingSummaryChains = await countMissingSummaryChainsRemote(options)
  console.log(JSON.stringify({
    target: 'remote',
    execute: options.execute,
    pendingChains: pendingBefore,
    missingSummaryChains,
    batchSize: options.batchSize,
    maxWrites: options.maxWrites,
    primaryStatsKey: options.primaryStatsKey,
  }, null, 2))
  if (!options.execute) return
  if (missingSummaryChains > 0) throw new Error('Mode event chains without summary rows require a full rating replay before public rating backfill.')

  let processedChains = 0
  let processedEvents = 0
  let processedWrites = 0
  while (processedWrites < options.maxWrites) {
    const chains = await listPendingChainsRemote(options, options.batchSize)
    if (chains.length === 0) break
    const events = await listEventsForChainsRemote(options, chains)
    const selected = selectRemoteBatch(events.map(toBackfillEvent), options.primaryStatsKey, options.maxWrites - processedWrites, processedWrites === 0)
    if (selected.updates.events.length === 0) break
    await applyRemoteBatch(options, selected.updates)
    processedChains += selected.updates.summaries.length
    processedEvents += selected.updates.events.length
    processedWrites += selected.writes
  }

  console.log(JSON.stringify({
    processedChains,
    processedEvents,
    processedWrites,
    writeBudgetRemaining: options.maxWrites - processedWrites,
    pendingChains: await countPendingChainsRemote(options),
  }, null, 2))
}

function countPendingChains(db: Database): number {
  const row = db.query(`select count(*) as count from (${pendingChainsSql()})`).get() as { count: number }
  return Math.max(0, Math.round(row.count))
}

function listPendingChains(db: Database, limit: number): ChainRow[] {
  return db.query(`${pendingChainsSql()} order by e.stats_key, e.player_id, e.mode limit ?`).all(limit) as ChainRow[]
}

function countMissingSummaryChains(db: Database): number {
  const modes = PUBLIC_RATING_BACKFILL_MODES.map(sqlString).join(', ')
  const row = db.query(`select count(*) as count from (
    select e.stats_key, e.player_id, e.mode
    from scoped_player_rating_events e
    left join scoped_player_ratings r on r.stats_key = e.stats_key and r.player_id = e.player_id and r.mode = e.mode
    where e.mode in (${modes}) and r.player_id is null
    group by e.stats_key, e.player_id, e.mode
  )`).get() as { count: number }
  return Math.max(0, Math.round(row.count))
}

function pendingChainsSql(): string {
  const modes = PUBLIC_RATING_BACKFILL_MODES.map(sqlString).join(', ')
  return `select e.stats_key, e.player_id, e.mode
    from scoped_player_rating_events e
    inner join scoped_player_ratings r
      on r.stats_key = e.stats_key and r.player_id = e.player_id and r.mode = e.mode
    where e.mode in (${modes})
    group by e.stats_key, e.player_id, e.mode
    having min(e.public_rating_before is not null and e.public_rating_after is not null) = 0
      or max(r.public_rating is null) = 1`
}

function listEventsForChains(db: Database, chains: ChainRow[]): StoredEventRow[] {
  if (chains.length === 0) return []
  const values = chains.map(() => '(?, ?, ?)').join(', ')
  const params = chains.flatMap(chain => [chain.stats_key, chain.player_id, chain.mode])
  return db.query(`select
      e.stats_key, e.match_id, e.player_id, e.mode, e.match_created_at,
      e.rating_before_mu, e.rating_after_mu, e.imported_games_delta, e.effective_games_delta,
      e.public_rating_before, e.public_rating_after
    from scoped_player_rating_events e
    where (e.stats_key, e.player_id, e.mode) in (values ${values})
    order by e.stats_key, e.player_id, e.mode, e.match_created_at, e.match_id`).all(...params) as StoredEventRow[]
}

async function countPendingChainsRemote(options: RemoteOptions): Promise<number> {
  const [row] = await runRemoteQuery<{ count: number }>(options, `select count(*) as count from (${pendingChainsSql()})`)
  return normalizeCount(row?.count)
}

async function countMissingSummaryChainsRemote(options: RemoteOptions): Promise<number> {
  const modes = PUBLIC_RATING_BACKFILL_MODES.map(sqlString).join(', ')
  const [row] = await runRemoteQuery<{ count: number }>(options, `select count(*) as count from (
    select e.stats_key, e.player_id, e.mode
    from scoped_player_rating_events e
    left join scoped_player_ratings r on r.stats_key = e.stats_key and r.player_id = e.player_id and r.mode = e.mode
    where e.mode in (${modes}) and r.player_id is null
    group by e.stats_key, e.player_id, e.mode
  )`)
  return normalizeCount(row?.count)
}

async function listPendingChainsRemote(options: RemoteOptions, limit: number): Promise<ChainRow[]> {
  return runRemoteQuery<ChainRow>(options, `${pendingChainsSql()} order by e.stats_key, e.player_id, e.mode limit ${limit}`)
}

async function listEventsForChainsRemote(options: RemoteOptions, chains: ChainRow[]): Promise<StoredEventRow[]> {
  if (chains.length === 0) return []
  const values = chains.map(chain => `(${sqlString(chain.stats_key)}, ${sqlString(chain.player_id)}, ${sqlString(chain.mode)})`).join(', ')
  return runRemoteQuery<StoredEventRow>(options, `select
      e.stats_key, e.match_id, e.player_id, e.mode, e.match_created_at,
      e.rating_before_mu, e.rating_after_mu, e.imported_games_delta, e.effective_games_delta,
      e.public_rating_before, e.public_rating_after
    from scoped_player_rating_events e
    where (e.stats_key, e.player_id, e.mode) in (values ${values})
    order by e.stats_key, e.player_id, e.mode, e.match_created_at, e.match_id`)
}

function selectRemoteBatch(events: PublicRatingBackfillEvent[], primaryStatsKey: string | null, availableWrites: number, failIfFirstTooLarge: boolean): { updates: PublicRatingBackfillResult, writes: number } {
  const byChain = new Map<string, PublicRatingBackfillEvent[]>()
  for (const event of events) {
    const key = `${event.statsKey}\0${event.playerId}\0${event.mode}`
    const chain = byChain.get(key) ?? []
    chain.push(event)
    byChain.set(key, chain)
  }

  const updates: PublicRatingBackfillResult = { events: [], summaries: [] }
  let writes = 0
  for (const chain of byChain.values()) {
    const calculated = calculatePublicRatingBackfill(chain)
    const chainWrites = countRemoteWrites(calculated, primaryStatsKey)
    if (writes + chainWrites > availableWrites) {
      if (writes === 0 && failIfFirstTooLarge && chainWrites > availableWrites) {
        throw new Error(`The next complete rating chain needs ${chainWrites} row writes, above the remaining ${availableWrites} write budget.`)
      }
      break
    }
    updates.events.push(...calculated.events)
    updates.summaries.push(...calculated.summaries)
    writes += chainWrites
  }
  return { updates, writes }
}

function countRemoteWrites(updates: PublicRatingBackfillResult, primaryStatsKey: string | null): number {
  const primaryEvents = primaryStatsKey ? updates.events.filter(row => row.statsKey === primaryStatsKey).length : 0
  const primarySummaries = primaryStatsKey ? updates.summaries.filter(row => row.statsKey === primaryStatsKey).length : 0
  return updates.events.length + updates.summaries.length + primaryEvents + primarySummaries
}

async function applyRemoteBatch(options: RemoteOptions, updates: PublicRatingBackfillResult): Promise<void> {
  const statements: string[] = []
  for (const row of updates.events) {
    statements.push(`update scoped_player_rating_events set public_rating_before = ${sqlNumber(row.publicRatingBefore)}, public_rating_after = ${sqlNumber(row.publicRatingAfter)} where stats_key = ${sqlString(row.statsKey)} and match_id = ${sqlString(row.matchId)} and player_id = ${sqlString(row.playerId)} and mode = ${sqlString(row.mode)}`)
    if (options.primaryStatsKey === row.statsKey) {
      statements.push(`update player_rating_events set public_rating_before = ${sqlNumber(row.publicRatingBefore)}, public_rating_after = ${sqlNumber(row.publicRatingAfter)} where match_id = ${sqlString(row.matchId)} and player_id = ${sqlString(row.playerId)} and mode = ${sqlString(row.mode)}`)
    }
  }
  for (const row of updates.summaries) {
    statements.push(`update scoped_player_ratings set public_rating = ${sqlNumber(row.publicRating)} where stats_key = ${sqlString(row.statsKey)} and player_id = ${sqlString(row.playerId)} and mode = ${sqlString(row.mode)}`)
    if (options.primaryStatsKey === row.statsKey) {
      statements.push(`update player_ratings set public_rating = ${sqlNumber(row.publicRating)} where player_id = ${sqlString(row.playerId)} and mode = ${sqlString(row.mode)}`)
    }
  }
  await runRemoteSqlFile(options, `${statements.join(';\n')};\n`)
}

async function runRemoteQuery<T>(options: RemoteOptions, sql: string): Promise<T[]> {
  const envelopes = await runWrangler(options, ['--command', normalizeSql(sql)]) as Array<WranglerEnvelope<T>>
  return envelopes.flatMap(envelope => envelope.results ?? [])
}

async function runRemoteSqlFile(options: RemoteOptions, sql: string): Promise<void> {
  const path = resolve(tmpdir(), `civup-public-rating-backfill-${Date.now()}.sql`)
  try {
    await Bun.write(path, sql)
    await runWrangler(options, ['--file', path])
  }
  finally {
    rmSync(path, { force: true })
  }
}

async function runWrangler<T>(options: RemoteOptions, queryArgs: string[]): Promise<Array<WranglerEnvelope<T>>> {
  const proc = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', options.database,
    '--remote', '--config', options.config, ...queryArgs, ...(options.execute ? ['--yes'] : []), '--json',
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
  if (failed) throw new Error(failed.errors?.map(error => error.message).filter(Boolean).join('; ') || 'Wrangler D1 execution failed')
  return envelopes
}

function toBackfillEvent(row: StoredEventRow): PublicRatingBackfillEvent {
  return {
    statsKey: row.stats_key,
    matchId: row.match_id,
    playerId: row.player_id,
    mode: row.mode,
    matchCreatedAt: row.match_created_at,
    ratingBeforeMu: row.rating_before_mu,
    ratingAfterMu: row.rating_after_mu,
    importedGamesDelta: row.imported_games_delta,
    effectiveGamesDelta: row.effective_games_delta,
    publicRatingBefore: row.public_rating_before,
    publicRatingAfter: row.public_rating_after,
  }
}

function openLocalD1(readonly: boolean): Database {
  const directory = resolve(botRoot, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(directory)) throw new Error(`Local D1 directory not found: ${directory}`)
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const path = resolve(directory, file)
    const probe = new Database(path, { readonly: true })
    const tables = new Set((probe.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(row => row.name))
    probe.close()
    if (tables.has('scoped_player_rating_events') && tables.has('scoped_player_ratings')) return new Database(path, { readonly })
  }
  throw new Error(`Could not find the migrated local D1 database in ${directory}`)
}

async function readPrimaryGuildId(config: string): Promise<string | null> {
  const text = await Bun.file(resolve(botRoot, config)).text()
  return /["']ALLOWED_DISCORD_GUILD_ID["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? null
}

function readIntegerFlag(args: string[], name: string, fallback: number, maximum = 200): number {
  const raw = readStringFlag(args, name)
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  return value
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot persist non-finite public rating: ${value}`)
  return String(value)
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}
