import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matchParticipants, matchRepairs, matches, playerRatingEvents, scopedPlayerRatingEvents, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { rebuildActivityOverview } from '../../session-runtime/activity-feed-client.ts'
import { queueSessionReportedDiscordSync, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS, STALE_CANCELLED_MATCH_TIMEOUT_MS, STALE_DRAFTING_MATCH_TIMEOUT_MS } from './retention.ts'

const D1_SAFE_IN_LIST_CHUNK_SIZE = 80

interface CleanupMatchRow {
  id: string
  status: string
  createdAt: number
  draftCompletedAt: number | null
  cancelledAt: number | null
  completedAt: number | null
  resultRevision: number
}

interface RepairFacts {
  participantCount: number
  placementCount: number
  ratedPlayerCount: number
  hasRatingEvents: boolean
}

export async function pruneAbandonedMatches(
  db: Database,
  _kv: KVNamespace,
  options: PruneMatchesOptions = {},
): Promise<PruneMatchesResult> {
  const now = options.now ?? Date.now()
  const staleDraftingMs = options.staleDraftingMs ?? STALE_DRAFTING_MATCH_TIMEOUT_MS
  const staleActiveMs = options.staleActiveMs ?? STALE_ACTIVE_MATCH_TIMEOUT_MS
  const staleCancelledMs = options.staleCancelledMs ?? STALE_CANCELLED_MATCH_TIMEOUT_MS
  const removedMatchIds: string[] = []
  const clearedLiveLobbyMatchIds: string[] = []
  const queuedRepairIds: string[] = []

  const staleMatches = await db.select({
    id: matches.id,
    status: matches.status,
    createdAt: matches.createdAt,
    draftCompletedAt: matches.draftCompletedAt,
    cancelledAt: matches.cancelledAt,
    completedAt: matches.completedAt,
    resultRevision: matches.resultRevision,
  }).from(matches).where(or(
    and(eq(matches.status, 'drafting'), lt(matches.createdAt, now - staleDraftingMs)),
    and(eq(matches.status, 'active'), lt(sql<number>`coalesce(${matches.draftCompletedAt}, ${matches.createdAt})`, now - staleActiveMs)),
    and(eq(matches.status, 'cancelled'), lt(sql<number>`coalesce(${matches.cancelledAt}, ${matches.completedAt}, ${matches.createdAt})`, now - staleCancelledMs)),
  ))

  for (const match of staleMatches) {
    try {
      const directory = await findDirectoryForMatch(db, match.id)
      if (match.status === 'cancelled') {
        const facts = await readRepairFacts(db, match.id)
        if (facts.hasRatingEvents) {
          queuedRepairIds.push(await recordRepair(db, {
            sessionId: directory?.sessionId ?? null,
            matchId: match.id,
            resultRevision: match.resultRevision,
            repairType: 'cancelled-with-rating-events',
            status: 'attention',
            error: 'Cancelled match still has rating events and was retained.',
          }, now))
          continue
        }
        await deleteRetainedMatch(db, match.id)
        removedMatchIds.push(match.id)
        continue
      }

      const facts = await readRepairFacts(db, match.id)
      if (match.status === 'active' && facts.hasRatingEvents) {
        if (facts.participantCount > 0 && facts.placementCount === facts.participantCount && facts.ratedPlayerCount === facts.participantCount) {
          const sessionId = directory?.sessionId ?? match.id
          if (await runCleanupTerminalSessionCommand(db, options, sessionId, match.id, 'mark-reported', now)) {
            await queueCleanupReportedDiscordSync(options, sessionId, match.id)
            clearedLiveLobbyMatchIds.push(match.id)
            await recordRepair(db, {
              sessionId,
              matchId: match.id,
              resultRevision: Math.max(1, match.resultRevision),
              repairType: 'complete-rated-active',
              status: 'completed',
            }, now)
          }
          continue
        }

        queuedRepairIds.push(await recordRepair(db, {
          sessionId: directory?.sessionId ?? null,
          matchId: match.id,
          resultRevision: match.resultRevision,
          repairType: 'partial-result',
          status: 'attention',
          error: `placements=${facts.placementCount}/${facts.participantCount}; ratedPlayers=${facts.ratedPlayerCount}/${facts.participantCount}`,
        }, now))
        continue
      }

      const sessionId = directory?.sessionId ?? match.id
      if (await runCleanupTerminalSessionCommand(db, options, sessionId, match.id, 'cancel-session', now)) {
        clearedLiveLobbyMatchIds.push(match.id)
        await recordRepair(db, {
          sessionId,
          matchId: match.id,
          resultRevision: match.resultRevision + 1,
          repairType: match.status === 'drafting' ? 'stale-draft-cancelled' : 'stale-unreported-cancelled',
          status: 'completed',
        }, now)
      }
    }
    catch (error) {
      console.error('[cleanup] failed to reconcile stale match', { matchId: match.id, error })
      queuedRepairIds.push(await recordRepair(db, {
        sessionId: null,
        matchId: match.id,
        resultRevision: match.resultRevision,
        repairType: 'cleanup-retry',
        status: 'pending',
        error: errorMessage(error),
      }, now))
    }
  }

  const liveDirectories = await db.select({
    sessionId: sessionDirectory.sessionId,
    phase: sessionDirectory.phase,
    matchId: sessionDirectory.matchId,
    deadlineAt: sessionDirectory.draftStartDeadlineAt,
  }).from(sessionDirectory).where(inArray(sessionDirectory.phase, ['draft', 'swap', 'active']))
  const pointedMatchIds = [...new Set(liveDirectories.flatMap(row => row.matchId ? [row.matchId] : []))]
  const pointedStatuses = await readMatchStatuses(db, pointedMatchIds)

  for (const directory of liveDirectories) {
    try {
      const match = directory.matchId ? pointedStatuses.get(directory.matchId) : null
      if (!match) {
        if (directory.phase === 'draft' && directory.deadlineAt != null && directory.deadlineAt > now) continue
        await forceCancelBrokenSession(db, options, directory.sessionId, directory.matchId, now)
        const repairType = directory.matchId ? 'missing-match-row' : 'null-match-id'
        queuedRepairIds.push(await recordRepair(db, {
          sessionId: directory.sessionId,
          matchId: directory.matchId,
          resultRevision: 0,
          repairType,
          status: 'completed',
        }, now))
        if (directory.matchId) clearedLiveLobbyMatchIds.push(directory.matchId)
        continue
      }

      if (match.status === 'drafting' || match.status === 'active') continue
      const commandType = match.status === 'completed' ? 'mark-reported' : 'cancel-session'
      if (!await runCleanupTerminalSessionCommand(db, options, directory.sessionId, match.id, commandType, now)) continue
      if (commandType === 'mark-reported') await queueCleanupReportedDiscordSync(options, directory.sessionId, match.id)
      clearedLiveLobbyMatchIds.push(match.id)
    }
    catch (error) {
      console.error('[cleanup] failed to reconcile live session directory row', { sessionId: directory.sessionId, matchId: directory.matchId, error })
      queuedRepairIds.push(await recordRepair(db, {
        sessionId: directory.sessionId,
        matchId: directory.matchId,
        resultRevision: directory.matchId ? pointedStatuses.get(directory.matchId)?.resultRevision ?? 0 : 0,
        repairType: 'cleanup-retry',
        status: 'pending',
        error: errorMessage(error),
      }, now))
    }
  }

  if (clearedLiveLobbyMatchIds.length > 0 || queuedRepairIds.length > 0) {
    try {
      await rebuildActivityOverview(options.activityNamespace, options.internalSecret)
    }
    catch (error) {
      console.error('[cleanup] failed to rebuild Activity overview', error)
      queuedRepairIds.push(await recordRepair(db, {
        sessionId: null,
        matchId: null,
        resultRevision: 0,
        repairType: 'activity-rebuild',
        status: 'pending',
        error: errorMessage(error),
      }, now))
    }
  }

  return {
    removedMatchIds: [...new Set(removedMatchIds)],
    clearedLiveLobbyMatchIds: [...new Set(clearedLiveLobbyMatchIds)],
    queuedRepairIds: [...new Set(queuedRepairIds)],
  }
}

