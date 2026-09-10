import type { Database } from '@civup/db'
import type { RecentQualityEvidence } from '@civup/rating'
import { divisionQualityCredits, divisionQualityDirty, divisionQualityInitializations, divisionRankSources, divisionRankStates, matches, playerRatingEvents, seasonMatchReports } from '@civup/db'
import { addQualityResult, ageQualityEvidence, QUALITY_HALF_LIFE_MS } from '@civup/rating'
import { and, eq, sql } from 'drizzle-orm'
import { runAtomicSeasonBatch } from '../season/report.ts'
import { divisionSourceGuard } from './division-source-guard.ts'
import type { DbBatchItem } from '../db/batch.ts'

export class QualityHistoryDateError extends Error {}

type QualityCredit = RecentQualityEvidence & { matchId: string }
function writeQualityCredits(db: Database, guildId: string, playerId: string, credits: QualityCredit[]) {
  return db.insert(divisionQualityCredits).select(db.select({
    guildId: sql<string>`${guildId}`.as('guild_id'), playerId: sql<string>`${playerId}`.as('player_id'),
    matchId: sql<string>`json_extract(value, '$.matchId')`.as('match_id'), at: sql<number>`json_extract(value, '$.at')`.as('at'),
    effectiveGames: sql<number>`json_extract(value, '$.effectiveGames')`.as('effective_games'),
    highRankWins: sql<number>`json_extract(value, '$.highRankWins')`.as('high_rank_wins'), eliteWins: sql<number>`json_extract(value, '$.eliteWins')`.as('elite_wins'),
  }).from(sql`json_each(${JSON.stringify(credits)})`).where(sql`true`)).onConflictDoUpdate({
    target: [divisionQualityCredits.guildId, divisionQualityCredits.playerId, divisionQualityCredits.matchId],
    set: { at: sql`excluded.at`, effectiveGames: sql`excluded.effective_games`, highRankWins: sql`excluded.high_rank_wins`, eliteWins: sql`excluded.elite_wins` },
  })
}

/** The caller commits these ledger writes with its source revision guard and assignment. */
export async function prepareQualityCheckpoint(db: Database, guildId: string, playerId: string, now: number, previous?: RecentQualityEvidence) {
  let initializedHistory: string | null = null
  if (!previous) {
    const [initialized] = await db.select().from(divisionQualityInitializations).where(and(eq(divisionQualityInitializations.guildId, guildId), eq(divisionQualityInitializations.playerId, playerId))).limit(1)
    if (initialized?.complete) {
      previous = JSON.parse(initialized.recent) as RecentQualityEvidence
      initializedHistory = initialized.recent
    }
    else {
      const [event] = await db.select({ matchId: playerRatingEvents.matchId }).from(playerRatingEvents).where(and(eq(playerRatingEvents.playerId, playerId), eq(playerRatingEvents.mode, 'global'))).limit(1)
      if (event) throw new Error('This player’s quality history is still being prepared.')
      previous = { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
    }
  }
  const dirtyMatch = sql`${playerRatingEvents.matchId} in (select match_id from division_quality_dirty where guild_id = ${guildId} and player_id = ${playerId})`
  const events = await db.select({ matchId: playerRatingEvents.matchId,
    at: sql<number | null>`coalesce(${seasonMatchReports.acceptedAt}, ${playerRatingEvents.matchCompletedAt})`,
    effectiveGames: playerRatingEvents.effectiveGamesDelta, highRankWins: playerRatingEvents.effectiveWinsVsTier2PlusDelta, eliteWins: playerRatingEvents.effectiveWinsVsTier1Delta,
  }).from(playerRatingEvents).innerJoin(matches, eq(matches.id, playerRatingEvents.matchId))
    .leftJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
    .where(and(eq(playerRatingEvents.playerId, playerId), eq(playerRatingEvents.mode, 'global'), eq(matches.status, 'completed'), dirtyMatch))
  const undatedMatchIds = events.filter(event => event.at == null || !Number.isSafeInteger(event.at) || event.at < 0 || event.at > now).map(event => event.matchId)
  if (undatedMatchIds.length) return { recent: previous ?? { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }, undatedMatchIds, queries: [] }
  const old = await db.select().from(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId),
    sql`${divisionQualityCredits.matchId} in (select match_id from division_quality_dirty where guild_id = ${guildId} and player_id = ${playerId})`))
  const recent = ageQualityEvidence(previous, now)
  const normalized = events.map(event => ({ matchId: event.matchId, ...addQualityResult({ at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }, { ...event, at: event.at! }) }))
  for (const [sign, credits] of [[-1, old], [1, normalized]] as const) {
    for (const credit of credits) {
      const weight = 2 ** (-(now - credit.at) / QUALITY_HALF_LIFE_MS)
      for (const key of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) recent[key] += sign * credit[key] * weight
    }
  }
  for (const key of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) {
    if (recent[key] < -1e-7) throw new Error('Quality checkpoint does not match its recorded contributions.')
    recent[key] = Math.max(0, recent[key])
  }
  recent.highRankWins = Math.min(recent.highRankWins, recent.effectiveGames)
  recent.eliteWins = Math.min(recent.eliteWins, recent.highRankWins)
  const byMatch = new Map(old.map(credit => [credit.matchId, credit]))
  const changed = normalized.filter(credit => {
    const previous = byMatch.get(credit.matchId)
    return !previous || (['at', 'effectiveGames', 'highRankWins', 'eliteWins'] as const).some(field => credit[field] !== previous[field])
  })
  const retained = new Set(normalized.map(credit => credit.matchId))
  const removed = old.filter(credit => !retained.has(credit.matchId)).map(credit => credit.matchId)
  const queries: DbBatchItem[] = []
  if (removed.length) queries.push(db.delete(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId),
    sql`${divisionQualityCredits.matchId} in (select value from json_each(${JSON.stringify(removed)}))`)))
  if (changed.length) queries.push(writeQualityCredits(db, guildId, playerId, changed))
  return { recent, undatedMatchIds, queries: [
    ...(initializedHistory ? [divisionSourceGuard(db, sql`exists(select 1 from division_quality_initializations where guild_id=${guildId} and player_id=${playerId} and complete=1 and recent=${initializedHistory})`)] : []),
    ...queries,
    ...(initializedHistory ? [db.delete(divisionQualityInitializations).where(and(eq(divisionQualityInitializations.guildId, guildId), eq(divisionQualityInitializations.playerId, playerId)))] : []),
    db.delete(divisionQualityDirty).where(and(eq(divisionQualityDirty.guildId, guildId), eq(divisionQualityDirty.playerId, playerId)))] }
}

