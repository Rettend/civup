import type { Database } from '@civup/db'
import { matches, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type SessionPhase, type SessionRecord } from '../../session-runtime/session-record.ts'

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

  const liveMemberIds = isLiveSessionPhase(record.phase)
    ? record.roster.participants.map(member => member.playerId)
    : []
  const now = record.closedAt ?? Math.max(record.updatedAt, record.lastActivityAt, 1)
  try {
    await assertNoLiveMembershipConflicts(db, record.id, liveMemberIds, now)

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
      },
    })

  if (snapshot.members.length > 0) await db.insert(sessionDirectoryMembers).values(snapshot.members)
}

async function assertNoLiveMembershipConflicts(
  db: Database,
  sessionId: string,
  liveMemberIds: readonly string[],
  now: number,
): Promise<void> {
  const uniqueLiveMemberIds = [...new Set(liveMemberIds)]
  if (uniqueLiveMemberIds.length === 0) return

  const conflicts = await db.select({
    playerId: sessionDirectoryMembers.playerId,
    sessionId: sessionDirectoryMembers.sessionId,
    phase: sessionDirectory.phase,
    matchId: sessionDirectory.matchId,
    updatedAt: sessionDirectory.updatedAt,
    lastActivityAt: sessionDirectory.lastActivityAt,
  })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectoryMembers.sessionId, sessionDirectory.sessionId))
    .where(and(
      inArray(sessionDirectoryMembers.playerId, uniqueLiveMemberIds),
      isNull(sessionDirectoryMembers.leftAt),
    ))

  const externalConflicts = conflicts.filter(row => row.sessionId !== sessionId)
  if (externalConflicts.length === 0) return

  const matchIds = [...new Set(externalConflicts.flatMap(row => row.matchId ? [row.matchId] : []))]
  const matchStatuses = matchIds.length > 0
    ? await db.select({ id: matches.id, status: matches.status }).from(matches).where(inArray(matches.id, matchIds))
    : []
  const statusByMatchId = new Map(matchStatuses.map(row => [row.id, row.status]))
  const activeConflicts: typeof externalConflicts = []

  for (const conflict of externalConflicts) {
    const matchStatus = conflict.matchId ? statusByMatchId.get(conflict.matchId) : null
    const staleTerminalResidue = conflict.phase !== 'open' && (matchStatus === 'completed' || matchStatus === 'cancelled')
    const lastSeenAt = Math.max(conflict.updatedAt, conflict.lastActivityAt)
    const staleOpenResidue = conflict.phase === 'open' && now - lastSeenAt >= SESSION_DIRECTORY_OPEN_STALE_MS
    if (!staleTerminalResidue && !staleOpenResidue) {
      activeConflicts.push(conflict)
      continue
    }

    await db.update(sessionDirectoryMembers)
      .set({ leftAt: now, updatedAt: now })
      .where(and(
        eq(sessionDirectoryMembers.sessionId, conflict.sessionId),
        eq(sessionDirectoryMembers.playerId, conflict.playerId),
        isNull(sessionDirectoryMembers.leftAt),
      ))
  }

  const conflictingPlayerIds = activeConflicts
    .map(row => row.playerId)
  if (conflictingPlayerIds.length > 0) {
    throw new SessionAdmissionError('Player already has a live session', [...new Set(conflictingPlayerIds)])
  }
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

  const transactional = db as Database & {
    transaction?: (operation: (tx: Database) => Promise<T>) => Promise<T>
  }
  if (typeof transactional.transaction === 'function') {
    return await transactional.transaction(async tx => await operation(tx as unknown as Database, true))
  }
  return await operation(db, false)
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
