import type { Database } from '@civup/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { eq, sql } from 'drizzle-orm'
import { ratingMaintenance, ratingMutationLeases } from '@civup/db'

export const RATING_MAINTENANCE_MESSAGE = 'Season setup is in progress. Please try again shortly.'
const admittedWriter = new AsyncLocalStorage<{ id: string; outcome: { uncertain: boolean } }>()

export function withinRatingMutation<T>(
  id: string,
  task: () => Promise<T>,
  outcome = { uncertain: false },
): Promise<T> {
  return admittedWriter.run({ id, outcome }, task)
}

export function markRatingMutationUncertain(): void {
  const writer = admittedWriter.getStore()
  if (writer) writer.outcome.uncertain = true
}

export async function runUnbufferedRatingMutation<T>(
  db: Database,
  matchId: string,
  task: () => Promise<T>,
): Promise<T | { error: string }> {
  if (admittedWriter.getStore()) return task()
  const lease = await acquireRatingMutation(db, matchId)
  if (!lease) return { error: RATING_MAINTENANCE_MESSAGE }
  let finished = false
  const outcome = { uncertain: false }
  try {
    const result = await withinRatingMutation(lease.id, task, outcome)
    finished = true
    return result
  } catch (error) {
    console.error(
      '[rating-mutation] operation failed; writer retained for review',
      { matchId, writerId: lease.id, uncertain: outcome.uncertain },
      error,
    )
    throw error
  } finally {
    if (finished && !outcome.uncertain) await releaseRatingMutation(db, lease.id)
    else if (finished)
      console.error('[rating-mutation] result returned with an uncertain database write; writer retained for review', {
        matchId,
        writerId: lease.id,
      })
  }
}

export async function acquireRatingMutation(db: Database, matchId: string): Promise<{ id: string } | null> {
  const id = crypto.randomUUID()
  const [lease] = await db
    .insert(ratingMutationLeases)
    .select(
      db
        .select({
          id: sql<string>`${id}`.as('id'),
          matchId: sql<string>`${matchId}`.as('match_id'),
          generation: ratingMaintenance.generation,
          createdAt: sql<number>`${Date.now()}`.as('created_at'),
        })
        .from(ratingMaintenance)
        .where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.state} = 'open'`),
    )
    .returning({ id: ratingMutationLeases.id })
  return lease ?? null
}

export async function releaseRatingMutation(db: Database, id: string): Promise<void> {
  await db.delete(ratingMutationLeases).where(eq(ratingMutationLeases.id, id))
}

export async function changeRatingMaintenanceState(
  db: Database,
  expectedGeneration: number,
  state: 'open' | 'paused',
): Promise<void> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
    throw new Error('Invalid maintenance generation.')
  const [updated] = await db
    .update(ratingMaintenance)
    .set({ state, generation: expectedGeneration + 1, updatedAt: Date.now() })
    .where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.generation} = ${expectedGeneration}
      AND (${state} = 'paused' OR (NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases}) AND NOT EXISTS(SELECT 1 FROM seasons WHERE active = 1 AND rating_system = 'rp' AND public_reads_enabled = 0)
        AND NOT EXISTS(SELECT 1 FROM division_rank_policies WHERE phase = 'activating')))`)
    .returning({ id: ratingMaintenance.id })
  if (!updated)
    throw new Error(
      'Maintenance state changed or accepted work remains. Do not clear leases merely because they are old.',
    )
}
