import type { Database } from '@civup/db'
import type { DraftDoublePickMetrics, DraftState, GameMode, LeaderDataVersion } from '@civup/game'
import type { ActivateDraftInput, ActivateDraftResult, CancelDraftInput, CancelDraftResult, CreateDraftMatchInput, ParticipantRow } from './types.ts'
import { matchBans, matches, matchParticipants, players } from '@civup/db'
import { getCivBlitzComponent, isCivBlitzFormatId, isRedDeathFormatId, normalizeAppliedCivLobbySettings, normalizeAvailableLeaderDataVersion } from '@civup/game'
import { and, eq, sql } from 'drizzle-orm'
import { getActiveSeason } from '../season/index.ts'

const MATCH_PARTICIPANT_INSERT_COLUMN_COUNT = 11
const D1_MAX_SQL_VARIABLES = 100
const DISCORD_ID_PATTERN = /^\d{17,20}$/

export async function createDraftMatch(
  db: Database,
  input: CreateDraftMatchInput,
): Promise<void> {
  const now = Date.now()
  if (!DISCORD_ID_PATTERN.test(input.guildId)) throw new Error('Cannot create a match without a valid owning server')
  if (!DISCORD_ID_PATTERN.test(input.primaryGuildId)) throw new Error('Cannot create a match without a valid primary server')
  const activeSeason = input.guildId === input.primaryGuildId ? await getActiveSeason(db) : null
  const initialDraftData = JSON.stringify({ gameSettings: normalizeAppliedCivLobbySettings(input.gameSettings) })

  const [existingMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!existingMatch) {
    await db.insert(matches).values({
      id: input.matchId,
      guildId: input.guildId,
      gameMode: input.mode,
      status: 'drafting',
      seasonId: activeSeason?.id ?? null,
      draftData: initialDraftData,
      createdAt: now,
      completedAt: null,
    })
  }
  else {
    if (existingMatch.guildId !== input.guildId) throw new Error(`Match ${input.matchId} has mismatched owning-server data`)
    if (existingMatch.status !== 'cancelled') return await ensureDraftMatchParticipants(db, input)

    await db.delete(matchBans).where(eq(matchBans.matchId, input.matchId))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, input.matchId))
    await db
      .update(matches)
      .set({
        gameMode: input.mode,
        status: 'drafting',
        seasonId: activeSeason?.id ?? null,
        draftData: initialDraftData,
        createdAt: now,
        completedAt: null,
        draftCompletedAt: null,
        cancelledAt: null,
      })
      .where(eq(matches.id, input.matchId))
  }

  await ensureDraftMatchParticipants(db, input)
}

async function ensureDraftMatchParticipants(db: Database, input: CreateDraftMatchInput): Promise<void> {
  const now = Date.now()
  const existingParticipants = await db
    .select({ playerId: matchParticipants.playerId })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))
  const existingPlayerIds = new Set(existingParticipants.map(participant => participant.playerId))

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

  const participantValues = [...uniquePlayers.values()]
    .filter(seat => !existingPlayerIds.has(seat.playerId))
    .map((seat) => {
      const source = resolveDraftSeatSource(input, seat.sourceGuild?.id)
      return {
        matchId: input.matchId,
        playerId: seat.playerId,
        sourceGuildId: source.guildId,
        sourceKind: source.kind,
        team: seat.team ?? null,
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      }
    })

  for (const chunk of splitValuesForD1InsertLimit(participantValues, MATCH_PARTICIPANT_INSERT_COLUMN_COUNT)) {
    await db.insert(matchParticipants).values(chunk)
  }
}

