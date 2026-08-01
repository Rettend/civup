/* eslint-disable no-console */
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { applyPublicRatingBackfillBatch, calculatePublicRatingBackfill, PUBLIC_RATING_BACKFILL_MODES, type PublicRatingBackfillEvent } from './public-rating-backfill-shared.ts'

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
  console.log('Usage: bun scripts/backfill-public-ratings.ts [--execute] [--batch-size N] [--primary-guild-id ID]')
  process.exit(0)
}
const execute = args.includes('--execute')
const batchSize = readIntegerFlag(args, '--batch-size', 50)
const primaryGuildId = readStringFlag(args, '--primary-guild-id') ?? await readPrimaryGuildId()
const primaryStatsKey = primaryGuildId ? `server:${primaryGuildId}` : null
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

async function readPrimaryGuildId(): Promise<string | null> {
  const text = await Bun.file(resolve(botRoot, 'wrangler.jsonc')).text()
  return /["']ALLOWED_DISCORD_GUILD_ID["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? null
}

function readIntegerFlag(args: string[], name: string, fallback: number): number {
  const raw = readStringFlag(args, name)
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new Error(`${name} must be an integer from 1 to 200`)
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
