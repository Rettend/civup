import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import type { ParticipantRow } from '../match/types.ts'
import type { SystemChannelScope } from '../system/channels.ts'
import { leaderboardMessageStates, matches, matchParticipants, players, tournamentCutPairings, tournamentEntries, tournamentEntryMembers, tournamentMatches, tournamentPlayers, tournaments } from '@civup/db'
import { defaultPlayerCount, isGameMode, teamSize } from '@civup/game'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { createChannelMessageWithFile, deleteChannelMessage, editChannelMessageWithFile, isDiscordApiError } from '../discord/index.ts'
import { runDbBatch, type DbBatchItem } from '../db/batch.ts'
import { getSystemChannel } from '../system/channels.ts'
import { renderTournamentLeaderboardPng } from './image.ts'

export type TournamentMode = Exclude<GameMode, 'ffa'>
export type TournamentRematchPolicy = 'allow' | 'warn' | 'block'
export type TournamentStatus = 'setup' | 'qualifier' | 'qualifier_locked' | 'top_cut' | 'completed' | 'cancelled'
export type TournamentStage = 'qualifier' | 'quarterfinal' | 'semifinal' | 'final' | 'third_place' | 'tiebreaker' | 'top_cut'
export type TournamentMatchStatus = 'open' | 'drafting' | 'active' | 'reported' | 'cancelled'
export type TournamentCutPairingStatus = 'scheduled' | 'open' | 'drafting' | 'reported' | 'cancelled'

export interface TournamentIdentity {
  userId: string
  displayName: string
  avatarUrl: string | null
  bot?: boolean
}

export interface TournamentEntryMemberSnapshot {
  position: number
  playerId: string | null
  displayName: string
  avatarUrl: string | null
}

export interface TournamentEntrySnapshot {
  entryId: string
  tournamentId: string
  seed: number | null
  status: string
  members: TournamentEntryMemberSnapshot[]
}

export interface CreateTournamentInput {
  name: string
  createdById: string
  mode?: TournamentMode | null
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
  avatarUrl?: string | null
}

export interface TournamentImportResult {
  imported: number
  linked: number
  pending: number
  duplicateDisplayNames: string[]
}

export interface TournamentStandingRow {
  entryId: string
  members: TournamentEntryMemberSnapshot[]
  /** Representative legacy export; competition logic never uses this identity. */
  playerId: string | null
  displayName: string
  avatarUrl: string | null
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
  mode: TournamentMode
  rematchPolicy: TournamentRematchPolicy
  rematchWarning: string | null
  configLocked: true
  rosterLocked: true
  entryRosters: Array<{
    entryId: string
    side: 0 | 1
    members: Array<TournamentEntryMemberSnapshot & { slot: number }>
  }>
}

export interface TournamentCutPairingSnapshot {
  seedOne: number
  seedTwo: number
  entryOneId: string
  entryTwoId: string
  playerOneId: string | null
  playerTwoId: string | null
  playerOneDisplayName: string
  playerTwoDisplayName: string
}

export interface TournamentOpenLobbyTarget {
  tournamentId: string
  tournamentName: string
  mode: TournamentMode
  stage: TournamentStage
  cutPairingId: string | null
  entryOneId: string
  entryTwoId: string | null
  creatorEntry: TournamentEntrySnapshot
  opponentEntry: TournamentEntrySnapshot | null
  opponentDisplayName: string | null
  existingSessionId: string | null
}

export interface TournamentOpponentCardPlayer {
  entryId: string
  members: TournamentEntryMemberSnapshot[]
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

interface BuildTournamentOpponentCardDataOptions {
  autoLink?: boolean
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
    entryOneId: string | null
    entryTwoId: string | null
    playerOneId: string | null
    playerTwoId: string | null
    playerOneDisplayName: string
    playerTwoDisplayName: string
    playerOneAvatarUrl: string | null
    playerTwoAvatarUrl: string | null
    playerOneScore: number
    playerTwoScore: number
    requiredWins: number
    winnerEntryId: string | null
    winnerDisplayName: string | null
  }>
  champion: TournamentOpponentCardPlayer | null
}

export interface TournamentResultImageData {
  tournamentName: string
  stage: TournamentStage
  matchLabel: string
  entries?: Array<{
    entryId: string
    placement: number | null
    members: Array<{
      playerId: string
      displayName: string
      avatarUrl: string | null
      civId: string | null
      placement: number | null
    }>
  }>
  players: Array<{
    entryId: string
    playerId: string
    displayName: string
    avatarUrl: string | null
    civId: string | null
    placement: number | null
  }>
}

export interface TournamentRegistrationResult {
  entry: TournamentEntrySnapshot
  idempotent: boolean
}

export const DEFAULT_TOURNAMENT_MIN_GAMES = 6
export const DEFAULT_TOURNAMENT_TOP_CUT = 8
export const DEFAULT_TOURNAMENT_REMATCH_POLICY: TournamentRematchPolicy = 'warn'
export const TOURNAMENT_SCORING_OPEN_WIN_RATE = 'open_win_rate'
export const SUPPORTED_TOURNAMENT_TOP_CUTS = [2, 4, 8] as const
export const SUPPORTED_TOURNAMENT_MODES = ['1v1', '2v2', '3v3', '4v4', '5v5', '6v6'] as const satisfies readonly TournamentMode[]
export const MAX_TOURNAMENT_ENTRIES = 128
const TOURNAMENT_IMPORT_BATCH_SIZE = 10
const CURRENT_TOURNAMENT_STATUSES: TournamentStatus[] = ['setup', 'qualifier', 'qualifier_locked', 'top_cut']
const ACTIVE_TOURNAMENT_STATUSES: TournamentStatus[] = ['qualifier', 'qualifier_locked', 'top_cut']
const ADVANCING_TOP_CUT_ROUNDS = ['quarterfinal', 'semifinal', 'final'] as const

export function isTournamentMode(value: unknown): value is TournamentMode {
  return typeof value === 'string' && (SUPPORTED_TOURNAMENT_MODES as readonly string[]).includes(value)
}

export function normalizeTournamentMode(value: unknown): TournamentMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return isTournamentMode(normalized) ? normalized : null
}

export function tournamentTeamSize(mode: string): number | null {
  return isTournamentMode(mode) ? teamSize(mode) : null
}

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

export function isSupportedTournamentTopCut(value: number): value is typeof SUPPORTED_TOURNAMENT_TOP_CUTS[number] {
  return (SUPPORTED_TOURNAMENT_TOP_CUTS as readonly number[]).includes(value)
}

export async function createTournament(db: Database, input: CreateTournamentInput) {
  const now = Date.now()
  const topCut = input.topCut ?? DEFAULT_TOURNAMENT_TOP_CUT
  const tournament = {
    id: nanoid(10),
    name: input.name.trim(),
    mode: input.mode ?? '1v1',
    status: 'setup' as const,
    scoring: TOURNAMENT_SCORING_OPEN_WIN_RATE,
    rematchPolicy: input.rematchPolicy ?? DEFAULT_TOURNAMENT_REMATCH_POLICY,
    minGames: input.minGames ?? DEFAULT_TOURNAMENT_MIN_GAMES,
    topCut: isSupportedTournamentTopCut(topCut) ? topCut : DEFAULT_TOURNAMENT_TOP_CUT,
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
  if (input.topCut != null && isSupportedTournamentTopCut(input.topCut)) set.topCut = input.topCut
  if (input.rematchPolicy != null) set.rematchPolicy = input.rematchPolicy
  await db.update(tournaments).set(set).where(eq(tournaments.id, tournamentId))
}

export async function startTournament(db: Database, tournamentId: string): Promise<{ ok: true } | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status !== 'setup') {
    return { error: tournament.status === 'qualifier' ? 'Tournament has already started.' : `Tournament is already ${tournament.status}.` }
  }
  if (!isTournamentMode(tournament.mode)) return { error: `Tournament mode ${tournament.mode} is not supported.` }

  const entries = await listTournamentEntrySnapshots(db, tournamentId, { activeOnly: true })
  if (entries.length > MAX_TOURNAMENT_ENTRIES) return { error: `Tournament entry cap is ${MAX_TOURNAMENT_ENTRIES}.` }
  const requiredSize = tournamentTeamSize(tournament.mode)!
  const invalid = entries.find(entry => entry.members.length !== requiredSize || (requiredSize > 1 && entry.members.some(member => !member.playerId)))
  if (invalid) {
    const roster = formatTournamentEntryName(invalid)
    return { error: requiredSize > 1
      ? `Every ${tournament.mode} entry must have exactly ${requiredSize} linked members. Check ${roster}.`
      : `Every 1v1 entry must have exactly one member. Check ${roster}.` }
  }

  await db.update(tournaments).set({ status: 'qualifier', updatedAt: Date.now() }).where(eq(tournaments.id, tournamentId))
  return { ok: true }
}

export async function registerTournamentEntry(
  db: Database,
  tournamentId: string,
  identities: readonly TournamentIdentity[],
): Promise<TournamentRegistrationResult | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status !== 'setup') return { error: 'Tournament registration is closed.' }
  if (!isTournamentMode(tournament.mode)) return { error: 'Tournament mode is invalid.' }
  const requiredSize = tournamentTeamSize(tournament.mode)!
  if (identities.length !== requiredSize) return { error: `${tournament.mode} registration requires exactly ${requiredSize} player${requiredSize === 1 ? '' : 's'}.` }
  if (identities.some(identity => !identity.userId || !identity.displayName.trim())) return { error: 'Every roster member must resolve to a Discord user.' }
  if (identities.some(identity => identity.bot === true)) return { error: 'Bots cannot register for tournaments.' }
  const uniqueIds = new Set(identities.map(identity => identity.userId))
  if (uniqueIds.size !== identities.length) return { error: 'A roster cannot include the same player more than once.' }

  const memberships = await findActiveTournamentMemberships(db, tournamentId, [...uniqueIds])
  if (memberships.length > 0) {
    const entryIds = new Set(memberships.map(row => row.entryId))
    if (entryIds.size === 1) {
      const existing = await getTournamentEntrySnapshot(db, [...entryIds][0]!)
      if (existing && samePlayerSet(existing.members, [...uniqueIds])) return { entry: existing, idempotent: true }
    }
    const conflicts = identities.filter(identity => memberships.some(row => row.playerId === identity.userId)).map(identity => identity.displayName)
    return { error: `${conflicts.join(', ')} ${conflicts.length === 1 ? 'is' : 'are'} already registered in another active entry.` }
  }

  const activeEntryRows = await db.select({ id: tournamentEntries.id }).from(tournamentEntries)
    .where(and(eq(tournamentEntries.tournamentId, tournamentId), eq(tournamentEntries.status, 'active')))
    .limit(MAX_TOURNAMENT_ENTRIES)
  if (activeEntryRows.length >= MAX_TOURNAMENT_ENTRIES) return { error: `Tournament entry cap is ${MAX_TOURNAMENT_ENTRIES}.` }

  const now = Date.now()
  const entryId = nanoid(14)
  const queries: DbBatchItem[] = [db.insert(tournamentEntries).values({
    id: entryId,
    tournamentId,
    seed: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })]
  for (const identity of identities) {
    queries.push(db.insert(players).values({
      id: identity.userId,
      displayName: identity.displayName.trim(),
      avatarUrl: identity.avatarUrl,
      createdAt: now,
    }).onConflictDoUpdate({
      target: players.id,
      set: { displayName: identity.displayName.trim(), avatarUrl: identity.avatarUrl },
    }))
  }
  queries.push(db.insert(tournamentEntryMembers).values(identities.map((identity, position) => ({
    entryId,
    tournamentId,
    position,
    playerId: identity.userId,
    displayName: identity.displayName.trim(),
    avatarUrl: identity.avatarUrl,
    active: true,
    linkedAt: now,
    createdAt: now,
    updatedAt: now,
  }))))
  if (tournament.mode === '1v1') {
    const identity = identities[0]!
    queries.push(db.insert(tournamentPlayers).values({
      tournamentId,
      seed: null,
      playerId: identity.userId,
      displayName: identity.displayName.trim(),
      avatarUrl: identity.avatarUrl,
      confirmed: true,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    }))
  }

  try {
    await runDbBatch(db, queries)
  }
  catch {
    await db.delete(tournamentEntries).where(eq(tournamentEntries.id, entryId)).catch(() => undefined)
    const raced = await findActiveTournamentMemberships(db, tournamentId, [...uniqueIds])
    if (raced.length > 0 && new Set(raced.map(row => row.entryId)).size === 1) {
      const existing = await getTournamentEntrySnapshot(db, raced[0]!.entryId)
      if (existing && samePlayerSet(existing.members, [...uniqueIds])) return { entry: existing, idempotent: true }
    }
    return { error: 'One or more roster members were registered by another request. Try again.' }
  }

  const entry = await getTournamentEntrySnapshot(db, entryId)
  if (!entry) return { error: 'Registration could not be loaded after it was saved.' }
  return { entry, idempotent: false }
}

