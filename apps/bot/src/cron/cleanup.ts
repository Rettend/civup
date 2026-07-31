import { createDb } from '@civup/db'
import { getKvStore } from '../services/kv/batch.ts'
import { pruneInactiveOpenLobbies } from '../services/lobby/index.ts'
import { processPendingMatchRepairs, pruneAbandonedMatches, sendOverdueHostReportReminders } from '../services/match/index.ts'
import { requestLeaderboardMaintenance, requestRankedRoleMaintenance } from '../maintenance/maintenance-client.ts'
import { factory } from '../setup.ts'
import { parseRecoveredAutosaveUploadMetadata } from '../services/uploads/metadata.ts'
import { recoverStaleAutosaveUploads } from '../services/uploads/multipart.ts'

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

    let removed: Awaited<ReturnType<typeof pruneInactiveOpenLobbies>> = []
    let prunedMatches = { removedMatchIds: [] as string[], clearedLiveLobbyMatchIds: [] as string[], queuedRepairIds: [] as string[] }
    let processedRepairs: Awaited<ReturnType<typeof processPendingMatchRepairs>> = { claimed: 0, completed: 0, retried: 0, attention: 0, superseded: 0 }
    let reminderResult: Awaited<ReturnType<typeof sendOverdueHostReportReminders>> = { attemptedCount: 0, sentCount: 0 }
    try {
      removed = await pruneInactiveOpenLobbies(kv, c.env.DISCORD_TOKEN, { db, sessionNamespace: c.env.SessionDO })
    }
    catch (error) {
      console.error('[cron] Failed to prune inactive lobbies:', error)
    }
    try {
      prunedMatches = await pruneAbandonedMatches(db, kv, {
        sessionNamespace: c.env.SessionDO,
        activityNamespace: c.env.Activity,
        internalSecret: c.env.CIVUP_SECRET,
      })
    }
    catch (error) {
      console.error('[cron] Failed to reconcile abandoned matches:', error)
    }
    try {
      processedRepairs = await processPendingMatchRepairs(db, kv, {
        sessionNamespace: c.env.SessionDO,
        activityNamespace: c.env.Activity,
        internalSecret: c.env.CIVUP_SECRET,
      })
    }
    catch (error) {
      console.error('[cron] Failed to process pending match repairs:', error)
    }
    try {
      reminderResult = await sendOverdueHostReportReminders(db, kv, c.env.DISCORD_TOKEN)
    }
    catch (error) {
      console.error('[cron] Failed to send report reminders:', error)
    }

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

    if (processedRepairs.claimed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cron] Processed ${processedRepairs.claimed} match repair(s): ${processedRepairs.completed} completed, ${processedRepairs.retried} retried, ${processedRepairs.attention} need attention, ${processedRepairs.superseded} superseded`)
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
      const result = await requestRankedRoleMaintenance(c.env.MaintenanceDO, action)
      if (action === 'sync' && result.guilds > 0) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Synced ranked roles for ${result.guilds} guild(s); qualified ${result.qualifiedPlayers}, attempted ${result.attemptedDiscordChanges}, applied ${result.appliedDiscordChanges}, pending ${result.pendingDiscordChanges}; ${result.elapsedMs}ms`)
      }
      if (action === 'apply-pending' && (result.attemptedDiscordChanges > 0 || result.appliedDiscordChanges > 0 || result.pendingDiscordChanges > 0)) {
        // eslint-disable-next-line no-console
        console.log(`[cron] Attempted ${result.attemptedDiscordChanges} ranked role Discord member(s); applied ${result.appliedDiscordChanges} change(s); ${result.pendingDiscordChanges} pending; ${result.elapsedMs}ms`)
      }
    }
    catch (error) {
      console.error(`[cron] Failed to ${action === 'sync' ? 'sync ranked roles' : 'retry ranked role Discord changes'}:`, error)
    }
  },
)
