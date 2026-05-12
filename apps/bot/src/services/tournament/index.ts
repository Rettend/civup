import type { Database } from '@civup/db'
import type { ParticipantRow } from '../match/types.ts'
import type { LobbyState } from '../lobby/types.ts'
import { leaderboardMessageStates, matchParticipants, players, tournamentCutPairings, tournamentMatches, tournamentPlayers, tournaments } from '@civup/db'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { Embed } from 'discord-hono'
import { createChannelMessageWithFile, deleteChannelMessage, editChannelMessageWithFile, isDiscordApiError } from '../discord/index.ts'
import { getSystemChannel } from '../system/channels.ts'
import { renderTournamentLeaderboardPng } from './image.ts'

export type TournamentRematchPolicy = 'allow' | 'warn' | 'block'
export type TournamentStatus = 'qualifier' | 'qualifier_locked' | 'top_cut' | 'completed' | 'cancelled'
export type TournamentStage = 'qualifier' | 'quarterfinal' | 'semifinal' | 'final' | 'third_place' | 'tiebreaker' | 'top_cut'
export type TournamentMatchStatus = 'open' | 'drafting' | 'active' | 'reported' | 'cancelled'
export type TournamentCutPairingStatus = 'scheduled' | 'open' | 'drafting' | 'reported' | 'cancelled'

export interface TournamentIdentity {
  userId: string
  displayName: string
  avatarUrl: string | null
}

export interface CreateTournamentInput {
  name: string
  createdById: string
  minGames?: number | null
  topCut?: number | null
  rematchPolicy?: TournamentRematchPolicy | null
  roleId?: string | null
}

export interface TournamentPlayerImportRow {
  seed: number | null
  displayName: string
  confirmed: boolean
  playerId: string | null
}

export interface TournamentImportResult {
  imported: number
  linked: number
  pending: number
  duplicateDisplayNames: string[]
}

export interface TournamentStandingRow {
  playerId: string | null
  displayName: string
  seed: number | null
  games: number
  wins: number
  losses: number
  winRate: number
  opponentWinRate: number
  eligible: boolean
}

export interface TournamentLobbySnapshot {
  id: string
  name: string
  rematchPolicy: TournamentRematchPolicy
  rematchWarning: string | null
  configLocked: true
}

export interface TournamentCutPairingSnapshot {
  seedOne: number
  seedTwo: number
  playerOneId: string
  playerTwoId: string
  playerOneDisplayName: string
  playerTwoDisplayName: string
}

export interface TournamentOpenLobbyTarget {
  tournamentId: string
  tournamentName: string
  stage: TournamentStage
  cutPairingId: string | null
  playerOneId: string | null
  playerTwoId: string | null
  opponentId: string | null
  opponentDisplayName: string | null
  existingSessionId: string | null
}

export interface TournamentOpponentCardPlayer {
  playerId: string | null
  displayName: string
  avatarUrl: string | null
  rank?: number | null
  seed: number | null
  games: number
  wins: number
  losses: number
  winRate: number
  note?: string
}

export interface TournamentOpponentCardData {
  tournamentName: string
  status: TournamentStatus
  player: TournamentOpponentCardPlayer
  opponents: TournamentOpponentCardPlayer[]
  pairing: {
    round: string
    seedOne: number
    seedTwo: number
    playerOne: TournamentOpponentCardPlayer
    playerTwo: TournamentOpponentCardPlayer
  } | null
}

export interface TournamentCutResult {
  tournamentId: string
  tournamentName: string
  requestedTopCut: number
  actualTopCut: number
  round: string
  pairings: TournamentCutPairingSnapshot[]
}

export interface TournamentLeaderboardImageData {
  tournamentName: string
  status: TournamentStatus
  minGames: number
  standings: Array<TournamentOpponentCardPlayer & { eligible: boolean }>
  pairings: Array<{
    round: string
    seedOne: number
    seedTwo: number
    playerOneDisplayName: string
    playerTwoDisplayName: string
    winnerDisplayName: string | null
  }>
  champion: TournamentOpponentCardPlayer | null
}

export interface TournamentResultImageData {
  tournamentName: string
  stage: TournamentStage
  matchLabel: string
  players: Array<{
    playerId: string
    displayName: string
    avatarUrl: string | null
    civId: string | null
    placement: number | null
  }>
}

export const DEFAULT_TOURNAMENT_MIN_GAMES = 6
export const DEFAULT_TOURNAMENT_TOP_CUT = 8
export const DEFAULT_TOURNAMENT_REMATCH_POLICY: TournamentRematchPolicy = 'warn'
export const TOURNAMENT_SCORING_OPEN_WIN_RATE = 'open_win_rate'

const ACTIVE_TOURNAMENT_STATUSES: TournamentStatus[] = ['qualifier', 'qualifier_locked', 'top_cut']
const ADVANCING_TOP_CUT_ROUNDS = ['quarterfinal', 'semifinal', 'final'] as const

export function isTournamentRematchPolicy(value: unknown): value is TournamentRematchPolicy {
  return value === 'allow' || value === 'warn' || value === 'block'
}

export function normalizeTournamentRematchPolicy(value: unknown): TournamentRematchPolicy | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return isTournamentRematchPolicy(normalized) ? normalized : null
}

export function normalizeTournamentPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    return rounded > 0 ? rounded : fallback
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return fallback
}

export async function createTournament(db: Database, input: CreateTournamentInput) {
  const now = Date.now()
  const tournament = {
    id: nanoid(10),
    name: input.name.trim(),
    mode: '1v1',
    status: 'qualifier' as const,
    scoring: TOURNAMENT_SCORING_OPEN_WIN_RATE,
    rematchPolicy: input.rematchPolicy ?? DEFAULT_TOURNAMENT_REMATCH_POLICY,
    minGames: input.minGames ?? DEFAULT_TOURNAMENT_MIN_GAMES,
    topCut: input.topCut ?? DEFAULT_TOURNAMENT_TOP_CUT,
    roleId: input.roleId?.trim() || null,
    createdById: input.createdById,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(tournaments).values(tournament)
  return tournament
}

export async function updateTournament(db: Database, tournamentId: string, input: {
  name?: string
  minGames?: number
  topCut?: number
  rematchPolicy?: TournamentRematchPolicy
}): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: Date.now() }
  if (input.name != null) set.name = input.name
  if (input.minGames != null) set.minGames = input.minGames
  if (input.topCut != null) set.topCut = input.topCut
  if (input.rematchPolicy != null) set.rematchPolicy = input.rematchPolicy
  await db.update(tournaments).set(set).where(eq(tournaments.id, tournamentId))
}

