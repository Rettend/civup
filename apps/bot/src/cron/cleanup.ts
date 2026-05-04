import { createDb } from '@civup/db'
import { refreshDirtyLeaderboards } from '../services/leaderboard/message.ts'
import { pruneInactiveOpenLobbies } from '../services/lobby/index.ts'
import { pruneAbandonedMatches, sendOverdueHostReportReminders } from '../services/match/index.ts'
import { clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { factory } from '../setup.ts'

const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 30 * 60 * 1000

export const cron_cleanup = factory.cron(
  '0 * * * *', // every hour
  async (c) => {
    const kv = getKvStore(c.env)
    const db = createDb(c.env.DB)

    const removed = await pruneInactiveOpenLobbies(kv, c.env.DISCORD_TOKEN, { db, sessionNamespace: c.env.SessionDO })
    const prunedMatches = await pruneAbandonedMatches(db, kv, { sessionNamespace: c.env.SessionDO })
    const reminderResult = await sendOverdueHostReportReminders(db, kv, c.env.DISCORD_TOKEN)

    if (removed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${removed.length} inactive open lobbies`)
    }

    if (prunedMatches.removedMatchIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Pruned ${prunedMatches.removedMatchIds.length} abandoned matches`)
    }

    if (prunedMatches.clearedLiveLobbyMatchIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Cleared ${prunedMatches.clearedLiveLobbyMatchIds.length} inconsistent live lobby(s)`)
    }

    if (reminderResult.sentCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Sent ${reminderResult.sentCount} host report reminder DM(s)`)
    }
  },
)

export const cron_leaderboards = factory.cron(
  '*/30 * * * *', // every 30 minutes
  async (c) => {
    const db = createDb(c.env.DB)
    const kv = getKvStore(c.env)
    try {
      const refreshed = await refreshDirtyLeaderboards(db, kv, c.env.DISCORD_TOKEN, {
        minDirtyAgeMs: LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS,
      })
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
    const kv = getKvStore(c.env)

    try {
      const guildIds = await listRankedRoleConfigGuildIds(kv)
      let syncedGuilds = 0
      for (const guildId of guildIds) {
        const result = await syncRankedRoles({
          db,
          kv,
          guildId,
          token: c.env.DISCORD_TOKEN,
          applyDiscord: true,
          advanceDemotionWindow: true,
        })
        if (result.pendingDiscordChanges === 0 && await getRankedRolesDirtyState(kv)) await clearRankedRolesDirtyState(kv)
        syncedGuilds += 1
      }

      if (syncedGuilds > 0) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Synced ranked roles for ${syncedGuilds} guild(s)`)
      }
    }
    catch (error) {
      console.error('[cron] Failed to sync ranked roles:', error)
    }
  },
)
