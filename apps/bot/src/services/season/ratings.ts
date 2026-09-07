import type { Database } from '@civup/db'
import { matches, matchParticipants, playerRatings, seasonRatingStates, tournamentMatches } from '@civup/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { resolveSeasonSelection } from './selection.ts'
import { SeasonSelectionError } from './selection.ts'
import { getStoredGameModeContext } from '../match/draft-data.ts'

export type SelectedSeason = Awaited<ReturnType<typeof resolveSeasonSelection>>

export async function loadSelectedSeasonRatings(db: Database, selected: SelectedSeason, playerIds: readonly string[]) {
  if (playerIds.length === 0) return []
  const season = selected.season
  if (selected.ratingSeason?.ratingSystem === 'rp' && !selected.ratingSeason.publicReadsEnabled) throw new SeasonSelectionError('Ratings for this season are not ready to display yet.')
  const historical = season != null && !season.active
  const ratings = historical
    ? (await db.select().from(seasonRatingStates).where(and(eq(seasonRatingStates.seasonId, season.id), inArray(seasonRatingStates.playerId, [...playerIds])))).map(row => ({
        ...row,
        gamesPlayed: row.seasonGames,
        wins: row.seasonWins,
        importedGames: row.evidence.importedGames ?? 0,
        effectiveGames: row.evidence.effectiveGames ?? 0,
        winsVsTier1: row.evidence.winsVsTier1 ?? 0,
        winsVsTier2Plus: row.evidence.winsVsTier2Plus ?? 0,
        effectiveWinsVsTier1: row.evidence.effectiveWinsVsTier1 ?? 0,
        effectiveWinsVsTier2Plus: row.evidence.effectiveWinsVsTier2Plus ?? 0,
      }))
    : await db.select().from(playerRatings).where(inArray(playerRatings.playerId, [...playerIds]))
  if (!season && !selected.allTime) return ratings
  const counts = await db.select({
    matchId: matches.id,
    playerId: matchParticipants.playerId,
    placement: matchParticipants.placement,
    gameMode: matches.gameMode,
    draftData: matches.draftData,
  }).from(matchParticipants).innerJoin(matches, eq(matches.id, matchParticipants.matchId)).where(and(
    inArray(matchParticipants.playerId, [...playerIds]),
    eq(matches.status, 'completed'),
    season ? eq(matches.seasonId, season.id) : undefined,
    sql`not exists (select 1 from ${tournamentMatches} where ${tournamentMatches.matchId} = ${matches.id} or ${tournamentMatches.sessionId} = ${matches.id})`,
  ))
  const countByKey = new Map<string, { gamesPlayed: number, wins: number }>()
  const seen = new Set<string>()
  for (const row of counts) {
    const mode = getStoredGameModeContext(row.gameMode, row.draftData)?.leaderboardMode
    const identity = `${row.matchId}:${row.playerId}`
    if (!mode || seen.has(identity)) continue
    seen.add(identity)
    for (const scope of [mode, 'global']) {
      const key = `${row.playerId}:${scope}`
      const count = countByKey.get(key) ?? { gamesPlayed: 0, wins: 0 }
      count.gamesPlayed += 1
      count.wins += row.placement === 1 ? 1 : 0
      countByKey.set(key, count)
    }
  }
  return ratings.map((row) => {
    if (selected.ratingSeason?.ratingSystem === 'rp' && row.publicRating == null) throw new SeasonSelectionError('Public rating data is incomplete; no hidden-rating substitute is shown.')
    const count = countByKey.get(`${row.playerId}:${row.mode}`)
    const lifetimeGamesPlayed = (row as { evidence?: Record<string, number> }).evidence?.gamesPlayed ?? row.gamesPlayed
    return { ...row, lifetimeGamesPlayed, gamesPlayed: Number(count?.gamesPlayed ?? 0), wins: Number(count?.wins ?? 0) }
  })
}
