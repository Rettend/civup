import type { Database } from '@civup/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { bufferedReportDirectory, ratingMaintenance, ratingMutationLeases } from '@civup/db'
import { eq, sql } from 'drizzle-orm'

export const RATING_MAINTENANCE_MESSAGE = 'Rating maintenance is in progress. Result corrections will be available again shortly.'
const admittedWriter = new AsyncLocalStorage<string>()

export function withinRatingMutation<T>(id: string, task: () => Promise<T>): Promise<T> {
  return admittedWriter.run(id, task)
}

export async function runUnbufferedRatingMutation<T>(db: Database, matchId: string, task: () => Promise<T>): Promise<T | { error: string }> {
  if (admittedWriter.getStore()) return task()
  const lease = await acquireRatingMutation(db, matchId)
  let finished = false
  try {
    if (lease.kind === 'buffer') { finished = true; return { error: RATING_MAINTENANCE_MESSAGE } }
    const result = await withinRatingMutation(lease.id, task)
    finished = true
    return result
  }
  finally { if (finished) await releaseRatingMutation(db, lease.id) }
}

export async function acquireRatingMutation(db: Database, matchId: string, draining = false): Promise<{ id: string, kind: 'rating' | 'buffer' }> {
  const id = crypto.randomUUID()
  const [lease] = await db.insert(ratingMutationLeases).select(db.select({
    id: sql<string>`${id}`.as('id'), matchId: sql<string>`${matchId}`.as('match_id'),
    generation: ratingMaintenance.generation,
    kind: sql<'rating' | 'buffer'>`CASE WHEN ${ratingMaintenance.state} = 'open' OR (${draining} = 1 AND ${ratingMaintenance.state} = 'draining') THEN 'rating' ELSE 'buffer' END`.as('kind'),
    createdAt: sql<number>`${Date.now()}`.as('created_at'),
  }).from(ratingMaintenance).where(eq(ratingMaintenance.id, 1)))
    .returning({ id: ratingMutationLeases.id, kind: ratingMutationLeases.kind })
  if (!lease) throw new Error('Rating maintenance state is missing; refusing uncoordinated writes.')
  return lease
}

export async function releaseRatingMutation(db: Database, id: string): Promise<void> {
  await db.delete(ratingMutationLeases).where(eq(ratingMutationLeases.id, id))
}

export async function changeRatingMaintenanceState(db: Database, expectedGeneration: number, state: 'open' | 'buffering' | 'draining'): Promise<void> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('Invalid maintenance generation.')
  const [updated] = await db.update(ratingMaintenance).set({ state, generation: expectedGeneration + 1, updatedAt: Date.now() })
    .where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.generation} = ${expectedGeneration}
      AND (${state} = 'buffering' OR NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases}))
      AND (${state} != 'open' OR NOT EXISTS(SELECT 1 FROM ${bufferedReportDirectory}))`).returning({ id: ratingMaintenance.id })
  if (!updated) throw new Error('Maintenance state changed or accepted work remains. Do not clear leases merely because they are old.')
}