export async function leaveTournament(
  db: Database,
  tournamentId: string,
  identity: TournamentIdentity,
): Promise<{ ok: true, entry: TournamentEntrySnapshot } | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status !== 'setup' && tournament.status !== 'qualifier') return { error: 'You cannot leave at this tournament stage.' }
  const membership = (await findActiveTournamentMemberships(db, tournamentId, [identity.userId]))[0]
  if (!membership) return { error: 'You are not in an active tournament entry.' }
  const entry = await getTournamentEntrySnapshot(db, membership.entryId)
  if (!entry) return { error: 'Tournament entry not found.' }

  if (tournament.status === 'qualifier') {
    const live = await db.select({ sessionId: tournamentMatches.sessionId }).from(tournamentMatches).where(and(
      eq(tournamentMatches.tournamentId, tournamentId),
      inArray(tournamentMatches.status, ['open', 'drafting', 'active']),
      or(eq(tournamentMatches.entryOneId, entry.entryId), eq(tournamentMatches.entryTwoId, entry.entryId)),
    )).limit(1)
    if (live.length > 0) return { error: 'Your entry has a live tournament match and cannot withdraw.' }
  }

  const now = Date.now()
  await runDbBatch(db, [
    db.update(tournamentEntries).set({ status: 'withdrawn', updatedAt: now }).where(eq(tournamentEntries.id, entry.entryId)),
    db.update(tournamentEntryMembers).set({ active: false, updatedAt: now }).where(eq(tournamentEntryMembers.entryId, entry.entryId)),
    db.update(tournamentPlayers).set({ confirmed: false, updatedAt: now }).where(and(
      eq(tournamentPlayers.tournamentId, tournamentId),
      inArray(tournamentPlayers.playerId, entry.members.flatMap(member => member.playerId ? [member.playerId] : [])),
    )),
  ])
  return { ok: true, entry: { ...entry, status: 'withdrawn' } }
}

export async function getActiveTournament(db: Database) {
  const [tournament] = await db.select().from(tournaments)
    .where(inArray(tournaments.status, ACTIVE_TOURNAMENT_STATUSES))
    .orderBy(desc(tournaments.updatedAt)).limit(1)
  return tournament ?? null
}

export async function getCurrentTournament(db: Database) {
  const [tournament] = await db.select().from(tournaments)
    .where(inArray(tournaments.status, CURRENT_TOURNAMENT_STATUSES))
    .orderBy(desc(tournaments.updatedAt)).limit(1)
  return tournament ?? null
}

export async function getActiveQualifierTournament(db: Database) {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.status, 'qualifier')).orderBy(desc(tournaments.updatedAt)).limit(1)
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
  if (expected.some((column, index) => header[index] !== column)) return { error: `CSV header must be: ${expected.join(',')}` }

  const imported: TournamentPlayerImportRow[] = []
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]
    if (!row || row.every(value => value.trim().length === 0)) continue
    const seed = parseOptionalSeed(row[0])
    const displayName = row[1]?.trim() ?? ''
    const confirmed = parseBoolean(row[2])
    const playerId = normalizeDiscordUserId(row[3])
    if (!displayName) return { error: `Row ${index + 1} is missing display_name.` }
    if (seed === undefined) return { error: `Row ${index + 1} has invalid seed.` }
    if (confirmed == null) return { error: `Row ${index + 1} has invalid confirmed value.` }
    imported.push({ seed, displayName, confirmed, playerId })
  }
  return imported
}

export async function importTournamentPlayersCsv(db: Database, tournamentId: string, csv: string): Promise<TournamentImportResult | { error: string }> {
  const parsed = await parseTournamentPlayersCsv(csv)
  if ('error' in parsed) return parsed
  return importTournamentPlayers(db, tournamentId, parsed)
}

export async function importTournamentPlayers(db: Database, tournamentId: string, rows: TournamentPlayerImportRow[]): Promise<TournamentImportResult | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.mode !== '1v1') return { error: 'CSV import is only available for 1v1 tournaments.' }
  if (tournament.status !== 'setup') return { error: 'CSV import is only available during setup.' }
  if (rows.length > MAX_TOURNAMENT_ENTRIES) return { error: `Tournament entry cap is ${MAX_TOURNAMENT_ENTRIES}.` }

  const duplicateDisplayNames = duplicateValues(rows, row => normalizeIdentityName(row.displayName))
    .map(group => group[0]!.displayName)
  if (duplicateDisplayNames.length > 0) return { error: `Duplicate display names: ${duplicateDisplayNames.join(', ')}` }
  const duplicateSeeds = duplicateValues(rows.filter(row => row.seed != null), row => String(row.seed))
    .map(group => `#${group[0]!.seed} (${group.map(row => row.displayName).join(', ')})`)
  if (duplicateSeeds.length > 0) return { error: `Duplicate seeds: ${duplicateSeeds.join('; ')}` }
  const duplicatePlayerIds = duplicateValues(rows.filter(row => row.playerId), row => row.playerId!)
    .map(group => `${group[0]!.playerId} (${group.map(row => row.displayName).join(', ')})`)
  if (duplicatePlayerIds.length > 0) return { error: `Duplicate Discord user IDs: ${duplicatePlayerIds.join('; ')}` }

  const now = Date.now()
  await runDbBatch(db, [
    db.delete(tournamentPlayers).where(eq(tournamentPlayers.tournamentId, tournamentId)),
    db.delete(tournamentEntries).where(eq(tournamentEntries.tournamentId, tournamentId)),
  ])
  for (const batch of chunkArray(rows, TOURNAMENT_IMPORT_BATCH_SIZE)) {
    const entryRows = batch.map(row => ({
      id: legacyEntryId(tournamentId, row.displayName),
      tournamentId,
      seed: row.seed,
      status: row.confirmed ? 'active' : 'withdrawn',
      createdAt: now,
      updatedAt: now,
    }))
    const queries: DbBatchItem[] = []
    for (const row of batch.filter(row => row.playerId)) {
      queries.push(db.insert(players).values({ id: row.playerId!, displayName: row.displayName, avatarUrl: row.avatarUrl ?? null, createdAt: now })
        .onConflictDoUpdate({ target: players.id, set: row.avatarUrl === undefined ? { displayName: row.displayName } : { displayName: row.displayName, avatarUrl: row.avatarUrl } }))
    }
    queries.push(
      db.insert(tournamentEntries).values(entryRows),
      db.insert(tournamentEntryMembers).values(batch.map(row => ({
        entryId: legacyEntryId(tournamentId, row.displayName),
        tournamentId,
        position: 0,
        playerId: row.playerId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl ?? null,
        active: row.confirmed,
        linkedAt: row.playerId ? now : null,
        createdAt: now,
        updatedAt: now,
      }))),
      db.insert(tournamentPlayers).values(batch.map(row => ({
        tournamentId,
        seed: row.seed,
        playerId: row.playerId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl ?? null,
        confirmed: row.confirmed,
        linkedAt: row.playerId ? now : null,
        createdAt: now,
        updatedAt: now,
      }))),
    )
    await runDbBatch(db, queries)
  }
  const linked = rows.filter(row => row.playerId).length
  return { imported: rows.length, linked, pending: rows.length - linked, duplicateDisplayNames }
}

export async function resolveTournamentPlayerForIdentity(
  db: Database,
  tournamentId: string,
  identity: TournamentIdentity,
): Promise<{ ok: true, entry: TournamentEntrySnapshot } | { ok: false, error: string }> {
  const linked = (await findActiveTournamentMemberships(db, tournamentId, [identity.userId]))[0]
  if (linked) {
    await upsertTournamentPlayerIdentity(db, identity)
    await db.update(tournamentEntryMembers).set({ avatarUrl: identity.avatarUrl ?? linked.avatarUrl, updatedAt: Date.now() })
      .where(and(eq(tournamentEntryMembers.entryId, linked.entryId), eq(tournamentEntryMembers.playerId, identity.userId)))
    const entry = await getTournamentEntrySnapshot(db, linked.entryId)
    return entry ? { ok: true, entry } : { ok: false, error: 'Tournament entry not found.' }
  }

  const tournament = await getTournamentById(db, tournamentId)
  if (tournament?.mode !== '1v1') return { ok: false, error: 'You are not registered in the active tournament.' }
  const pending = await db.select().from(tournamentEntryMembers).where(and(
    eq(tournamentEntryMembers.tournamentId, tournamentId),
    eq(tournamentEntryMembers.active, true),
    isNull(tournamentEntryMembers.playerId),
  ))
  const identityName = normalizeIdentityName(identity.displayName)
  const nameMatches = pending.filter(row => normalizeIdentityName(row.displayName) === identityName)
  if (nameMatches.length !== 1) return { ok: false, error: nameMatches.length > 1
    ? 'Your tournament entry is ambiguous. Ask an admin to link your Discord ID.'
    : 'You are not linked as a player in the active tournament.' }

  const row = nameMatches[0]!
  const now = Date.now()
  await upsertTournamentPlayerIdentity(db, identity)
  try {
    await runDbBatch(db, [
      db.update(tournamentEntryMembers).set({ playerId: identity.userId, avatarUrl: identity.avatarUrl, linkedAt: now, updatedAt: now })
        .where(and(eq(tournamentEntryMembers.entryId, row.entryId), eq(tournamentEntryMembers.position, row.position), isNull(tournamentEntryMembers.playerId))),
      db.update(tournamentPlayers).set({ playerId: identity.userId, avatarUrl: identity.avatarUrl, linkedAt: now, updatedAt: now })
        .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.displayName, row.displayName))),
    ])
  }
  catch {
    return { ok: false, error: 'You are already linked to another active tournament entry.' }
  }
  const entry = await getTournamentEntrySnapshot(db, row.entryId)
  return entry ? { ok: true, entry } : { ok: false, error: 'Tournament entry not found.' }
}

