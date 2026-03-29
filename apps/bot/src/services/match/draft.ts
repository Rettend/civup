import type { Database } from '@civup/db'
import type { DraftState, GameMode } from '@civup/game'
import type { ActivateDraftInput, ActivateDraftResult, CancelDraftInput, CancelDraftResult, CreateDraftMatchInput, ParticipantRow } from './types.ts'
import { matchBans, matches, matchParticipants, players } from '@civup/db'
import { isRedDeathFormatId, isTeamMode } from '@civup/game'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { getActiveSeason } from '../season/index.ts'

export async function createDraftMatch(
  db: Database,
  input: CreateDraftMatchInput,
): Promise<void> {
  const now = Date.now()
  const activeSeason = await getActiveSeason(db)

  const [existingMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!existingMatch) {
    await db.insert(matches).values({
      id: input.matchId,
      gameMode: input.mode,
      status: 'drafting',
      seasonId: activeSeason?.id ?? null,
      createdAt: now,
      completedAt: null,
    })
  }

  const uniquePlayers = new Map<string, (typeof input.seats)[number]>()
  for (const seat of input.seats) {
    if (!uniquePlayers.has(seat.playerId)) {
      uniquePlayers.set(seat.playerId, seat)
    }
  }

  for (const seat of uniquePlayers.values()) {
    const updateValues: { displayName: string, avatarUrl?: string } = {
      displayName: seat.displayName,
    }
    if (seat.avatarUrl) updateValues.avatarUrl = seat.avatarUrl

    await db
      .insert(players)
      .values({
        id: seat.playerId,
        displayName: seat.displayName,
        avatarUrl: seat.avatarUrl ?? null,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: players.id,
        set: updateValues,
      })
  }

  const [existingParticipant] = await db
    .select({ playerId: matchParticipants.playerId })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))
    .limit(1)

  if (!existingParticipant && input.seats.length > 0) {
    await db.insert(matchParticipants).values(
      input.seats.map(seat => ({
        matchId: input.matchId,
        playerId: seat.playerId,
        team: seat.team ?? null,
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      })),
    )
  }
}

export async function activateDraftMatch(
  db: Database,
  input: ActivateDraftInput,
): Promise<ActivateDraftResult> {
  const matchId = input.state.matchId

  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${matchId}** not found.` }
  }

  if (match.status === 'cancelled' || match.status === 'completed') {
    return { error: `Match **${matchId}** cannot be activated (status: ${match.status}).` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  if (participantRows.length === 0) {
    return { error: `Match **${matchId}** has no participants.` }
  }

  const civByPlayer = mapCivsFromDraftState(input.state, participantRows, match.gameMode as GameMode)

  for (const participant of participantRows) {
    await db
      .update(matchParticipants)
      .set({ civId: civByPlayer.get(participant.playerId) ?? null })
      .where(
        and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ),
      )
  }

  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))

  const banRows = input.state.bans
    .map((ban) => {
      const seat = input.state.seats[ban.seatIndex]
      if (!seat) return null
      return {
        matchId,
        civId: ban.civId,
        bannedBy: seat.playerId,
        phase: ban.stepIndex,
      }
    })
    .filter(row => row !== null)

  if (banRows.length > 0) {
    await db.insert(matchBans).values(banRows)
  }

  await db
    .update(matches)
      .set({
        status: 'active',
        draftData: JSON.stringify({
          completedAt: input.completedAt,
          hostId: input.hostId,
          redDeath: isRedDeathFormatId(input.state.formatId),
          state: input.state,
        }),
      })
    .where(eq(matches.id, matchId))

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return { match: updatedMatch!, participants: updatedParticipants }
}

export async function cancelDraftMatch(
  db: Database,
  kv: KVNamespace,
  input: CancelDraftInput,
): Promise<CancelDraftResult> {
  const matchId = input.state.matchId

  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${matchId}** not found.` }
  }

  if (match.status === 'completed') {
    return { error: `Match **${matchId}** cannot be cancelled (status: completed).` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  if (participantRows.length === 0) {
    return { error: `Match **${matchId}** has no participants.` }
  }

  if (match.status === 'cancelled') {
    const channelId = await getChannelForMatch(kv, matchId)
    await clearActivityMappings(
      kv,
      matchId,
      participantRows.map(p => p.playerId),
      channelId ?? undefined,
    )

    return { match, participants: participantRows }
  }

  const civByPlayer = mapCivsFromDraftState(input.state, participantRows, match.gameMode as GameMode)

  for (const participant of participantRows) {
    await db
      .update(matchParticipants)
      .set({ civId: civByPlayer.get(participant.playerId) ?? null })
      .where(
        and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ),
      )
  }

  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))

  await db
    .update(matches)
      .set({
        status: 'cancelled',
        completedAt: input.cancelledAt,
        draftData: JSON.stringify({
          cancelledAt: input.cancelledAt,
          reason: input.reason,
          hostId: input.hostId,
          redDeath: isRedDeathFormatId(input.state.formatId),
          state: input.state,
        }),
      })
    .where(eq(matches.id, matchId))

  const channelId = await getChannelForMatch(kv, matchId)
  await clearActivityMappings(
    kv,
    matchId,
    participantRows.map(p => p.playerId),
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

  return { match: updatedMatch!, participants: updatedParticipants }
}

function mapCivsFromDraftState(
  state: DraftState,
  participantRows: ParticipantRow[],
  gameMode: GameMode,
): Map<string, string | null> {
  const civByPlayer = new Map<string, string | null>()

  if (isTeamMode(gameMode)) {
    const playerToSeatIndex = new Map<string, number>()
    state.seats.forEach((seat, idx) => {
      playerToSeatIndex.set(seat.playerId, idx)
    })

    const orderedParticipants = [...participantRows].sort((a, b) => {
      const aSeat = playerToSeatIndex.get(a.playerId) ?? Number.MAX_SAFE_INTEGER
      const bSeat = playerToSeatIndex.get(b.playerId) ?? Number.MAX_SAFE_INTEGER
      return aSeat - bSeat
    })

    const picksByTeam = new Map<number, string[]>()
    for (const pick of state.picks) {
      const team = state.seats[pick.seatIndex]?.team
      if (team == null) continue
      const teamPicks = picksByTeam.get(team) ?? []
      teamPicks.push(pick.civId)
      picksByTeam.set(team, teamPicks)
    }

    const teamPickOffsets = new Map<number, number>()
    for (const participant of orderedParticipants) {
      const team = participant.team
      if (team == null) {
        civByPlayer.set(participant.playerId, null)
        continue
      }

      const offset = teamPickOffsets.get(team) ?? 0
      const civId = picksByTeam.get(team)?.[offset] ?? null
      civByPlayer.set(participant.playerId, civId)
      teamPickOffsets.set(team, offset + 1)
    }

    return civByPlayer
  }

  const pickBySeat = new Map<number, string>()
  for (const pick of state.picks) {
    if (!pickBySeat.has(pick.seatIndex)) {
      pickBySeat.set(pick.seatIndex, pick.civId)
    }
  }

  state.seats.forEach((seat, seatIndex) => {
    civByPlayer.set(seat.playerId, pickBySeat.get(seatIndex) ?? null)
  })

  return civByPlayer
}