export async function leaveTournament(
  db: Database,
  tournamentId: string,
  identity: TournamentIdentity,
): Promise<{ ok: true } | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status !== 'qualifier') return { error: 'You can only leave during the qualifier phase.' }

  const [player] = await db
    .select()
    .from(tournamentPlayers)
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.playerId, identity.userId)))
    .limit(1)
  if (!player) return { error: 'You are not linked as a player in this tournament.' }
  if (!player.confirmed) return { error: 'You have already left this tournament.' }

  await db
    .update(tournamentPlayers)
    .set({ confirmed: false, updatedAt: Date.now() })
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.playerId, identity.userId)))
  return { ok: true }
}

export async function getActiveTournament(db: Database) {
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(inArray(tournaments.status, ACTIVE_TOURNAMENT_STATUSES))
    .orderBy(desc(tournaments.updatedAt))
    .limit(1)
  return tournament ?? null
}

export async function getActiveQualifierTournament(db: Database) {
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.status, 'qualifier'))
    .orderBy(desc(tournaments.updatedAt))
    .limit(1)
  return tournament ?? null
}

export async function getTournamentById(db: Database, tournamentId: string) {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1)
  return tournament ?? null
}

export async function parseTournamentPlayersCsv(csv: string): Promise<TournamentPlayerImportRow[] | { error: string }> {
  const rows = parseCsv(csv)
  if (rows.length === 0) return { error: 'CSV is empty.' }
  const header = rows[0]?.map(value => value.trim()) ?? []
  const expected = ['seed', 'display_name', 'confirmed', 'discord_user_id']
  if (expected.some((column, index) => header[index] !== column)) {
    return { error: `CSV header must be: ${expected.join(',')}` }
  }

  const imported: TournamentPlayerImportRow[] = []
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]
    if (!row || row.every(value => value.trim().length === 0)) continue
    const seed = parseOptionalSeed(row[0])
    const displayName = row[1]?.trim() ?? ''
    const confirmed = parseBoolean(row[2])
    const playerId = normalizeDiscordUserId(row[3])
    if (displayName.length === 0) return { error: `Row ${index + 1} is missing display_name.` }
    if (seed === undefined) return { error: `Row ${index + 1} has invalid seed.` }
    if (confirmed == null) return { error: `Row ${index + 1} has invalid confirmed value.` }
    imported.push({ seed, displayName, confirmed, playerId })
  }

  return imported
}

export async function importTournamentPlayersCsv(db: Database, tournamentId: string, csv: string): Promise<TournamentImportResult | { error: string }> {
  const parsed = await parseTournamentPlayersCsv(csv)
  if ('error' in parsed) return parsed

  const normalizedNames = new Map<string, string[]>()
  for (const row of parsed) {
    const key = normalizeIdentityName(row.displayName)
    normalizedNames.set(key, [...(normalizedNames.get(key) ?? []), row.displayName])
  }
  const duplicateDisplayNames = [...normalizedNames.values()]
    .filter(values => values.length > 1)
    .map(values => values[0]!)
  if (duplicateDisplayNames.length > 0) {
    return { error: `Duplicate display names: ${duplicateDisplayNames.join(', ')}` }
  }

  const now = Date.now()
  const linkedRows = parsed.filter(row => row.playerId)
  for (const row of linkedRows) {
    await db.insert(players).values({
      id: row.playerId!,
      displayName: row.displayName,
      avatarUrl: null,
      createdAt: now,
    }).onConflictDoUpdate({
      target: players.id,
      set: { displayName: row.displayName },
    })
  }

  await db.delete(tournamentPlayers).where(eq(tournamentPlayers.tournamentId, tournamentId))
  if (parsed.length > 0) {
    await db.insert(tournamentPlayers).values(parsed.map(row => ({
      tournamentId,
      seed: row.seed,
      playerId: row.playerId,
      displayName: row.displayName,
      avatarUrl: null,
      confirmed: row.confirmed,
      linkedAt: row.playerId ? now : null,
      createdAt: now,
      updatedAt: now,
    })))
  }

  return {
    imported: parsed.length,
    linked: linkedRows.length,
    pending: parsed.length - linkedRows.length,
    duplicateDisplayNames,
  }
}

export async function resolveTournamentPlayerForIdentity(
  db: Database,
  tournamentId: string,
  identity: TournamentIdentity,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const [linked] = await db
    .select()
    .from(tournamentPlayers)
    .where(and(
      eq(tournamentPlayers.tournamentId, tournamentId),
      eq(tournamentPlayers.playerId, identity.userId),
    ))
    .limit(1)
  if (linked) {
    if (!linked.confirmed) return { ok: false, error: 'You have left this tournament.' }
    await upsertTournamentPlayerIdentity(db, identity)
    await db
      .update(tournamentPlayers)
      .set({ displayName: identity.displayName, avatarUrl: identity.avatarUrl ?? linked.avatarUrl, updatedAt: Date.now() })
      .where(and(
        eq(tournamentPlayers.tournamentId, tournamentId),
        eq(tournamentPlayers.playerId, identity.userId),
      ))
    return { ok: true }
  }

  const pendingRows = await db
    .select()
    .from(tournamentPlayers)
    .where(and(
      eq(tournamentPlayers.tournamentId, tournamentId),
      eq(tournamentPlayers.confirmed, true),
    ))
  const identityName = normalizeIdentityName(identity.displayName)
  const matches = pendingRows.filter(row => !row.playerId && normalizeIdentityName(row.displayName) === identityName)
  if (matches.length === 1) {
    await upsertTournamentPlayerIdentity(db, identity)
    await db
      .update(tournamentPlayers)
      .set({
        playerId: identity.userId,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        linkedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(and(
        eq(tournamentPlayers.tournamentId, tournamentId),
        eq(tournamentPlayers.displayName, matches[0]!.displayName),
      ))
    return { ok: true }
  }

  if (matches.length > 1) return { ok: false, error: 'Your tournament entry is ambiguous. Ask an admin to link your Discord ID.' }
  return { ok: false, error: 'You are not linked as a player in the active tournament.' }
}

export async function createTournamentMatchLink(
  db: Database,
  input: {
    tournamentId: string
    sessionId: string
    hostId: string
    stage?: TournamentStage
    cutPairingId?: string | null
    playerOneId?: string | null
    playerTwoId?: string | null
  },
): Promise<void> {
  const now = Date.now()
  await db.insert(tournamentMatches).values({
    sessionId: input.sessionId,
    tournamentId: input.tournamentId,
    matchId: null,
    stage: input.stage ?? 'qualifier',
    status: 'open',
    playerOneId: input.playerOneId ?? input.hostId,
    playerTwoId: input.playerTwoId ?? null,
    winnerId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: tournamentMatches.sessionId,
    set: {
      tournamentId: input.tournamentId,
      stage: input.stage ?? 'qualifier',
      playerOneId: input.playerOneId ?? input.hostId,
      playerTwoId: input.playerTwoId ?? null,
      updatedAt: now,
    },
  })

  if (input.cutPairingId) {
    await db
      .update(tournamentCutPairings)
      .set({ sessionId: input.sessionId, status: 'open', updatedAt: now })
      .where(eq(tournamentCutPairings.id, input.cutPairingId))
  }
}

export async function updateTournamentMatchRoster(db: Database, sessionId: string, playerIds: readonly string[]): Promise<void> {
  const cutPairing = await getTournamentCutPairingBySessionId(db, sessionId)
  if (cutPairing) {
    await db
      .update(tournamentMatches)
      .set({
        playerOneId: cutPairing.playerOneId,
        playerTwoId: cutPairing.playerTwoId,
        updatedAt: Date.now(),
      })
      .where(eq(tournamentMatches.sessionId, sessionId))
    return
  }

  const uniquePlayerIds = [...new Set(playerIds)].slice(0, 2)
  const now = Date.now()
  await db
    .update(tournamentMatches)
    .set({
      playerOneId: uniquePlayerIds[0] ?? null,
      playerTwoId: uniquePlayerIds[1] ?? null,
      updatedAt: now,
    })
    .where(eq(tournamentMatches.sessionId, sessionId))
}

export async function markTournamentMatchDrafting(db: Database, sessionId: string, matchId: string): Promise<void> {
  const now = Date.now()
  await db
    .update(tournamentMatches)
    .set({ matchId, status: 'drafting', updatedAt: now })
    .where(eq(tournamentMatches.sessionId, sessionId))
  await db
    .update(tournamentCutPairings)
    .set({ matchId, status: 'drafting', updatedAt: now })
    .where(eq(tournamentCutPairings.sessionId, sessionId))
}

export async function reopenTournamentMatchAfterDraftCancel(db: Database, sessionId: string): Promise<void> {
  const now = Date.now()
  await db
    .update(tournamentMatches)
    .set({ matchId: null, status: 'open', winnerId: null, updatedAt: now })
    .where(eq(tournamentMatches.sessionId, sessionId))
  await db
    .update(tournamentCutPairings)
    .set({ matchId: null, status: 'open', winnerId: null, updatedAt: now })
    .where(eq(tournamentCutPairings.sessionId, sessionId))
}

export async function getTournamentMatchBySessionId(db: Database, sessionId: string) {
  const [row] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, sessionId)).limit(1)
  return row ?? null
}