async function resolveLinkedTournamentPlayerForIdentity(
  db: Database,
  tournamentId: string,
  identity: TournamentIdentity,
): Promise<{ ok: true, entry: TournamentEntrySnapshot } | { ok: false, error: string }> {
  const linked = (await findActiveTournamentMemberships(db, tournamentId, [identity.userId]))[0]
  if (!linked) return { ok: false, error: 'That player is not linked to an active tournament entry.' }
  const entry = await getTournamentEntrySnapshot(db, linked.entryId)
  return entry ? { ok: true, entry } : { ok: false, error: 'Tournament entry not found.' }
}

export async function createTournamentMatchLink(db: Database, input: {
  tournamentId: string
  sessionId: string
  hostId: string
  stage?: TournamentStage
  cutPairingId?: string | null
  entryOneId?: string | null
  entryTwoId?: string | null
  /** Legacy caller compatibility. */
  playerOneId?: string | null
  playerTwoId?: string | null
}): Promise<void> {
  const cutPairing = input.cutPairingId ? await getTournamentCutPairingById(db, input.cutPairingId) : null
  if (input.cutPairingId) {
    const claim = await claimTournamentPlayoffLobby(db, input.cutPairingId, input.sessionId)
    if (!claim.ok) throw new Error(claim.error)
    if (claim.sessionId !== input.sessionId) throw new Error('This playoff pairing already has another lobby.')
  }
  const legacyMemberships = await findActiveTournamentMemberships(db, input.tournamentId, [input.playerOneId ?? input.hostId, ...(input.playerTwoId ? [input.playerTwoId] : [])])
  const membershipByPlayerId = new Map(legacyMemberships.map(row => [row.playerId, row.entryId]))
  const entryOneId = input.entryOneId ?? cutPairing?.entryOneId ?? membershipByPlayerId.get(input.playerOneId ?? input.hostId) ?? null
  const entryTwoId = input.entryTwoId ?? cutPairing?.entryTwoId ?? (input.playerTwoId ? membershipByPlayerId.get(input.playerTwoId) ?? null : null)
  if (!entryOneId) throw new Error('Tournament match host is not attached to an entry')
  const representatives = await getEntryRepresentativeIds(db, [entryOneId, ...(entryTwoId ? [entryTwoId] : [])])
  const now = Date.now()
  const stage = input.stage ?? (cutPairing ? normalizeTournamentStage(cutPairing.round) : 'qualifier')
  await db.insert(tournamentMatches).values({
    sessionId: input.sessionId,
    tournamentId: input.tournamentId,
    matchId: null,
    stage,
    status: 'open',
    playerOneId: representatives.get(entryOneId) ?? input.playerOneId ?? input.hostId,
    playerTwoId: entryTwoId ? representatives.get(entryTwoId) ?? input.playerTwoId ?? null : null,
    winnerId: null,
    entryOneId,
    entryTwoId,
    winnerEntryId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: tournamentMatches.sessionId,
    set: { tournamentId: input.tournamentId, stage, entryOneId, entryTwoId, playerOneId: representatives.get(entryOneId) ?? input.hostId, playerTwoId: entryTwoId ? representatives.get(entryTwoId) ?? null : null, updatedAt: now },
  })
  if (input.cutPairingId) {
    await db.update(tournamentCutPairings).set({ status: 'open', updatedAt: now }).where(and(
      eq(tournamentCutPairings.id, input.cutPairingId),
      eq(tournamentCutPairings.sessionId, input.sessionId),
    ))
  }
}

export async function claimTournamentPlayoffLobby(
  db: Database,
  pairingId: string,
  sessionId: string,
): Promise<{ ok: true, claimed: boolean, sessionId: string } | { ok: false, error: string }> {
  const claimed = await db.update(tournamentCutPairings)
    .set({ sessionId, status: 'open', updatedAt: Date.now() })
    .where(and(
      eq(tournamentCutPairings.id, pairingId),
      eq(tournamentCutPairings.status, 'scheduled'),
      isNull(tournamentCutPairings.sessionId),
    ))
    .returning({ sessionId: tournamentCutPairings.sessionId })
  if (claimed[0]?.sessionId === sessionId) return { ok: true, claimed: true, sessionId }

  const pairing = await getTournamentCutPairingById(db, pairingId)
  if (pairing?.sessionId) return { ok: true, claimed: false, sessionId: pairing.sessionId }
  return { ok: false, error: 'This playoff pairing is not available for a new lobby.' }
}

export async function releaseTournamentPlayoffLobbyClaim(db: Database, pairingId: string, sessionId: string): Promise<void> {
  await runDbBatch(db, [
    db.delete(tournamentMatches).where(eq(tournamentMatches.sessionId, sessionId)),
    db.update(tournamentCutPairings).set({ sessionId: null, matchId: null, status: 'scheduled', updatedAt: Date.now() }).where(and(
      eq(tournamentCutPairings.id, pairingId),
      eq(tournamentCutPairings.sessionId, sessionId),
      eq(tournamentCutPairings.status, 'open'),
    )),
  ])
}

export async function getTournamentCutPairingById(db: Database, id: string) {
  const [row] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.id, id)).limit(1)
  return row ?? null
}

export async function markTournamentMatchDrafting(db: Database, sessionId: string, matchId: string): Promise<void> {
  const now = Date.now()
  await runDbBatch(db, [
    db.update(tournamentMatches).set({ matchId, status: 'drafting', updatedAt: now }).where(eq(tournamentMatches.sessionId, sessionId)),
    db.update(tournamentCutPairings).set({ matchId, status: 'drafting', updatedAt: now }).where(eq(tournamentCutPairings.sessionId, sessionId)),
  ])
}

export async function reopenTournamentMatchAfterDraftCancel(db: Database, sessionId: string): Promise<void> {
  const now = Date.now()
  await runDbBatch(db, [
    db.update(tournamentMatches).set({ matchId: null, status: 'open', winnerId: null, winnerEntryId: null, updatedAt: now }).where(eq(tournamentMatches.sessionId, sessionId)),
    db.update(tournamentCutPairings).set({ matchId: null, status: 'open', winnerId: null, winnerEntryId: null, updatedAt: now }).where(eq(tournamentCutPairings.sessionId, sessionId)),
  ])
}

export async function cancelTournamentOpenLobby(db: Database, sessionId: string): Promise<void> {
  const link = await getTournamentMatchBySessionId(db, sessionId)
  if (!link || link.status !== 'open') return
  const pairing = await getTournamentCutPairingBySessionId(db, sessionId)
  const queries: DbBatchItem[] = [db.delete(tournamentMatches).where(eq(tournamentMatches.sessionId, sessionId))]
  if (pairing) {
    queries.push(db.update(tournamentCutPairings).set({ sessionId: null, matchId: null, winnerId: null, winnerEntryId: null, status: 'scheduled', updatedAt: Date.now() }).where(eq(tournamentCutPairings.id, pairing.id)))
  }
  await runDbBatch(db, queries)
}

export async function getTournamentMatchBySessionId(db: Database, sessionId: string) {
  const [row] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, sessionId)).limit(1)
  return row ?? null
}

export async function getTournamentMatchByMatchId(db: Database, matchId: string) {
  const [row] = await db.select().from(tournamentMatches).where(or(eq(tournamentMatches.matchId, matchId), eq(tournamentMatches.sessionId, matchId))).limit(1)
  return row ?? null
}

export async function getTournamentCutPairingBySessionId(db: Database, sessionId: string) {
  const [row] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.sessionId, sessionId)).limit(1)
  return row ?? null
}

async function getTournamentCutPairingForMatchLink(db: Database, link: typeof tournamentMatches.$inferSelect) {
  const bySession = await getTournamentCutPairingBySessionId(db, link.sessionId)
  if (bySession) return bySession
  if (link.stage === 'qualifier' || !link.entryOneId || !link.entryTwoId) return null
  const [row] = await db.select().from(tournamentCutPairings).where(and(
    eq(tournamentCutPairings.tournamentId, link.tournamentId),
    eq(tournamentCutPairings.round, link.stage),
    or(
      and(eq(tournamentCutPairings.entryOneId, link.entryOneId), eq(tournamentCutPairings.entryTwoId, link.entryTwoId)),
      and(eq(tournamentCutPairings.entryOneId, link.entryTwoId), eq(tournamentCutPairings.entryTwoId, link.entryOneId)),
    ),
  )).limit(1)
  return row ?? null
}

export async function resolveTournamentOpenLobbyTarget(db: Database, identity: TournamentIdentity): Promise<TournamentOpenLobbyTarget | { error: string }> {
  const tournament = await getActiveTournament(db)
  if (!tournament) return { error: 'No active tournament is accepting lobbies.' }
  if (!isTournamentMode(tournament.mode)) return { error: 'Tournament mode is invalid.' }
  const resolved = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!resolved.ok) return { error: resolved.error }

  if (tournament.status === 'qualifier') {
    return {
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      mode: tournament.mode,
      stage: 'qualifier',
      cutPairingId: null,
      entryOneId: resolved.entry.entryId,
      entryTwoId: null,
      creatorEntry: resolved.entry,
      opponentEntry: null,
      opponentDisplayName: null,
      existingSessionId: null,
    }
  }
  if (tournament.status !== 'top_cut') return { error: `Tournament is ${tournament.status} and is not accepting new lobbies.` }

  await advanceTournamentCutIfRoundComplete(db, tournament.id, 'quarterfinal')
  await advanceTournamentCutIfRoundComplete(db, tournament.id, 'semifinal')
  const pairing = await getOpenTournamentCutPairingForEntry(db, tournament.id, resolved.entry.entryId)
  if (!pairing?.entryOneId || !pairing.entryTwoId) return { error: 'No open playoff pairing found for your entry.' }
  const entryOne = await getTournamentEntrySnapshot(db, pairing.entryOneId)
  const entryTwo = await getTournamentEntrySnapshot(db, pairing.entryTwoId)
  if (!entryOne || !entryTwo) return { error: 'Playoff pairing has a missing entry roster.' }
  const creatorIsOne = resolved.entry.entryId === entryOne.entryId
  return {
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    mode: tournament.mode,
    stage: normalizeTournamentStage(pairing.round),
    cutPairingId: pairing.id,
    entryOneId: creatorIsOne ? entryOne.entryId : entryTwo.entryId,
    entryTwoId: creatorIsOne ? entryTwo.entryId : entryOne.entryId,
    creatorEntry: creatorIsOne ? entryOne : entryTwo,
    opponentEntry: creatorIsOne ? entryTwo : entryOne,
    opponentDisplayName: formatTournamentEntryName(creatorIsOne ? entryTwo : entryOne),
    existingSessionId: pairing.sessionId,
  }
}

