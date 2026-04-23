import type { Database } from '@civup/db'
import type { LobbyState } from '../lobby/types.ts'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { buildOpenSessionRecordFromLobby, buildSessionRoster, type SessionPhase } from '../../session-runtime/session-record.ts'

export class SessionAdmissionError extends Error {
  constructor(
    message: string,
    readonly playerIds: readonly string[],
  ) {
    super(message)
    this.name = 'SessionAdmissionError'
  }
}

export function isSessionAdmissionError(error: unknown): error is SessionAdmissionError {
  return error instanceof SessionAdmissionError
}

export function formatSessionAdmissionError(error: SessionAdmissionError): string {
  const players = error.playerIds.length > 0
    ? error.playerIds.map(playerId => `<@${playerId}>`).join(', ')
    : 'A requested player'
  return `${players} already ${error.playerIds.length === 1 ? 'has' : 'have'} a live session. Finish, cancel, or leave it before joining another one.`
}

export async function projectLobbySession(
  db: Database,
  lobby: LobbyState,
): Promise<void> {
  const phase = mapLobbyStatusToSessionPhase(lobby.status)
  const liveMemberIds = isLiveSessionPhase(phase) ? lobby.memberPlayerIds : []
  const record = buildOpenSessionRecordFromLobby(lobby)
  const roster = buildSessionRoster(lobby)
  const now = Math.max(lobby.updatedAt, lobby.lastActivityAt, 1)

  await db.insert(sessionDirectory)
    .values({
      sessionId: lobby.id,
      phase,
      mode: lobby.mode,
      guildId: lobby.guildId,
      channelId: lobby.channelId,
      hostId: lobby.hostId,
      messageId: lobby.messageId,
      matchId: lobby.matchId,
      steamLobbyLink: lobby.steamLobbyLink,
      version: lobby.revision,
      rosterJson: JSON.stringify(roster),
      configJson: JSON.stringify(record.config),
      createdAt: lobby.createdAt,
      updatedAt: lobby.updatedAt,
      lastActivityAt: lobby.lastActivityAt,
      closedAt: isLiveSessionPhase(phase) ? null : now,
    })
    .onConflictDoUpdate({
      target: sessionDirectory.sessionId,
      set: {
        phase,
        mode: lobby.mode,
        guildId: lobby.guildId,
        channelId: lobby.channelId,
        hostId: lobby.hostId,
        messageId: lobby.messageId,
        matchId: lobby.matchId,
        steamLobbyLink: lobby.steamLobbyLink,
        version: lobby.revision,
        rosterJson: JSON.stringify(roster),
        configJson: JSON.stringify(record.config),
        updatedAt: lobby.updatedAt,
        lastActivityAt: lobby.lastActivityAt,
        closedAt: isLiveSessionPhase(phase) ? null : now,
      },
    })

  await reconcileDirectoryMembers(db, lobby.id, liveMemberIds, now)
}

export async function closeLobbySessionProjection(
  db: Database,
  sessionId: string,
  closedAt = Date.now(),
): Promise<void> {
  await db.update(sessionDirectoryMembers)
    .set({ leftAt: closedAt, updatedAt: closedAt })
    .where(and(
      eq(sessionDirectoryMembers.sessionId, sessionId),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  await db.update(sessionDirectory)
    .set({ phase: 'cancelled', closedAt, updatedAt: closedAt })
    .where(eq(sessionDirectory.sessionId, sessionId))
}

export async function closeLobbySessionProjectionByMatch(
  db: Database,
  matchId: string,
  closedAt = Date.now(),
): Promise<void> {
  const [row] = await db.select({ sessionId: sessionDirectory.sessionId })
    .from(sessionDirectory)
    .where(eq(sessionDirectory.matchId, matchId))
    .limit(1)

  if (!row) return
  await closeLobbySessionProjection(db, row.sessionId, closedAt)
}

export function mapLobbyStatusToSessionPhase(status: LobbyState['status']): SessionPhase {
  switch (status) {
    case 'open':
      return 'open'
    case 'drafting':
      return 'draft'
    case 'active':
      return 'active'
    case 'completed':
      return 'reported'
    case 'cancelled':
    case 'scrubbed':
      return 'cancelled'
  }
}

function isLiveSessionPhase(phase: SessionPhase): boolean {
  return phase === 'open' || phase === 'draft'
}

async function reconcileDirectoryMembers(
  db: Database,
  sessionId: string,
  liveMemberIds: readonly string[],
  now: number,
): Promise<void> {
  const uniqueLiveMemberIds = [...new Set(liveMemberIds)]
  const existingLiveRows = await db.select({
    playerId: sessionDirectoryMembers.playerId,
  })
    .from(sessionDirectoryMembers)
    .where(and(
      eq(sessionDirectoryMembers.sessionId, sessionId),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  const nextLiveMemberIdSet = new Set(uniqueLiveMemberIds)
  const departedPlayerIds = existingLiveRows
    .map(row => row.playerId)
    .filter(playerId => !nextLiveMemberIdSet.has(playerId))

  if (departedPlayerIds.length > 0) {
    await db.update(sessionDirectoryMembers)
      .set({ leftAt: now, updatedAt: now })
      .where(and(
        eq(sessionDirectoryMembers.sessionId, sessionId),
        inArray(sessionDirectoryMembers.playerId, departedPlayerIds),
        isNull(sessionDirectoryMembers.leftAt),
      ))
  }

  for (const playerId of uniqueLiveMemberIds) {
    try {
      await db.insert(sessionDirectoryMembers)
        .values({
          sessionId,
          playerId,
          role: 'participant',
          joinedAt: now,
          leftAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [sessionDirectoryMembers.sessionId, sessionDirectoryMembers.playerId],
          set: {
            role: 'participant',
            leftAt: null,
            updatedAt: now,
          },
        })
    }
    catch (error) {
      if (isLiveMembershipUniquenessError(error)) {
        throw new SessionAdmissionError('Player already has a live session', [playerId])
      }
      throw error
    }
  }
}

function isLiveMembershipUniquenessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('session_directory_members_live_player_idx')
    || message.includes('session_directory_members.player_id')
    || message.includes('UNIQUE constraint failed')
    || message.includes('constraint failed')
}
