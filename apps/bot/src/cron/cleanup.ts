import { createDb } from '@civup/db'
import { refreshDirtyLeaderboards } from '../services/leaderboard/message.ts'
import { pruneInactiveOpenLobbies } from '../services/lobby/index.ts'
import { pruneAbandonedMatches } from '../services/match/index.ts'
import { clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

export const cron_cleanup = factory.cron(
  '0 * * * *', // every hour
  async (c) => {
    const kv = createStateStore(c.env)
    const db = createDb(c.env.DB)

    const removed = await pruneInactiveOpenLobbies(kv, c.env.DISCORD_TOKEN)
    const prunedMatches = await pruneAbandonedMatches(db, kv)

    if (removed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${removed.length} inactive open lobbies`)
    }

    if (prunedMatches.removedMatchIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${prunedMatches.removedMatchIds.length} abandoned matches`)
    }
  },
)

export const cron_leaderboards = factory.cron(
  '*/2 * * * *', // every 2 minutes
  async (c) => {
    const db = createDb(c.env.DB)
    const kv = createStateStore(c.env)
    try {
      const refreshed = await refreshDirtyLeaderboards(db, kv, c.env.DISCORD_TOKEN)
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

export const cron_ranked_roles = factory.cron(
  '0 0 * * *', // every day at 0:00 UTC
  async (c) => {
    const db = createDb(c.env.DB)
    const kv = createStateStore(c.env)

    try {
      const guildIds = await listRankedRoleConfigGuildIds(kv)
      let syncedGuilds = 0
      for (const guildId of guildIds) {
        await syncRankedRoles({
          db,
          kv,
          guildId,
          token: c.env.DISCORD_TOKEN,
          applyDiscord: true,
          advanceDemotionWindow: true,
        })
        syncedGuilds += 1
      }

      if (syncedGuilds > 0) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Synced ranked roles for ${syncedGuilds} guild(s)`)
      }

      if (await getRankedRolesDirtyState(kv)) await clearRankedRolesDirtyState(kv)
    }
    catch (error) {
      console.error('[cron] Failed to sync ranked roles:', error)
    }
  },
)