async function findDirectoryForMatch(db: Database, matchId: string) {
  const [row] = await db.select({ sessionId: sessionDirectory.sessionId }).from(sessionDirectory).where(eq(sessionDirectory.matchId, matchId)).limit(1)
  return row ?? null
}

async function readRepairFacts(db: Database, matchId: string): Promise<RepairFacts> {
  const [participantRows, legacyEvents, scopedEvents] = await Promise.all([
    db.select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement }).from(matchParticipants).where(eq(matchParticipants.matchId, matchId)),
    db.select({ playerId: playerRatingEvents.playerId }).from(playerRatingEvents).where(eq(playerRatingEvents.matchId, matchId)),
    db.select({ playerId: scopedPlayerRatingEvents.playerId }).from(scopedPlayerRatingEvents).where(eq(scopedPlayerRatingEvents.matchId, matchId)),
  ])
  const ratedPlayers = new Set([...legacyEvents, ...scopedEvents].map(row => row.playerId))
  return {
    participantCount: participantRows.length,
    placementCount: participantRows.filter(row => row.placement != null).length,
    ratedPlayerCount: ratedPlayers.size,
    hasRatingEvents: ratedPlayers.size > 0,
  }
}

async function readMatchStatuses(db: Database, matchIds: readonly string[]): Promise<Map<string, CleanupMatchRow>> {
  const rows: CleanupMatchRow[] = []
  for (const chunk of chunkArray(matchIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
    rows.push(...await db.select({
      id: matches.id,
      status: matches.status,
      createdAt: matches.createdAt,
      draftCompletedAt: matches.draftCompletedAt,
      cancelledAt: matches.cancelledAt,
      completedAt: matches.completedAt,
      resultRevision: matches.resultRevision,
    }).from(matches).where(inArray(matches.id, chunk)))
  }
  return new Map(rows.map(row => [row.id, row]))
}

async function deleteRetainedMatch(db: Database, matchId: string): Promise<void> {
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  await db.delete(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  await db.delete(matches).where(eq(matches.id, matchId))
}

async function runCleanupTerminalSessionCommand(
  db: Database,
  options: PruneMatchesOptions,
  sessionId: string,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<boolean> {
  if (options.sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(options.sessionNamespace, sessionId, { type, matchId, at })
      return true
    }
    catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      await applyDirectTerminalCleanup(db, sessionId, matchId, type, at)
      return true
    }
  }

  if (!options.allowDirectTerminalWriteForTests) {
    console.warn('[cleanup] skipping terminal cleanup without SessionDO binding', { sessionId, matchId, type })
    return false
  }
  await applyDirectTerminalCleanup(db, sessionId, matchId, type, at)
  return true
}

async function applyDirectTerminalCleanup(
  db: Database,
  sessionId: string,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<void> {
  const [match] = await db.select({ status: matches.status, completedAt: matches.completedAt }).from(matches).where(eq(matches.id, matchId)).limit(1)
  if (match) {
    const alreadyTerminal = match.status === (type === 'mark-reported' ? 'completed' : 'cancelled')
    await db.update(matches).set(type === 'mark-reported'
      ? {
          status: 'completed',
          completedAt: match.completedAt ?? at,
          cancelledAt: null,
          ...(alreadyTerminal ? {} : { resultRevision: sql`${matches.resultRevision} + 1` }),
        }
      : {
          status: 'cancelled',
          cancelledAt: at,
          ...(alreadyTerminal ? {} : { resultRevision: sql`${matches.resultRevision} + 1` }),
        }).where(eq(matches.id, matchId))
  }
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  await closeDirectorySession(db, sessionId, type === 'mark-reported' ? 'reported' : 'cancelled', at)
}

async function forceCancelBrokenSession(db: Database, options: PruneMatchesOptions, sessionId: string, matchId: string | null, at: number): Promise<void> {
  if (options.sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(options.sessionNamespace, sessionId, {
        type: 'cancel-session',
        ...(matchId ? { matchId } : {}),
        at,
      })
      return
    }
    catch (error) {
      if (!isSessionNotFoundError(error)) throw error
    }
  }
  else if (!options.allowDirectTerminalWriteForTests) {
    throw new Error('SessionDO binding is required to cancel a broken live session')
  }
  await closeDirectorySession(db, sessionId, 'cancelled', at)
}

async function closeDirectorySession(db: Database, sessionId: string, phase: 'reported' | 'cancelled', at: number): Promise<void> {
  await db.update(sessionDirectory).set({
    phase,
    version: sql`${sessionDirectory.version} + 1`,
    updatedAt: at,
    lastActivityAt: at,
    closedAt: at,
    draftStartDeadlineAt: null,
  }).where(eq(sessionDirectory.sessionId, sessionId))
  await db.update(sessionDirectoryMembers).set({ leftAt: at, updatedAt: at }).where(and(
    eq(sessionDirectoryMembers.sessionId, sessionId),
    isNull(sessionDirectoryMembers.leftAt),
  ))
}

async function recordRepair(
  db: Database,
  input: {
    sessionId: string | null
    matchId: string | null
    resultRevision: number
    repairType: string
    status: 'pending' | 'completed' | 'attention'
    error?: string
  },
  now: number,
): Promise<string> {
  const idempotencyKey = [input.repairType, input.sessionId ?? '-', input.matchId ?? '-', input.resultRevision].join(':')
  const id = crypto.randomUUID()
  const [row] = await db.insert(matchRepairs).values({
    id,
    idempotencyKey,
    sessionId: input.sessionId,
    matchId: input.matchId,
    resultRevision: input.resultRevision,
    repairType: input.repairType,
    status: input.status,
    attempts: 0,
    nextAttemptAt: input.status === 'pending' ? now + 60_000 : 0,
    lastError: input.error ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: matchRepairs.idempotencyKey,
    set: {
      status: input.status,
      lastError: input.error ?? null,
      updatedAt: now,
      ...(input.status === 'pending' ? { nextAttemptAt: now + 60_000 } : {}),
    },
  }).returning({ id: matchRepairs.id })
  return row?.id ?? idempotencyKey
}

async function queueCleanupReportedDiscordSync(options: PruneMatchesOptions, sessionId: string, matchId: string): Promise<void> {
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

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('404 Session not found')
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
