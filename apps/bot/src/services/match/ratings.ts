import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, TeamInput } from '@civup/rating'
import { matches, matchParticipants, playerRatings, seasons } from '@civup/db'
import { isTeamMode, leaderboardModesToGameModes } from '@civup/game'
import { calculateRatings, createRating, displayRating, LEADERBOARD_MIN_GAMES, seasonReset } from '@civup/rating'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getStoredGameModeContext } from './draft-data.ts'

interface LeaderboardSnapshotRow {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
}

export function buildRankByPlayer(rows: LeaderboardSnapshotRow[]): Map<string, number> {
  const ranked = rows
    .filter(row => row.gamesPlayed >= LEADERBOARD_MIN_GAMES)
    .map(row => ({
      playerId: row.playerId,
      display: displayRating(row.mu, row.sigma),
    }))
    .sort((a, b) => b.display - a.display)

  return new Map(ranked.map((row, index) => [row.playerId, index + 1]))
}

export async function recalculateLeaderboardMode(
  db: Database,
  leaderboardMode: LeaderboardMode,
): Promise<{ matchIds: string[] } | { error: string }> {
  const gameModes = leaderboardModesToGameModes(leaderboardMode)
  const [completedMatches, seasonRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        gameMode: matches.gameMode,
        draftData: matches.draftData,
        createdAt: matches.createdAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(
        eq(matches.status, 'completed'),
        inArray(matches.gameMode, gameModes),
      ))
      .orderBy(asc(matches.createdAt), asc(matches.id)),
    db
      .select({
        id: seasons.id,
        startsAt: seasons.startsAt,
      })
      .from(seasons)
      .orderBy(asc(seasons.startsAt), asc(seasons.id)),
  ])

  const ratingStateByPlayer = new Map<string, {
    mu: number
    sigma: number
    gamesPlayed: number
    wins: number
    lastPlayedAt: number | null
  }>()
  let seasonIndex = 0

  function applySeasonResetsUntil(timestamp: number): void {
    while (seasonIndex < seasonRows.length && seasonRows[seasonIndex]!.startsAt <= timestamp) {
      for (const [playerId, state] of ratingStateByPlayer.entries()) {
        const reset = seasonReset(state.mu, state.sigma)
        ratingStateByPlayer.set(playerId, {
          ...state,
          mu: reset.mu,
          sigma: reset.sigma,
          gamesPlayed: 0,
          wins: 0,
        })
      }

      seasonIndex += 1
    }
  }

  for (const match of completedMatches) {
    applySeasonResetsUntil(match.createdAt)

    const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
    if (!gameContext) return { error: `Completed match **${match.id}** has unsupported game mode: ${match.gameMode}.` }
    if (gameContext.leaderboardMode !== leaderboardMode) continue

    const participantRows = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, match.id))

    if (participantRows.length === 0) return { error: `Completed match **${match.id}** has no participants.` }
    if (participantRows.some(participant => participant.placement == null)) {
      return { error: `Completed match **${match.id}** has missing placements.` }
    }

    let ratingUpdates
    const gameMode = gameContext.mode

    if (isTeamMode(gameMode) || gameMode === '1v1') {
      const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()

      for (const participant of participantRows) {
        const team = participant.team ?? 0
        const existingRating = ratingStateByPlayer.get(participant.playerId)
        const rating = existingRating
          ? { mu: existingRating.mu, sigma: existingRating.sigma }
          : createRating(participant.playerId)

        const teamPlayers = teams.get(team) ?? []
        teamPlayers.push({ playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma })
        teams.set(team, teamPlayers)
      }

      const teamEntries = [...teams.entries()].sort((a, b) => {
        const aPlacement = participantRows.find(participant => participant.team === a[0])?.placement ?? Number.MAX_SAFE_INTEGER
        const bPlacement = participantRows.find(participant => participant.team === b[0])?.placement ?? Number.MAX_SAFE_INTEGER
        return aPlacement - bPlacement
      })

      const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
        players: players.map(player => ({ playerId: player.playerId, mu: player.mu, sigma: player.sigma })),
      }))

      ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
    }
    else {
      const ffaEntries: FfaEntry[] = participantRows.map((participant) => {
        const existingRating = ratingStateByPlayer.get(participant.playerId)
        const rating = existingRating
          ? { mu: existingRating.mu, sigma: existingRating.sigma }
          : createRating(participant.playerId)

        return {
          player: {
            playerId: participant.playerId,
            mu: rating.mu,
            sigma: rating.sigma,
          },
          placement: participant.placement!,
        }
      })

      ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
    }

    const updateByPlayer = new Map(ratingUpdates.map(update => [update.playerId, update]))

    for (const participant of participantRows) {
      const update = updateByPlayer.get(participant.playerId)
      if (!update) return { error: `Failed to recalculate ratings for match **${match.id}**.` }

      await db
        .update(matchParticipants)
        .set({
          ratingBeforeMu: update.before.mu,
          ratingBeforeSigma: update.before.sigma,
          ratingAfterMu: update.after.mu,
          ratingAfterSigma: update.after.sigma,
        })
        .where(
          and(
            eq(matchParticipants.matchId, match.id),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )

      const currentState = ratingStateByPlayer.get(participant.playerId)
      const nextGamesPlayed = (currentState?.gamesPlayed ?? 0) + 1
      const nextWins = (currentState?.wins ?? 0) + (participant.placement === 1 ? 1 : 0)

      ratingStateByPlayer.set(participant.playerId, {
        mu: update.after.mu,
        sigma: update.after.sigma,
        gamesPlayed: nextGamesPlayed,
        wins: nextWins,
        lastPlayedAt: match.completedAt ?? match.createdAt,
      })
    }
  }

  applySeasonResetsUntil(Number.POSITIVE_INFINITY)

  await db.delete(playerRatings).where(eq(playerRatings.mode, leaderboardMode))

  for (const [playerId, state] of ratingStateByPlayer.entries()) {
    await db.insert(playerRatings).values({
      playerId,
      mode: leaderboardMode,
      mu: state.mu,
      sigma: state.sigma,
      gamesPlayed: state.gamesPlayed,
      wins: state.wins,
      lastPlayedAt: state.lastPlayedAt,
    })
  }

  return { matchIds: completedMatches.map(match => match.id) }
}
