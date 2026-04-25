import type { Database } from '@civup/db'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type SessionPhase, type SessionRecord } from '../../session-runtime/session-record.ts'

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

export async function projectSessionRecord(
  db: Database,
  record: SessionRecord,
): Promise<void> {
  const liveMemberIds = isLiveSessionPhase(record.phase)
    ? record.roster.participants.map(member => member.playerId)
    : []
  const now = record.closedAt ?? Math.max(record.updatedAt, record.lastActivityAt, 1)

  const appliedRows = await db.insert(sessionDirectory)
    .values({
      sessionId: record.id,
      phase: record.phase,
      mode: record.mode,
      guildId: record.guildId,
      channelId: record.projectionState.channelId,
      hostId: record.hostId,
      messageId: record.projectionState.messageId,
      matchId: record.matchId,
      steamLobbyLink: record.projectionState.steamLobbyLink,
      version: record.version,
      rosterJson: JSON.stringify(record.roster),
      configJson: JSON.stringify(record.config),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivityAt: record.lastActivityAt,
      closedAt: isLiveSessionPhase(record.phase) ? null : now,
    })
    .onConflictDoUpdate({
      target: sessionDirectory.sessionId,
      set: {
        phase: record.phase,
        mode: record.mode,
        guildId: record.guildId,
        channelId: record.projectionState.channelId,
        hostId: record.hostId,
        messageId: record.projectionState.messageId,
        matchId: record.matchId,
        steamLobbyLink: record.projectionState.steamLobbyLink,
        version: record.version,
        rosterJson: JSON.stringify(record.roster),
        configJson: JSON.stringify(record.config),
        updatedAt: record.updatedAt,
        lastActivityAt: record.lastActivityAt,
        closedAt: isLiveSessionPhase(record.phase) ? null : now,
      },
      where: sql`excluded.version > ${sessionDirectory.version}`,
    })
    .returning({ version: sessionDirectory.version })

  if (!appliedRows.some(row => row.version === record.version)) return

  await reconcileDirectoryMembers(db, record.id, liveMemberIds, now)
}

function isLiveSessionPhase(phase: SessionPhase): boolean {
  return phase === 'open' || phase === 'draft' || phase === 'swap'
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
  if (message.includes('session_directory_members_live_player_idx')
    || message.includes('session_directory_members.player_id')
    || message.includes('UNIQUE constraint failed')
    || message.includes('constraint failed')) return true

  const cause = error && typeof error === 'object' && 'cause' in error ? (error as { cause?: unknown }).cause : null
  return cause != null && cause !== error && isLiveMembershipUniquenessError(cause)
}
