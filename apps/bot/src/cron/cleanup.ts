import { createDb } from '@civup/db'
import { pruneAbandonedMatches } from '../services/match.ts'
import { pruneStaleEntries } from '../services/queue.ts'
import { factory } from '../setup.ts'

export const cron_cleanup = factory.cron(
  '*/10 * * * *',
  async (c) => {
    const kv = c.env.KV
    const db = createDb(c.env.DB)

    const removed = await pruneStaleEntries(kv)
    const prunedMatches = await pruneAbandonedMatches(db, kv)

    if (removed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${removed.length} stale queue entries`)
      // Could optionally notify a log channel here
    }

    if (prunedMatches.removedMatchIds.length > 0) {
      console.log(`[cron] Pruned ${prunedMatches.removedMatchIds.length} abandoned matches`)
    }
  },
)