export async function getTournamentMatchByMatchId(db: Database, matchId: string) {
  const [row] = await db
    .select()
    .from(tournamentMatches)
    .where(or(eq(tournamentMatches.matchId, matchId), eq(tournamentMatches.sessionId, matchId)))
    .limit(1)
  return row ?? null
}

export async function getTournamentCutPairingBySessionId(db: Database, sessionId: string) {
  const [row] = await db
    .select()
    .from(tournamentCutPairings)
    .where(eq(tournamentCutPairings.sessionId, sessionId))
    .limit(1)
  return row ?? null
}

export async function resolveTournamentOpenLobbyTarget(
  db: Database,
  identity: TournamentIdentity,
): Promise<TournamentOpenLobbyTarget | { error: string }> {
  const tournament = await getActiveTournament(db)
  if (!tournament) return { error: 'No active tournament is accepting lobbies.' }

  const player = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!player.ok) return { error: player.error }

  if (tournament.status === 'qualifier') {
    return {
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      stage: 'qualifier',
      cutPairingId: null,
      playerOneId: identity.userId,
      playerTwoId: null,
      opponentId: null,
      opponentDisplayName: null,
      existingSessionId: null,
    }
  }

  if (tournament.status !== 'top_cut') {
    return { error: `Tournament is ${tournament.status} and is not accepting new lobbies.` }
  }

  const pairing = await getOpenTournamentCutPairingForPlayer(db, tournament.id, identity.userId)
  if (!pairing) return { error: 'No open playoff pairing found for you.' }

  const opponentId = pairing.playerOneId === identity.userId ? pairing.playerTwoId : pairing.playerOneId
  const opponent = opponentId ? await getTournamentPlayerByUserId(db, tournament.id, opponentId) : null
  return {
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    stage: normalizeTournamentStage(pairing.round),
    cutPairingId: pairing.id,
    playerOneId: pairing.playerOneId,
    playerTwoId: pairing.playerTwoId,
    opponentId,
    opponentDisplayName: opponent?.displayName ?? opponentId,
    existingSessionId: pairing.sessionId,
  }
}

export async function buildTournamentReservedSlotLabels(
  db: Database,
  lobby: Pick<LobbyState, 'id' | 'slots'>,
): Promise<(string | null)[]> {
  const pairing = await getTournamentCutPairingBySessionId(db, lobby.id)
  if (!pairing || (pairing.status !== 'scheduled' && pairing.status !== 'open')) return []

  const reservedIds = [pairing.playerOneId, pairing.playerTwoId].filter((playerId): playerId is string => Boolean(playerId))
  const slottedIds = new Set(lobby.slots.filter((playerId): playerId is string => Boolean(playerId)))
  const missingIds = reservedIds.filter(playerId => !slottedIds.has(playerId))
  if (missingIds.length === 0) return []

  const playersById = new Map((await listTournamentPlayersByIds(db, pairing.tournamentId, missingIds)).map(player => [player.playerId, player]))
  const missingLabels = missingIds.map(playerId => playersById.get(playerId)?.displayName ?? playerId)
  const labels: (string | null)[] = Array.from({ length: lobby.slots.length }, () => null)
  let nextMissing = 0
  for (let slot = 0; slot < labels.length; slot++) {
    if (lobby.slots[slot]) continue
    labels[slot] = missingLabels[nextMissing] ?? null
    nextMissing += 1
    if (nextMissing >= missingLabels.length) break
  }
  return labels
}

export async function buildTournamentLobbySnapshot(
  db: Database,
  sessionId: string,
  playerIds: readonly string[],
): Promise<TournamentLobbySnapshot | null> {
  const link = await getTournamentMatchBySessionId(db, sessionId)
  if (!link) return null

  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament) return null

  const rematchPolicy = isTournamentRematchPolicy(tournament.rematchPolicy)
    ? tournament.rematchPolicy
    : DEFAULT_TOURNAMENT_REMATCH_POLICY
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const rematchWarning = rematchPolicy === 'warn' && uniquePlayerIds.length === 2
    ? await buildRematchWarning(db, tournament.id, uniquePlayerIds[0]!, uniquePlayerIds[1]!)
    : null

  return {
    id: tournament.id,
    name: tournament.name,
    rematchPolicy,
    rematchWarning,
    configLocked: true,
  }
}

export async function listOpenTournamentSessionIds(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ sessionId: tournamentMatches.sessionId })
    .from(tournamentMatches)
    .where(inArray(tournamentMatches.status, ['open', 'drafting', 'active']))
  return new Set(rows.map(row => row.sessionId))
}

