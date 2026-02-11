import type { Database } from '@civup/db'
import type { DraftCancelReason, DraftSeat, DraftState, GameMode, LeaderboardMode } from '@civup/game'
import type { FfaEntry, TeamInput } from '@civup/rating'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { isTeamMode, toLeaderboardMode } from '@civup/game'
import { calculateRatings, createRating, displayRating, LEADERBOARD_MIN_GAMES } from '@civup/rating'
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from './activity.ts'
import { clearLobbyByMatch } from './lobby.ts'

// ── Types ───────────────────────────────────────────────────

interface MatchRow {
  id: string
  gameMode: string
  status: string
  createdAt: number
  completedAt: number | null
}

interface ParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  leaderboardBeforeRank?: number | null
  leaderboardAfterRank?: number | null
}

interface ReportInput {
  matchId: string
  reporterId: string
  /** For team and 1v1 games: "A" or "B". For FFA: player IDs in placement order, newline-separated. */
  placements: string
}

type ReportResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

interface ResolveMatchInput {
  matchId: string
  placements: string
  resolvedAt: number
}

interface CancelMatchInput {
  matchId: string
  cancelledAt: number
}

interface ModeratedMatchResult {
  match: MatchRow
  participants: ParticipantRow[]
  previousStatus: string
  recalculatedMatchIds: string[]
}

type ResolveMatchResult = ModeratedMatchResult | { error: string }
type CancelMatchResult = ModeratedMatchResult | { error: string }

interface CreateDraftMatchInput {
  matchId: string
  mode: GameMode
  seats: DraftSeat[]
}

interface ActivateDraftInput {
  state: DraftState
  completedAt: number
  hostId: string
}

type ActivateDraftResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

interface CancelDraftInput {
  state: DraftState
  cancelledAt: number
  reason: DraftCancelReason
  hostId: string
}

type CancelDraftResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

interface PruneMatchesOptions {
  staleDraftingMs?: number
  staleActiveMs?: number
  staleCancelledMs?: number
}

interface PruneMatchesResult {
  removedMatchIds: string[]
}

function getHostIdFromDraftData(draftData: string | null): string | null {
  if (!draftData) return null
  try {
    const parsed = JSON.parse(draftData) as {
      hostId?: string
      state?: {
        seats?: Array<{ playerId?: string }>
      }
    }
    if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
      return parsed.hostId
    }
    const hostId = parsed.state?.seats?.[0]?.playerId
    return typeof hostId === 'string' && hostId.length > 0 ? hostId : null
  }
  catch {
    return null
  }
}

// ── Draft lifecycle: create DB rows when queue pops ───────────

export async function createDraftMatch(
  db: Database,
  input: CreateDraftMatchInput,
): Promise<void> {
  const now = Date.now()

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
      createdAt: now,
      completedAt: null,
    })
  }

  const uniquePlayers = new Map<string, DraftSeat>()
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

