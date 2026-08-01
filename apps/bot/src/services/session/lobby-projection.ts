import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { SessionPhase, SessionRoster } from '../../session-runtime/session-record.ts'
import type { LobbyState } from '../lobby/types.ts'
import { matches, matchParticipants, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { buildLobbyDraftConfigFromSessionConfig, parseStoredSessionDirectoryConfig } from '../../session-runtime/session-record.ts'
import { SESSION_DIRECTORY_OPEN_STALE_MS } from './directory.ts'

type SessionDirectoryRow = typeof sessionDirectory.$inferSelect

export interface SessionOrigin {
  sessionId: string
  matchId: string | null
  guildId: string | null
  channelId: string
  messageId: string
}

const LIVE_PROJECTION_PHASES = ['open', 'draft', 'swap', 'active'] as const
const LIVE_MEMBERSHIP_PHASES = ['open', 'draft'] as const

export async function getLiveSessionLobbyProjections(
  db: Database,
  options: { mode?: GameMode, guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  if (options.guildIds?.length === 0) return []
  const conditions = [inArray(sessionDirectory.phase, [...LIVE_PROJECTION_PHASES])]
  if (options.mode) conditions.push(eq(sessionDirectory.mode, options.mode))
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))

  const rows = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt))

  return filterStaleOpenDirectoryRows(rows).flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionsByMode(
  db: Database,
  mode: GameMode,
  options: { includeStale?: boolean, guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  if (options.guildIds?.length === 0) return []
  const conditions = [
    eq(sessionDirectory.mode, mode),
    eq(sessionDirectory.phase, 'open'),
  ]
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))
  const rows = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(asc(sessionDirectory.createdAt))

  const visibleRows = options.includeStale ? rows : filterStaleOpenDirectoryRows(rows)
  return visibleRows.flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionsByChannel(
  db: Database,
  channelId: string,
  options: { guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  if (options.guildIds?.length === 0) return []
  const conditions = [
    eq(sessionDirectory.channelId, channelId),
    eq(sessionDirectory.phase, 'open'),
  ]
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))
  const rows = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt))

  return filterStaleOpenDirectoryRows(rows).flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionForPlayer(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[], guildIds?: readonly string[] } = {},
): Promise<LobbyState | null> {
  return (await getCurrentSessionLobbyProjectionsForPlayer(db, playerId, options))
    .find(lobby => lobby.status === 'open') ?? null
}

export async function getCurrentSessionLobbyProjectionsForPlayers(
  db: Database,
  playerIds: readonly string[],
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[], guildIds?: readonly string[] } = {},
): Promise<Map<string, LobbyState | null>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const result = new Map<string, LobbyState | null>()
  for (const playerId of uniquePlayerIds) result.set(playerId, null)
  if (uniquePlayerIds.length === 0) return result
  if (options.guildIds?.length === 0) return result

  const conditions = [
    inArray(sessionDirectoryMembers.playerId, uniquePlayerIds),
    isNull(sessionDirectoryMembers.leftAt),
    inArray(sessionDirectory.phase, [...LIVE_MEMBERSHIP_PHASES]),
  ]
  if (options.mode) conditions.push(eq(sessionDirectory.mode, options.mode))
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))

  const rows = await db.select({ playerId: sessionDirectoryMembers.playerId, session: sessionDirectory })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectory.sessionId, sessionDirectoryMembers.sessionId))
    .where(and(...conditions))
    .orderBy(desc(sessionDirectory.updatedAt))

  const excludedLobbyIds = new Set(options.excludeLobbyIds ?? [])
  for (const row of rows) {
    if (result.get(row.playerId)) continue
    if (excludedLobbyIds.has(row.session.sessionId)) continue
    if (isStaleOpenDirectoryRow(row.session)) continue
    const lobby = parseSessionLobbyProjection(row.session)
    if (!lobby) continue
    result.set(row.playerId, lobby)
  }

  return result
}

export async function getCurrentSessionLobbyProjectionsForPlayer(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[], guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  const lobby = (await getCurrentSessionLobbyProjectionsForPlayers(db, [playerId], options)).get(playerId) ?? null
  return lobby ? [lobby] : []
}

