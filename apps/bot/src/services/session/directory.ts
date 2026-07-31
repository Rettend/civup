import type { Database } from '@civup/db'
import type { SessionPhase, SessionRecord } from '../../session-runtime/session-record.ts'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

type SessionDirectoryRow = typeof sessionDirectory.$inferSelect
type SessionDirectoryMemberRow = typeof sessionDirectoryMembers.$inferSelect

export const SESSION_DIRECTORY_OPEN_STALE_MS = 2 * 60 * 60 * 1000

interface DirectoryProjectionSnapshot {
  sessionId: string
  directory: SessionDirectoryRow | null
  members: SessionDirectoryMemberRow[]
}

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

export async function repairStaleOpenSessionDirectoryMemberships(
  db: Database,
  playerIds: readonly string[],
  now: number = Date.now(),
  options: { excludeSessionIds?: readonly string[], staleMs?: number } = {},
): Promise<{ sessionIds: string[], playerIds: string[] }> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return { sessionIds: [], playerIds: [] }

  const excludedSessionIds = new Set(options.excludeSessionIds ?? [])
  const candidates = await db.select({
    sessionId: sessionDirectoryMembers.sessionId,
    playerId: sessionDirectoryMembers.playerId,
    updatedAt: sessionDirectory.updatedAt,
    lastActivityAt: sessionDirectory.lastActivityAt,
  })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectory.sessionId, sessionDirectoryMembers.sessionId))
    .where(and(
      inArray(sessionDirectoryMembers.playerId, uniquePlayerIds),
      isNull(sessionDirectoryMembers.leftAt),
      eq(sessionDirectory.phase, 'open'),
      isNull(sessionDirectory.matchId),
    ))

  const staleSessionIds = [...new Set(candidates
    .filter(row => !excludedSessionIds.has(row.sessionId) && isStaleOpenDirectoryMembership(row, now, options.staleMs ?? SESSION_DIRECTORY_OPEN_STALE_MS))
    .map(row => row.sessionId))]
  if (staleSessionIds.length === 0) return { sessionIds: [], playerIds: [] }

  const releasedRows = await db.select({
    sessionId: sessionDirectoryMembers.sessionId,
    playerId: sessionDirectoryMembers.playerId,
  })
    .from(sessionDirectoryMembers)
    .where(and(
      inArray(sessionDirectoryMembers.sessionId, staleSessionIds),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  await db.update(sessionDirectoryMembers)
    .set({ leftAt: now, updatedAt: now })
    .where(and(
      inArray(sessionDirectoryMembers.sessionId, staleSessionIds),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  await db.update(sessionDirectory)
    .set({ phase: 'cancelled', version: sql`${sessionDirectory.version} + 1`, updatedAt: now, closedAt: now })
    .where(and(
      inArray(sessionDirectory.sessionId, staleSessionIds),
      eq(sessionDirectory.phase, 'open'),
      isNull(sessionDirectory.matchId),
    ))

  return {
    sessionIds: staleSessionIds,
    playerIds: [...new Set(releasedRows.map(row => row.playerId))],
  }
}

export async function releaseSessionDirectoryMembers(
  db: Database,
  sessionId: string,
  playerIds: readonly string[],
  now: number,
): Promise<void> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return
  await db.update(sessionDirectoryMembers)
    .set({ leftAt: now, updatedAt: now })
    .where(and(
      eq(sessionDirectoryMembers.sessionId, sessionId),
      inArray(sessionDirectoryMembers.playerId, uniquePlayerIds),
      isNull(sessionDirectoryMembers.leftAt),
    ))
}

export async function restoreSessionDirectoryMembers(
  db: Database,
  sessionId: string,
  playerIds: readonly string[],
  now: number,
): Promise<void> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return
  await db.update(sessionDirectoryMembers)
    .set({ leftAt: null, updatedAt: now })
    .where(and(
      eq(sessionDirectoryMembers.sessionId, sessionId),
      inArray(sessionDirectoryMembers.playerId, uniquePlayerIds),
    ))
}

export async function projectSessionRecord(
  db: Database,
  record: SessionRecord,
): Promise<void> {
  await runDirectoryProjectionTransaction(db, async (tx, hasTransactionalRollback) => projectSessionRecordTransaction(tx, record, !hasTransactionalRollback))
}

async function projectSessionRecordTransaction(
  db: Database,
  record: SessionRecord,
  useCompensatingRestore: boolean,
): Promise<void> {
  const [currentDirectory] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, record.id)).limit(1)
  if (currentDirectory && record.version <= currentDirectory.version) return
  const snapshot = useCompensatingRestore
    ? await readDirectoryProjectionSnapshot(db, record.id, currentDirectory ?? null)
    : null

  const liveMemberIds = isLiveMembershipPhase(record.phase)
    ? record.roster.participants.map(member => member.playerId)
    : []
  const now = record.closedAt ?? Math.max(record.updatedAt, record.lastActivityAt, 1)
  try {
    await assertNoLiveMembershipConflicts(db, record.id, liveMemberIds)

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
        closedAt: isCurrentSessionPhase(record.phase) ? null : now,
        draftStartDeadlineAt: record.phase === 'draft' && record.draftStartSync ? record.draftStartSync.deadlineAt : null,
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
          closedAt: isCurrentSessionPhase(record.phase) ? null : now,
          draftStartDeadlineAt: record.phase === 'draft' && record.draftStartSync ? record.draftStartSync.deadlineAt : null,
        },
        where: sql`excluded.version > ${sessionDirectory.version}`,
      })
      .returning({ version: sessionDirectory.version })

    if (!appliedRows.some(row => row.version === record.version)) return

    await reconcileDirectoryMembers(db, record.id, liveMemberIds, now)
  }
  catch (error) {
    if (snapshot) {
      await restoreDirectoryProjectionSnapshot(db, snapshot).catch((restoreError) => {
        console.error('[session-directory] failed to restore projection snapshot after projection error', restoreError)
      })
    }
    throw error
  }
}