export async function validateTournamentLobbyJoin(
  db: Database,
  lobby: LobbyState,
  identity: TournamentIdentity,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const link = await getTournamentMatchBySessionId(db, lobby.id)
  if (!link) return { ok: true }
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament) return { ok: false, error: 'Tournament not found.' }

  if (tournament.status === 'top_cut') {
    const pairing = await getTournamentCutPairingBySessionId(db, lobby.id)
    if (!pairing) return { ok: false, error: 'This playoff lobby is missing its pairing.' }
    if (pairing.status !== 'scheduled' && pairing.status !== 'open') return { ok: false, error: 'This playoff pairing is not accepting players.' }
    if (identity.userId !== pairing.playerOneId && identity.userId !== pairing.playerTwoId) {
      return { ok: false, error: 'This playoff lobby is reserved for its paired players.' }
    }
    const player = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
    if (!player.ok) return player
    return { ok: true }
  }

  if (tournament.status !== 'qualifier') return { ok: false, error: 'This tournament is not accepting qualifier matches.' }
  const player = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!player.ok) return player

  if (tournament.rematchPolicy !== 'block') return { ok: true }
  const opponentId = lobby.memberPlayerIds.find(playerId => playerId !== identity.userId) ?? null
  if (!opponentId) return { ok: true }
  const previousMeetings = await countReportedMeetings(db, tournament.id, identity.userId, opponentId)
  if (previousMeetings < 1) return { ok: true }
  return { ok: false, error: 'You already played this opponent in the tournament.' }
}

export async function syncTournamentMatchAfterReport(db: Database, matchId: string): Promise<void> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return

  const cutPairing = await getTournamentCutPairingBySessionId(db, link.sessionId)
  const participants = await db
    .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))
  const winner = participants.find(participant => participant.placement === 1)?.playerId ?? null
  const playerIds = participants.map(participant => participant.playerId).sort()
  const playerOneId = cutPairing?.playerOneId ?? playerIds[0] ?? link.playerOneId
  const playerTwoId = cutPairing?.playerTwoId ?? playerIds[1] ?? link.playerTwoId
  await db
    .update(tournamentMatches)
    .set({
      matchId,
      status: 'reported',
      playerOneId,
      playerTwoId,
      winnerId: winner,
      updatedAt: Date.now(),
    })
    .where(eq(tournamentMatches.sessionId, link.sessionId))

  await db
    .update(tournamentCutPairings)
    .set({ matchId, status: 'reported', winnerId: winner, updatedAt: Date.now() })
    .where(eq(tournamentCutPairings.sessionId, link.sessionId))

  if (cutPairing) await advanceTournamentCutIfRoundComplete(db, link.tournamentId, cutPairing.round)
}

export async function syncTournamentMatchAfterCancel(db: Database, matchId: string): Promise<void> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return

  const cutPairing = await getTournamentCutPairingBySessionId(db, link.sessionId)
  const participants = await db
    .select({ playerId: matchParticipants.playerId })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))
  const playerIds = participants.map(participant => participant.playerId).sort()
  const playerOneId = cutPairing?.playerOneId ?? playerIds[0] ?? link.playerOneId
  const playerTwoId = cutPairing?.playerTwoId ?? playerIds[1] ?? link.playerTwoId

  await db
    .update(tournamentMatches)
    .set({
      matchId: link.matchId ?? matchId,
      status: 'cancelled',
      playerOneId,
      playerTwoId,
      winnerId: null,
      updatedAt: Date.now(),
    })
    .where(eq(tournamentMatches.sessionId, link.sessionId))

  if (cutPairing) {
    await resetTournamentCutPairingAfterCancel(db, cutPairing)
    return
  }

  await db
    .update(tournamentCutPairings)
    .set({ status: 'cancelled', winnerId: null, updatedAt: Date.now() })
    .where(eq(tournamentCutPairings.sessionId, link.sessionId))
}

export async function buildTournamentStandings(db: Database, tournamentId: string): Promise<TournamentStandingRow[]> {
  const tournament = await getTournamentById(db, tournamentId)
  const playerRows = await db
    .select()
    .from(tournamentPlayers)
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.confirmed, true)))
  const matchRows = await db
    .select()
    .from(tournamentMatches)
    .where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.status, 'reported')))

  const statsByPlayerId = new Map<string, { games: number, wins: number, opponentIds: string[] }>()
  for (const row of playerRows) {
    if (!row.playerId) continue
    statsByPlayerId.set(row.playerId, { games: 0, wins: 0, opponentIds: [] })
  }
  for (const row of matchRows) {
    if (!row.playerOneId || !row.playerTwoId) continue
    const left = getOrCreateStats(statsByPlayerId, row.playerOneId)
    const right = getOrCreateStats(statsByPlayerId, row.playerTwoId)
    left.games += 1
    right.games += 1
    left.opponentIds.push(row.playerTwoId)
    right.opponentIds.push(row.playerOneId)
    if (row.winnerId === row.playerOneId) left.wins += 1
    if (row.winnerId === row.playerTwoId) right.wins += 1
  }

  const minGames = tournament?.minGames ?? DEFAULT_TOURNAMENT_MIN_GAMES
  return playerRows.map((player) => {
    const stats = player.playerId ? statsByPlayerId.get(player.playerId) : null
    const games = stats?.games ?? 0
    const wins = stats?.wins ?? 0
    const opponentWinRate = stats && stats.opponentIds.length > 0
      ? stats.opponentIds.reduce((sum, opponentId) => sum + getWinRate(statsByPlayerId.get(opponentId)), 0) / stats.opponentIds.length
      : 0
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      seed: player.seed,
      games,
      wins,
      losses: Math.max(0, games - wins),
      winRate: games > 0 ? wins / games : 0,
      opponentWinRate,
      eligible: games >= minGames,
    }
  }).sort(compareTournamentStandingRows)
}

export async function createTournamentCut(db: Database, tournamentId: string): Promise<TournamentCutResult | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status !== 'qualifier' && tournament.status !== 'qualifier_locked') {
    return { error: `Tournament is already ${tournament.status}.` }
  }

  const existingPairings = await db
    .select({ id: tournamentCutPairings.id })
    .from(tournamentCutPairings)
    .where(eq(tournamentCutPairings.tournamentId, tournamentId))
    .limit(1)
  if (existingPairings.length > 0) return { error: 'Playoff pairings already exist for this tournament.' }

  const standings = await buildTournamentStandings(db, tournamentId)
  const qualified = standings.filter(row => row.eligible && row.playerId)
  const actualTopCut = Math.min(tournament.topCut, qualified.length)
  const pairedTopCut = actualTopCut - (actualTopCut % 2)
  if (pairedTopCut < 2) return { error: 'At least two eligible linked players are required to create playoff pairings.' }

  const cutRows = qualified.slice(0, pairedTopCut).map((row, index) => ({
    ...row,
    cutSeed: index + 1,
    playerId: row.playerId!,
  }))
  const round = resolveTopCutRound(pairedTopCut)
  const cutRowsBySeed = new Map(cutRows.map(row => [row.cutSeed, row]))
  const bracketSeeds = getInitialBracketSeedOrder(pairedTopCut)
  const pairings: TournamentCutPairingSnapshot[] = []
  for (let index = 0; index < bracketSeeds.length; index += 2) {
    const left = cutRowsBySeed.get(bracketSeeds[index]!)!
    const right = cutRowsBySeed.get(bracketSeeds[index + 1]!)!
    pairings.push({
      seedOne: left.cutSeed,
      seedTwo: right.cutSeed,
      playerOneId: left.playerId,
      playerTwoId: right.playerId,
      playerOneDisplayName: left.displayName,
      playerTwoDisplayName: right.displayName,
    })
  }

  const now = Date.now()
  await db.update(tournaments).set({ status: 'top_cut', updatedAt: now }).where(eq(tournaments.id, tournamentId))
  await db.insert(tournamentCutPairings).values(pairings.map(pairing => ({
    id: nanoid(10),
    tournamentId,
    round,
    seedOne: pairing.seedOne,
    seedTwo: pairing.seedTwo,
    playerOneId: pairing.playerOneId,
    playerTwoId: pairing.playerTwoId,
    sessionId: null,
    matchId: null,
    winnerId: null,
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
  })))

  return {
    tournamentId,
    tournamentName: tournament.name,
    requestedTopCut: tournament.topCut,
    actualTopCut: pairedTopCut,
    round,
    pairings,
  }
}

