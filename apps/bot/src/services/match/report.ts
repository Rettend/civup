import type { Database } from '@civup/db'
import type { FfaEntry, TeamInput } from '@civup/rating'
import type { GameMode } from '@civup/game'
import type { MatchRow, ParticipantRow, ReportInput, ReportResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { isTeamMode, toLeaderboardMode } from '@civup/game'
import { calculateRatings, createRating } from '@civup/rating'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { getHostIdFromDraftData } from './draft-data.ts'
import { parseOrderedParticipantIds, resolveWinningTeamIndex } from './placements.ts'
import { buildRankByPlayer } from './ratings.ts'

export async function reportMatch(
  db: Database,
  kv: KVNamespace,
  input: ReportInput,
): Promise<ReportResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${input.matchId}** not found.` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  const isParticipant = participantRows.some(p => p.playerId === input.reporterId)
  if (!isParticipant) {
    return { error: 'Only match participants can report results.' }
  }

  const hostId = getHostIdFromDraftData(match.draftData)
  if (hostId && input.reporterId !== hostId) {
    return { error: 'Only the match host can report the result.' }
  }

  if (match.status === 'completed') {
    return { match, participants: participantRows, idempotent: true }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  const gameMode = match.gameMode as GameMode

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const resolvedTeam = resolveWinningTeamIndex(input.placements, participantRows)
    if ('error' in resolvedTeam) return resolvedTeam

    const winTeamIdx = resolvedTeam.winningTeamIndex

    for (const participant of participantRows) {
      const placement = participant.team === winTeamIdx ? 1 : 2
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
  }
  else {
    const parsedOrder = parseOrderedParticipantIds(input.placements, participantRows)
    if ('error' in parsedOrder) return parsedOrder
    const placementIds = parsedOrder.orderedIds

    for (let index = 0; index < placementIds.length; index++) {
      const playerId = placementIds[index]!
      await db
        .update(matchParticipants)
        .set({ placement: index + 1 })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, playerId),
          ),
        )
    }

    const mentionedIds = new Set(placementIds)
    const unplaced = participantRows.filter(participant => !mentionedIds.has(participant.playerId))
    const lastPlace = placementIds.length + 1
    for (const participant of unplaced) {
      await db
        .update(matchParticipants)
        .set({ placement: lastPlace })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )
    }
  }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (updatedParticipants.some(participant => participant.placement === null)) {
    return { error: 'Could not resolve placements for all participants.' }
  }

  const finalized = await finalizeReportedMatch(db, kv, match, updatedParticipants)
  if ('error' in finalized) {
    return finalized
  }

  return finalized
}

async function finalizeReportedMatch(
  db: Database,
  kv: KVNamespace,
  match: { id: string, gameMode: string },
  participantRows: ParticipantRow[],
): Promise<ReportResult> {
  const matchId = match.id
  const gameMode = match.gameMode as GameMode
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
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const participant of participantRows) {
    const [existing] = await db
      .select()
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.playerId, participant.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ),
      )
      .limit(1)

    if (existing) {
      playerRatingMap.set(participant.playerId, { mu: existing.mu, sigma: existing.sigma })
    }
    else {
      const fresh = createRating(participant.playerId)
      playerRatingMap.set(participant.playerId, { mu: fresh.mu, sigma: fresh.sigma })
    }
  }

  let ratingUpdates

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()
    for (const participant of participantRows) {
      const team = participant.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(participant.playerId)!
      teams.get(team)!.push({ playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma })
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(participant => participant.team === a[0])?.placement ?? 99
      const bPlacement = participantRows.find(participant => participant.team === b[0])?.placement ?? 99
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(player => ({ playerId: player.playerId, mu: player.mu, sigma: player.sigma })),
    }))

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    const ffaEntries: FfaEntry[] = participantRows.map((participant) => {
      const rating = playerRatingMap.get(participant.playerId)!
      return {
        player: { playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma },
        placement: participant.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  const now = Date.now()

  for (const update of ratingUpdates) {
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
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, update.playerId),
        ),
      )

    const [existing] = await db
      .select()
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.playerId, update.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ),
      )
      .limit(1)

    const isWin = participantRows.find(participant => participant.playerId === update.playerId)?.placement === 1

    if (existing) {
      await db
        .update(playerRatings)
        .set({
          mu: update.after.mu,
          sigma: update.after.sigma,
          gamesPlayed: existing.gamesPlayed + 1,
          wins: existing.wins + (isWin ? 1 : 0),
          lastPlayedAt: now,
        })
        .where(
          and(
            eq(playerRatings.playerId, update.playerId),
            eq(playerRatings.mode, leaderboardMode),
          ),
        )
    }
    else {
      await db.insert(playerRatings).values({
        playerId: update.playerId,
        mode: leaderboardMode,
        mu: update.after.mu,
        sigma: update.after.sigma,
        gamesPlayed: 1,
        wins: isWin ? 1 : 0,
        lastPlayedAt: now,
      })
    }

    await db
      .insert(players)
      .values({
        id: update.playerId,
        displayName: update.playerId,
        createdAt: now,
      })
      .onConflictDoNothing()
  }

  await db
    .update(matches)
    .set({ status: 'completed', completedAt: now })
    .where(eq(matches.id, matchId))

  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))

  const channelId = await getChannelForMatch(kv, matchId)
  await clearActivityMappings(
    kv,
    matchId,
    participantRows.map(participant => participant.playerId),
    channelId ?? undefined,
  )

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

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

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  const participantsWithLeaderboardRanks: ParticipantRow[] = updatedParticipants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankByPlayer.get(participant.playerId) ?? null,
    leaderboardEligibleCount,
  }))

  return { match: updatedMatch!, participants: participantsWithLeaderboardRanks }
}