/** Explicit, resumable initialization; live reports never invoke this history walk. */
export async function initializeQualityCheckpointPage(db: Database, guildId: string, playerId: string, now: number) {
  const [assignment] = await db.select({ result: divisionRankStates.resultJson }).from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.playerId, playerId))).limit(1)
  if (assignment?.result && (JSON.parse(assignment.result) as { recent?: RecentQualityEvidence }).recent) return true
  const [stored] = await db.select().from(divisionQualityInitializations).where(and(eq(divisionQualityInitializations.guildId, guildId), eq(divisionQualityInitializations.playerId, playerId))).limit(1)
  if (stored?.complete) return true
  const [source] = await db.select().from(divisionRankSources).where(eq(divisionRankSources.playerId, playerId)).limit(1)
  const revision = source?.revision ?? 0
  const guard = () => divisionSourceGuard(db, sql`not exists(select 1 from rating_mutation_leases) and coalesce((select revision from division_rank_sources where player_id=${playerId}),0)=${revision}
    and (select result_json from division_rank_states where guild_id=${guildId} and player_id=${playerId}) is ${assignment?.result ?? null}
    and (select cursor from division_quality_initializations where guild_id=${guildId} and player_id=${playerId}) is ${stored?.cursor ?? null}
    and (select source_revision from division_quality_initializations where guild_id=${guildId} and player_id=${playerId}) is ${stored?.sourceRevision ?? null}
    and (select recent from division_quality_initializations where guild_id=${guildId} and player_id=${playerId}) is ${stored?.recent ?? null}`)
  // Clear abandoned ledger pages in bounded batches before restarting a changed source.
  if (!stored || stored.resetting || stored.sourceRevision !== revision) {
    const old = await db.select({ matchId: divisionQualityCredits.matchId }).from(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId))).limit(100)
    const value = { guildId, playerId, sourceRevision: revision, cursor: '', recent: JSON.stringify({ at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }), complete: false, resetting: old.length === 100 }
    if (old.length || stored) {
      await runAtomicSeasonBatch(db, [guard(),
        db.delete(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId), sql`${divisionQualityCredits.matchId} in (select value from json_each(${JSON.stringify(old.map(row => row.matchId))}))`)),
        db.insert(divisionQualityInitializations).values(value).onConflictDoUpdate({ target: [divisionQualityInitializations.guildId, divisionQualityInitializations.playerId], set: value }),
      ])
      return false
    }
  }
  const recent: RecentQualityEvidence = stored ? JSON.parse(stored.recent) : { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
  const cursor = stored?.cursor ? JSON.parse(stored.cursor) as [number, number] : null
  if (cursor && (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some(value => !Number.isSafeInteger(value)))) throw new Error('Invalid quality initialization cursor.')
  // The existing player/scope/created-at index also orders equal timestamps by SQLite rowid.
  // Any event rewrite advances the source revision and restarts this unfinished walk.
  const rowId = sql<number>`player_rating_events.rowid`
  // Separate the tied timestamp from later timestamps: SQLite cannot seek on the implicit
  // rowid suffix of this index using a tuple comparison, but can with timestamp equality.
  const page = cursor ? sql`${rowId} in (select rowid from (
    select rowid,match_created_at from player_rating_events where player_id=${playerId} and mode='global' and match_created_at=${cursor[0]} and rowid>${cursor[1]}
    union all
    select rowid,match_created_at from player_rating_events where player_id=${playerId} and mode='global' and match_created_at>${cursor[0]}
    order by match_created_at,rowid limit 100))` : and(eq(playerRatingEvents.playerId, playerId), eq(playerRatingEvents.mode, 'global'))
  const rows = await db.select({ matchId: playerRatingEvents.matchId, status: matches.status, createdAt: playerRatingEvents.matchCreatedAt, rowId,
    at: sql<number | null>`coalesce(${seasonMatchReports.acceptedAt}, ${playerRatingEvents.matchCompletedAt})`,
    effectiveGames: playerRatingEvents.effectiveGamesDelta, highRankWins: playerRatingEvents.effectiveWinsVsTier2PlusDelta, eliteWins: playerRatingEvents.effectiveWinsVsTier1Delta,
  }).from(playerRatingEvents).innerJoin(matches, eq(matches.id, playerRatingEvents.matchId)).leftJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
    .where(page)
    .orderBy(playerRatingEvents.matchCreatedAt, rowId).limit(100)
  const credits = rows.filter(row => row.status === 'completed').map(row => {
    if (row.at == null || !Number.isSafeInteger(row.at) || row.at < 0 || row.at > recent.at) throw new QualityHistoryDateError('Quality evidence has an unverified report date.')
    const credit = addQualityResult({ at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }, { ...row, at: row.at })
    const aged = ageQualityEvidence(credit, recent.at)
    for (const field of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) recent[field] += aged[field]
    return { guildId, playerId, matchId: row.matchId, ...credit }
  })
  const dirtyIds = rows.length < 100
    ? (await db.select({ matchId: divisionQualityDirty.matchId }).from(divisionQualityDirty).where(and(eq(divisionQualityDirty.guildId, guildId), eq(divisionQualityDirty.playerId, playerId))).limit(100)).map(row => row.matchId)
    : rows.map(row => row.matchId)
  const complete = rows.length < 100 && dirtyIds.length < 100
  const queries: DbBatchItem[] = [guard()]
  if (credits.length) queries.push(writeQualityCredits(db, guildId, playerId, credits))
  const last = rows.at(-1)
  if (last && !Number.isSafeInteger(last.rowId)) throw new Error('Quality history has an invalid row identity.')
  const value = { guildId, playerId, sourceRevision: revision, cursor: last ? JSON.stringify([last.createdAt, last.rowId]) : stored?.cursor ?? '', recent: JSON.stringify(recent), complete }
  queries.push(db.insert(divisionQualityInitializations).values(value).onConflictDoUpdate({ target: [divisionQualityInitializations.guildId, divisionQualityInitializations.playerId], set: value }))
  queries.push(db.delete(divisionQualityDirty).where(and(eq(divisionQualityDirty.guildId, guildId), eq(divisionQualityDirty.playerId, playerId),
    sql`${divisionQualityDirty.matchId} in (select value from json_each(${JSON.stringify(dirtyIds)}))`)))
  await runAtomicSeasonBatch(db, queries)
  return complete
}
