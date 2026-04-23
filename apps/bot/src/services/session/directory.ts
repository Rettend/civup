import type { Database } from '@civup/db'
import type { LobbyState } from '../lobby/types.ts'
import { matches, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { buildSessionConfig, buildSessionRoster, type SessionPhase } from '../../session-runtime/session-record.ts'

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
  const roster = buildSessionRoster(lobby)
  const config = buildSessionConfig(lobby)
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
      configJson: JSON.stringify(config),
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
        configJson: JSON.stringify(config),
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
  await releaseStaleConflictingMemberships(db, sessionId, uniqueLiveMemberIds, now)
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

async function releaseStaleConflictingMemberships(
  db: Database,
  sessionId: string,
  playerIds: readonly string[],
  now: number,
): Promise<void> {
  if (playerIds.length === 0) return

  const liveRows = await db.select({
    sessionId: sessionDirectoryMembers.sessionId,
    playerId: sessionDirectoryMembers.playerId,
    phase: sessionDirectory.phase,
    matchId: sessionDirectory.matchId,
  })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectory.sessionId, sessionDirectoryMembers.sessionId))
    .where(and(
      inArray(sessionDirectoryMembers.playerId, [...playerIds]),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  const conflicts = liveRows.filter(row => row.sessionId !== sessionId)
  if (conflicts.length === 0) return

  const conflictMatchIds = [...new Set(conflicts.flatMap(row => row.matchId ? [row.matchId] : []))]
  const matchRows = conflictMatchIds.length > 0
    ? await db.select({
      id: matches.id,
      status: matches.status,
      draftData: matches.draftData,
    })
      .from(matches)
      .where(inArray(matches.id, conflictMatchIds))
    : []
  const blockingMatchIds = new Set(
    matchRows
      .filter(row => isBlockingDraftMatch(row.status, row.draftData))
      .map(row => row.id),
  )

  const staleRows = conflicts.filter((row) => {
    if (row.phase === 'open') return false
    if (!row.matchId) return false
    return !blockingMatchIds.has(row.matchId)
  })
  for (const row of staleRows) {
    await db.update(sessionDirectoryMembers)
      .set({ leftAt: now, updatedAt: now })
      .where(and(
        eq(sessionDirectoryMembers.sessionId, row.sessionId),
        eq(sessionDirectoryMembers.playerId, row.playerId),
        isNull(sessionDirectoryMembers.leftAt),
      ))
  }
}

function isBlockingDraftMatch(status: string, draftData: string | null): boolean {
  if (status === 'drafting') return true
  if (status !== 'active') return false
  return !hasDraftCompletedAt(draftData)
}

function hasDraftCompletedAt(draftData: string | null): boolean {
  if (!draftData) return false
  try {
    const parsed = JSON.parse(draftData) as { completedAt?: unknown } | null
    return parsed != null && parsed.completedAt != null
  }
  catch {
    return false
  }
}

function isLiveMembershipUniquenessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('session_directory_members_live_player_idx')
    || message.includes('session_directory_members.player_id')
    || message.includes('UNIQUE constraint failed')
    || message.includes('constraint failed')
}
