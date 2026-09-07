import type { Database } from '@civup/db'
import { markRatingMutationUncertain } from '../season/maintenance.ts'

export type DbBatchItem = Parameters<Database['batch']>[0][number]

interface OptionalBatchRunner {
  batch?: (queries: [DbBatchItem, ...DbBatchItem[]]) => Promise<unknown>
}

export async function runDbBatch(db: Database, queries: DbBatchItem[]): Promise<void> {
  if (queries.length === 0) return

  const batchRunner = db as OptionalBatchRunner
  if (typeof batchRunner.batch === 'function') {
    try { await batchRunner.batch(queries as [DbBatchItem, ...DbBatchItem[]]) }
    catch (error) { markRatingMutationUncertain(); throw error }
    return
  }

  for (const query of queries) {
    await query
  }
}