export async function buildTournamentReservedSlotLabels(db: Database, lobby: Pick<LobbyState, 'id' | 'mode' | 'slots'>): Promise<(string | null)[]> {
  const link = await getTournamentMatchBySessionId(db, lobby.id)
  if (!link?.entryOneId) return []
  const size = tournamentTeamSize(lobby.mode)
  if (!size) return []
  const entryIds = [link.entryOneId, ...(link.entryTwoId ? [link.entryTwoId] : [])]
  const entryMap = new Map((await listTournamentEntrySnapshotsByIds(db, entryIds)).map(entry => [entry.entryId, entry]))
  const labels: (string | null)[] = Array.from({ length: lobby.slots.length }, () => null)
  for (const [side, entryId] of entryIds.entries()) {
    const entry = entryMap.get(entryId)
    if (!entry) continue
    for (const member of entry.members) {
      const slot = side * size + member.position
      if (slot < labels.length && !lobby.slots[slot]) labels[slot] = member.displayName
    }
  }
  return labels
}

export async function buildTournamentLobbySnapshot(db: Database, sessionId: string, _playerIds: readonly string[]): Promise<TournamentLobbySnapshot | null> {
  const link = await getTournamentMatchBySessionId(db, sessionId)
  if (!link?.entryOneId) return null
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament || !isTournamentMode(tournament.mode)) return null
  const size = tournamentTeamSize(tournament.mode)!
  const entryIds = [link.entryOneId, ...(link.entryTwoId ? [link.entryTwoId] : [])]
  const entries = await listTournamentEntrySnapshotsByIds(db, entryIds)
  const entryById = new Map(entries.map(entry => [entry.entryId, entry]))
  const rematchPolicy = isTournamentRematchPolicy(tournament.rematchPolicy) ? tournament.rematchPolicy : DEFAULT_TOURNAMENT_REMATCH_POLICY
  const rematchWarning = rematchPolicy === 'warn' && link.entryTwoId
    ? await buildRematchWarning(db, tournament.id, link.entryOneId, link.entryTwoId)
    : null
  return {
    id: tournament.id,
    name: tournament.name,
    mode: tournament.mode,
    rematchPolicy,
    rematchWarning,
    configLocked: true,
    rosterLocked: true,
    entryRosters: entryIds.flatMap((entryId, side) => {
      const entry = entryById.get(entryId)
      return entry ? [{ entryId, side: side as 0 | 1, members: entry.members.map(member => ({ ...member, slot: side * size + member.position })) }] : []
    }),
  }
}

export async function listOpenTournamentSessionIds(db: Database): Promise<Set<string>> {
  const rows = await db.select({ sessionId: tournamentMatches.sessionId }).from(tournamentMatches).where(inArray(tournamentMatches.status, ['open', 'drafting', 'active']))
  return new Set(rows.map(row => row.sessionId))
}

export async function validateTournamentLobbyJoin(
  db: Database,
  lobby: LobbyState,
  identity: TournamentIdentity,
  targetSlot?: number,
): Promise<{ ok: true, entryId: string, expectedSlot: number, needsClaim: boolean } | { ok: false, error: string }> {
  const link = await getTournamentMatchBySessionId(db, lobby.id)
  if (!link) return { ok: false, error: 'Tournament match not found.' }
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament || !isTournamentMode(tournament.mode)) return { ok: false, error: 'Tournament not found.' }
  if (lobby.mode !== tournament.mode) return { ok: false, error: `This tournament lobby must use ${tournament.mode}.` }
  const resolved = await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!resolved.ok) return resolved
  const size = tournamentTeamSize(tournament.mode)!
  let side: 0 | 1
  let needsClaim = false
  if (resolved.entry.entryId === link.entryOneId) side = 0
  else if (resolved.entry.entryId === link.entryTwoId) side = 1
  else if (!link.entryTwoId && tournament.status === 'qualifier') {
    side = 1
    needsClaim = true
  }
  else return { ok: false, error: tournament.status === 'top_cut' ? 'This playoff lobby is reserved for its paired entries.' : 'This lobby is already reserved for two tournament entries.' }

  const member = resolved.entry.members.find(member => member.playerId === identity.userId)
  if (!member) return { ok: false, error: 'Your tournament entry member snapshot is missing.' }
  const expectedSlot = side * size + member.position
  if (targetSlot != null && targetSlot !== expectedSlot) return { ok: false, error: `Your registered roster position is slot ${expectedSlot + 1}.` }
  if (tournament.status === 'top_cut' && !link.entryTwoId) return { ok: false, error: 'This playoff lobby is missing its paired entry.' }
  if (tournament.status !== 'qualifier' && tournament.status !== 'top_cut') return { ok: false, error: 'This tournament match is not accepting players.' }
  if (tournament.rematchPolicy === 'block' && link.entryOneId && side === 1) {
    if (await countReportedMeetings(db, tournament.id, link.entryOneId, resolved.entry.entryId) > 0) return { ok: false, error: 'These entries already played in the tournament.' }
  }
  return { ok: true, entryId: resolved.entry.entryId, expectedSlot, needsClaim }
}

export async function claimTournamentQualifierOpponentEntry(db: Database, sessionId: string, entryId: string): Promise<{ ok: true, claimed: boolean } | { ok: false, error: string }> {
  const before = await getTournamentMatchBySessionId(db, sessionId)
  if (!before) return { ok: false, error: 'Tournament match not found.' }
  if (before.entryTwoId === entryId) return { ok: true, claimed: false }
  if (before.entryTwoId) return { ok: false, error: 'Another tournament entry claimed this lobby first.' }
  const representative = (await getEntryRepresentativeIds(db, [entryId])).get(entryId) ?? null
  const claimed = await db.update(tournamentMatches).set({ entryTwoId: entryId, playerTwoId: representative, updatedAt: Date.now() })
    .where(and(eq(tournamentMatches.sessionId, sessionId), isNull(tournamentMatches.entryTwoId), eq(tournamentMatches.status, 'open')))
    .returning({ entryTwoId: tournamentMatches.entryTwoId })
  if (claimed[0]?.entryTwoId === entryId) return { ok: true, claimed: true }
  const after = await getTournamentMatchBySessionId(db, sessionId)
  return after?.entryTwoId === entryId
    ? { ok: true, claimed: false }
    : { ok: false, error: 'Another tournament entry claimed this lobby first.' }
}

export async function resolveTournamentLobbyJoinSlot(
  db: Database,
  sessionId: string,
  playerId: string,
): Promise<{ ok: true, slot: number } | { ok: false, error: string } | null> {
  const link = await getTournamentMatchBySessionId(db, sessionId)
  if (!link) return null
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament || !isTournamentMode(tournament.mode)) return { ok: false, error: 'Tournament not found.' }
  if (tournament.status !== 'qualifier' && tournament.status !== 'top_cut') return { ok: false, error: 'This tournament match is not accepting players.' }

  const membership = (await findActiveTournamentMemberships(db, tournament.id, [playerId]))[0]
  if (!membership) return { ok: false, error: 'You are not registered in this tournament.' }
  const entry = await getTournamentEntrySnapshot(db, membership.entryId)
  const member = entry?.members.find(candidate => candidate.playerId === playerId)
  if (!entry || !member) return { ok: false, error: 'Your tournament roster could not be loaded.' }

  const side = entry.entryId === link.entryOneId
    ? 0
    : entry.entryId === link.entryTwoId || (!link.entryTwoId && tournament.status === 'qualifier')
      ? 1
      : null
  if (side == null) return { ok: false, error: tournament.status === 'top_cut' ? 'This playoff lobby is reserved for its paired entries.' : 'This lobby is already reserved for two tournament entries.' }
  return { ok: true, slot: side * tournamentTeamSize(tournament.mode)! + member.position }
}

export async function validateTournamentLobbyRoster(db: Database, lobby: Pick<LobbyState, 'id' | 'mode' | 'slots'>): Promise<{ ok: true } | { ok: false, error: string }> {
  const link = await getTournamentMatchBySessionId(db, lobby.id)
  if (!link) return { ok: true }
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament || !isTournamentMode(tournament.mode)) return { ok: false, error: 'Tournament not found.' }
  if (lobby.mode !== tournament.mode) return { ok: false, error: `Tournament mode is locked to ${tournament.mode}.` }
  if (!link.entryOneId || !link.entryTwoId) return { ok: false, error: 'Both tournament entries must join before the draft starts.' }
  const size = tournamentTeamSize(tournament.mode)!
  if (lobby.slots.length !== size * 2) return { ok: false, error: `Tournament lobby must have exactly ${size * 2} player slots.` }
  const entries = await listTournamentEntrySnapshotsByIds(db, [link.entryOneId, link.entryTwoId])
  const byId = new Map(entries.map(entry => [entry.entryId, entry]))
  for (const [side, entryId] of [link.entryOneId, link.entryTwoId].entries()) {
    const entry = byId.get(entryId)
    if (!entry || entry.status !== 'active' || entry.members.length !== size || entry.members.some(member => !member.playerId)) return { ok: false, error: 'A registered entry roster is incomplete or withdrawn.' }
    for (const member of entry.members) {
      if (lobby.slots[side * size + member.position] !== member.playerId) return { ok: false, error: `${member.displayName} must remain on their registered team side.` }
    }
  }
  const expectedIds = new Set(entries.flatMap(entry => entry.members.flatMap(member => member.playerId ? [member.playerId] : [])))
  const actualIds = lobby.slots.filter((id): id is string => Boolean(id))
  if (actualIds.length !== expectedIds.size || actualIds.some(id => !expectedIds.has(id))) return { ok: false, error: 'Tournament lobby roster does not exactly match the two registered entries.' }
  return { ok: true }
}

