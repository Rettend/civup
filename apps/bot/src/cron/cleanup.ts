import { pruneStaleEntries } from '../services/queue.ts'
import { factory } from '../setup.ts'

export const cron_cleanup = factory.cron(
  '*/10 * * * *',
  async (c) => {
    const kv = c.env.KV
    const removed = await pruneStaleEntries(kv)

    if (removed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${removed.length} stale queue entries`)
      // Could optionally notify a log channel here
    }
  },
)
