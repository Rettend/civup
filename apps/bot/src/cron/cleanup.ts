import { createDb } from '@civup/db'
import { getKvStore } from '../services/kv/batch.ts'
import { refreshDirtyLeaderboards } from '../services/leaderboard/message.ts'
import { pruneInactiveOpenLobbies } from '../services/lobby/index.ts'
import { pruneAbandonedMatches, sendOverdueHostReportReminders } from '../services/match/index.ts'
import { applyPendingRankedRoleDiscordChanges, clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { factory } from '../setup.ts'

const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 30 * 60 * 1000
const RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE = 8

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
          maxDiscordRoleSyncPlayers: RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE,
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

export const cron_ranked_role_discord_retries = factory.cron(
  '12 0,2,4,6,8,10,12,14,16,18 * * *', // 10/day, offset
  async (c) => {
    const kv = getKvStore(c.env)

    try {
      const guildIds = await listRankedRoleConfigGuildIds(kv)
      let appliedChanges = 0
      let pendingChanges = 0
      for (const guildId of guildIds) {
        const result = await applyPendingRankedRoleDiscordChanges({
          kv,
          guildId,
          token: c.env.DISCORD_TOKEN,
          maxPlayers: RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE,
        })
        appliedChanges += result.appliedChanges
        pendingChanges += result.pendingChanges
      }

      if (appliedChanges > 0 || pendingChanges > 0) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Applied ${appliedChanges} ranked role Discord change(s); ${pendingChanges} pending`)
      }
    }
    catch (error) {
      console.error('[cron] Failed to retry ranked role Discord changes:', error)
    }
  },
)
