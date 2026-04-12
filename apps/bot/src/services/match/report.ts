import type { Database } from '@civup/db'
import type { FfaEntry, TeamInput } from '@civup/rating'
import type { ParticipantRow, ReportInput, ReportResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { isTeamMode } from '@civup/game'
import { calculateRatings, createRating } from '@civup/rating'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { clearTeamLeaderboardModeSnapshots } from '../leaderboard/team-snapshot.ts'
import { getStoredGameModeContext } from './draft-data.ts'
import { parseOrderedParticipantIds, parseOrderedTeamIndexes, resolveWinningTeamIndex } from './placements.ts'
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

  if (match.status === 'completed') {
    return { match, participants: participantRows, idempotent: true }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) {
    return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
  }

  const gameMode = gameContext.mode

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const uniqueTeams = new Set(participantRows.flatMap(participant => participant.team == null ? [] : [participant.team]))
    if (uniqueTeams.size > 2) {
      const parsedTeams = parseOrderedTeamIndexes(input.placements, participantRows)
      if ('error' in parsedTeams) return parsedTeams

      for (let index = 0; index < parsedTeams.orderedTeams.length; index++) {
        const teamIndex = parsedTeams.orderedTeams[index]!
        await db
          .update(matchParticipants)
          .set({ placement: index + 1 })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.team, teamIndex),
            ),
          )
      }

      const remainingTeams = [...uniqueTeams].filter(teamIndex => !parsedTeams.orderedTeams.includes(teamIndex))
      let nextPlacement = parsedTeams.orderedTeams.length + 1
      for (const teamIndex of remainingTeams) {
        await db
          .update(matchParticipants)
          .set({ placement: nextPlacement })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.team, teamIndex),
            ),
          )
        nextPlacement += 1
      }
    }
    else {
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
  match: { id: string, gameMode: string, draftData: string | null },
  participantRows: ParticipantRow[],
): Promise<ReportResult> {
  const matchId = match.id
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${match.id}** has unsupported game mode: ${match.gameMode}.` }

  const gameMode = gameContext.mode
  const leaderboardMode = gameContext.leaderboardMode
  if (leaderboardMode == null) {
    return await finalizeReportedUnrankedMatch(db, kv, match, participantRows)
  }
  const leaderboardSnapshotBefore = await rebuildLeaderboardModeSnapshot(db, kv, leaderboardMode)
  const beforeRankByPlayer = buildRankByPlayer(leaderboardSnapshotBefore.rows, leaderboardMode)
  const leaderboardSnapshotByPlayerId = new Map(
    leaderboardSnapshotBefore.rows.map(row => [row.playerId, row]),
  )
  const placementByPlayerId = new Map(participantRows.map(participant => [participant.playerId, participant.placement]))
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const participant of participantRows) {
    const existing = leaderboardSnapshotByPlayerId.get(participant.playerId)

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

    const existing = leaderboardSnapshotByPlayerId.get(update.playerId)
    const isWin = placementByPlayerId.get(update.playerId) === 1

    await db
      .insert(players)
      .values({
        id: update.playerId,
        displayName: update.playerId,
        createdAt: now,
      })
      .onConflictDoNothing()

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

  const leaderboardSnapshotAfter = await rebuildLeaderboardModeSnapshot(db, kv, leaderboardMode, now)
  if (leaderboardMode === 'duo' || leaderboardMode === 'squad') {
    await clearTeamLeaderboardModeSnapshots(kv, leaderboardMode)
  }
  const afterRankByPlayer = buildRankByPlayer(leaderboardSnapshotAfter.rows, leaderboardMode)
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

async function finalizeReportedUnrankedMatch(
  db: Database,
  kv: KVNamespace,
  match: { id: string },
  participantRows: ParticipantRow[],
): Promise<ReportResult> {
  const matchId = match.id
  const now = Date.now()

  await db
    .update(matchParticipants)
    .set({
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, matchId))

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

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return {
    match: updatedMatch!,
    participants: updatedParticipants.map(participant => ({
      ...participant,
      leaderboardBeforeRank: null,
      leaderboardAfterRank: null,
      leaderboardEligibleCount: null,
    })),
  }
}
