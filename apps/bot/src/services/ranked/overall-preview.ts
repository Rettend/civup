import type { Database } from '@civup/db'
import type { OverallModeStanding, RecentQualityEvidence, OverallRankPolicyVersion } from '@civup/rating'
import { matches, playerRatingEvents, playerRatings, seasonMatchReports } from '@civup/db'
import { addQualityResult, OVERALL_RANK_POLICY_VERSION, nextOverallRankChangeAt, nextPublicRatingDisplayChangeAt, resolveOverallRank } from '@civup/rating'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { projectPublicRatingDecay } from '../season/decay.ts'
import { getDisplaySeason } from '../season/index.ts'

/** Read-only candidate policy; deliberately not connected to live role assignment. */
export async function previewOverallDivisionRanks(db: Database, playerIds: readonly string[], now = Date.now(), saved = new Map<string, { recent: RecentQualityEvidence, minimum: number | null, qualityMinimum?: number | null, unchanged: boolean }>(), policyVersion: OverallRankPolicyVersion = OVERALL_RANK_POLICY_VERSION) {
  const ids = [...new Set(playerIds)]
  if (ids.length > 80) throw new Error('Preview at most 80 players per batch.')
  if (ids.length === 0) return []
  const season = await getDisplaySeason(db)
  if (season?.ratingSystem !== 'rp' || !season.publicReadsEnabled) throw new Error('Preview requires an active public rating view.')
  const historyIds = ids.filter(id => !saved.get(id)?.unchanged)
  const [ratings, events] = await Promise.all([
    db.select().from(playerRatings).where(inArray(playerRatings.playerId, ids)),
    historyIds.length ? db.select({ playerId: playerRatingEvents.playerId, matchId: playerRatingEvents.matchId,
      at: sql<number | null>`coalesce(${seasonMatchReports.acceptedAt}, ${playerRatingEvents.matchCompletedAt})`,
      effectiveGames: playerRatingEvents.effectiveGamesDelta, highRankWins: playerRatingEvents.effectiveWinsVsTier2PlusDelta, eliteWins: playerRatingEvents.effectiveWinsVsTier1Delta,
    }).from(playerRatingEvents).innerJoin(matches, eq(matches.id, playerRatingEvents.matchId))
      .leftJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
      .where(and(inArray(playerRatingEvents.playerId, historyIds), eq(playerRatingEvents.mode, 'global'), eq(matches.status, 'completed'))) : Promise.resolve([]),
  ])
  const projected = await projectPublicRatingDecay(db, ratings, now, season)
  return ids.map((playerId) => {
    const rows = projected.filter(row => row.playerId === playerId)
    const global = rows.find(row => row.mode === 'global')
    const modes: OverallModeStanding[] = rows.flatMap(row => row.mode === 'duel' || row.mode === 'duo' || row.mode === 'squad' || row.mode === 'ffa'
      ? row.publicRating == null ? [] : [{ mode: row.mode, rating: row.publicRating, effectiveGames: row.effectiveGames, heldMinimum: row.publicBadge }] : [])
    const history = events.filter(row => row.playerId === playerId)
    const undatedMatchIds = history.filter(row => row.at == null || !Number.isSafeInteger(row.at) || row.at < 0 || row.at > now).map(row => row.matchId)
    const previous = saved.get(playerId)
    let recent: RecentQualityEvidence = previous?.unchanged ? previous.recent : { at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
    for (const event of history.filter(row => !undatedMatchIds.includes(row.matchId)).sort((a, b) => a.at! - b.at! || a.matchId.localeCompare(b.matchId))) {
      recent = addQualityResult(recent, { ...event, at: event.at! })
    }
    const resolved = resolveOverallRank({ policyVersion, modes, recent, lifetimeEliteWins: global?.winsVsTier1 ?? 0, lifetimeHighRankWins: global?.winsVsTier2Plus ?? 0, now,
      previous: previous?.minimum != null ? { policyVersion, minimum: previous.minimum, qualityMinimum: previous.qualityMinimum } : null })
    if (resolved.overallRating != null) {
      const times = rows.filter(row => row.mode !== 'global' && row.publicRating != null).flatMap(row => nextPublicRatingDisplayChangeAt(row.publicRating!, row.publicDecay, now) ?? [])
      resolved.ratingChangeAt = times.length ? Math.min(...times) : null
    }
    return { playerId, currentGlobalRating: global?.publicRating ?? null, undatedMatchIds, nextCheckAt: nextOverallRankChangeAt(resolved), ...resolved }
  })
}
