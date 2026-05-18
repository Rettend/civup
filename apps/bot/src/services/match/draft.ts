import type { Database } from '@civup/db'
import type { DraftState, GameMode } from '@civup/game'
import type { ActivateDraftInput, ActivateDraftResult, CancelDraftInput, CancelDraftResult, CreateDraftMatchInput, ParticipantRow } from './types.ts'
import { matchBans, matches, matchParticipants, players } from '@civup/db'
import { isRedDeathFormatId } from '@civup/game'
import { and, eq } from 'drizzle-orm'
import { getActiveSeason } from '../season/index.ts'

const MATCH_PARTICIPANT_INSERT_COLUMN_COUNT = 9
const D1_MAX_SQL_VARIABLES = 100

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
  else if (existingMatch.status === 'cancelled') {
    await db.delete(matchBans).where(eq(matchBans.matchId, input.matchId))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, input.matchId))
    await db
      .update(matches)
      .set({
        gameMode: input.mode,
        status: 'drafting',
        seasonId: activeSeason?.id ?? null,
        draftData: null,
        createdAt: now,
        completedAt: null,
      })
      .where(eq(matches.id, input.matchId))
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
    const participantValues = input.seats.map(seat => ({
      matchId: input.matchId,
      playerId: seat.playerId,
      team: seat.team ?? null,
      civId: null,
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    }))

    for (const chunk of splitValuesForD1InsertLimit(participantValues, MATCH_PARTICIPANT_INSERT_COLUMN_COUNT)) {
      await db.insert(matchParticipants).values(chunk)
    }
  }
}

export function splitValuesForD1InsertLimit<T>(values: T[], columnCount: number, maxVariables: number = D1_MAX_SQL_VARIABLES): T[][] {
  if (values.length === 0) return []
  if (!Number.isInteger(columnCount) || columnCount <= 0) return [values]

  const maxRowsPerInsert = Math.max(1, Math.floor(maxVariables / columnCount))
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += maxRowsPerInsert) {
    chunks.push(values.slice(index, index + maxRowsPerInsert))
  }
  return chunks
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
  const permanentAlly = isPermanentAllyFfaDraft(match.gameMode as GameMode, input.state, input.permanentAlly)
  const draftData = JSON.stringify({
    completedAt: input.completedAt,
    hostId: input.hostId,
    mapVoteResult: input.mapVoteResult ?? null,
    redDeath: isRedDeathFormatId(input.state.formatId),
    permanentAlly,
    hiddenDraft: input.hiddenDraft === true,
    state: input.state,
  })

  if (match.status === 'active') {
    for (const participant of participantRows) {
      const nextCivId = civByPlayer.get(participant.playerId) ?? null
      if (participant.civId === nextCivId) continue

      await db
        .update(matchParticipants)
        .set({ civId: nextCivId })
        .where(
          and(
            eq(matchParticipants.matchId, matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )
    }

    await db
      .update(matches)
      .set({ draftData })
      .where(eq(matches.id, matchId))

    return {
      alreadyActive: true,
      match: {
        ...match,
        draftData,
      },
      participants: participantRows.map(participant => ({
        ...participant,
        civId: civByPlayer.get(participant.playerId) ?? null,
      })),
    }
  }

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
      draftData,
    })
    .where(eq(matches.id, matchId))

  return {
    alreadyActive: false,
    match: {
      ...match,
      status: 'active',
      draftData,
    },
    participants: participantRows.map(participant => ({
      ...participant,
      civId: civByPlayer.get(participant.playerId) ?? null,
    })),
  }
}

export async function cancelDraftMatch(
  db: Database,
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

  if ((match.status === 'active' && input.allowActive !== true) || match.status === 'completed') {
    return { error: `Match **${matchId}** cannot be cancelled (status: ${match.status}).` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  if (participantRows.length === 0) {
    return { error: `Match **${matchId}** has no participants.` }
  }

  if (match.status === 'cancelled') {
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
        mapVoteResult: input.mapVoteResult ?? null,
        redDeath: isRedDeathFormatId(input.state.formatId),
        permanentAlly: isPermanentAllyFfaDraft(match.gameMode as GameMode, input.state, input.permanentAlly),
        hiddenDraft: input.hiddenDraft === true,
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

function isPermanentAllyFfaDraft(gameMode: GameMode, state: DraftState, permanentAlly?: boolean): boolean {
  return gameMode === 'ffa' && !isRedDeathFormatId(state.formatId) && permanentAlly === true
}

function mapCivsFromDraftState(
  state: DraftState,
  participantRows: ParticipantRow[],
  gameMode: GameMode,
): Map<string, string | null> {
  const civByPlayer = new Map<string, string | null>()
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
