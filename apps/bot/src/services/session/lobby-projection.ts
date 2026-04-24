import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import type { SessionConfig, SessionPhase, SessionRoster } from '../../session-runtime/session-record.ts'
import { sessionDirectory } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { desc, eq, or } from 'drizzle-orm'
import { buildLobbyDraftConfigFromSessionConfig } from '../../session-runtime/session-record.ts'

type SessionDirectoryRow = typeof sessionDirectory.$inferSelect

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
