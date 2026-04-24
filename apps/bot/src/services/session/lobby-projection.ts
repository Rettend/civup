import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import type { SessionConfig, SessionPhase, SessionRoster } from '../../session-runtime/session-record.ts'
import { matches, matchParticipants, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { buildLobbyDraftConfigFromSessionConfig } from '../../session-runtime/session-record.ts'

type SessionDirectoryRow = typeof sessionDirectory.$inferSelect

const LIVE_PROJECTION_PHASES = ['open', 'draft', 'swap', 'active'] as const
const LIVE_MEMBERSHIP_PHASES = ['open', 'draft', 'swap'] as const

export async function getLiveSessionLobbyProjections(
  db: Database,
  options: { mode?: GameMode } = {},
): Promise<LobbyState[]> {
  const conditions = [inArray(sessionDirectory.phase, [...LIVE_PROJECTION_PHASES])]
  if (options.mode) conditions.push(eq(sessionDirectory.mode, options.mode))

  const rows = await db.select().from(sessionDirectory)
    .where(and(...conditions))
    .orderBy(desc(sessionDirectory.updatedAt))

  return rows.flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionsByMode(
  db: Database,
  mode: GameMode,
): Promise<LobbyState[]> {
  const rows = await db.select().from(sessionDirectory)
    .where(and(
      eq(sessionDirectory.mode, mode),
      eq(sessionDirectory.phase, 'open'),
    ))
    .orderBy(asc(sessionDirectory.createdAt))

  return rows.flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionsByChannel(
  db: Database,
  channelId: string,
): Promise<LobbyState[]> {
  const rows = await db.select().from(sessionDirectory)
    .where(and(
      eq(sessionDirectory.channelId, channelId),
      eq(sessionDirectory.phase, 'open'),
    ))
    .orderBy(desc(sessionDirectory.updatedAt))

  return rows.flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getOpenSessionLobbyProjectionForPlayer(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[] } = {},
): Promise<LobbyState | null> {
  return (await getCurrentSessionLobbyProjectionsForPlayer(db, playerId, options))
    .find(lobby => lobby.status === 'open') ?? null
}

export async function getCurrentSessionLobbyProjectionsForPlayers(
  db: Database,
  playerIds: readonly string[],
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[] } = {},
): Promise<Map<string, LobbyState | null>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const result = new Map<string, LobbyState | null>()
  for (const playerId of uniquePlayerIds) result.set(playerId, null)
  if (uniquePlayerIds.length === 0) return result

  const conditions = [
    inArray(sessionDirectoryMembers.playerId, uniquePlayerIds),
    isNull(sessionDirectoryMembers.leftAt),
    inArray(sessionDirectory.phase, [...LIVE_MEMBERSHIP_PHASES]),
  ]
  if (options.mode) conditions.push(eq(sessionDirectory.mode, options.mode))

  const rows = await db.select({ playerId: sessionDirectoryMembers.playerId, session: sessionDirectory })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectory.sessionId, sessionDirectoryMembers.sessionId))
    .where(and(...conditions))
    .orderBy(desc(sessionDirectory.updatedAt))

  const excludedLobbyIds = new Set(options.excludeLobbyIds ?? [])
  for (const row of rows) {
    if (result.get(row.playerId)) continue
    if (excludedLobbyIds.has(row.session.sessionId)) continue
    const lobby = parseSessionLobbyProjection(row.session)
    if (!lobby) continue
    result.set(row.playerId, lobby)
  }

  return result
}

export async function getCurrentSessionLobbyProjectionsForPlayer(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  const lobby = (await getCurrentSessionLobbyProjectionsForPlayers(db, [playerId], options)).get(playerId) ?? null
  return lobby ? [lobby] : []
}

export async function getLiveSessionLobbyProjectionsForUser(
  db: Database,
  playerId: string,
  options: { mode?: GameMode, excludeLobbyIds?: readonly string[] } = {},
): Promise<LobbyState[]> {
  const bySessionId = new Map<string, LobbyState>()
  for (const lobby of await getCurrentSessionLobbyProjectionsForPlayer(db, playerId, options)) {
    bySessionId.set(lobby.id, lobby)
  }

  const matchRows = await db.select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      eq(matchParticipants.playerId, playerId),
      inArray(matches.status, ['drafting', 'active']),
    ))
    .orderBy(desc(matches.createdAt))

  const excludedLobbyIds = new Set(options.excludeLobbyIds ?? [])
  for (const row of matchRows) {
    const lobby = await getSessionLobbyProjectionByMatch(db, row.matchId)
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
): Promise<LobbyState | null> {
  const rows = await db.select().from(sessionDirectory)
    .where(and(
      eq(sessionDirectory.hostId, hostId),
      eq(sessionDirectory.phase, 'open'),
    ))
    .orderBy(asc(sessionDirectory.createdAt))

  return rows.flatMap(row => parseSessionLobbyProjection(row) ?? [])[0] ?? null
}

export async function getLiveSessionLobbyProjectionsHostedBy(
  db: Database,
  hostId: string,
): Promise<LobbyState[]> {
  const rows = await db.select().from(sessionDirectory)
    .where(and(
      eq(sessionDirectory.hostId, hostId),
      inArray(sessionDirectory.phase, [...LIVE_PROJECTION_PHASES]),
    ))
    .orderBy(desc(sessionDirectory.updatedAt))

  return rows.flatMap(row => parseSessionLobbyProjection(row) ?? [])
}

export async function getSessionLobbyProjectionByMatch(
  db: Database,
  matchId: string,
): Promise<LobbyState | null> {
  const [row] = await db.select().from(sessionDirectory)
    .where(or(
      eq(sessionDirectory.matchId, matchId),
      eq(sessionDirectory.sessionId, matchId),
    ))
    .orderBy(desc(sessionDirectory.updatedAt))
    .limit(1)

  return row ? parseSessionLobbyProjection(row) : null
}

function compareLobbyProjectionByUpdatedAtDesc(left: LobbyState, right: LobbyState): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.id.localeCompare(right.id)
}

export function parseSessionLobbyProjection(row: SessionDirectoryRow): LobbyState | null {
  if (!isSessionPhase(row.phase) || !isGameMode(row.mode)) return null
  const roster = parseSessionRoster(row.rosterJson)
  const config = parseSessionConfig(row.configJson)
  if (!roster || !config) return null

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

function parseSessionConfig(raw: string): SessionConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionConfig>
    if (!parsed || typeof parsed !== 'object') return null

    return {
      banTimerSeconds: typeof parsed.banTimerSeconds === 'number' ? parsed.banTimerSeconds : null,
      pickTimerSeconds: typeof parsed.pickTimerSeconds === 'number' ? parsed.pickTimerSeconds : null,
      leaderPoolSize: typeof parsed.leaderPoolSize === 'number' ? parsed.leaderPoolSize : null,
      leaderDataVersion: parsed.leaderDataVersion === 'beta' ? 'beta' : 'live',
      mapVoteEnabled: parsed.mapVoteEnabled === true,
      blindBans: parsed.blindBans === true,
      simultaneousPick: parsed.simultaneousPick === true,
      redDeath: parsed.redDeath === true,
      dealOptionsSize: typeof parsed.dealOptionsSize === 'number' ? parsed.dealOptionsSize : null,
      randomDraft: parsed.randomDraft === true,
      duplicateFactions: parsed.duplicateFactions === true,
      minRole: parsed.minRole ?? null,
      maxRole: parsed.maxRole ?? null,
    }
  }
  catch {
    return null
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
