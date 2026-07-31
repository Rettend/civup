import type { Database } from '@civup/db'
import type { PruneMatchesOptions } from './types.ts'
import { matchRepairs, matches } from '@civup/db'
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm'
import { rebuildActivityOverview } from '../../session-runtime/activity-feed-client.ts'
import { pruneAbandonedMatches } from './cleanup.ts'

const DEFAULT_BATCH_SIZE = 10
const LEASE_DURATION_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000

export interface ProcessMatchRepairsOptions extends PruneMatchesOptions {
  batchSize?: number
  leaseOwner?: string
}

export interface ProcessMatchRepairsResult {
  claimed: number
  completed: number
  retried: number
  attention: number
  superseded: number
}

export async function processPendingMatchRepairs(
  db: Database,
  kv: KVNamespace,
  options: ProcessMatchRepairsOptions = {},
): Promise<ProcessMatchRepairsResult> {
  const now = options.now ?? Date.now()
  const batchSize = normalizeBatchSize(options.batchSize)
  const leaseOwner = options.leaseOwner?.trim() || crypto.randomUUID()
  const candidates = await db
    .select()
    .from(matchRepairs)
    .where(and(
      eq(matchRepairs.status, 'pending'),
      lte(matchRepairs.nextAttemptAt, now),
      or(isNull(matchRepairs.leaseExpiresAt), lt(matchRepairs.leaseExpiresAt, now)),
    ))
    .orderBy(matchRepairs.nextAttemptAt, matchRepairs.createdAt)
    .limit(batchSize)

  const result: ProcessMatchRepairsResult = { claimed: 0, completed: 0, retried: 0, attention: 0, superseded: 0 }
  for (const candidate of candidates) {
    const [claimed] = await db
      .update(matchRepairs)
      .set({ leaseOwner, leaseExpiresAt: now + LEASE_DURATION_MS, updatedAt: now })
      .where(and(
        eq(matchRepairs.id, candidate.id),
        eq(matchRepairs.status, 'pending'),
        lte(matchRepairs.nextAttemptAt, now),
        or(isNull(matchRepairs.leaseExpiresAt), lt(matchRepairs.leaseExpiresAt, now)),
      ))
      .returning()
    if (!claimed) continue
    result.claimed += 1

    if (await isSuperseded(db, claimed.matchId, claimed.resultRevision)) {
      await finishRepair(db, claimed.id, leaseOwner, 'superseded', now, claimed.attempts + 1)
      result.superseded += 1
      continue
    }

    try {
      const supported = await runRepair(db, kv, claimed, options, now)
      if (!supported) {
        await finishRepair(db, claimed.id, leaseOwner, 'attention', now, claimed.attempts + 1, `Unsupported repair type: ${claimed.repairType}`)
        result.attention += 1
        continue
      }
      await finishRepair(db, claimed.id, leaseOwner, 'completed', now, claimed.attempts + 1)
      result.completed += 1
    }
    catch (error) {
      const attempts = claimed.attempts + 1
      const attention = attempts >= MAX_ATTEMPTS
      await db.update(matchRepairs).set({
        status: attention ? 'attention' : 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts,
        nextAttemptAt: attention ? 0 : now + retryDelay(attempts),
        lastError: errorMessage(error),
        updatedAt: now,
      }).where(and(eq(matchRepairs.id, claimed.id), eq(matchRepairs.leaseOwner, leaseOwner)))
      if (attention) result.attention += 1
      else result.retried += 1
    }
  }

  return result
}

async function runRepair(
  db: Database,
  kv: KVNamespace,
  repair: typeof matchRepairs.$inferSelect,
  options: ProcessMatchRepairsOptions,
  now: number,
): Promise<boolean> {
  switch (repair.repairType) {
    case 'activity-rebuild':
      await rebuildActivityOverview(options.activityNamespace, options.internalSecret)
      return true
    case 'cleanup-retry': {
      const cleanup = await pruneAbandonedMatches(db, kv, { ...options, now })
      if (cleanup.queuedRepairIds.includes(repair.id)) throw new Error('Cleanup reconciliation is still failing')
      return true
    }
    default:
      return false
  }
}

async function isSuperseded(db: Database, matchId: string | null, resultRevision: number): Promise<boolean> {
  if (!matchId) return false
  const [match] = await db.select({ resultRevision: matches.resultRevision }).from(matches).where(eq(matches.id, matchId)).limit(1)
  return match != null && match.resultRevision > resultRevision
}

async function finishRepair(
  db: Database,
  id: string,
  leaseOwner: string,
  status: 'completed' | 'attention' | 'superseded',
  now: number,
  attempts: number,
  lastError: string | null = null,
): Promise<void> {
  await db.update(matchRepairs).set({
    status,
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts,
    nextAttemptAt: 0,
    lastError,
    updatedAt: now,
  }).where(and(eq(matchRepairs.id, id), eq(matchRepairs.leaseOwner, leaseOwner)))
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.max(0, attempts - 1))
}

function normalizeBatchSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(50, value!) : DEFAULT_BATCH_SIZE
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