export async function isMatchTournamentLinked(db: Database, matchId: string): Promise<boolean> {
  return (await getTournamentMatchByMatchId(db, matchId)) != null
}

export async function buildTournamentOpponentCardData(
  db: Database,
  identity: TournamentIdentity,
): Promise<TournamentOpponentCardData | { error: string }> {
  const tournament = await getActiveTournament(db)
  if (!tournament) return { error: 'No active tournament.' }

  const resolved = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!resolved.ok) return { error: resolved.error }

  const standings = await buildTournamentStandings(db, tournament.id)
  const playerStanding = standings.find(row => row.playerId === identity.userId)
  if (!playerStanding) return { error: 'You are not linked as a player in the active tournament.' }

  const rankByPlayerId = buildTournamentRankByPlayerId(standings)
  const player = await toOpponentCardPlayer(db, tournament.id, playerStanding, rankByPlayerId.get(identity.userId) ?? null)
  const pairing = tournament.status === 'top_cut'
    ? await buildTopCutOpponentCardPairing(db, tournament.id, identity.userId, standings)
    : null
  const opponents = pairing
    ? []
    : await buildQualifierOpponentRows(db, tournament.id, identity.userId, playerStanding, standings, tournament.minGames, rankByPlayerId)

  return {
    tournamentName: tournament.name,
    status: tournament.status as TournamentStatus,
    player,
    opponents,
    pairing,
  }
}

export async function buildTournamentLeaderboardImageData(
  db: Database,
  tournamentId: string,
  standingsInput?: TournamentStandingRow[],
  pairingsInput?: Array<typeof tournamentCutPairings.$inferSelect>,
): Promise<TournamentLeaderboardImageData | null> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return null

  const standings = standingsInput ?? await buildTournamentStandings(db, tournament.id)
  const pairingRows = pairingsInput ?? await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
  const sortedPairingRows = [...pairingRows].sort(compareCutPairingsForDisplay)
  const playersById = await getTournamentDisplayPlayersById(db, tournament.id, [
    ...standings.flatMap(row => row.playerId ? [row.playerId] : []),
    ...sortedPairingRows.flatMap(row => [row.playerOneId, row.playerTwoId, row.winnerId].filter((id): id is string => Boolean(id))),
  ])
  const imageStandings = await Promise.all(standings.map(async row => ({
    ...await toOpponentCardPlayer(db, tournament.id, row),
    eligible: row.eligible,
  })))
  const championId = sortedPairingRows.find(row => row.round === 'final' && row.status === 'reported' && row.winnerId)?.winnerId ?? null
  const championStanding = championId ? standings.find(row => row.playerId === championId) : null

  return {
    tournamentName: tournament.name,
    status: tournament.status as TournamentStatus,
    minGames: tournament.minGames,
    standings: imageStandings,
    pairings: sortedPairingRows.map(row => ({
      round: row.round,
      seedOne: row.seedOne,
      seedTwo: row.seedTwo,
      playerOneDisplayName: formatTournamentDisplayPlayer(playersById, row.playerOneId),
      playerTwoDisplayName: formatTournamentDisplayPlayer(playersById, row.playerTwoId),
      winnerDisplayName: row.winnerId ? formatTournamentDisplayPlayer(playersById, row.winnerId) : null,
    })),
    champion: championStanding ? await toOpponentCardPlayer(db, tournament.id, championStanding) : null,
  }
}

export async function buildTournamentResultImageData(
  db: Database,
  matchId: string,
  participants: ParticipantRow[],
): Promise<TournamentResultImageData | null> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return null
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament) return null

  const playersById = await getTournamentDisplayPlayersById(db, tournament.id, participants.map(participant => participant.playerId))
  return {
    tournamentName: tournament.name,
    stage: link.stage as TournamentStage,
    matchLabel: formatTournamentMatchLabel(link.stage, link.winnerId),
    players: participants.map(participant => ({
      playerId: participant.playerId,
      displayName: formatTournamentDisplayPlayer(playersById, participant.playerId),
      avatarUrl: playersById.get(participant.playerId)?.avatarUrl ?? null,
      civId: participant.civId,
      placement: participant.placement,
    })),
  }
}

export async function refreshTournamentLeaderboard(db: Database, kv: KVNamespace, token: string): Promise<boolean> {
  const tournament = await getTournamentForLeaderboard(db)
  if (!tournament) return false
  const channelId = await getSystemChannel(kv, 'tournament-leaderboard')
  if (!channelId) return false

  const standings = await buildTournamentStandings(db, tournament.id)
  const pairings = tournament.status === 'top_cut' || tournament.status === 'completed'
    ? await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
    : []
  const imageData = await buildTournamentLeaderboardImageData(db, tournament.id, standings, pairings)
  if (!imageData) return false

  const hasPairings = pairings.length > 0
  const standingsData = hasPairings ? { ...imageData, pairings: [], champion: null } : imageData
  const standingsPng = await renderTournamentLeaderboardPng(standingsData)
  await upsertLeaderboardMessage(db, token, channelId, 'tournament:active', standingsPng, 'tournament-standings.png')

  if (hasPairings) {
    const bracketPng = await renderTournamentLeaderboardPng(imageData)
    await upsertLeaderboardMessage(db, token, channelId, 'tournament:active:bracket', bracketPng, 'tournament-bracket.png')
  } else {
    await deleteLeaderboardMessage(db, token, channelId, 'tournament:active:bracket')
  }

  await deleteStaleTournamentLeaderboardPageMessages(db, token, channelId)
  return true
}

