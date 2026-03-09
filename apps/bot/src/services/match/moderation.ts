import type { Database } from '@civup/db'
import type { CancelMatchInput, CancelMatchResult, ResolveMatchInput, ResolveMatchResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatings } from '@civup/db'
import { parseGameMode, toLeaderboardMode } from '@civup/game'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { clearLobbyByMatch } from '../lobby/index.ts'
import { parseModerationPlacements } from './placements.ts'
import { buildRankByPlayer, recalculateLeaderboardMode } from './ratings.ts'

export async function resolveMatchByModerator(
  db: Database,
  kv: KVNamespace,
  input: ResolveMatchInput,
): Promise<ResolveMatchResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  if (match.status === 'drafting') {
    return { error: `Match **${input.matchId}** is still drafting and cannot be resolved yet.` }
  }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const gameMode = parseGameMode(match.gameMode)
  if (!gameMode) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
  const parsedPlacements = parseModerationPlacements(gameMode, input.placements, participants)
  if ('error' in parsedPlacements) return parsedPlacements

  for (const participant of participants) {
    const placement = parsedPlacements.placementsByPlayer.get(participant.playerId)
    if (placement == null) return { error: `Failed to resolve placement for <@${participant.playerId}>.` }

    await db
      .update(matchParticipants)
      .set({ placement })
      .where(
        and(
          eq(matchParticipants.matchId, input.matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ),
      )
  }

  const previousStatus = match.status
  await db
    .update(matches)
    .set({ status: 'completed', completedAt: match.completedAt ?? input.resolvedAt })
    .where(eq(matches.id, input.matchId))

  await db.delete(matchBans).where(eq(matchBans.matchId, input.matchId))

  const channelId = await getChannelForMatch(kv, input.matchId)
  await clearActivityMappings(
    kv,
    input.matchId,
    participants.map(participant => participant.playerId),
    channelId ?? undefined,
  )
  await clearLobbyByMatch(kv, input.matchId)

  const leaderboardMode = toLeaderboardMode(gameMode)
  const leaderboardRowsBefore = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
    })
    .from(playerRatings)
    .where(eq(playerRatings.mode, leaderboardMode))
  const beforeRankByPlayer = buildRankByPlayer(leaderboardRowsBefore)
  const recalculated = await recalculateLeaderboardMode(db, leaderboardMode)
  if ('error' in recalculated) return recalculated

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  const leaderboardRowsAfter = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
    })
    .from(playerRatings)
    .where(eq(playerRatings.mode, leaderboardMode))
  const afterRankByPlayer = buildRankByPlayer(leaderboardRowsAfter)
  const leaderboardEligibleCount = afterRankByPlayer.size

  return {
    match: updatedMatch!,
    participants: updatedParticipants.map(participant => ({
      ...participant,
      leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
      leaderboardAfterRank: afterRankByPlayer.get(participant.playerId) ?? null,
      leaderboardEligibleCount,
    })),
    previousStatus,
    recalculatedMatchIds: recalculated.matchIds,
  }
}

export async function cancelMatchByModerator(
  db: Database,
  kv: KVNamespace,
  input: CancelMatchInput,
): Promise<CancelMatchResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const previousStatus = match.status

  await db
    .update(matchParticipants)
    .set({
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, input.matchId))

  await db
    .update(matches)
    .set({
      status: 'cancelled',
      completedAt: match.completedAt ?? input.cancelledAt,
    })
    .where(eq(matches.id, input.matchId))

  await db.delete(matchBans).where(eq(matchBans.matchId, input.matchId))

  const channelId = await getChannelForMatch(kv, input.matchId)
  await clearActivityMappings(
    kv,
    input.matchId,
    participants.map(participant => participant.playerId),
    channelId ?? undefined,
  )
  await clearLobbyByMatch(kv, input.matchId)

  let recalculatedMatchIds: string[] = []
  if (previousStatus === 'completed') {
    const gameMode = parseGameMode(match.gameMode)
    if (!gameMode) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
    const leaderboardMode = toLeaderboardMode(gameMode)
    const recalculated = await recalculateLeaderboardMode(db, leaderboardMode)
    if ('error' in recalculated) return recalculated
    recalculatedMatchIds = recalculated.matchIds
  }

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  return {
    match: updatedMatch!,
    participants: updatedParticipants,
    previousStatus,
    recalculatedMatchIds,
  }
}