// ── Draft lifecycle: activate match when draft completes ─────

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

  const playerToSeatIndex = new Map<string, number>()
  input.state.seats.forEach((seat, idx) => {
    playerToSeatIndex.set(seat.playerId, idx)
  })

  const orderedParticipants = [...participantRows].sort((a, b) => {
    const aSeat = playerToSeatIndex.get(a.playerId) ?? Number.MAX_SAFE_INTEGER
    const bSeat = playerToSeatIndex.get(b.playerId) ?? Number.MAX_SAFE_INTEGER
    return aSeat - bSeat
  })

  const civByPlayer = new Map<string, string | null>()
  const gameMode = match.gameMode as GameMode

  if (isTeamMode(gameMode)) {
    const picksByTeam = new Map<number, string[]>()
    for (const pick of input.state.picks) {
      const teamPicks = picksByTeam.get(pick.seatIndex) ?? []
      teamPicks.push(pick.civId)
      picksByTeam.set(pick.seatIndex, teamPicks)
    }

    const teamPickOffsets = new Map<number, number>()
    for (const participant of orderedParticipants) {
      const team = participant.team
      if (team === null) {
        civByPlayer.set(participant.playerId, null)
        continue
      }

      const offset = teamPickOffsets.get(team) ?? 0
      const civId = picksByTeam.get(team)?.[offset] ?? null
      civByPlayer.set(participant.playerId, civId)
      teamPickOffsets.set(team, offset + 1)
    }
  }
  else {
    const pickBySeat = new Map<number, string>()
    for (const pick of input.state.picks) {
      if (!pickBySeat.has(pick.seatIndex)) {
        pickBySeat.set(pick.seatIndex, pick.civId)
      }
    }

    input.state.seats.forEach((seat, seatIndex) => {
      civByPlayer.set(seat.playerId, pickBySeat.get(seatIndex) ?? null)
    })
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
      draftData: JSON.stringify({
        completedAt: input.completedAt,
        hostId: input.hostId,
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

  const gameMode = match.gameMode as GameMode
  const civByPlayer = mapCivsFromDraftState(input.state, participantRows, gameMode)

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
      const teamPicks = picksByTeam.get(pick.seatIndex) ?? []
      teamPicks.push(pick.civId)
      picksByTeam.set(pick.seatIndex, teamPicks)
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

// ── Report a match result ───────────────────────────────────

export async function reportMatch(
  db: Database,
  kv: KVNamespace,
  input: ReportInput,
): Promise<ReportResult> {
  // Fetch the match
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${input.matchId}** not found.` }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  // Verify reporter is a participant
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

  const gameMode = match.gameMode as GameMode

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    // Team and 1v1 games: placements is "A" or "B"
    const winningTeam = input.placements.trim().toUpperCase()
    if (winningTeam !== 'A' && winningTeam !== 'B') {
      return { error: 'For team and 1v1 games, enter "A" or "B" for the winning side.' }
    }

    const winTeamIdx = winningTeam === 'A' ? 0 : 1

    // Set placements: winning team = 1, losing team = 2
    for (const p of participantRows) {
      const placement = p.team === winTeamIdx ? 1 : 2
      await db
        .update(matchParticipants)
        .set({ placement })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, p.playerId),
          ),
        )
    }
  }
  else {
    // FFA: parse placement order from newline-separated player IDs/mentions
    const lines = input.placements
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)

    // Extract player IDs (handle mentions like <@123456>)
    const placementIds = lines.map(l => l.replace(/[<@!>]/g, ''))

    for (let i = 0; i < placementIds.length; i++) {
      const playerId = placementIds[i]!
      await db
        .update(matchParticipants)
        .set({ placement: i + 1 })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, playerId),
          ),
        )
    }

    // Anyone not mentioned gets last place (tied)
    const mentionedIds = new Set(placementIds)
    const unplaced = participantRows.filter(p => !mentionedIds.has(p.playerId))
    const lastPlace = placementIds.length + 1
    for (const p of unplaced) {
      await db
        .update(matchParticipants)
        .set({ placement: lastPlace })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, p.playerId),
          ),
        )
    }
  }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (updatedParticipants.some(p => p.placement === null)) {
    return { error: 'Could not resolve placements for all participants.' }
  }

  const finalized = await finalizeReportedMatch(db, kv, match, updatedParticipants)
  if ('error' in finalized) {
    return finalized
  }

  return finalized
}

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

  const gameMode = toSupportedGameMode(match.gameMode)
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
    participants.map(p => p.playerId),
    channelId ?? undefined,
  )
  await clearLobbyByMatch(kv, input.matchId)

  const leaderboardMode = toLeaderboardMode(gameMode)
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

  return {
    match: updatedMatch!,
    participants: updatedParticipants,
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
    participants.map(p => p.playerId),
    channelId ?? undefined,
  )
  await clearLobbyByMatch(kv, input.matchId)

  let recalculatedMatchIds: string[] = []
  if (previousStatus === 'completed') {
    const gameMode = toSupportedGameMode(match.gameMode)
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

function parseModerationPlacements(
  gameMode: GameMode,
  placements: string,
  participants: ParticipantRow[],
):
  | { placementsByPlayer: Map<string, number> }
  | { error: string } {
  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const winningTeam = placements.trim().toUpperCase()
    if (winningTeam !== 'A' && winningTeam !== 'B') {
      return { error: 'For team and 1v1 games, enter "A" or "B" for the winning side.' }
    }

    const winningTeamIndex = winningTeam === 'A' ? 0 : 1
    const placementsByPlayer = new Map<string, number>()

    for (const participant of participants) {
      const placement = participant.team === winningTeamIndex ? 1 : 2
      placementsByPlayer.set(participant.playerId, placement)
    }

    const hasWinner = [...placementsByPlayer.values()].some(value => value === 1)
    if (!hasWinner) return { error: 'Could not map Team A/Team B for this match. Participant team data is missing.' }

    return { placementsByPlayer }
  }

  const tokens = placements
    .split(/\r?\n|,/)
    .map(token => token.trim())
    .filter(token => token.length > 0)

  if (tokens.length === 0) {
    return { error: 'For FFA resolves, provide at least one player in placement order.' }
  }

  const participantIds = new Set(participants.map(participant => participant.playerId))
  const orderedIds: string[] = []

  for (const token of tokens) {
    const playerId = token.replace(/[<@!>]/g, '')
    if (!participantIds.has(playerId)) {
      return { error: `<@${playerId}> is not part of match **${participants[0]?.matchId ?? 'unknown'}**.` }
    }
    if (orderedIds.includes(playerId)) {
      return { error: `<@${playerId}> appears multiple times in the resolve input.` }
    }
    orderedIds.push(playerId)
  }

  const placementsByPlayer = new Map<string, number>()
  orderedIds.forEach((playerId, index) => {
    placementsByPlayer.set(playerId, index + 1)
  })

  const lastPlace = orderedIds.length + 1
  for (const participant of participants) {
    if (placementsByPlayer.has(participant.playerId)) continue
    placementsByPlayer.set(participant.playerId, lastPlace)
  }

  return { placementsByPlayer }
}

function toSupportedGameMode(mode: string): GameMode | null {
  if (mode === 'ffa' || mode === '1v1' || mode === '2v2' || mode === '3v3') return mode
  return null
}

function leaderboardModesToGameModes(mode: LeaderboardMode): string[] {
  if (mode === 'duel') return ['1v1']
  if (mode === 'teamers') return ['2v2', '3v3']
  return ['ffa']
}

async function recalculateLeaderboardMode(
  db: Database,
  leaderboardMode: LeaderboardMode,
): Promise<{ matchIds: string[] } | { error: string }> {
  const gameModes = leaderboardModesToGameModes(leaderboardMode)
  const completedMatches = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(
      eq(matches.status, 'completed'),
      inArray(matches.gameMode, gameModes),
    ))
    .orderBy(asc(matches.createdAt), asc(matches.id))

  const ratingStateByPlayer = new Map<string, {
    mu: number
    sigma: number
    gamesPlayed: number
    wins: number
    lastPlayedAt: number | null
  }>()

  for (const match of completedMatches) {
    const participantRows = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, match.id))

    if (participantRows.length === 0) return { error: `Completed match **${match.id}** has no participants.` }
    if (participantRows.some(participant => participant.placement == null)) {
      return { error: `Completed match **${match.id}** has missing placements.` }
    }

    const gameMode = toSupportedGameMode(match.gameMode)
    if (!gameMode) return { error: `Completed match **${match.id}** has unsupported game mode: ${match.gameMode}.` }
    let ratingUpdates

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

export async function pruneAbandonedMatches(
  db: Database,
  kv: KVNamespace,
  options: PruneMatchesOptions = {},
): Promise<PruneMatchesResult> {
  const now = Date.now()
  const staleDraftingMs = options.staleDraftingMs ?? 12 * 60 * 60 * 1000
  const staleActiveMs = options.staleActiveMs ?? 36 * 60 * 60 * 1000
  const staleCancelledMs = options.staleCancelledMs ?? 6 * 60 * 60 * 1000

  const staleMatches = await db
    .select({ id: matches.id })
    .from(matches)
    .where(or(
      and(eq(matches.status, 'drafting'), lt(matches.createdAt, now - staleDraftingMs)),
      and(eq(matches.status, 'active'), lt(matches.createdAt, now - staleActiveMs)),
      and(eq(matches.status, 'cancelled'), lt(matches.createdAt, now - staleCancelledMs)),
    ))

  const removedMatchIds: string[] = []

  for (const match of staleMatches) {
    const participants = await db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, match.id))

    const channelId = await getChannelForMatch(kv, match.id)
    await clearActivityMappings(
      kv,
      match.id,
      participants.map(p => p.playerId),
      channelId ?? undefined,
    )

    await clearLobbyByMatch(kv, match.id)
    await db.delete(matchBans).where(eq(matchBans.matchId, match.id))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, match.id))
    await db.delete(matches).where(eq(matches.id, match.id))

    removedMatchIds.push(match.id)
  }

  // Backfill cleanup: completed matches no longer keep draft bans.
  const completedBanRows = await db
    .select({ matchId: matchBans.matchId })
    .from(matchBans)
    .innerJoin(matches, eq(matchBans.matchId, matches.id))
    .where(eq(matches.status, 'completed'))

  const completedBanMatchIds = [...new Set(completedBanRows.map(row => row.matchId))]
  for (const matchId of completedBanMatchIds) {
    await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  }

  // Defensive cleanup for manual DB edits (or any failed partial deletes).
  const orphanParticipantRows = await db
    .select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .leftJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(isNull(matches.id))

  const orphanParticipantMatchIds = [...new Set(orphanParticipantRows.map(row => row.matchId))]
  for (const matchId of orphanParticipantMatchIds) {
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  }

  const orphanBanRows = await db
    .select({ matchId: matchBans.matchId })
    .from(matchBans)
    .leftJoin(matches, eq(matchBans.matchId, matches.id))
    .where(isNull(matches.id))

  const orphanBanMatchIds = [...new Set(orphanBanRows.map(row => row.matchId))]
  for (const matchId of orphanBanMatchIds) {
    await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  }

  return { removedMatchIds }
}

// ── Finalize a reported match and apply ratings ──────────────

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

  // Fetch or create ratings for all participants
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const p of participantRows) {
    const [existing] = await db
      .select()
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.playerId, p.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ),
      )
      .limit(1)

    if (existing) {
      playerRatingMap.set(p.playerId, { mu: existing.mu, sigma: existing.sigma })
    }
    else {
      const fresh = createRating(p.playerId)
      playerRatingMap.set(p.playerId, { mu: fresh.mu, sigma: fresh.sigma })
    }
  }

  // Calculate new ratings
  let ratingUpdates

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    // Group by team
    const teams: Map<number, { playerId: string, mu: number, sigma: number }[]> = new Map()
    for (const p of participantRows) {
      const team = p.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(p.playerId)!
      teams.get(team)!.push({ playerId: p.playerId, mu: rating.mu, sigma: rating.sigma })
    }

    // Sort teams by placement (team with placement=1 first)
    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(p => p.team === a[0])?.placement ?? 99
      const bPlacement = participantRows.find(p => p.team === b[0])?.placement ?? 99
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(p => ({ playerId: p.playerId, mu: p.mu, sigma: p.sigma })),
    }))

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    // FFA
    const ffaEntries: FfaEntry[] = participantRows.map((p) => {
      const rating = playerRatingMap.get(p.playerId)!
      return {
        player: { playerId: p.playerId, mu: rating.mu, sigma: rating.sigma },
        placement: p.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  // Apply rating updates to DB
  const now = Date.now()

  for (const update of ratingUpdates) {
    // Snapshot before/after on the participant row
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

    // Upsert the player rating
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

    const isWin = participantRows.find(p => p.playerId === update.playerId)?.placement === 1

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

    // Ensure player exists in players table
    await db
      .insert(players)
      .values({
        id: update.playerId,
        displayName: update.playerId, // will be updated with real name on next interaction
        createdAt: now,
      })
      .onConflictDoNothing()
  }

  // Mark match as completed
  await db
    .update(matches)
    .set({ status: 'completed', completedAt: now })
    .where(eq(matches.id, matchId))

  // Ban rows are only useful during the draft lifecycle.
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))

  const channelId = await getChannelForMatch(kv, matchId)
  await clearActivityMappings(
    kv,
    matchId,
    participantRows.map(p => p.playerId),
    channelId ?? undefined,
  )

  // Fetch final state
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

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  const participantsWithLeaderboardRanks: ParticipantRow[] = updatedParticipants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankByPlayer.get(participant.playerId) ?? null,
  }))

  return { match: updatedMatch!, participants: participantsWithLeaderboardRanks }
}

interface LeaderboardSnapshotRow {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
}

function buildRankByPlayer(rows: LeaderboardSnapshotRow[]): Map<string, number> {
  const ranked = rows
    .filter(row => row.gamesPlayed >= LEADERBOARD_MIN_GAMES)
    .map(row => ({
      playerId: row.playerId,
      display: displayRating(row.mu, row.sigma),
    }))
    .sort((a, b) => b.display - a.display)

  return new Map(ranked.map((row, index) => [row.playerId, index + 1]))
}