export async function validateTournamentMatchParticipants(db: Database, matchId: string, participantsInput?: readonly ParticipantRow[]): Promise<{ ok: true } | { error: string }> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return { ok: true }
  if (!link.entryOneId || !link.entryTwoId) return { error: 'Tournament match is missing one of its entries.' }
  const [tournament, matchRow, participants, entries] = await Promise.all([
    getTournamentById(db, link.tournamentId),
    db.select({ gameMode: matches.gameMode }).from(matches).where(eq(matches.id, matchId)).limit(1).then(rows => rows[0] ?? null),
    participantsInput ? Promise.resolve([...participantsInput]) : db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId)),
    listTournamentEntrySnapshotsByIds(db, [link.entryOneId, link.entryTwoId]),
  ])
  if (!tournament || !isTournamentMode(tournament.mode)) return { error: 'Tournament mode is invalid.' }
  if (matchRow && matchRow.gameMode !== tournament.mode) return { error: `Tournament match mode must be ${tournament.mode}.` }
  const entryById = new Map(entries.map(entry => [entry.entryId, entry]))
  const expected = [link.entryOneId, link.entryTwoId].map(id => entryById.get(id))
  if (expected.some(entry => !entry)) return { error: 'Tournament entry roster is missing.' }
  const expectedIds = new Set(expected.flatMap(entry => entry!.members.flatMap(member => member.playerId ? [member.playerId] : [])))
  if (expectedIds.size !== participants.length || participants.some(participant => !expectedIds.has(participant.playerId))) return { error: 'Tournament result competitors do not exactly match the registered entries.' }
  if (tournament.mode !== '1v1') {
    const teamByEntry = expected.map((entry) => {
      const teams = new Set(participants.filter(participant => entry!.members.some(member => member.playerId === participant.playerId)).map(participant => participant.team))
      return teams.size === 1 ? [...teams][0] : undefined
    })
    if (teamByEntry.some(team => team == null) || teamByEntry[0] === teamByEntry[1]) return { error: 'Tournament entry members must remain grouped on opposite team sides.' }
  }
  return { ok: true }
}

export async function syncTournamentMatchAfterReport(db: Database, matchId: string): Promise<void> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return
  const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  const validation = await validateTournamentMatchParticipants(db, matchId, participants)
  if ('error' in validation) throw new Error(validation.error)
  if (!link.entryOneId || !link.entryTwoId) throw new Error('Tournament match entries are missing')
  const entries = await listTournamentEntrySnapshotsByIds(db, [link.entryOneId, link.entryTwoId])
  const winnerEntry = entries.find(entry => {
    const memberIds = entry.members.flatMap(member => member.playerId ? [member.playerId] : [])
    return memberIds.length > 0 && memberIds.every(id => participants.some(participant => participant.playerId === id && participant.placement === 1))
  }) ?? null
  if (!winnerEntry) throw new Error('Winning placement does not match either registered tournament entry')
  const representatives = await getEntryRepresentativeIds(db, [link.entryOneId, link.entryTwoId])
  const cutPairing = await getTournamentCutPairingForMatchLink(db, link)
  if (cutPairing && link.status === 'reported' && link.winnerEntryId !== winnerEntry.entryId) {
    const mutation = await validateTournamentPairingMutation(db, cutPairing)
    if (!mutation.ok) throw new Error(mutation.error)
  }
  await db.update(tournamentMatches).set({
    matchId,
    status: 'reported',
    entryOneId: cutPairing?.entryOneId ?? link.entryOneId,
    entryTwoId: cutPairing?.entryTwoId ?? link.entryTwoId,
    winnerEntryId: winnerEntry.entryId,
    playerOneId: representatives.get(link.entryOneId) ?? null,
    playerTwoId: representatives.get(link.entryTwoId) ?? null,
    winnerId: representatives.get(winnerEntry.entryId) ?? null,
    updatedAt: Date.now(),
  }).where(eq(tournamentMatches.sessionId, link.sessionId))
  if (cutPairing) await syncTournamentCutPairingAfterReport(db, cutPairing, matchId)
}

export async function syncTournamentMatchAfterCancel(db: Database, matchId: string): Promise<void> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return
  const cutPairing = await getTournamentCutPairingForMatchLink(db, link)
  if (cutPairing && link.status === 'reported') {
    const mutation = await validateTournamentPairingMutation(db, cutPairing)
    if (!mutation.ok) throw new Error(mutation.error)
  }
  await db.update(tournamentMatches).set({ matchId: link.matchId ?? matchId, status: 'cancelled', winnerId: null, winnerEntryId: null, updatedAt: Date.now() }).where(eq(tournamentMatches.sessionId, link.sessionId))
  if (cutPairing) {
    await resetTournamentCutPairingAfterCancel(db, cutPairing)
    return
  }
  await db.update(tournamentCutPairings).set({ status: 'cancelled', winnerId: null, winnerEntryId: null, updatedAt: Date.now() }).where(eq(tournamentCutPairings.sessionId, link.sessionId))
}

export async function buildTournamentStandings(db: Database, tournamentId: string): Promise<TournamentStandingRow[]> {
  const [tournament, entries, matchRows] = await Promise.all([
    getTournamentById(db, tournamentId),
    listTournamentEntrySnapshots(db, tournamentId, { activeOnly: true }),
    db.select().from(tournamentMatches).where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.stage, 'qualifier'), eq(tournamentMatches.status, 'reported'))),
  ])
  const stats = new Map<string, { games: number, wins: number, opponentIds: string[] }>()
  for (const entry of entries) stats.set(entry.entryId, { games: 0, wins: 0, opponentIds: [] })
  for (const row of matchRows) {
    if (!row.entryOneId || !row.entryTwoId) continue
    const left = getOrCreateStats(stats, row.entryOneId)
    const right = getOrCreateStats(stats, row.entryTwoId)
    left.games += 1
    right.games += 1
    left.opponentIds.push(row.entryTwoId)
    right.opponentIds.push(row.entryOneId)
    if (row.winnerEntryId === row.entryOneId) left.wins += 1
    if (row.winnerEntryId === row.entryTwoId) right.wins += 1
  }
  const minGames = tournament?.minGames ?? DEFAULT_TOURNAMENT_MIN_GAMES
  return entries.map((entry) => {
    const row = stats.get(entry.entryId)
    const games = row?.games ?? 0
    const wins = row?.wins ?? 0
    const representative = entry.members.find(member => member.playerId) ?? entry.members[0] ?? null
    return {
      entryId: entry.entryId,
      members: entry.members,
      playerId: representative?.playerId ?? null,
      displayName: formatTournamentEntryName(entry),
      avatarUrl: representative?.avatarUrl ?? null,
      seed: entry.seed,
      games,
      wins,
      losses: Math.max(0, games - wins),
      winRate: games > 0 ? wins / games : 0,
      opponentWinRate: row?.opponentIds.length ? row.opponentIds.reduce((sum, id) => sum + getWinRate(stats.get(id)), 0) / row.opponentIds.length : 0,
      eligible: games >= minGames,
    }
  }).sort(compareTournamentStandingRows)
}

export async function createTournamentCut(db: Database, tournamentId: string): Promise<TournamentCutResult | { error: string }> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return { error: 'Tournament not found.' }
  if (tournament.status === 'setup') return { error: 'Start the tournament before creating playoff pairings.' }
  if (tournament.status !== 'qualifier' && tournament.status !== 'qualifier_locked') return { error: `Tournament is already ${tournament.status}.` }
  if (!isSupportedTournamentTopCut(tournament.topCut)) return { error: `Top cut must be one of: ${SUPPORTED_TOURNAMENT_TOP_CUTS.join(', ')}.` }
  const existing = await db.select({ id: tournamentCutPairings.id }).from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournamentId)).limit(1)
  if (existing.length > 0) return { error: 'Playoff pairings already exist for this tournament.' }

  const standings = await buildTournamentStandings(db, tournamentId)
  const qualified = standings.filter(row => row.eligible)
  const availableTopCut = Math.min(tournament.topCut, qualified.length)
  const pairedTopCut = [...SUPPORTED_TOURNAMENT_TOP_CUTS].reverse().find(size => size <= availableTopCut) ?? 0
  if (pairedTopCut < 2) return { error: 'At least two eligible entries are required to create playoff pairings.' }
  const cutRows = qualified.slice(0, pairedTopCut).map((row, index) => ({ ...row, cutSeed: index + 1 }))
  const rowsBySeed = new Map(cutRows.map(row => [row.cutSeed, row]))
  const bracketSeeds = getInitialBracketSeedOrder(pairedTopCut)
  const pairings: TournamentCutPairingSnapshot[] = []
  for (let index = 0; index < bracketSeeds.length; index += 2) {
    const left = rowsBySeed.get(bracketSeeds[index]!)!
    const right = rowsBySeed.get(bracketSeeds[index + 1]!)!
    pairings.push({
      seedOne: left.cutSeed,
      seedTwo: right.cutSeed,
      entryOneId: left.entryId,
      entryTwoId: right.entryId,
      playerOneId: left.playerId,
      playerTwoId: right.playerId,
      playerOneDisplayName: left.displayName,
      playerTwoDisplayName: right.displayName,
    })
  }
  const round = resolveTopCutRound(pairedTopCut)
  const now = Date.now()
  await runDbBatch(db, [
    db.update(tournaments).set({ status: 'top_cut', updatedAt: now }).where(eq(tournaments.id, tournamentId)),
    db.insert(tournamentCutPairings).values(pairings.map((pairing, bracketSlot) => ({
      id: tournamentCutPairingId(tournamentId, round, bracketSlot), tournamentId, round, seedOne: pairing.seedOne, seedTwo: pairing.seedTwo,
      entryOneId: pairing.entryOneId, entryTwoId: pairing.entryTwoId, winnerEntryId: null,
      playerOneId: pairing.playerOneId, playerTwoId: pairing.playerTwoId, winnerId: null,
      sessionId: null, matchId: null, status: 'scheduled', createdAt: now, updatedAt: now,
    }))).onConflictDoNothing({ target: tournamentCutPairings.id }),
  ])
  return { tournamentId, tournamentName: tournament.name, requestedTopCut: tournament.topCut, actualTopCut: pairedTopCut, round, pairings }
}

export async function isMatchTournamentLinked(db: Database, matchId: string): Promise<boolean> {
  return (await getTournamentMatchByMatchId(db, matchId)) != null
}

export async function validateTournamentMatchMutation(db: Database, matchId: string): Promise<{ ok: true } | { ok: false, error: string }> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link) return { ok: true }
  const pairing = await getTournamentCutPairingForMatchLink(db, link)
  if (!pairing) return { ok: true }
  return validateTournamentPairingMutation(db, pairing)
}

export async function buildTournamentOpponentCardData(db: Database, identity: TournamentIdentity, options: BuildTournamentOpponentCardDataOptions = {}): Promise<TournamentOpponentCardData | { error: string }> {
  const tournament = await getActiveTournament(db)
  if (!tournament) return { error: 'No active tournament.' }
  const resolved = options.autoLink === false
    ? await resolveLinkedTournamentPlayerForIdentity(db, tournament.id, identity)
    : await resolveTournamentPlayerForIdentity(db, tournament.id, identity)
  if (!resolved.ok) return { error: resolved.error }
  const standings = await buildTournamentStandings(db, tournament.id)
  const playerStanding = standings.find(row => row.entryId === resolved.entry.entryId)
  if (!playerStanding) return { error: 'That player is not linked to an active tournament entry.' }
  const rankByEntryId = new Map(standings.map((row, index) => [row.entryId, index + 1]))
  const player = toOpponentCardPlayer(playerStanding, rankByEntryId.get(playerStanding.entryId) ?? null)
  const pairing = tournament.status === 'top_cut' ? await buildTopCutOpponentCardPairing(db, tournament.id, playerStanding.entryId, standings) : null
  const opponents = pairing ? [] : await buildQualifierOpponentRows(db, tournament.id, playerStanding, standings, tournament.minGames, rankByEntryId)
  return { tournamentName: tournament.name, status: tournament.status as TournamentStatus, player, opponents, pairing }
}

