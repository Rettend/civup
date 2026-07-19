import { createDb } from '@civup/db'
import { getKvStore } from '../services/kv/batch.ts'
import { pruneInactiveOpenLobbies } from '../services/lobby/index.ts'
import { pruneAbandonedMatches, sendOverdueHostReportReminders } from '../services/match/index.ts'
<<<<<<< New base: fix: keep lobby join buttons available
<<<<<<< New base: fix: deploy config
<<<<<<< New base: chore: cleanup and simplify setup
import { requestLeaderboardMaintenance, requestRankedRoleMaintenance } from '../maintenance/maintenance-client.ts'
||||||| Common ancestor
import { applyPendingRankedRoleDiscordChanges, clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
=======
import { applyPendingRankedRoleDiscordChanges, clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { refreshRankedRoleDisplayMetadata } from '../services/ranked/roles.ts'
>>>>>>> Current commit: fix: refresh ranked role colors
||||||| Common ancestor
import { applyPendingRankedRoleDiscordChanges, clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { refreshRankedRoleDisplayMetadata } from '../services/ranked/roles.ts'
=======
import { requestRankedRoleMaintenance } from '../maintenance/maintenance-client.ts'
>>>>>>> Current commit: feat: maintenance do
||||||| Common ancestor
import { requestRankedRoleMaintenance } from '../maintenance/maintenance-client.ts'
=======
import { requestLeaderboardMaintenance, requestRankedRoleMaintenance } from '../maintenance/maintenance-client.ts'
>>>>>>> Current commit: fix: move leaderboard to DO
import { factory } from '../setup.ts'
<<<<<<< New base: fix: mod resolve
import { parseRecoveredAutosaveUploadMetadata } from '../services/uploads/metadata.ts'
import { recoverStaleAutosaveUploads } from '../services/uploads/multipart.ts'
||||||| Common ancestor

<<<<<<< New base: fix: keep lobby join buttons available
const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 15 * 60 * 1000
const RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE = 16
=======
import { parseRecoveredAutosaveUploadMetadata } from '../services/uploads/metadata.ts'
import { recoverStaleAutosaveUploads } from '../services/uploads/multipart.ts'

const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 15 * 60 * 1000
<<<<<<< New base: fix: deploy config
const RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE = 16
>>>>>>> Current commit: chore: cleanup and simplify setup
||||||| Common ancestor
const RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE = 16
=======
>>>>>>> Current commit: feat: maintenance do

||||||| Common ancestor
const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 15 * 60 * 1000

=======
>>>>>>> Current commit: fix: move leaderboard to DO
export const cron_cleanup = factory.cron(
  '0 * * * *', // every hour
  async (c) => {
    const kv = getKvStore(c.env)
    const db = createDb(c.env.DB)

    try {
      const uploadRecovery = await recoverStaleAutosaveUploads(c.env)
      await parseRecoveredAutosaveUploadMetadata(c.env, uploadRecovery.completed)
      if (uploadRecovery.cleaned > 0 || uploadRecovery.completed.length > 0 || uploadRecovery.pending > 0) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Recovered ${uploadRecovery.cleaned} abandoned upload(s), completed ${uploadRecovery.completed.length}, pending ${uploadRecovery.pending}`)
      }
    }
    catch (error) {
      console.error('[cron] Failed to recover saved-game uploads:', error)
    }

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
  '*/15 * * * *', // every 15 minutes
  async (c) => {
    try {
      const result = await requestLeaderboardMaintenance(c.env.MaintenanceDO)
      if (result.refreshed) {
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
  '0 0,2,4,6,8,10,12,14,16,18,20 * * *', // daily sync at 0:00 UTC, then 10 retries
  async (c) => {
    const action = new Date(c.interaction.scheduledTime).getUTCHours() === 0 ? 'sync' : 'apply-pending'
    try {
<<<<<<< New base: fix: deploy config
<<<<<<< New base: chore: cleanup and simplify setup
      const result = await requestRankedRoleMaintenance(c.env.MaintenanceDO, action)
      if (action === 'sync' && result.guilds > 0) {
||||||| Common ancestor
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
=======
      const guildIds = await listRankedRoleConfigGuildIds(kv)
      let syncedGuilds = 0
      for (const guildId of guildIds) {
        try {
          const refresh = await refreshRankedRoleDisplayMetadata(kv, guildId, c.env.DISCORD_TOKEN)
          if (refresh.refreshed) {
            // eslint-disable-next-line no-console
            console.log(`[cron] Refreshed ranked role display metadata for guild ${guildId}${refresh.updated ? '' : ' (unchanged)'}`)
          }
          if (refresh.missingRoleIds.length > 0) {
            console.error(`[cron] Ranked role display refresh could not find ${refresh.missingRoleIds.length} configured role(s) in guild ${guildId}`)
          }
        }
        catch (error) {
          console.error(`[cron] Failed to refresh ranked role display metadata for guild ${guildId}:`, error)
        }

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
>>>>>>> Current commit: fix: refresh ranked role colors
||||||| Common ancestor
      const guildIds = await listRankedRoleConfigGuildIds(kv)
      let syncedGuilds = 0
      for (const guildId of guildIds) {
        try {
          const refresh = await refreshRankedRoleDisplayMetadata(kv, guildId, c.env.DISCORD_TOKEN)
          if (refresh.refreshed) {
            // eslint-disable-next-line no-console
            console.log(`[cron] Refreshed ranked role display metadata for guild ${guildId}${refresh.updated ? '' : ' (unchanged)'}`)
          }
          if (refresh.missingRoleIds.length > 0) {
            console.error(`[cron] Ranked role display refresh could not find ${refresh.missingRoleIds.length} configured role(s) in guild ${guildId}`)
          }
        }
        catch (error) {
          console.error(`[cron] Failed to refresh ranked role display metadata for guild ${guildId}:`, error)
        }

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
=======
      const result = await requestRankedRoleMaintenance(c.env.MaintenanceDO, action)
      if (action === 'sync' && result.guilds > 0) {
>>>>>>> Current commit: feat: maintenance do
        // eslint-disable-next-line no-console
<<<<<<< New base: fix: deploy config
        console.log(`[cron] Synced ranked roles for ${result.guilds} guild(s); qualified ${result.qualifiedPlayers}, attempted ${result.attemptedDiscordChanges}, applied ${result.appliedDiscordChanges}, pending ${result.pendingDiscordChanges}; ${result.elapsedMs}ms`)
      }
      if (action === 'apply-pending' && (result.attemptedDiscordChanges > 0 || result.appliedDiscordChanges > 0 || result.pendingDiscordChanges > 0)) {
||||||| Common ancestor
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
      let attemptedChanges = 0
      let pendingChanges = 0
      for (const guildId of guildIds) {
        const result = await applyPendingRankedRoleDiscordChanges({
          kv,
          guildId,
          token: c.env.DISCORD_TOKEN,
          maxPlayers: RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE,
        })
        attemptedChanges += result.attemptedChanges
        appliedChanges += result.appliedChanges
        pendingChanges += result.pendingChanges
      }

      if (attemptedChanges > 0 || appliedChanges > 0 || pendingChanges > 0) {
=======
        console.log(`[cron] Synced ranked roles for ${result.guilds} guild(s); qualified ${result.qualifiedPlayers}, attempted ${result.attemptedDiscordChanges}, applied ${result.appliedDiscordChanges}, pending ${result.pendingDiscordChanges}; ${result.elapsedMs}ms`)
      }
      if (action === 'apply-pending' && (result.attemptedDiscordChanges > 0 || result.appliedDiscordChanges > 0 || result.pendingDiscordChanges > 0)) {
>>>>>>> Current commit: feat: maintenance do
        // eslint-disable-next-line no-console
        console.log(`[cron] Attempted ${result.attemptedDiscordChanges} ranked role Discord member(s); applied ${result.appliedDiscordChanges} change(s); ${result.pendingDiscordChanges} pending; ${result.elapsedMs}ms`)
      }
    }
    catch (error) {
      console.error(`[cron] Failed to ${action === 'sync' ? 'sync ranked roles' : 'retry ranked role Discord changes'}:`, error)
    }
  },
)
