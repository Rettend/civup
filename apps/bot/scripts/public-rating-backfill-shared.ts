import { calculatePublicRatingUpdateFromStoredEvent, PUBLIC_RATING_START } from '@civup/rating'
import type { Database } from 'bun:sqlite'

export const PUBLIC_RATING_BACKFILL_MODES = ['global', 'duel', 'duo', 'squad', 'ffa', 'red-death'] as const

export interface PublicRatingBackfillEvent {
  statsKey: string
  matchId: string
  playerId: string
  mode: string
  matchCreatedAt: number
  ratingBeforeMu: number
  ratingAfterMu: number
  importedGamesDelta: number
  effectiveGamesDelta: number
  publicRatingBefore?: number | null
  publicRatingAfter?: number | null
}

export interface PublicRatingBackfillEventUpdate {
  statsKey: string
  matchId: string
  playerId: string
  mode: string
  publicRatingBefore: number
  publicRatingAfter: number
}

export interface PublicRatingBackfillSummaryUpdate {
  statsKey: string
  playerId: string
  mode: string
  publicRating: number
}

export interface PublicRatingBackfillResult {
  events: PublicRatingBackfillEventUpdate[]
  summaries: PublicRatingBackfillSummaryUpdate[]
}

/** Replay complete public chains from 900 RP. */
export function calculatePublicRatingBackfill(events: readonly PublicRatingBackfillEvent[]): PublicRatingBackfillResult {
  const eligible = events
    .filter(event => isPublicRatingMode(event.mode))
    .sort(compareBackfillEvents)
  const publicByChain = new Map<string, number>()
  const eventUpdates: PublicRatingBackfillEventUpdate[] = []
  const summaryByChain = new Map<string, PublicRatingBackfillSummaryUpdate>()

  for (const event of eligible) {
    const chain = chainKey(event)
    const before = publicByChain.get(chain) ?? PUBLIC_RATING_START
    const update = calculatePublicRatingUpdateFromStoredEvent({
      priorPublicRating: before,
      hiddenMuBefore: event.ratingBeforeMu,
      hiddenMuAfter: event.ratingAfterMu,
      effectiveGamesDelta: event.effectiveGamesDelta,
      importedGamesDelta: event.importedGamesDelta,
    })
    const identity = {
      statsKey: event.statsKey,
      matchId: event.matchId,
      playerId: event.playerId,
      mode: event.mode,
    }
    const after = update.after
    eventUpdates.push({
      ...identity,
      publicRatingBefore: before,
      publicRatingAfter: after,
    })
    publicByChain.set(chain, after)
    summaryByChain.set(chain, {
      statsKey: event.statsKey,
      playerId: event.playerId,
      mode: event.mode,
      publicRating: after,
    })
  }

  return { events: eventUpdates, summaries: [...summaryByChain.values()] }
}

export function isPublicRatingMode(mode: string): mode is typeof PUBLIC_RATING_BACKFILL_MODES[number] {
  return PUBLIC_RATING_BACKFILL_MODES.includes(mode as typeof PUBLIC_RATING_BACKFILL_MODES[number])
}

/** Persist one calculated batch with bulk staging updates and optional PPL legacy mirroring. */
export function applyPublicRatingBackfillBatch(
  db: Database,
  updates: PublicRatingBackfillResult,
  primaryStatsKey: string | null,
): void {
  db.exec(`create temp table if not exists public_rating_backfill_stage (
    stats_key text not null, match_id text not null, player_id text not null, mode text not null,
    public_rating_before real not null, public_rating_after real not null,
    primary key (stats_key, match_id, player_id, mode)
  )`)
  db.transaction(() => {
    db.exec('delete from public_rating_backfill_stage')
    for (const chunk of chunks(updates.events, 75)) {
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
      db.query(`insert into public_rating_backfill_stage values ${values}`).run(...chunk.flatMap(row => [
        row.statsKey,
        row.matchId,
        row.playerId,
        row.mode,
        row.publicRatingBefore,
        row.publicRatingAfter,
      ]))
    }
    db.exec(`update scoped_player_rating_events as e set
      public_rating_before = (select s.public_rating_before from public_rating_backfill_stage s where s.stats_key = e.stats_key and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode),
      public_rating_after = (select s.public_rating_after from public_rating_backfill_stage s where s.stats_key = e.stats_key and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)
      where exists (select 1 from public_rating_backfill_stage s where s.stats_key = e.stats_key and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)`)
    db.exec(`update scoped_player_ratings as r set public_rating = (
      select s.public_rating_after from public_rating_backfill_stage s
      where s.stats_key = r.stats_key and s.player_id = r.player_id and s.mode = r.mode
      order by s.rowid desc limit 1
    ) where exists (select 1 from public_rating_backfill_stage s where s.stats_key = r.stats_key and s.player_id = r.player_id and s.mode = r.mode)`)

    if (primaryStatsKey) {
      db.query(`update player_rating_events as e set
        public_rating_before = (select s.public_rating_before from public_rating_backfill_stage s where s.stats_key = ? and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode),
        public_rating_after = (select s.public_rating_after from public_rating_backfill_stage s where s.stats_key = ? and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)
        where exists (select 1 from public_rating_backfill_stage s where s.stats_key = ? and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)`).run(primaryStatsKey, primaryStatsKey, primaryStatsKey)
      db.query(`update player_ratings as r set public_rating = (
        select s.public_rating_after from public_rating_backfill_stage s
        where s.stats_key = ? and s.player_id = r.player_id and s.mode = r.mode
        order by s.rowid desc limit 1
      ) where exists (select 1 from public_rating_backfill_stage s where s.stats_key = ? and s.player_id = r.player_id and s.mode = r.mode)`).run(primaryStatsKey, primaryStatsKey)
    }
  })()
}

function compareBackfillEvents(left: PublicRatingBackfillEvent, right: PublicRatingBackfillEvent): number {
  return left.statsKey.localeCompare(right.statsKey)
    || left.playerId.localeCompare(right.playerId)
    || left.mode.localeCompare(right.mode)
    || left.matchCreatedAt - right.matchCreatedAt
    || left.matchId.localeCompare(right.matchId)
}

function chainKey(event: Pick<PublicRatingBackfillEvent, 'statsKey' | 'playerId' | 'mode'>): string {
  return `${event.statsKey}\0${event.playerId}\0${event.mode}`
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}