export async function buildTournamentLeaderboardImageData(
  db: Database,
  tournamentId: string,
  standingsInput?: TournamentStandingRow[],
  pairingsInput?: Array<typeof tournamentCutPairings.$inferSelect>,
): Promise<TournamentLeaderboardImageData | null> {
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament) return null
  const [standings, pairingRows, seriesRows] = await Promise.all([
    standingsInput ? Promise.resolve(standingsInput) : buildTournamentStandings(db, tournamentId),
    pairingsInput ? Promise.resolve(pairingsInput) : db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournamentId)),
    db.select({ stage: tournamentMatches.stage, entryOneId: tournamentMatches.entryOneId, entryTwoId: tournamentMatches.entryTwoId, winnerEntryId: tournamentMatches.winnerEntryId })
      .from(tournamentMatches).where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.status, 'reported'))),
  ])
  const sortedPairings = [...pairingRows].sort((left, right) => compareCutPairingsForDisplay(left, right, getCutSizeFromPairings(pairingRows)))
  const entryIds = [...new Set([
    ...standings.map(row => row.entryId),
    ...sortedPairings.flatMap(row => [row.entryOneId, row.entryTwoId, row.winnerEntryId].filter((id): id is string => Boolean(id))),
  ])]
  const entries = await listTournamentEntrySnapshotsByIds(db, entryIds)
  const entryById = new Map(entries.map(entry => [entry.entryId, entry]))
  const standingById = new Map(standings.map(row => [row.entryId, row]))
  const championId = sortedPairings.find(row => row.round === 'final' && row.status === 'reported')?.winnerEntryId ?? null
  return {
    tournamentName: tournament.name,
    status: tournament.status as TournamentStatus,
    minGames: tournament.minGames,
    standings: standings.map(row => ({ ...toOpponentCardPlayer(row), eligible: row.eligible })),
    pairings: sortedPairings.map((row) => {
      const left = row.entryOneId ? entryById.get(row.entryOneId) : null
      const right = row.entryTwoId ? entryById.get(row.entryTwoId) : null
      const relevant = seriesRows.filter(match => match.stage === row.round && ((match.entryOneId === row.entryOneId && match.entryTwoId === row.entryTwoId) || (match.entryOneId === row.entryTwoId && match.entryTwoId === row.entryOneId)))
      return {
        round: row.round,
        seedOne: row.seedOne,
        seedTwo: row.seedTwo,
        entryOneId: row.entryOneId,
        entryTwoId: row.entryTwoId,
        playerOneId: representativeMember(left)?.playerId ?? null,
        playerTwoId: representativeMember(right)?.playerId ?? null,
        playerOneDisplayName: left ? formatTournamentEntryName(left) : 'TBD',
        playerTwoDisplayName: right ? formatTournamentEntryName(right) : 'TBD',
        playerOneAvatarUrl: representativeMember(left)?.avatarUrl ?? null,
        playerTwoAvatarUrl: representativeMember(right)?.avatarUrl ?? null,
        playerOneScore: relevant.filter(match => match.winnerEntryId === row.entryOneId).length,
        playerTwoScore: relevant.filter(match => match.winnerEntryId === row.entryTwoId).length,
        requiredWins: getTopCutRoundRequiredWins(row.round),
        winnerEntryId: row.winnerEntryId,
        winnerDisplayName: row.winnerEntryId ? formatTournamentEntryName(entryById.get(row.winnerEntryId)) : null,
      }
    }),
    champion: championId && standingById.has(championId) ? toOpponentCardPlayer(standingById.get(championId)!) : null,
  }
}

export async function buildTournamentResultImageData(db: Database, matchId: string, participants: ParticipantRow[]): Promise<TournamentResultImageData | null> {
  const link = await getTournamentMatchByMatchId(db, matchId)
  if (!link?.entryOneId || !link.entryTwoId) return null
  const tournament = await getTournamentById(db, link.tournamentId)
  if (!tournament) return null
  const entries = await listTournamentEntrySnapshotsByIds(db, [link.entryOneId, link.entryTwoId])
  const participantById = new Map(participants.map(participant => [participant.playerId, participant]))
  const imageEntries = [link.entryOneId, link.entryTwoId].flatMap((entryId) => {
    const entry = entries.find(candidate => candidate.entryId === entryId)
    if (!entry) return []
    const members = entry.members.flatMap((member) => {
      if (!member.playerId) return []
      const participant = participantById.get(member.playerId)
      return [{ playerId: member.playerId, displayName: member.displayName, avatarUrl: member.avatarUrl, civId: participant?.civId ?? null, placement: participant?.placement ?? null }]
    })
    return [{ entryId, placement: members[0]?.placement ?? null, members }]
  })
  return {
    tournamentName: tournament.name,
    stage: link.stage as TournamentStage,
    matchLabel: formatTournamentMatchLabel(link.stage, link.winnerEntryId),
    entries: imageEntries,
    players: imageEntries.flatMap(entry => entry.members.map(member => ({ ...member, entryId: entry.entryId }))),
  }
}

export async function refreshTournamentLeaderboard(db: Database, kv: KVNamespace, token: string, channelScope: SystemChannelScope): Promise<boolean> {
  const tournament = await getTournamentForLeaderboard(db)
  if (!tournament) return false
  const channelId = await getSystemChannel(kv, 'tournament-leaderboard', channelScope)
  if (!channelId) return false
  const standings = await buildTournamentStandings(db, tournament.id)
  const pairings = tournament.status === 'top_cut' || tournament.status === 'completed'
    ? await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
    : []
  const imageData = await buildTournamentLeaderboardImageData(db, tournament.id, standings, pairings)
  if (!imageData) return false
  const png = await renderTournamentLeaderboardPng(imageData)
  if (pairings.length > 0) {
    await deleteLeaderboardMessage(db, token, channelId, tournamentTopCutStandingsScope(tournament.id))
    await upsertLeaderboardMessage(db, token, channelId, tournamentTopCutBracketScope(tournament.id), png, 'tournament-bracket.png')
  }
  else {
    await upsertLeaderboardMessage(db, token, channelId, 'tournament:active', png, 'tournament-standings.png')
    await deleteLeaderboardMessage(db, token, channelId, 'tournament:active:bracket')
  }
  await deleteStaleTournamentLeaderboardPageMessages(db, token, channelId)
  return true
}

export async function listTournamentEntrySnapshots(db: Database, tournamentId: string, options: { activeOnly?: boolean } = {}): Promise<TournamentEntrySnapshot[]> {
  const conditions = [eq(tournamentEntries.tournamentId, tournamentId)]
  if (options.activeOnly) conditions.push(eq(tournamentEntries.status, 'active'))
  const [entryRows, memberRows] = await Promise.all([
    db.select().from(tournamentEntries).where(and(...conditions)),
    db.select().from(tournamentEntryMembers).where(and(
      eq(tournamentEntryMembers.tournamentId, tournamentId),
      ...(options.activeOnly ? [eq(tournamentEntryMembers.active, true)] : []),
    )),
  ])
  return mapTournamentEntrySnapshots(entryRows, memberRows)
}

export function formatTournamentEntryName(entry: Pick<TournamentEntrySnapshot, 'members'> | undefined | null): string {
  if (!entry || entry.members.length === 0) return 'TBD'
  return entry.members.map(member => member.displayName).join(' / ')
}

async function listTournamentEntrySnapshotsByIds(db: Database, entryIds: readonly string[]): Promise<TournamentEntrySnapshot[]> {
  const ids = [...new Set(entryIds.filter(Boolean))]
  if (ids.length === 0) return []
  const [entryRows, memberRows] = await Promise.all([
    db.select().from(tournamentEntries).where(inArray(tournamentEntries.id, ids)),
    db.select().from(tournamentEntryMembers).where(inArray(tournamentEntryMembers.entryId, ids)),
  ])
  return mapTournamentEntrySnapshots(entryRows, memberRows)
}

async function getTournamentEntrySnapshot(db: Database, entryId: string): Promise<TournamentEntrySnapshot | null> {
  return (await listTournamentEntrySnapshotsByIds(db, [entryId]))[0] ?? null
}

function mapTournamentEntrySnapshots(entryRows: Array<typeof tournamentEntries.$inferSelect>, memberRows: Array<typeof tournamentEntryMembers.$inferSelect>): TournamentEntrySnapshot[] {
  const membersByEntry = new Map<string, TournamentEntryMemberSnapshot[]>()
  for (const row of memberRows) {
    const members = membersByEntry.get(row.entryId) ?? []
    members.push({ position: row.position, playerId: row.playerId, displayName: row.displayName, avatarUrl: row.avatarUrl })
    membersByEntry.set(row.entryId, members)
  }
  return entryRows.map(row => ({
    entryId: row.id,
    tournamentId: row.tournamentId,
    seed: row.seed,
    status: row.status,
    members: (membersByEntry.get(row.id) ?? []).sort((left, right) => left.position - right.position),
  })).sort((left, right) => (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER) || left.entryId.localeCompare(right.entryId))
}

async function findActiveTournamentMemberships(db: Database, tournamentId: string, playerIds: readonly string[]) {
  if (playerIds.length === 0) return []
  return db.select({
    entryId: tournamentEntryMembers.entryId,
    playerId: tournamentEntryMembers.playerId,
    displayName: tournamentEntryMembers.displayName,
    avatarUrl: tournamentEntryMembers.avatarUrl,
  }).from(tournamentEntryMembers).innerJoin(tournamentEntries, eq(tournamentEntries.id, tournamentEntryMembers.entryId)).where(and(
    eq(tournamentEntryMembers.tournamentId, tournamentId),
    eq(tournamentEntryMembers.active, true),
    eq(tournamentEntries.status, 'active'),
    inArray(tournamentEntryMembers.playerId, [...playerIds]),
  ))
}

function samePlayerSet(members: readonly TournamentEntryMemberSnapshot[], playerIds: readonly string[]): boolean {
  const memberIds = members.flatMap(member => member.playerId ? [member.playerId] : []).sort()
  return memberIds.length === playerIds.length && memberIds.every((id, index) => id === [...playerIds].sort()[index])
}

async function getEntryRepresentativeIds(db: Database, entryIds: readonly string[]): Promise<Map<string, string>> {
  const entries = await listTournamentEntrySnapshotsByIds(db, entryIds)
  return new Map(entries.flatMap((entry) => {
    const representative = representativeMember(entry)
    return representative?.playerId ? [[entry.entryId, representative.playerId] as const] : []
  }))
}

function representativeMember(entry: Pick<TournamentEntrySnapshot, 'members'> | undefined | null): TournamentEntryMemberSnapshot | null {
  return entry?.members.find(member => member.playerId) ?? entry?.members[0] ?? null
}

async function upsertTournamentPlayerIdentity(db: Database, identity: TournamentIdentity): Promise<void> {
  await db.insert(players).values({ id: identity.userId, displayName: identity.displayName, avatarUrl: identity.avatarUrl, createdAt: Date.now() })
    .onConflictDoUpdate({ target: players.id, set: { displayName: identity.displayName, avatarUrl: identity.avatarUrl } })
}

