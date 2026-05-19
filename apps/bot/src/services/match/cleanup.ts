import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatingEvents, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { queueSessionReportedDiscordSync, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { getLiveSessionLobbyProjections } from '../session/index.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS, STALE_CANCELLED_MATCH_TIMEOUT_MS, STALE_DRAFTING_MATCH_TIMEOUT_MS } from './retention.ts'

const D1_SAFE_IN_LIST_CHUNK_SIZE = 80

export async function pruneAbandonedMatches(
  db: Database,
  kv: KVNamespace,
  options: PruneMatchesOptions = {},
): Promise<PruneMatchesResult> {
  const now = Date.now()
  const staleDraftingMs = options.staleDraftingMs ?? STALE_DRAFTING_MATCH_TIMEOUT_MS
  const staleActiveMs = options.staleActiveMs ?? STALE_ACTIVE_MATCH_TIMEOUT_MS
  const staleCancelledMs = options.staleCancelledMs ?? STALE_CANCELLED_MATCH_TIMEOUT_MS

  const staleMatches = await db
    .select({ id: matches.id })
    .from(matches)
    .where(or(
      and(eq(matches.status, 'drafting'), lt(matches.createdAt, now - staleDraftingMs)),
      and(eq(matches.status, 'active'), lt(matches.createdAt, now - staleActiveMs)),
      and(eq(matches.status, 'cancelled'), lt(matches.createdAt, now - staleCancelledMs)),
    ))

  const removedMatchIds: string[] = []
  const clearedLiveLobbyMatchIds: string[] = []
  const staleMatchIds = staleMatches.map(match => match.id)
  const ratedStaleMatchIds = await listRatedMatchIds(db, staleMatchIds)

  for (const match of staleMatches) {
    if (ratedStaleMatchIds.has(match.id)) {
      console.warn('[cleanup] skipping abandoned match prune because rating events still reference it', { matchId: match.id })
      continue
    }

    if (!await runCleanupTerminalSessionCommand(db, options, match.id, match.id, 'cancel-session', now)) continue

    await db.delete(matchBans).where(eq(matchBans.matchId, match.id))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, match.id))
    await db.delete(matches).where(eq(matches.id, match.id))

    removedMatchIds.push(match.id)
  }

  const liveMatchLobbies = (await getLiveSessionLobbyProjections(db)).flatMap(lobby => lobby.matchId
    ? [{ lobby, matchId: lobby.matchId }]
    : [])
  const liveMatchIds = [...new Set(liveMatchLobbies.map(entry => entry.matchId))]

  if (liveMatchIds.length > 0) {
    const liveMatchRows: Array<{ id: string, status: string }> = []
    for (const chunk of chunkArray(liveMatchIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
      liveMatchRows.push(...await db
        .select({ id: matches.id, status: matches.status })
        .from(matches)
        .where(inArray(matches.id, chunk)))
    }
    const liveStatusByMatchId = new Map(liveMatchRows.map(row => [row.id, row.status]))

    for (const { lobby, matchId } of liveMatchLobbies) {
      const matchStatus = liveStatusByMatchId.get(matchId)
      if (matchStatus === 'drafting' || matchStatus === 'active') continue

      const commandType = matchStatus === 'completed' ? 'mark-reported' : 'cancel-session'
      if (!await runCleanupTerminalSessionCommand(db, options, lobby.id, matchId, commandType, now)) continue
      if (commandType === 'mark-reported') await queueCleanupReportedDiscordSync(options, lobby.id, matchId)
      clearedLiveLobbyMatchIds.push(matchId)
    }
  }

  return { removedMatchIds, clearedLiveLobbyMatchIds }
}

async function listRatedMatchIds(db: Database, matchIds: readonly string[]): Promise<Set<string>> {
  const ratedMatchIds = new Set<string>()
  for (const chunk of chunkArray(matchIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
    const rows = await db
      .select({ matchId: playerRatingEvents.matchId })
      .from(playerRatingEvents)
      .where(inArray(playerRatingEvents.matchId, chunk))

    for (const row of rows) ratedMatchIds.add(row.matchId)
  }
  return ratedMatchIds
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function runCleanupTerminalSessionCommand(
  db: Database,
  options: PruneMatchesOptions,
  sessionId: string,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<boolean> {
  const { sessionNamespace } = options
  if (sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(sessionNamespace, sessionId, { type, matchId, at })
      return true
    }
    catch (error) {
      if (isSessionNotFoundError(error)) {
        await applyDirectTerminalCleanup(db, sessionId, matchId, type, at)
        return true
      }
      console.warn('[cleanup] failed to update terminal session state', { matchId, type, error })
      return false
    }
  }

  if (!options.allowDirectTerminalWriteForTests) {
    console.warn('[cleanup] skipping terminal cleanup without SessionDO binding', { matchId, type })
    return false
  }

  await db.update(matches)
    .set({ status: type === 'mark-reported' ? 'completed' : 'cancelled', completedAt: at })
    .where(eq(matches.id, matchId))
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return true
}

async function applyDirectTerminalCleanup(
  db: Database,
  sessionId: string,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<void> {
  if (type === 'mark-reported') {
    const [match] = await db
      .select({ completedAt: matches.completedAt })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)

    await db.update(matches)
      .set({ status: 'completed', completedAt: match?.completedAt ?? at })
      .where(eq(matches.id, matchId))
  }
  else {
    await db.update(matches)
      .set({ status: 'cancelled', completedAt: at })
      .where(eq(matches.id, matchId))
  }

  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  await db.update(sessionDirectory)
    .set({
      phase: type === 'mark-reported' ? 'reported' : 'cancelled',
      version: sql`${sessionDirectory.version} + 1`,
      updatedAt: at,
      lastActivityAt: at,
      closedAt: at,
    })
    .where(eq(sessionDirectory.sessionId, sessionId))
  await db.update(sessionDirectoryMembers)
    .set({ leftAt: at, updatedAt: at })
    .where(and(
      eq(sessionDirectoryMembers.sessionId, sessionId),
      isNull(sessionDirectoryMembers.leftAt),
    ))
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('404 Session not found')
}

async function queueCleanupReportedDiscordSync(
  options: PruneMatchesOptions,
  sessionId: string,
  matchId: string,
): Promise<void> {
  if (!options.sessionNamespace) return
  try {
    await queueSessionReportedDiscordSync(options.sessionNamespace, sessionId, {
      matchId,
      reason: 'completed match cleanup reconciliation',
    })
  }
  catch (error) {
    console.warn('[cleanup] failed to queue reported Discord sync', { sessionId, matchId, error })
  }
}
