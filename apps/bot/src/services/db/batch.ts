import type { Database } from '@civup/db'

export type DbBatchItem = Parameters<Database['batch']>[0][number]

interface OptionalBatchRunner {
  batch?: (queries: [DbBatchItem, ...DbBatchItem[]]) => Promise<unknown>
}

export async function runDbBatch(db: Database, queries: DbBatchItem[]): Promise<void> {
  if (queries.length === 0) return

  const batchRunner = db as OptionalBatchRunner
  if (typeof batchRunner.batch === 'function') {
    await batchRunner.batch(queries as [DbBatchItem, ...DbBatchItem[]])
    return
  }

  for (const query of queries) {
    await query
  }
}