async function upsertTournamentPlayerIdentity(db: Database, identity: TournamentIdentity): Promise<void> {
  await db.insert(players).values({
    id: identity.userId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: players.id,
    set: { displayName: identity.displayName, avatarUrl: identity.avatarUrl },
  })
}

async function getTournamentForLeaderboard(db: Database) {
  const active = await getActiveTournament(db)
  if (active) return active
  const [completed] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.status, 'completed'))
    .orderBy(desc(tournaments.updatedAt))
    .limit(1)
  return completed ?? null
}

async function deleteStaleTournamentLeaderboardPageMessages(db: Database, token: string, channelId: string): Promise<void> {
  for (const scope of ['tournament:active:2', 'tournament:active:3']) {
    const [existing] = await db
      .select()
      .from(leaderboardMessageStates)
      .where(eq(leaderboardMessageStates.scope, scope))
      .limit(1)
    if (!existing) continue

    if (existing.channelId === channelId) {
      try {
        await deleteChannelMessage(token, channelId, existing.messageId)
      }
      catch (error) {
        if (!isDiscordApiError(error, 404)) throw error
      }
    }
    await db.delete(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope))
  }
}

async function upsertLeaderboardMessage(
  db: Database,
  token: string,
  channelId: string,
  scope: string,
  data: Uint8Array,
  filename: string,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(leaderboardMessageStates)
    .where(eq(leaderboardMessageStates.scope, scope))
    .limit(1)

  if (existing?.channelId === channelId) {
    try {
      await editChannelMessageWithFile({
        token,
        channelId,
        messageId: existing.messageId,
        filename,
        contentType: 'image/png',
        data,
      })
      await upsertTournamentLeaderboardMessageState(db, scope, channelId, existing.messageId)
      return
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
    }
  }

  const created = await createChannelMessageWithFile({
    token,
    channelId,
    filename,
    contentType: 'image/png',
    data,
  })
  await upsertTournamentLeaderboardMessageState(db, scope, channelId, created.id)
}

async function deleteLeaderboardMessage(db: Database, token: string, channelId: string, scope: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(leaderboardMessageStates)
    .where(eq(leaderboardMessageStates.scope, scope))
    .limit(1)
  if (!existing) return

  if (existing.channelId === channelId) {
    try {
      await deleteChannelMessage(token, channelId, existing.messageId)
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
    }
  }
  await db.delete(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope))
}

async function getTournamentPlayerByUserId(db: Database, tournamentId: string, playerId: string) {
  const [row] = await db
    .select()
    .from(tournamentPlayers)
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.playerId, playerId)))
    .limit(1)
  return row ?? null
}

async function listTournamentPlayersByIds(db: Database, tournamentId: string, playerIds: readonly string[]) {
  const ids = [...new Set(playerIds.filter(Boolean))]
  if (ids.length === 0) return []
  return db
    .select()
    .from(tournamentPlayers)
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), inArray(tournamentPlayers.playerId, ids)))
}

async function getTournamentDisplayPlayersById(db: Database, tournamentId: string, playerIds: readonly string[]) {
  const ids = [...new Set(playerIds.filter(Boolean))]
  if (ids.length === 0) return new Map<string, { displayName: string, avatarUrl: string | null }>()

  const [tournamentRows, playerRows] = await Promise.all([
    listTournamentPlayersByIds(db, tournamentId, ids),
    db
      .select({ id: players.id, displayName: players.displayName, avatarUrl: players.avatarUrl })
      .from(players)
      .where(inArray(players.id, ids)),
  ])
  const result = new Map<string, { displayName: string, avatarUrl: string | null }>()
  for (const row of playerRows) result.set(row.id, { displayName: row.displayName, avatarUrl: row.avatarUrl })
  for (const row of tournamentRows) {
    if (!row.playerId) continue
    result.set(row.playerId, {
      displayName: row.displayName,
      avatarUrl: row.avatarUrl ?? result.get(row.playerId)?.avatarUrl ?? null,
    })
  }
  return result
}

function formatTournamentDisplayPlayer(playersById: Map<string, { displayName: string, avatarUrl: string | null }>, playerId: string | null): string {
  if (!playerId) return 'TBD'
  return playersById.get(playerId)?.displayName ?? playerId
}

function formatTournamentMatchLabel(stage: string, winnerId: string | null): string {
  const label = stage === 'qualifier' ? 'Qualifier match' : `${stage.replace(/_/g, ' ')} match`
  return winnerId ? `${label} - winner reported` : label
}

async function getOpenTournamentCutPairingForPlayer(db: Database, tournamentId: string, playerId: string) {
  const rows = await db
    .select()
    .from(tournamentCutPairings)
    .where(and(
      eq(tournamentCutPairings.tournamentId, tournamentId),
      inArray(tournamentCutPairings.status, ['scheduled', 'open', 'drafting']),
      or(eq(tournamentCutPairings.playerOneId, playerId), eq(tournamentCutPairings.playerTwoId, playerId)),
    ))
  return rows.sort(compareCutPairingsForLobbyTarget)[0] ?? null
}

function compareCutPairingsForLobbyTarget(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect): number {
  const statusScore = (status: string) => status === 'open' ? 0 : status === 'scheduled' ? 1 : 2
  return statusScore(left.status) - statusScore(right.status)
    || (left.seedOne + left.seedTwo) - (right.seedOne + right.seedTwo)
    || left.id.localeCompare(right.id)
}

function normalizeTournamentStage(round: string): TournamentStage {
  if (round === 'quarterfinal' || round === 'semifinal' || round === 'final' || round === 'third_place' || round === 'tiebreaker') return round
  return 'top_cut'
}

async function advanceTournamentCutIfRoundComplete(db: Database, tournamentId: string, round: string): Promise<void> {
  if (!isAdvancingTopCutRound(round)) return

  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament || tournament.status !== 'top_cut') return

  const currentPairings = await db
    .select()
    .from(tournamentCutPairings)
    .where(and(eq(tournamentCutPairings.tournamentId, tournamentId), eq(tournamentCutPairings.round, round)))
  if (currentPairings.length === 0) return
  if (currentPairings.some(pairing => pairing.status !== 'reported' || !pairing.winnerId)) return

  const nextRound = getNextTopCutRound(round)
  const now = Date.now()
  if (!nextRound) {
    await db
      .update(tournaments)
      .set({ status: 'completed', updatedAt: now })
      .where(eq(tournaments.id, tournamentId))
    return
  }

  const existingNextPairings = await db
    .select({ id: tournamentCutPairings.id })
    .from(tournamentCutPairings)
    .where(and(eq(tournamentCutPairings.tournamentId, tournamentId), eq(tournamentCutPairings.round, nextRound)))
    .limit(1)
  if (existingNextPairings.length > 0) return

  const cutSize = await getTournamentCutSize(db, tournamentId)
  const sortedPairings = [...currentPairings].sort((left, right) => compareCutPairingsByBracketPosition(left, right, cutSize))
  const nextPairings: Array<typeof tournamentCutPairings.$inferInsert> = []
  for (let index = 0; index < sortedPairings.length; index += 2) {
    const leftWinner = getPairingWinner(sortedPairings[index]!)
    const rightWinner = getPairingWinner(sortedPairings[index + 1]!)
    if (!leftWinner || !rightWinner) return
    nextPairings.push({
      id: nanoid(10),
      tournamentId,
      round: nextRound,
      seedOne: leftWinner.seed,
      seedTwo: rightWinner.seed,
      playerOneId: leftWinner.playerId,
      playerTwoId: rightWinner.playerId,
      sessionId: null,
      matchId: null,
      winnerId: null,
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    })
  }
  if (nextPairings.length === 0) return

  await db.insert(tournamentCutPairings).values(nextPairings)
  await db.update(tournaments).set({ updatedAt: now }).where(eq(tournaments.id, tournamentId))
}

