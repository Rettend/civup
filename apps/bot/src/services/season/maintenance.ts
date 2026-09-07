import type { Database } from '@civup/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ratingMaintenance, ratingMutationLeases } from '@civup/db'
import { eq, sql } from 'drizzle-orm'

export const RATING_MAINTENANCE_MESSAGE = 'Season setup is in progress. Please try again shortly.'
const admittedWriter = new AsyncLocalStorage<string>()

export function withinRatingMutation<T>(id: string, task: () => Promise<T>): Promise<T> {
  return admittedWriter.run(id, task)
}

export async function runUnbufferedRatingMutation<T>(db: Database, matchId: string, task: () => Promise<T>): Promise<T | { error: string }> {
  if (admittedWriter.getStore()) return task()
  const lease = await acquireRatingMutation(db, matchId)
  if (!lease) return { error: RATING_MAINTENANCE_MESSAGE }
  let finished = false
  try {
    const result = await withinRatingMutation(lease.id, task)
    finished = true
    return result
  }
  finally { if (finished) await releaseRatingMutation(db, lease.id) }
}

export async function acquireRatingMutation(db: Database, matchId: string): Promise<{ id: string } | null> {
  const id = crypto.randomUUID()
  const [lease] = await db.insert(ratingMutationLeases).select(db.select({
    id: sql<string>`${id}`.as('id'), matchId: sql<string>`${matchId}`.as('match_id'),
    generation: ratingMaintenance.generation,
    createdAt: sql<number>`${Date.now()}`.as('created_at'),
  }).from(ratingMaintenance).where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.state} = 'open'`))
    .returning({ id: ratingMutationLeases.id })
  return lease ?? null
}

export async function releaseRatingMutation(db: Database, id: string): Promise<void> {
  await db.delete(ratingMutationLeases).where(eq(ratingMutationLeases.id, id))
}

export async function changeRatingMaintenanceState(db: Database, expectedGeneration: number, state: 'open' | 'paused'): Promise<void> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('Invalid maintenance generation.')
  const [updated] = await db.update(ratingMaintenance).set({ state, generation: expectedGeneration + 1, updatedAt: Date.now() })
    .where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.generation} = ${expectedGeneration}
      AND (${state} = 'paused' OR NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases}))`).returning({ id: ratingMaintenance.id })
  if (!updated) throw new Error('Maintenance state changed or accepted work remains. Do not clear leases merely because they are old.')
}