async function getTournamentForLeaderboard(db: Database) {
  const active = await getActiveTournament(db)
  if (active) return active
  const [completed] = await db.select().from(tournaments).where(eq(tournaments.status, 'completed')).orderBy(desc(tournaments.updatedAt)).limit(1)
  return completed ?? null
}

async function getOpenTournamentCutPairingForEntry(db: Database, tournamentId: string, entryId: string) {
  const rows = await db.select().from(tournamentCutPairings).where(and(
    eq(tournamentCutPairings.tournamentId, tournamentId),
    inArray(tournamentCutPairings.status, ['scheduled', 'open', 'drafting']),
    or(eq(tournamentCutPairings.entryOneId, entryId), eq(tournamentCutPairings.entryTwoId, entryId)),
  ))
  return rows.sort(compareCutPairingsForLobbyTarget)[0] ?? null
}

function compareCutPairingsForLobbyTarget(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect): number {
  const score = (status: string) => status === 'open' ? 0 : status === 'scheduled' ? 1 : 2
  return score(left.status) - score(right.status) || (left.seedOne + left.seedTwo) - (right.seedOne + right.seedTwo) || left.id.localeCompare(right.id)
}

function normalizeTournamentStage(round: string): TournamentStage {
  if (round === 'quarterfinal' || round === 'semifinal' || round === 'final' || round === 'third_place' || round === 'tiebreaker') return round
  return 'top_cut'
}

async function syncTournamentCutPairingAfterReport(db: Database, pairing: typeof tournamentCutPairings.$inferSelect, matchId: string): Promise<void> {
  const score = await buildTournamentCutSeriesScore(db, pairing)
  const requiredWins = getTopCutRoundRequiredWins(pairing.round)
  const winnerEntryId = score.entryOneWins >= requiredWins ? pairing.entryOneId : score.entryTwoWins >= requiredWins ? pairing.entryTwoId : null
  const representative = winnerEntryId ? (await getEntryRepresentativeIds(db, [winnerEntryId])).get(winnerEntryId) ?? null : null
  const now = Date.now()
  if (!winnerEntryId) {
    await runDbBatch(db, [
      db.update(tournamentCutPairings).set({ sessionId: null, matchId: null, status: 'scheduled', winnerId: null, winnerEntryId: null, updatedAt: now }).where(eq(tournamentCutPairings.id, pairing.id)),
      db.update(tournaments).set({ status: 'top_cut', updatedAt: now }).where(eq(tournaments.id, pairing.tournamentId)),
    ])
    return
  }
  await db.update(tournamentCutPairings).set({ matchId, status: 'reported', winnerEntryId, winnerId: representative, updatedAt: now }).where(eq(tournamentCutPairings.id, pairing.id))
  await advanceTournamentCutIfRoundComplete(db, pairing.tournamentId, pairing.round)
}

async function buildTournamentCutSeriesScore(db: Database, pairing: typeof tournamentCutPairings.$inferSelect): Promise<{ entryOneWins: number, entryTwoWins: number }> {
  if (!pairing.entryOneId || !pairing.entryTwoId) return { entryOneWins: 0, entryTwoWins: 0 }
  const rows = await db.select({ winnerEntryId: tournamentMatches.winnerEntryId }).from(tournamentMatches).where(and(
    eq(tournamentMatches.tournamentId, pairing.tournamentId),
    eq(tournamentMatches.stage, pairing.round),
    eq(tournamentMatches.status, 'reported'),
    or(
      and(eq(tournamentMatches.entryOneId, pairing.entryOneId), eq(tournamentMatches.entryTwoId, pairing.entryTwoId)),
      and(eq(tournamentMatches.entryOneId, pairing.entryTwoId), eq(tournamentMatches.entryTwoId, pairing.entryOneId)),
    ),
  ))
  return { entryOneWins: rows.filter(row => row.winnerEntryId === pairing.entryOneId).length, entryTwoWins: rows.filter(row => row.winnerEntryId === pairing.entryTwoId).length }
}

function getTopCutRoundRequiredWins(round: string): number {
  return round === 'final' ? 3 : 2
}

async function advanceTournamentCutIfRoundComplete(db: Database, tournamentId: string, round: string): Promise<void> {
  if (!isAdvancingTopCutRound(round)) return
  const tournament = await getTournamentById(db, tournamentId)
  if (!tournament || tournament.status !== 'top_cut') return
  const current = await db.select().from(tournamentCutPairings).where(and(eq(tournamentCutPairings.tournamentId, tournamentId), eq(tournamentCutPairings.round, round)))
  if (current.length === 0) return
  const nextRound = getNextTopCutRound(round)
  const now = Date.now()
  if (!nextRound) {
    if (current.some(pairing => pairing.status !== 'reported' || !pairing.winnerEntryId)) return
    await db.update(tournaments).set({ status: 'completed', updatedAt: now }).where(eq(tournaments.id, tournamentId))
    return
  }
  const cutSize = await getTournamentCutSize(db, tournamentId)
  const sorted = [...current].sort((left, right) => compareCutPairingsByBracketPosition(left, right, cutSize))
  const existingNext = await db.select().from(tournamentCutPairings).where(and(eq(tournamentCutPairings.tournamentId, tournamentId), eq(tournamentCutPairings.round, nextRound)))
  const branchWidth = getNextRoundBranchWidth(cutSize, sorted.length)
  let changed = false
  for (let index = 0; index < sorted.length; index += 2) {
    const left = sorted[index]
    const right = sorted[index + 1]
    if (!left || !right) continue
    const leftWinner = getPairingWinner(left)
    const rightWinner = getPairingWinner(right)
    if (!leftWinner || !rightWinner) continue
    const branchIndex = getPairingBranchIndex(left, cutSize, branchWidth)
    const existing = existingNext.find(pairing => getPairingBranchIndex(pairing, cutSize, branchWidth) === branchIndex)
    const representatives = await getEntryRepresentativeIds(db, [leftWinner.entryId, rightWinner.entryId])
    const next = {
      seedOne: leftWinner.seed, seedTwo: rightWinner.seed,
      entryOneId: leftWinner.entryId, entryTwoId: rightWinner.entryId, winnerEntryId: null,
      playerOneId: representatives.get(leftWinner.entryId) ?? null, playerTwoId: representatives.get(rightWinner.entryId) ?? null, winnerId: null,
      sessionId: null, matchId: null, status: 'scheduled' as const, updatedAt: now,
    }
    if (existing) {
      if (!canReplaceUnstartedCutPairing(existing)) continue
      await db.update(tournamentCutPairings).set(next).where(eq(tournamentCutPairings.id, existing.id))
    }
    else {
      await db.insert(tournamentCutPairings).values({
        id: tournamentCutPairingId(tournamentId, nextRound, branchIndex),
        tournamentId,
        round: nextRound,
        ...next,
        createdAt: now,
      }).onConflictDoNothing({ target: tournamentCutPairings.id })
    }
    changed = true
  }
  if (changed) await db.update(tournaments).set({ updatedAt: now }).where(eq(tournaments.id, tournamentId))
}

async function resetTournamentCutPairingAfterCancel(db: Database, pairing: typeof tournamentCutPairings.$inferSelect): Promise<void> {
  const now = Date.now()
  const nextRound = getNextTopCutRound(pairing.round)
  const downstream = nextRound ? await getDirectDownstreamCutPairings(db, pairing, nextRound) : []
  if (!downstream.every(canReplaceUnstartedCutPairing)) {
    await db.update(tournamentCutPairings).set({ status: 'cancelled', winnerId: null, winnerEntryId: null, updatedAt: now }).where(eq(tournamentCutPairings.id, pairing.id))
    return
  }
  if (downstream.length > 0) await db.delete(tournamentCutPairings).where(inArray(tournamentCutPairings.id, downstream.map(row => row.id)))
  await runDbBatch(db, [
    db.update(tournamentCutPairings).set({ sessionId: null, matchId: null, winnerId: null, winnerEntryId: null, status: 'scheduled', updatedAt: now }).where(eq(tournamentCutPairings.id, pairing.id)),
    db.update(tournaments).set({ status: 'top_cut', updatedAt: now }).where(eq(tournaments.id, pairing.tournamentId)),
  ])
}

async function validateTournamentPairingMutation(
  db: Database,
  pairing: typeof tournamentCutPairings.$inferSelect,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const nextRound = getNextTopCutRound(pairing.round)
  if (!nextRound) return { ok: true }
  const downstream = await getDirectDownstreamCutPairings(db, pairing, nextRound)
  if (downstream.every(canReplaceUnstartedCutPairing)) return { ok: true }
  return { ok: false, error: 'This playoff result is locked because the next-round lobby has already started.' }
}

function isAdvancingTopCutRound(round: string): round is typeof ADVANCING_TOP_CUT_ROUNDS[number] {
  return (ADVANCING_TOP_CUT_ROUNDS as readonly string[]).includes(round)
}

function getNextTopCutRound(round: string): 'semifinal' | 'final' | null {
  if (round === 'quarterfinal') return 'semifinal'
  if (round === 'semifinal') return 'final'
  return null
}

function getPairingWinner(pairing: typeof tournamentCutPairings.$inferSelect): { entryId: string, seed: number } | null {
  if (pairing.winnerEntryId === pairing.entryOneId && pairing.entryOneId) return { entryId: pairing.entryOneId, seed: pairing.seedOne }
  if (pairing.winnerEntryId === pairing.entryTwoId && pairing.entryTwoId) return { entryId: pairing.entryTwoId, seed: pairing.seedTwo }
  return null
}

function canReplaceUnstartedCutPairing(pairing: typeof tournamentCutPairings.$inferSelect): boolean {
  return pairing.status === 'scheduled' && !pairing.sessionId && !pairing.matchId
}

async function getDirectDownstreamCutPairings(db: Database, pairing: typeof tournamentCutPairings.$inferSelect, nextRound: 'semifinal' | 'final') {
  const [current, next, cutSize] = await Promise.all([
    db.select().from(tournamentCutPairings).where(and(eq(tournamentCutPairings.tournamentId, pairing.tournamentId), eq(tournamentCutPairings.round, pairing.round))),
    db.select().from(tournamentCutPairings).where(and(eq(tournamentCutPairings.tournamentId, pairing.tournamentId), eq(tournamentCutPairings.round, nextRound))),
    getTournamentCutSize(db, pairing.tournamentId),
  ])
  if (!current.length || !next.length) return []
  const width = getNextRoundBranchWidth(cutSize, current.length)
  const branch = getPairingBranchIndex(pairing, cutSize, width)
  return next.filter(row => getPairingBranchIndex(row, cutSize, width) === branch)
}

function getNextRoundBranchWidth(cutSize: number, currentPairingCount: number): number {
  const nextCount = Math.ceil(currentPairingCount / 2)
  return nextCount > 0 ? Math.max(1, cutSize / nextCount) : Math.max(1, cutSize)
}