async function resetTournamentCutPairingAfterCancel(db: Database, pairing: typeof tournamentCutPairings.$inferSelect): Promise<void> {
  const now = Date.now()
  const nextRound = getNextTopCutRound(pairing.round)
  const downstreamPairings = nextRound
    ? await db
        .select()
        .from(tournamentCutPairings)
        .where(and(eq(tournamentCutPairings.tournamentId, pairing.tournamentId), eq(tournamentCutPairings.round, nextRound)))
    : []

  const canReset = downstreamPairings.every(row => row.status === 'scheduled' && !row.sessionId && !row.matchId)
  if (!canReset) {
    await db
      .update(tournamentCutPairings)
      .set({ status: 'cancelled', winnerId: null, updatedAt: now })
      .where(eq(tournamentCutPairings.id, pairing.id))
    return
  }

  if (downstreamPairings.length > 0 && nextRound) {
    await db
      .delete(tournamentCutPairings)
      .where(and(eq(tournamentCutPairings.tournamentId, pairing.tournamentId), eq(tournamentCutPairings.round, nextRound)))
  }

  await db
    .update(tournamentCutPairings)
    .set({ sessionId: null, matchId: null, winnerId: null, status: 'scheduled', updatedAt: now })
    .where(eq(tournamentCutPairings.id, pairing.id))

  await db
    .update(tournaments)
    .set({ status: 'top_cut', updatedAt: now })
    .where(eq(tournaments.id, pairing.tournamentId))
}

function isAdvancingTopCutRound(round: string): round is typeof ADVANCING_TOP_CUT_ROUNDS[number] {
  return (ADVANCING_TOP_CUT_ROUNDS as readonly string[]).includes(round)
}

function getNextTopCutRound(round: string): 'semifinal' | 'final' | null {
  if (round === 'quarterfinal') return 'semifinal'
  if (round === 'semifinal') return 'final'
  return null
}

function getPairingWinner(pairing: typeof tournamentCutPairings.$inferSelect): { playerId: string, seed: number } | null {
  if (pairing.winnerId === pairing.playerOneId && pairing.playerOneId) return { playerId: pairing.playerOneId, seed: pairing.seedOne }
  if (pairing.winnerId === pairing.playerTwoId && pairing.playerTwoId) return { playerId: pairing.playerTwoId, seed: pairing.seedTwo }
  return null
}

async function getTournamentCutSize(db: Database, tournamentId: string): Promise<number> {
  const pairings = await db
    .select({ seedOne: tournamentCutPairings.seedOne, seedTwo: tournamentCutPairings.seedTwo })
    .from(tournamentCutPairings)
    .where(eq(tournamentCutPairings.tournamentId, tournamentId))
  return Math.max(0, ...pairings.flatMap(pairing => [pairing.seedOne, pairing.seedTwo]))
}

function compareCutPairingsByBracketPosition(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect, cutSize: number): number {
  const seedOrder = getInitialBracketSeedOrder(cutSize)
  const seedPosition = new Map(seedOrder.map((seed, index) => [seed, index]))
  const leftPosition = Math.min(seedPosition.get(left.seedOne) ?? left.seedOne, seedPosition.get(left.seedTwo) ?? left.seedTwo)
  const rightPosition = Math.min(seedPosition.get(right.seedOne) ?? right.seedOne, seedPosition.get(right.seedTwo) ?? right.seedTwo)
  return leftPosition - rightPosition || left.id.localeCompare(right.id)
}

async function buildQualifierOpponentRows(
  db: Database,
  tournamentId: string,
  playerId: string,
  playerStanding: TournamentStandingRow,
  standings: TournamentStandingRow[],
  minGames: number,
  rankByPlayerId: Map<string, number>,
): Promise<TournamentOpponentCardPlayer[]> {
  const rows = standings.filter(row => row.playerId && row.playerId !== playerId)
  const meetings = await Promise.all(rows.map(row => countReportedMeetings(db, tournamentId, playerId, row.playerId!)))
  const ranked = rows.map((row, index) => ({ row, meetings: meetings[index] ?? 0 }))
    .sort((left, right) => left.meetings - right.meetings || compareTournamentStandingRows(left.row, right.row))
    .slice(0, 8)

  return Promise.all(ranked.map(async (entry) => ({
    ...await toOpponentCardPlayer(db, tournamentId, entry.row, entry.row.playerId ? rankByPlayerId.get(entry.row.playerId) ?? null : null),
    note: buildOpponentRecommendationNote(playerStanding, entry.row, entry.meetings, minGames),
  })))
}

function buildOpponentRecommendationNote(player: TournamentStandingRow, opponent: TournamentStandingRow, meetings: number, minGames: number): string {
  const parts: string[] = []
  if (meetings > 0) parts.push(`rematch x${meetings}`)
  if (opponent.games < minGames) parts.push('needs games')
  if (opponent.wins === player.wins && opponent.losses === player.losses) parts.push('same record')
  else if (Math.abs(opponent.winRate - player.winRate) <= 0.25) parts.push('similar record')
  if (parts.length === 0) parts.push(`${opponent.games} games`)
  return parts.slice(0, 2).join(' - ')
}

async function buildTopCutOpponentCardPairing(
  db: Database,
  tournamentId: string,
  playerId: string,
  standings: TournamentStandingRow[],
): Promise<TournamentOpponentCardData['pairing']> {
  const pairing = await getOpenTournamentCutPairingForPlayer(db, tournamentId, playerId)
  if (!pairing) return null

  const playerOneStanding = standings.find(row => row.playerId === pairing.playerOneId)
  const playerTwoStanding = standings.find(row => row.playerId === pairing.playerTwoId)
  if (!playerOneStanding || !playerTwoStanding) return null
  const rankByPlayerId = buildTournamentRankByPlayerId(standings)

  return {
    round: pairing.round,
    seedOne: pairing.seedOne,
    seedTwo: pairing.seedTwo,
    playerOne: await toOpponentCardPlayer(db, tournamentId, playerOneStanding, getTournamentRank(rankByPlayerId, playerOneStanding.playerId)),
    playerTwo: await toOpponentCardPlayer(db, tournamentId, playerTwoStanding, getTournamentRank(rankByPlayerId, playerTwoStanding.playerId)),
  }
}