export async function getLiveSessionLobbyProjectionsForUser(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[], guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  const bySessionId = new Map<string, LobbyState>()
  for (const lobby of await getCurrentSessionLobbyProjectionsForPlayer(db, playerId, options)) {
    bySessionId.set(lobby.id, lobby)
  }

  if (options.guildIds?.length === 0) return [...bySessionId.values()]
  const matchConditions = [
    eq(matchParticipants.playerId, playerId),
    inArray(matches.status, ['drafting', 'active']),
  ]
  if (options.guildIds) matchConditions.push(inArray(matches.guildId, [...options.guildIds]))
  const matchRows = await db.select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(...matchConditions))
    .orderBy(desc(matches.createdAt))

  const excludedLobbyIds = new Set(options.excludeLobbyIds ?? [])
  for (const row of matchRows) {
    const lobby = await getSessionLobbyProjectionByMatch(db, row.matchId, { guildIds: options.guildIds })
    if (!lobby) continue
    if (options.mode && lobby.mode !== options.mode) continue
    if (excludedLobbyIds.has(lobby.id)) continue
    if (lobby.status !== 'drafting' && lobby.status !== 'active') continue
    bySessionId.set(lobby.id, lobby)
  }

  return [...bySessionId.values()].sort(compareLobbyProjectionByUpdatedAtDesc)
}

export async function getOpenSessionLobbyProjectionHostedBy(
  db: Database,
  hostId: string,
  options: { guildIds?: readonly string[] } = {},
): Promise<LobbyState | null> {
  if (options.guildIds?.length === 0) return null
  const conditions = [
    eq(sessionDirectory.hostId, hostId),
    eq(sessionDirectory.phase, 'open'),
  ]
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))
  const rows = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(asc(sessionDirectory.createdAt))

  return filterStaleOpenDirectoryRows(rows).flatMap(row => parseSessionLobbyProjection(row) ?? [])[0] ?? null
}

export async function getLiveSessionLobbyProjectionsHostedBy(
  db: Database,
  hostId: string,
  options: { guildIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  if (options.guildIds?.length === 0) return []
  const conditions = [
    eq(sessionDirectory.hostId, hostId),
    inArray(sessionDirectory.phase, [...LIVE_PROJECTION_PHASES]),
  ]
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))
  const rows = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt))

  return filterStaleOpenDirectoryRows(rows).flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

function filterStaleOpenDirectoryRows(rows: SessionDirectoryRow[]): SessionDirectoryRow[] {
  const now = Date.now()
  return rows.filter(row => !isStaleOpenDirectoryRow(row, now))
}

function isStaleOpenDirectoryRow(row: Pick<SessionDirectoryRow, 'phase' | 'updatedAt' | 'lastActivityAt'>, now: number = Date.now()): boolean {
  return row.phase === 'open' && now - Math.max(row.updatedAt, row.lastActivityAt) >= SESSION_DIRECTORY_OPEN_STALE_MS
}

export async function getSessionLobbyProjectionByMatch(
  db: Database,
  matchId: string,
  options: { guildIds?: readonly string[] } = {},
): Promise<LobbyState | null> {
  if (options.guildIds?.length === 0) return null
  const matchCondition = or(
    eq(sessionDirectory.matchId, matchId),
    eq(sessionDirectory.sessionId, matchId),
  )!
  const conditions = [matchCondition]
  if (options.guildIds) conditions.push(inArray(sessionDirectory.guildId, [...options.guildIds]))
  const [row] = await db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt)).limit(1)

  return row ? parseSessionLobbyProjection(row) : null
}

export async function getSessionOriginByMatch(
  db: Database,
  matchId: string,
): Promise<SessionOrigin | null> {
  const [row] = await db.select({
    sessionId: sessionDirectory.sessionId,
    matchId: sessionDirectory.matchId,
    guildId: sessionDirectory.guildId,
    channelId: sessionDirectory.channelId,
    messageId: sessionDirectory.messageId,
  }).from(sessionDirectory).where(or(
    eq(sessionDirectory.matchId, matchId),
    eq(sessionDirectory.sessionId, matchId),
  )).orderBy(desc(sessionDirectory.updatedAt)).limit(1)

  return row ?? null
}

