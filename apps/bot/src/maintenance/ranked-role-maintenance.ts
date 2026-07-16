import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { getKvStore } from '../services/kv/batch.ts'
import { applyPendingRankedRoleDiscordChanges, clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, syncRankedRoles } from '../services/ranked/role-sync.ts'
import { refreshRankedRoleDisplayMetadata } from '../services/ranked/roles.ts'

export type RankedRoleMaintenanceAction = 'sync' | 'apply-pending'

export interface RankedRoleMaintenanceResult {
  action: RankedRoleMaintenanceAction
  guilds: number
  qualifiedPlayers: number
  attemptedDiscordChanges: number
  appliedDiscordChanges: number
  pendingDiscordChanges: number
  elapsedMs: number
}

const RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE = 16
const MAINTENANCE_GUILD_ROTATION_INTERVAL_MS = 2 * 60 * 60 * 1000

export async function runRankedRoleMaintenance(
  env: Env['Bindings'],
  action: RankedRoleMaintenanceAction,
  now = Date.now(),
): Promise<RankedRoleMaintenanceResult> {
  const startedAt = Date.now()
  const kv = getKvStore(env)
  const guildIds = await listRankedRoleConfigGuildIds(kv)
  const orderedGuildIds = rotateGuildIds(guildIds, now)
  let qualifiedPlayers = 0
  let attemptedDiscordChanges = 0
  let appliedDiscordChanges = 0
  let pendingDiscordChanges = 0
  let remainingDiscordChanges = RANKED_ROLE_DISCORD_SYNC_BATCH_SIZE

  for (const [index, guildId] of orderedGuildIds.entries()) {
    const guildBudget = Math.ceil(remainingDiscordChanges / (orderedGuildIds.length - index))
    if (action === 'sync') {
      try {
        const refresh = await refreshRankedRoleDisplayMetadata(kv, guildId, env.DISCORD_TOKEN, { now })
        if (refresh.missingRoleIds.length > 0) {
          console.error(`[maintenance] Ranked role display refresh could not find ${refresh.missingRoleIds.length} configured role(s) in guild ${guildId}`)
        }
      }
      catch (error) {
        console.error(`[maintenance] Failed to refresh ranked role display metadata for guild ${guildId}:`, error)
      }

      const result = await syncRankedRoles({
        db: createDb(env.DB),
        kv,
        guildId,
        token: env.DISCORD_TOKEN,
        applyDiscord: true,
        advanceDemotionWindow: true,
        maxDiscordRoleSyncPlayers: guildBudget,
        now,
      })
      qualifiedPlayers += result.playerPreviews.filter(player => player.qualified).length
      attemptedDiscordChanges += result.attemptedDiscordChanges
      appliedDiscordChanges += result.appliedDiscordChanges
      pendingDiscordChanges += result.pendingDiscordChanges
      remainingDiscordChanges = Math.max(0, remainingDiscordChanges - result.attemptedDiscordChanges)
      continue
    }

    const result = await applyPendingRankedRoleDiscordChanges({
      kv,
      guildId,
      token: env.DISCORD_TOKEN,
      maxPlayers: guildBudget,
    })
    attemptedDiscordChanges += result.attemptedChanges
    appliedDiscordChanges += result.appliedChanges
    pendingDiscordChanges += result.pendingChanges
    remainingDiscordChanges = Math.max(0, remainingDiscordChanges - result.attemptedChanges)
  }

  if (action === 'sync' && pendingDiscordChanges === 0 && await getRankedRolesDirtyState(kv)) {
    await clearRankedRolesDirtyState(kv)
  }

  return {
    action,
    guilds: guildIds.length,
    qualifiedPlayers,
    attemptedDiscordChanges,
    appliedDiscordChanges,
    pendingDiscordChanges,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  }
}

function rotateGuildIds(guildIds: string[], now: number): string[] {
  if (guildIds.length < 2) return guildIds
  const startIndex = Math.floor(now / MAINTENANCE_GUILD_ROTATION_INTERVAL_MS) % guildIds.length
  return [...guildIds.slice(startIndex), ...guildIds.slice(0, startIndex)]
}