async function toOpponentCardPlayer(
  db: Database,
  tournamentId: string,
  row: TournamentStandingRow,
  rank?: number | null,
): Promise<TournamentOpponentCardPlayer> {
  const player = row.playerId ? await getTournamentPlayerByUserId(db, tournamentId, row.playerId) : null
  const [globalPlayer] = row.playerId
    && !player?.avatarUrl
    ? await db.select({ avatarUrl: players.avatarUrl }).from(players).where(eq(players.id, row.playerId)).limit(1)
    : []
  return {
    playerId: row.playerId,
    displayName: row.displayName,
    avatarUrl: player?.avatarUrl ?? globalPlayer?.avatarUrl ?? null,
    rank: rank ?? null,
    seed: row.seed,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    winRate: row.winRate,
  }
}

function buildTournamentRankByPlayerId(standings: TournamentStandingRow[]): Map<string, number> {
  return new Map(standings.flatMap((row, index) => row.playerId ? [[row.playerId, index + 1] as const] : []))
}

function getTournamentRank(rankByPlayerId: Map<string, number>, playerId: string | null): number | null {
  return playerId ? rankByPlayerId.get(playerId) ?? null : null
}

function buildTournamentLeaderboardEmbed(
  tournament: typeof tournaments.$inferSelect,
  standings: TournamentStandingRow[],
  pairings: Array<typeof tournamentCutPairings.$inferSelect>,
): Embed {
  const embed = new Embed()
    .title(tournament.name)
    .color(0xC8AA6E)

  const standingLines = standings.slice(0, 16).map((row, index) => {
    const seed = row.seed ? `#${row.seed} ` : ''
    const record = `${row.wins}-${row.losses}`
    const games = row.eligible ? `${row.games}` : `${row.games}/${tournament.minGames}`
    return `${index + 1}. ${seed}${row.displayName} ${record} (${games})`
  })

  const fields: Array<{ name: string, value: string, inline: boolean }> = [
    { name: tournament.status === 'top_cut' ? 'Playoffs' : 'Standings', value: standingLines.join('\n') || 'No players imported.', inline: false },
  ]

  const finalPairing = pairings.find(pairing => pairing.round === 'final' && pairing.status === 'reported' && pairing.winnerId)
  if (tournament.status === 'completed' && finalPairing?.winnerId) {
    fields.unshift({ name: 'Champion', value: `<@${finalPairing.winnerId}>`, inline: false })
  }

  if (pairings.length > 0) {
    const pairingLines = pairings
      .sort(compareCutPairingsForDisplay)
      .slice(0, 8)
      .map(pairing => `#${pairing.seedOne} <@${pairing.playerOneId}> vs #${pairing.seedTwo} <@${pairing.playerTwoId}>`)
    fields.push({ name: 'Pairings', value: pairingLines.join('\n') || 'No pairings.', inline: false })
  }

  return embed.fields(...fields)
}

function compareCutPairingsForDisplay(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect): number {
  const roundScore = (round: string) => round === 'quarterfinal' ? 0 : round === 'semifinal' ? 1 : round === 'final' ? 2 : 3
  return roundScore(left.round) - roundScore(right.round)
    || left.seedOne - right.seedOne
    || left.id.localeCompare(right.id)
}

async function upsertTournamentLeaderboardMessageState(
  db: Database,
  scope: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await db
    .insert(leaderboardMessageStates)
    .values({ scope, channelId, messageId, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: leaderboardMessageStates.scope,
      set: { channelId, messageId, updatedAt: Date.now() },
    })
}

async function countReportedMeetings(db: Database, tournamentId: string, leftPlayerId: string, rightPlayerId: string): Promise<number> {
  const rows = await db
    .select({ sessionId: tournamentMatches.sessionId })
    .from(tournamentMatches)
    .where(and(
      eq(tournamentMatches.tournamentId, tournamentId),
      eq(tournamentMatches.status, 'reported'),
      or(
        and(eq(tournamentMatches.playerOneId, leftPlayerId), eq(tournamentMatches.playerTwoId, rightPlayerId)),
        and(eq(tournamentMatches.playerOneId, rightPlayerId), eq(tournamentMatches.playerTwoId, leftPlayerId)),
      ),
    ))
  return rows.length
}

async function buildRematchWarning(db: Database, tournamentId: string, leftPlayerId: string, rightPlayerId: string): Promise<string | null> {
  const previousMeetings = await countReportedMeetings(db, tournamentId, leftPlayerId, rightPlayerId)
  if (previousMeetings < 1) return null
  return 'Rematch: these players have already played against each other.'
}

function getOrCreateStats(statsByPlayerId: Map<string, { games: number, wins: number, opponentIds: string[] }>, playerId: string) {
  const existing = statsByPlayerId.get(playerId)
  if (existing) return existing
  const created = { games: 0, wins: 0, opponentIds: [] }
  statsByPlayerId.set(playerId, created)
  return created
}

function getWinRate(stats: { games: number, wins: number } | null | undefined): number {
  if (!stats || stats.games <= 0) return 0
  return stats.wins / stats.games
}

function compareTournamentStandingRows(left: TournamentStandingRow, right: TournamentStandingRow): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  if (left.winRate !== right.winRate) return right.winRate - left.winRate
  if (left.wins !== right.wins) return right.wins - left.wins
  if (left.opponentWinRate !== right.opponentWinRate) return right.opponentWinRate - left.opponentWinRate
  return (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER)
}

function resolveTopCutRound(cutSize: number): string {
  if (cutSize === 2) return 'final'
  if (cutSize === 4) return 'semifinal'
  if (cutSize === 8) return 'quarterfinal'
  return 'top_cut'
}

function getInitialBracketSeedOrder(cutSize: number): number[] {
  if (!isPowerOfTwo(cutSize)) {
    return Array.from({ length: cutSize / 2 }, (_, index) => [index + 1, cutSize - index]).flat()
  }
  let seeds = [1, 2]
  while (seeds.length < cutSize) {
    const size = seeds.length * 2
    seeds = seeds.flatMap(seed => [seed, size + 1 - seed])
  }
  return seeds
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]
    const next = csv[index + 1]
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        index += 1
        continue
      }
      if (char === '"') {
        quoted = false
        continue
      }
      field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\r') continue
    field += char
  }
  row.push(field)
  rows.push(row)
  return rows
}

function parseOptionalSeed(value: string | undefined): number | null | undefined {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false
  return null
}

function normalizeDiscordUserId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  const mention = /^<@!?(\d+)>$/.exec(trimmed)
  const candidate = mention?.[1] ?? trimmed
  return /^\d{16,22}$/.test(candidate) ? candidate : null
}

function normalizeIdentityName(value: string): string {
  return value.trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '')
}
