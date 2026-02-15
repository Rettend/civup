import { createDb } from '@civup/db'
import { getQueueTimeoutMs } from '../services/config.ts'
import { refreshDirtyLeaderboards } from '../services/leaderboard-message.ts'
import { pruneAbandonedMatches } from '../services/match.ts'
import { pruneStaleEntries } from '../services/queue.ts'
import { factory } from '../setup.ts'

export const cron_cleanup = factory.cron(
  '0 * * * *',
  async (c) => {
    const kv = c.env.KV
    const db = createDb(c.env.DB)

    const queueTimeoutMs = await getQueueTimeoutMs(kv)
    const removed = await pruneStaleEntries(kv, queueTimeoutMs)
    const prunedMatches = await pruneAbandonedMatches(db, kv)

    if (removed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${removed.length} stale queue entries`)
    }

    if (prunedMatches.removedMatchIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${prunedMatches.removedMatchIds.length} abandoned matches`)
    }
  },
)

export const cron_leaderboards = factory.cron(
  '*/2 * * * *',
  async (c) => {
    const db = createDb(c.env.DB)
    try {
      const refreshed = await refreshDirtyLeaderboards(db, c.env.KV, c.env.DISCORD_TOKEN)
      if (refreshed) {
        // eslint-disable-next-line no-console
        console.log('[cron] Refreshed dirty leaderboards')
      }
    }
    catch (error) {
      console.error('[cron] Failed to refresh dirty leaderboards:', error)
    }
  },
)
