import type { Database } from '@civup/db'
import type { LobbyState } from '../lobby/types.ts'
import { matchParticipants, players, tournamentCutPairings, tournamentMatches, tournamentPlayers, tournaments } from '@civup/db'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'

export type TournamentRematchPolicy = 'allow' | 'warn' | 'block'
export type TournamentStatus = 'qualifier' | 'qualifier_locked' | 'top_cut' | 'completed' | 'cancelled'
export type TournamentStage = 'qualifier' | 'semifinal' | 'final' | 'third_place' | 'tiebreaker'
export type TournamentMatchStatus = 'open' | 'drafting' | 'active' | 'reported' | 'cancelled'

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

export interface TournamentCutResult {
  tournamentId: string
  tournamentName: string
  requestedTopCut: number
  actualTopCut: number
  round: string
  pairings: TournamentCutPairingSnapshot[]
}

export const DEFAULT_TOURNAMENT_MIN_GAMES = 6
export const DEFAULT_TOURNAMENT_TOP_CUT = 8
export const DEFAULT_TOURNAMENT_REMATCH_POLICY: TournamentRematchPolicy = 'warn'
export const TOURNAMENT_SCORING_OPEN_WIN_RATE = 'open_win_rate'

const ACTIVE_TOURNAMENT_STATUSES: TournamentStatus[] = ['qualifier', 'qualifier_locked', 'top_cut']

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
    await upsertTournamentPlayerIdentity(db, identity)
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
  },
): Promise<void> {
  const now = Date.now()
  await db.insert(tournamentMatches).values({
    sessionId: input.sessionId,
    tournamentId: input.tournamentId,
    matchId: null,
    stage: input.stage ?? 'qualifier',
    status: 'open',
    playerOneId: input.hostId,
    playerTwoId: null,
    winnerId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: tournamentMatches.sessionId,
    set: {
      tournamentId: input.tournamentId,
      playerOneId: input.hostId,
      updatedAt: now,
    },
  })
}

export async function updateTournamentMatchRoster(db: Database, sessionId: string, playerIds: readonly string[]): Promise<void> {
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
  await db
    .update(tournamentMatches)
    .set({ matchId, status: 'drafting', updatedAt: Date.now() })
    .where(eq(tournamentMatches.sessionId, sessionId))
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
  if (!tournament || tournament.status !== 'qualifier') return { ok: false, error: 'This tournament is not accepting qualifier matches.' }
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

  const participants = await db
    .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))
  const winner = participants.find(participant => participant.placement === 1)?.playerId ?? null
  const playerIds = participants.map(participant => participant.playerId).sort()
  await db
    .update(tournamentMatches)
    .set({
      matchId,
      status: 'reported',
      playerOneId: playerIds[0] ?? link.playerOneId,
      playerTwoId: playerIds[1] ?? link.playerTwoId,
      winnerId: winner,
      updatedAt: Date.now(),
    })
    .where(eq(tournamentMatches.sessionId, link.sessionId))
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
  if (existingPairings.length > 0) return { error: 'Top cut pairings already exist for this tournament.' }

  const standings = await buildTournamentStandings(db, tournamentId)
  const qualified = standings.filter(row => row.eligible && row.playerId)
  const actualTopCut = Math.min(tournament.topCut, qualified.length)
  const pairedTopCut = actualTopCut - (actualTopCut % 2)
  if (pairedTopCut < 2) return { error: 'At least two eligible linked players are required to create top cut pairings.' }

  const cutRows = qualified.slice(0, pairedTopCut).map((row, index) => ({
    ...row,
    cutSeed: index + 1,
    playerId: row.playerId!,
  }))
  const round = resolveTopCutRound(pairedTopCut)
  const pairings: TournamentCutPairingSnapshot[] = []
  for (let index = 0; index < pairedTopCut / 2; index++) {
    const left = cutRows[index]!
    const right = cutRows[pairedTopCut - 1 - index]!
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
  return 'Tournament rematch warning: these players already have a reported match against each other.'
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