function getPairingBranchIndex(pairing: Pick<typeof tournamentCutPairings.$inferSelect, 'seedOne' | 'seedTwo'>, cutSize: number, branchWidth: number): number {
  const positions = new Map(getInitialBracketSeedOrder(cutSize).map((seed, index) => [seed, index]))
  return Math.floor(Math.min(positions.get(pairing.seedOne) ?? pairing.seedOne, positions.get(pairing.seedTwo) ?? pairing.seedTwo) / Math.max(1, branchWidth))
}

async function getTournamentCutSize(db: Database, tournamentId: string): Promise<number> {
  const rows = await db.select({ seedOne: tournamentCutPairings.seedOne, seedTwo: tournamentCutPairings.seedTwo }).from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournamentId))
  return Math.max(0, ...rows.flatMap(row => [row.seedOne, row.seedTwo]))
}

function compareCutPairingsByBracketPosition(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect, cutSize: number): number {
  const positions = new Map(getInitialBracketSeedOrder(cutSize).map((seed, index) => [seed, index]))
  const leftPosition = Math.min(positions.get(left.seedOne) ?? left.seedOne, positions.get(left.seedTwo) ?? left.seedTwo)
  const rightPosition = Math.min(positions.get(right.seedOne) ?? right.seedOne, positions.get(right.seedTwo) ?? right.seedTwo)
  return leftPosition - rightPosition || left.id.localeCompare(right.id)
}

async function buildQualifierOpponentRows(db: Database, tournamentId: string, player: TournamentStandingRow, standings: TournamentStandingRow[], minGames: number, rankByEntryId: Map<string, number>): Promise<TournamentOpponentCardPlayer[]> {
  const matchRows = await db.select({ entryOneId: tournamentMatches.entryOneId, entryTwoId: tournamentMatches.entryTwoId }).from(tournamentMatches).where(and(
    eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.status, 'reported'),
    or(eq(tournamentMatches.entryOneId, player.entryId), eq(tournamentMatches.entryTwoId, player.entryId)),
  ))
  const meetings = new Map<string, number>()
  for (const match of matchRows) {
    const opponent = match.entryOneId === player.entryId ? match.entryTwoId : match.entryOneId
    if (opponent) meetings.set(opponent, (meetings.get(opponent) ?? 0) + 1)
  }
  return standings.filter(row => row.entryId !== player.entryId)
    .map(row => ({ row, meetings: meetings.get(row.entryId) ?? 0 }))
    .sort((left, right) => compareTournamentRecommendationRows(player, left, right)).slice(0, 8)
    .map(entry => ({ ...toOpponentCardPlayer(entry.row, rankByEntryId.get(entry.row.entryId) ?? null), note: buildOpponentRecommendationNote(player, entry.row, entry.meetings, minGames) }))
}

function compareTournamentRecommendationRows(player: TournamentStandingRow, left: { row: TournamentStandingRow, meetings: number }, right: { row: TournamentStandingRow, meetings: number }): number {
  return left.meetings - right.meetings
    || getRecordDistance(player, left.row) - getRecordDistance(player, right.row)
    || Math.abs(left.row.winRate - player.winRate) - Math.abs(right.row.winRate - player.winRate)
    || compareTournamentStandingRows(left.row, right.row)
}

function getRecordDistance(player: TournamentStandingRow, opponent: TournamentStandingRow): number {
  return Math.abs(opponent.wins - player.wins) + Math.abs(opponent.losses - player.losses)
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

async function buildTopCutOpponentCardPairing(db: Database, tournamentId: string, entryId: string, standings: TournamentStandingRow[]): Promise<TournamentOpponentCardData['pairing']> {
  const pairing = await getOpenTournamentCutPairingForEntry(db, tournamentId, entryId)
  if (!pairing?.entryOneId || !pairing.entryTwoId) return null
  const one = standings.find(row => row.entryId === pairing.entryOneId)
  const two = standings.find(row => row.entryId === pairing.entryTwoId)
  if (!one || !two) return null
  const ranks = new Map(standings.map((row, index) => [row.entryId, index + 1]))
  return { round: pairing.round, seedOne: pairing.seedOne, seedTwo: pairing.seedTwo, playerOne: toOpponentCardPlayer(one, ranks.get(one.entryId)), playerTwo: toOpponentCardPlayer(two, ranks.get(two.entryId)) }
}

function toOpponentCardPlayer(row: TournamentStandingRow, rank?: number | null): TournamentOpponentCardPlayer {
  return { entryId: row.entryId, members: row.members, playerId: row.playerId, displayName: row.displayName, avatarUrl: row.avatarUrl, rank: rank ?? null, seed: row.seed, games: row.games, wins: row.wins, losses: row.losses, winRate: row.winRate }
}

function tournamentTopCutStandingsScope(tournamentId: string): string { return `tournament:${tournamentId}:top-cut` }
function tournamentTopCutBracketScope(tournamentId: string): string { return `tournament:${tournamentId}:bracket` }

async function deleteStaleTournamentLeaderboardPageMessages(db: Database, token: string, channelId: string): Promise<void> {
  for (const scope of ['tournament:active:2', 'tournament:active:3']) {
    const [existing] = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope)).limit(1)
    if (!existing) continue
    if (existing.channelId === channelId) {
      try { await deleteChannelMessage(token, channelId, existing.messageId) }
      catch (error) { if (!isDiscordApiError(error, 404)) throw error }
    }
    await db.delete(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope))
  }
}

async function upsertLeaderboardMessage(db: Database, token: string, channelId: string, scope: string, data: Uint8Array, filename: string): Promise<void> {
  const [existing] = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope)).limit(1)
  if (existing?.channelId === channelId) {
    try {
      await editChannelMessageWithFile({ token, channelId, messageId: existing.messageId, filename, contentType: 'image/png', data })
      await upsertTournamentLeaderboardMessageState(db, scope, channelId, existing.messageId)
      return
    }
    catch (error) { if (!isDiscordApiError(error, 404)) throw error }
  }
  const created = await createChannelMessageWithFile({ token, channelId, filename, contentType: 'image/png', data })
  await upsertTournamentLeaderboardMessageState(db, scope, channelId, created.id)
}

async function deleteLeaderboardMessage(db: Database, token: string, channelId: string, scope: string): Promise<void> {
  const [existing] = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope)).limit(1)
  if (!existing) return
  if (existing.channelId === channelId) {
    try { await deleteChannelMessage(token, channelId, existing.messageId) }
    catch (error) { if (!isDiscordApiError(error, 404)) throw error }
  }
  await db.delete(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope))
}

async function upsertTournamentLeaderboardMessageState(db: Database, scope: string, channelId: string, messageId: string): Promise<void> {
  await db.insert(leaderboardMessageStates).values({ scope, channelId, messageId, updatedAt: Date.now() }).onConflictDoUpdate({ target: leaderboardMessageStates.scope, set: { channelId, messageId, updatedAt: Date.now() } })
}

async function countReportedMeetings(db: Database, tournamentId: string, leftEntryId: string, rightEntryId: string): Promise<number> {
  const rows = await db.select({ sessionId: tournamentMatches.sessionId }).from(tournamentMatches).where(and(
    eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.status, 'reported'),
    or(
      and(eq(tournamentMatches.entryOneId, leftEntryId), eq(tournamentMatches.entryTwoId, rightEntryId)),
      and(eq(tournamentMatches.entryOneId, rightEntryId), eq(tournamentMatches.entryTwoId, leftEntryId)),
    ),
  ))
  return rows.length
}

async function buildRematchWarning(db: Database, tournamentId: string, leftEntryId: string, rightEntryId: string): Promise<string | null> {
  return await countReportedMeetings(db, tournamentId, leftEntryId, rightEntryId) > 0 ? 'Rematch: these entries have already played against each other.' : null
}

function getOrCreateStats(stats: Map<string, { games: number, wins: number, opponentIds: string[] }>, entryId: string) {
  const existing = stats.get(entryId)
  if (existing) return existing
  const created = { games: 0, wins: 0, opponentIds: [] as string[] }
  stats.set(entryId, created)
  return created
}

function getWinRate(stats: { games: number, wins: number } | null | undefined): number { return !stats || stats.games <= 0 ? 0 : stats.wins / stats.games }

function compareTournamentStandingRows(left: TournamentStandingRow, right: TournamentStandingRow): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  return right.winRate - left.winRate || right.wins - left.wins || right.opponentWinRate - left.opponentWinRate || (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER) || left.entryId.localeCompare(right.entryId)
}

function resolveTopCutRound(cutSize: number): string { return cutSize === 2 ? 'final' : cutSize === 4 ? 'semifinal' : cutSize === 8 ? 'quarterfinal' : 'top_cut' }

function tournamentCutPairingId(tournamentId: string, round: string, bracketSlot: number): string {
  return `cut:${tournamentId}:${round}:${bracketSlot}`
}

function getInitialBracketSeedOrder(cutSize: number): number[] {
  if (!isPowerOfTwo(cutSize)) return Array.from({ length: cutSize / 2 }, (_, index) => [index + 1, cutSize - index]).flat()
  let seeds = [1, 2]
  while (seeds.length < cutSize) {
    const size = seeds.length * 2
    seeds = seeds.flatMap(seed => [seed, size + 1 - seed])
  }
  return seeds
}

function isPowerOfTwo(value: number): boolean { return value > 0 && (value & (value - 1)) === 0 }

function compareCutPairingsForDisplay(left: typeof tournamentCutPairings.$inferSelect, right: typeof tournamentCutPairings.$inferSelect, cutSize: number): number {
  const score = (round: string) => round === 'quarterfinal' ? 0 : round === 'semifinal' ? 1 : round === 'final' ? 2 : 3
  return score(left.round) - score(right.round) || compareCutPairingsByBracketPosition(left, right, cutSize) || left.seedOne - right.seedOne || left.id.localeCompare(right.id)
}

function getCutSizeFromPairings(pairings: Array<typeof tournamentCutPairings.$inferSelect>): number { return Math.max(0, ...pairings.flatMap(pairing => [pairing.seedOne, pairing.seedTwo])) }

function formatTournamentMatchLabel(stage: string, winnerEntryId: string | null): string {
  const label = stage === 'qualifier' ? 'Qualifier match' : `${stage.replace(/_/g, ' ')} match`
  return winnerEntryId ? `${label} - winner reported` : label
}

function legacyEntryId(tournamentId: string, displayName: string): string {
  return `legacy:${tournamentId}:${Array.from(new TextEncoder().encode(displayName)).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function duplicateValues<T>(values: T[], key: (value: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value])
  return [...groups.values()].filter(group => group.length > 1)
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
      if (char === '"' && next === '"') { field += '"'; index += 1; continue }
      if (char === '"') { quoted = false; continue }
      field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (char !== '\r') field += char
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
  const candidate = /^<@!?(\d+)>$/.exec(trimmed)?.[1] ?? trimmed
  return /^\d{16,22}$/.test(candidate) ? candidate : null
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function normalizeIdentityName(value: string): string { return value.trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '') }