async function readDirectoryProjectionSnapshot(
  db: Database,
  sessionId: string,
  directory: SessionDirectoryRow | null,
): Promise<DirectoryProjectionSnapshot> {
  const members = await db.select().from(sessionDirectoryMembers).where(eq(sessionDirectoryMembers.sessionId, sessionId))
  return { sessionId, directory, members }
}

async function restoreDirectoryProjectionSnapshot(db: Database, snapshot: DirectoryProjectionSnapshot): Promise<void> {
  await db.delete(sessionDirectoryMembers).where(eq(sessionDirectoryMembers.sessionId, snapshot.sessionId))
  if (!snapshot.directory) {
    await db.delete(sessionDirectory).where(eq(sessionDirectory.sessionId, snapshot.sessionId))
    return
  }

  await db.insert(sessionDirectory)
    .values(snapshot.directory)
    .onConflictDoUpdate({
      target: sessionDirectory.sessionId,
      set: {
        phase: snapshot.directory.phase,
        mode: snapshot.directory.mode,
        guildId: snapshot.directory.guildId,
        channelId: snapshot.directory.channelId,
        hostId: snapshot.directory.hostId,
        messageId: snapshot.directory.messageId,
        matchId: snapshot.directory.matchId,
        steamLobbyLink: snapshot.directory.steamLobbyLink,
        version: snapshot.directory.version,
        rosterJson: snapshot.directory.rosterJson,
        configJson: snapshot.directory.configJson,
        createdAt: snapshot.directory.createdAt,
        updatedAt: snapshot.directory.updatedAt,
        lastActivityAt: snapshot.directory.lastActivityAt,
        closedAt: snapshot.directory.closedAt,
        draftStartDeadlineAt: snapshot.directory.draftStartDeadlineAt,
      },
    })

  if (snapshot.members.length > 0) await db.insert(sessionDirectoryMembers).values(snapshot.members)
}

async function assertNoLiveMembershipConflicts(
  db: Database,
  sessionId: string,
  liveMemberIds: readonly string[],
): Promise<void> {
  const uniqueLiveMemberIds = [...new Set(liveMemberIds)]
  if (uniqueLiveMemberIds.length === 0) return

  let conflicts = await readLiveMembershipConflicts(db, uniqueLiveMemberIds)

  let externalConflicts = conflicts.filter(row => row.sessionId !== sessionId)
  if (externalConflicts.length === 0) return

  const repaired = await repairStaleOpenSessionDirectoryMemberships(db, uniqueLiveMemberIds, Date.now(), { excludeSessionIds: [sessionId] })
  if (repaired.sessionIds.length > 0) {
    console.warn('[session-directory] repaired stale open admission lock', {
      sessionIds: repaired.sessionIds,
      playerIds: repaired.playerIds,
      targetSessionId: sessionId,
    })
    conflicts = await readLiveMembershipConflicts(db, uniqueLiveMemberIds)
    externalConflicts = conflicts.filter(row => row.sessionId !== sessionId)
    if (externalConflicts.length === 0) return
  }

  const conflictingPlayerIds = externalConflicts.map(row => row.playerId)
  if (conflictingPlayerIds.length > 0) {
    throw new SessionAdmissionError('Player already has a live session', [...new Set(conflictingPlayerIds)])
  }
}

async function readLiveMembershipConflicts(
  db: Database,
  playerIds: readonly string[],
): Promise<Array<{ playerId: string, sessionId: string }>> {
  return await db.select({
    playerId: sessionDirectoryMembers.playerId,
    sessionId: sessionDirectoryMembers.sessionId,
  })
    .from(sessionDirectoryMembers)
    .where(and(
      inArray(sessionDirectoryMembers.playerId, [...playerIds]),
      isNull(sessionDirectoryMembers.leftAt),
    ))
}

function isStaleOpenDirectoryMembership(
  row: Pick<SessionDirectoryRow, 'updatedAt' | 'lastActivityAt'>,
  now: number,
  staleMs: number,
): boolean {
  return now - Math.max(row.updatedAt, row.lastActivityAt) >= staleMs
}

async function runDirectoryProjectionTransaction<T>(db: Database, operation: (tx: Database, hasTransactionalRollback: boolean) => Promise<T>): Promise<T> {
  const sqlite = (db as Database & { $client?: { exec?: (query: string) => unknown, query?: unknown } }).$client
  if (sqlite && typeof sqlite.exec === 'function' && typeof sqlite.query === 'function') {
    sqlite.exec('BEGIN')
    try {
      const result = await operation(db, true)
      sqlite.exec('COMMIT')
      return result
    }
    catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  return operation(db, false)
}

function isLiveMembershipPhase(phase: SessionPhase): boolean {
  return phase === 'open' || phase === 'draft'
}

function isCurrentSessionPhase(phase: SessionPhase): boolean {
  return phase === 'open' || phase === 'draft' || phase === 'swap' || phase === 'active'
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
  const existingLiveMemberIdSet = new Set(existingLiveRows.map(row => row.playerId))

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
    if (existingLiveMemberIdSet.has(playerId)) continue
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
    || message.includes('constraint failed')) { return true }

  const cause = error && typeof error === 'object' && 'cause' in error ? (error as { cause?: unknown }).cause : null
  return cause != null && cause !== error && isLiveMembershipUniquenessError(cause)
}
