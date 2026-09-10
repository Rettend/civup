import type { Database } from '@civup/db'
import type { RecentQualityEvidence } from '@civup/rating'
import { divisionQualityCredits, divisionQualityDirty, matches, playerRatingEvents, seasonMatchReports } from '@civup/db'
import { addQualityResult, ageQualityEvidence, QUALITY_HALF_LIFE_MS } from '@civup/rating'
import { and, eq, sql } from 'drizzle-orm'

/** The caller commits these ledger writes with its source revision guard and assignment. */
export async function prepareQualityCheckpoint(db: Database, guildId: string, playerId: string, now: number, previous?: RecentQualityEvidence) {
  const dirtyMatch = sql`${playerRatingEvents.matchId} in (select match_id from division_quality_dirty where guild_id = ${guildId} and player_id = ${playerId})`
  const events = await db.select({ matchId: playerRatingEvents.matchId,
    at: sql<number | null>`coalesce(${seasonMatchReports.acceptedAt}, ${playerRatingEvents.matchCompletedAt})`,
    effectiveGames: playerRatingEvents.effectiveGamesDelta, highRankWins: playerRatingEvents.effectiveWinsVsTier2PlusDelta, eliteWins: playerRatingEvents.effectiveWinsVsTier1Delta,
  }).from(playerRatingEvents).innerJoin(matches, eq(matches.id, playerRatingEvents.matchId))
    .leftJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
    .where(and(eq(playerRatingEvents.playerId, playerId), eq(playerRatingEvents.mode, 'global'), eq(matches.status, 'completed'), previous ? dirtyMatch : undefined))
  const undatedMatchIds = events.filter(event => event.at == null || !Number.isSafeInteger(event.at) || event.at < 0 || event.at > now).map(event => event.matchId)
  if (undatedMatchIds.length) return { recent: previous ?? { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }, undatedMatchIds, queries: [] }
  const old = previous ? await db.select().from(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId),
    sql`${divisionQualityCredits.matchId} in (select match_id from division_quality_dirty where guild_id = ${guildId} and player_id = ${playerId})`)) : []
  const recent = previous ? ageQualityEvidence(previous, now) : { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
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
  const queries = [db.delete(divisionQualityCredits).where(and(eq(divisionQualityCredits.guildId, guildId), eq(divisionQualityCredits.playerId, playerId), previous
    ? sql`${divisionQualityCredits.matchId} in (select match_id from division_quality_dirty where guild_id = ${guildId} and player_id = ${playerId})` : undefined))]
  // JSON keeps large historical rebuilds inside the statement and binding limits.
  const insert = db.insert(divisionQualityCredits).select(db.select({
    guildId: sql<string>`${guildId}`.as('guild_id'), playerId: sql<string>`${playerId}`.as('player_id'),
    matchId: sql<string>`json_extract(value, '$.matchId')`.as('match_id'), at: sql<number>`json_extract(value, '$.at')`.as('at'),
    effectiveGames: sql<number>`json_extract(value, '$.effectiveGames')`.as('effective_games'),
    highRankWins: sql<number>`json_extract(value, '$.highRankWins')`.as('high_rank_wins'), eliteWins: sql<number>`json_extract(value, '$.eliteWins')`.as('elite_wins'),
  }).from(sql`json_each(${JSON.stringify(normalized)})`))
  return { recent, undatedMatchIds, queries: [...queries, insert,
    db.delete(divisionQualityDirty).where(and(eq(divisionQualityDirty.guildId, guildId), eq(divisionQualityDirty.playerId, playerId)))] }
}