function resolveDraftSeatSource(input: CreateDraftMatchInput, sourceGuildId: string | undefined): { guildId: string, kind: 'joined' | 'legacy_primary' } {
  if (sourceGuildId && DISCORD_ID_PATTERN.test(sourceGuildId)) return { guildId: sourceGuildId, kind: 'joined' }
  if (input.allowLegacyPrimarySource === true && input.guildId === input.primaryGuildId) return { guildId: input.primaryGuildId, kind: 'legacy_primary' }
  throw new Error('Cannot create a match with missing participant source-server data')
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

  const leaderDataVersion = normalizeAvailableLeaderDataVersion(input.leaderDataVersion)
  const civByPlayer = mapCivsFromDraftState(input.state, leaderDataVersion)
  const teamByPlayer = mapTeamsFromDraftState(input.state)
  const permanentAlly = isPermanentAllyFfaDraft(match.gameMode as GameMode, input.state, input.permanentAlly)
  const doublePickMetrics = normalizeDoublePickMetrics(input.doublePickMetrics)
  const draftData = JSON.stringify({
    completedAt: input.completedAt,
    hostId: input.hostId,
    leaderDataVersion,
    mapVoteResult: input.mapVoteResult ?? null,
    redDeath: isRedDeathFormatId(input.state.formatId),
    civBlitz: isCivBlitzFormatId(input.state.formatId),
    permanentAlly,
    hiddenDraft: input.hiddenDraft === true,
    gameSettings: input.gameSettings,
    ...(doublePickMetrics ? { doublePickMetrics } : {}),
    state: input.state,
  })

  if (match.status === 'active') {
    for (const participant of participantRows) {
      const nextCivId = civByPlayer.get(participant.playerId) ?? null
      const nextTeam = teamByPlayer.get(participant.playerId) ?? null
      if (participant.civId === nextCivId && participant.team === nextTeam) continue

      await db
        .update(matchParticipants)
        .set({ civId: nextCivId, team: nextTeam })
        .where(
          and(
            eq(matchParticipants.matchId, matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )
    }

    await db
      .update(matches)
      .set({
        draftData,
        draftCompletedAt: match.draftCompletedAt ?? input.completedAt,
      })
      .where(eq(matches.id, matchId))

    return {
      alreadyActive: true,
      match: {
        ...match,
        draftData,
        draftCompletedAt: match.draftCompletedAt ?? input.completedAt,
      },
      participants: participantRows.map(participant => ({
        ...participant,
        civId: civByPlayer.get(participant.playerId) ?? null,
        team: teamByPlayer.get(participant.playerId) ?? null,
      })),
    }
  }

  for (const participant of participantRows) {
    await db
      .update(matchParticipants)
      .set({
        civId: civByPlayer.get(participant.playerId) ?? null,
        team: teamByPlayer.get(participant.playerId) ?? null,
      })
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
      draftCompletedAt: input.completedAt,
      cancelledAt: null,
    })
    .where(eq(matches.id, matchId))

  return {
    alreadyActive: false,
    match: {
      ...match,
      status: 'active',
      draftData,
      draftCompletedAt: input.completedAt,
      cancelledAt: null,
    },
    participants: participantRows.map(participant => ({
      ...participant,
      civId: civByPlayer.get(participant.playerId) ?? null,
      team: teamByPlayer.get(participant.playerId) ?? null,
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

  const leaderDataVersion = normalizeAvailableLeaderDataVersion(input.leaderDataVersion)
  const civByPlayer = mapCivsFromDraftState(input.state, leaderDataVersion)
  const teamByPlayer = mapTeamsFromDraftState(input.state)

  if (match.status === 'cancelled') {
    for (const participant of participantRows) {
      const nextCivId = civByPlayer.get(participant.playerId) ?? null
      const nextTeam = teamByPlayer.get(participant.playerId) ?? null
      if (participant.civId === nextCivId && participant.team === nextTeam) continue
      await db
        .update(matchParticipants)
        .set({ civId: nextCivId, team: nextTeam })
        .where(and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.playerId, participant.playerId)))
    }
    return {
      match,
      participants: participantRows.map(participant => ({
        ...participant,
        civId: civByPlayer.get(participant.playerId) ?? null,
        team: teamByPlayer.get(participant.playerId) ?? null,
      })),
    }
  }

  const doublePickMetrics = normalizeDoublePickMetrics(input.doublePickMetrics)

  for (const participant of participantRows) {
    await db
      .update(matchParticipants)
      .set({
        civId: civByPlayer.get(participant.playerId) ?? null,
        team: teamByPlayer.get(participant.playerId) ?? null,
      })
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
      cancelledAt: input.cancelledAt,
      resultRevision: sql`${matches.resultRevision} + 1`,
      draftData: JSON.stringify({
        cancelledAt: input.cancelledAt,
        reason: input.reason,
        hostId: input.hostId,
        leaderDataVersion,
        mapVoteResult: input.mapVoteResult ?? null,
        redDeath: isRedDeathFormatId(input.state.formatId),
        civBlitz: isCivBlitzFormatId(input.state.formatId),
        permanentAlly: isPermanentAllyFfaDraft(match.gameMode as GameMode, input.state, input.permanentAlly),
        hiddenDraft: input.hiddenDraft === true,
        gameSettings: input.gameSettings,
        ...(doublePickMetrics ? { doublePickMetrics } : {}),
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

function normalizeDoublePickMetrics(metrics: DraftDoublePickMetrics | undefined): DraftDoublePickMetrics | null {
  if (!metrics || metrics.groups <= 0) return null
  return {
    groups: Math.max(0, Math.round(metrics.groups)),
    fallbackStarted: Math.max(0, Math.round(metrics.fallbackStarted)),
    fallbackResolved: Math.max(0, Math.round(metrics.fallbackResolved)),
    bothMissedTimeouts: Math.max(0, Math.round(metrics.bothMissedTimeouts)),
    fallbackTimeouts: Math.max(0, Math.round(metrics.fallbackTimeouts)),
  }
}

function mapCivsFromDraftState(
  state: DraftState,
  leaderDataVersion: LeaderDataVersion,
): Map<string, string | null> {
  const civByPlayer = new Map<string, string | null>()
  const pickBySeat = new Map<number, string>()
  for (const pick of state.picks) {
    if (!pickBySeat.has(pick.seatIndex)) {
      pickBySeat.set(pick.seatIndex, pick.civId)
    }
  }

  const civBlitzLeaderBySeat = new Map<number, string>()
  const civBlitzState = state.civBlitz
  if (civBlitzState) {
    for (const [rawSeatIndex, kit] of Object.entries(civBlitzState.lockedKits)) {
      const seatIndex = Number(rawSeatIndex)
      if (!Number.isInteger(seatIndex)) continue
      const leaderAbilityId = kit.leaderAbility
      if (!leaderAbilityId) continue

      const component = getCivBlitzComponent(leaderAbilityId, leaderDataVersion, {
        excludeBbgExpanded: civBlitzState.excludeBbgExpanded,
      })
      if (component?.category === 'leaderAbility') {
        civBlitzLeaderBySeat.set(seatIndex, component.sourceLeaderId)
      }
    }
  }

  state.seats.forEach((seat, seatIndex) => {
    civByPlayer.set(seat.playerId, civBlitzLeaderBySeat.get(seatIndex) ?? pickBySeat.get(seatIndex) ?? null)
  })

  return civByPlayer
}

function mapTeamsFromDraftState(state: DraftState): Map<string, number | null> {
  return new Map(state.seats.map(seat => [seat.playerId, seat.team ?? null]))
}