export async function resolveMatchOriginGuildId(
  db: Database,
  matchId: string,
): Promise<string> {
  const guildId = await getStoredMatchGuildId(db, matchId)
  if (!guildId) throw new Error(`Match ${matchId} is missing owning-server data`)
  return guildId
}

export async function getStoredMatchGuildId(db: Database, matchId: string): Promise<string | null> {
  const [row] = await db.select({ guildId: matches.guildId }).from(matches).where(eq(matches.id, matchId)).limit(1)
  return row?.guildId ?? null
}

function compareLobbyProjectionByUpdatedAtDesc(left: LobbyState, right: LobbyState): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.id.localeCompare(right.id)
}

export function parseSessionLobbyProjection(row: SessionDirectoryRow): LobbyState | null {
  if (!isSessionPhase(row.phase) || !isGameMode(row.mode)) return null
  const roster = parseSessionRoster(row.rosterJson)
  const storedConfig = parseStoredSessionDirectoryConfig(row.configJson, row.mode)
  if (!roster || !storedConfig) return null
  const { config, gameSettings } = storedConfig

  return {
    id: row.sessionId,
    mode: row.mode,
    status: mapSessionPhaseToLobbyStatus(row.phase),
    guildId: row.guildId,
    hostId: row.hostId,
    channelId: row.channelId,
    messageId: row.messageId,
    matchId: row.matchId,
    steamLobbyLink: row.steamLobbyLink,
    minRole: config.minRole,
    maxRole: config.maxRole,
    lastArrange: null,
    lastActivityAt: row.lastActivityAt,
    memberPlayerIds: roster.participants.map(member => member.playerId),
    slots: [...roster.slots],
    draftConfig: buildLobbyDraftConfigFromSessionConfig(config),
    gameSettings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.version,
  }
}

function parseSessionRoster(raw: string): SessionRoster | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRoster>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.participants) || !Array.isArray(parsed.slots)) return null

    const participants = parsed.participants.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const member = candidate as Partial<SessionRoster['participants'][number]>
      if (typeof member.playerId !== 'string' || member.playerId.length === 0) return []
      return [{
        playerId: member.playerId,
        displayName: typeof member.displayName === 'string' ? member.displayName : null,
        avatarUrl: typeof member.avatarUrl === 'string' ? member.avatarUrl : null,
        ...(parseSourceGuild(member.sourceGuild) ? { sourceGuild: parseSourceGuild(member.sourceGuild)! } : {}),
        joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : 0,
        ...(Array.isArray(member.partyIds) ? { partyIds: member.partyIds.filter((partyId): partyId is string => typeof partyId === 'string') } : {}),
        slotIndex: typeof member.slotIndex === 'number' ? member.slotIndex : null,
      }]
    })

    return {
      participants,
      slots: parsed.slots.map(slot => typeof slot === 'string' ? slot : null),
    }
  }
  catch {
    return null
  }
}

function parseSourceGuild(value: unknown): NonNullable<SessionRoster['participants'][number]['sourceGuild']> | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { id?: unknown, name?: unknown, iconUrl?: unknown }
  if (typeof candidate.id !== 'string' || !/^\d{17,20}$/.test(candidate.id)) return null
  return {
    id: candidate.id,
    ...(typeof candidate.name === 'string' && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
    ...(typeof candidate.iconUrl === 'string' && candidate.iconUrl.startsWith('https://') ? { iconUrl: candidate.iconUrl } : {}),
  }
}

function mapSessionPhaseToLobbyStatus(phase: SessionPhase): LobbyState['status'] {
  switch (phase) {
    case 'open':
      return 'open'
    case 'draft':
      return 'drafting'
    case 'swap':
    case 'active':
      return 'active'
    case 'reported':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
  }
}

function isSessionPhase(value: string): value is SessionPhase {
  return value === 'open' || value === 'draft' || value === 'swap' || value === 'active' || value === 'reported' || value === 'cancelled'
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
}
