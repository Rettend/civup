import type { CompetitiveTier } from '@civup/game'
import type { AdminCommandContext, AdminVar } from './types.ts'
import { createDb } from '@civup/db'
import { formatLeaderboardModeLabel, parseLeaderboardMode } from '@civup/game'
import { previewRankedRoles, syncRankedRoles } from '../../services/ranked/role-sync.ts'
import {
  createRankedRoleTierId,
  fetchGuildRoles,
  formatRankedRoleSlotLabel,
  getConfiguredRankedRoleId,
  getConfiguredRankedRoleLabel,
  getRankedRoleConfig,
  updateRankedRoleConfig,
} from '../../services/ranked/roles.ts'
import { createStateStore } from '../../services/state/store.ts'
import { buildResolvedRoleDisplayById, sendEphemeralResponse, sendTransientEphemeralResponse } from './shared.ts'

export function handleRankedRoles(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const config = await getRankedRoleConfig(c.env.KV, guildId)
    await sendTransientEphemeralResponse(c, `Current ranked roles:
${formatRankedRoleConfig(config)}`, 'success')
  })
}

export function handleRankedRolesSet(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  const roleInputs = getRankedRoleInputs(c.var)
  const resolvedRoleDisplayById = buildResolvedRoleDisplayById(c.interaction.data)

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const hasConfigChanges = roleInputs.some(roleId => roleId !== undefined)
    let roleDisplayById: Map<string, { name: string, color: string | null }> | undefined = resolvedRoleDisplayById.size > 0
      ? resolvedRoleDisplayById
      : undefined
    if (!roleDisplayById) {
      try {
        const roles = await fetchGuildRoles(c.env.DISCORD_TOKEN, guildId)
        roleDisplayById = new Map(roles.map(role => [role.id, { name: role.name, color: role.color }]))
      }
      catch (error) {
        console.error('Failed to fetch guild roles while saving ranked role config:', error)
      }
    }

    const currentConfig = await getRankedRoleConfig(c.env.KV, guildId)
    const config = hasConfigChanges
      ? await updateRankedRoleConfig(c.env.KV, guildId, {
          tierRoleIdsByRank: roleInputs,
        }, roleDisplayById)
      : currentConfig

    const actionPrefix = hasConfigChanges ? 'Updated current ranked roles:' : 'Current ranked roles:'
    await sendTransientEphemeralResponse(c, `${actionPrefix}
${formatRankedRoleConfig(config)}`, 'success')
  })
}

export function handleRankedRolesUnset(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  const slot = parseUnsetSlot(c.var.slot)
  if (slot == null) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Choose a ranked role slot to unset.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const currentConfig = await getRankedRoleConfig(c.env.KV, guildId)
    const updates = buildUnsetRoleUpdates(currentConfig.tiers.length, slot)
    const config = currentConfig.tiers[slot - 1]?.roleId
      ? await updateRankedRoleConfig(c.env.KV, guildId, {
          tierRoleIdsByRank: updates,
        })
      : currentConfig

    const actionPrefix = currentConfig.tiers[slot - 1]?.roleId ? 'Updated current ranked roles:' : 'Current ranked roles:'
    await sendTransientEphemeralResponse(c, `${actionPrefix}
${formatRankedRoleConfig(config)}`, 'success')
  })
}

export function handleRankedPreview(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const kv = createStateStore(c.env)
    const db = createDb(c.env.DB)
    const preview = await previewRankedRoles({ db, kv, guildId })
    const config = await getRankedRoleConfig(kv, guildId)
    await sendEphemeralResponse(c, formatRankedRolePreview(preview, config), 'info')
  })
}

export function handleRankedSync(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const kv = createStateStore(c.env)
    const db = createDb(c.env.DB)
    try {
      const result = await syncRankedRoles({
        db,
        kv,
        guildId,
        token: c.env.DISCORD_TOKEN,
        applyDiscord: true,
      })
      const config = await getRankedRoleConfig(kv, guildId)
      await sendEphemeralResponse(c, formatRankedRoleSyncResult(result, config), 'success')
    }
    catch (error) {
      console.error('Failed to sync ranked roles:', error)
      const message = error instanceof Error ? error.message : 'Failed to sync ranked roles.'
      await sendTransientEphemeralResponse(c, message, 'error')
    }
  })
}

export function handleReset(c: AdminCommandContext) {
  const playerId = c.var.player
  const mode = parseLeaderboardMode(c.var.mode)
  if (!playerId || !mode) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Please provide player and mode.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const _db = createDb(c.env.DB)
    await sendTransientEphemeralResponse(c, `<@${playerId}>'s **${formatLeaderboardModeLabel(mode, mode)}** rating has been reset.`, 'success')
  })
}

function getRankedRoleInputs(vars: AdminVar): Array<string | null | undefined> {
  return [vars.role1, vars.role2, vars.role3, vars.role4, vars.role5, vars.role6, vars.role7, vars.role8, vars.role9, vars.role10]
}

function parseUnsetSlot(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const slot = Number(value)
  if (!Number.isInteger(slot) || slot < 1 || slot > 10) return null
  return slot
}

function buildUnsetRoleUpdates(length: number, slot: number): Array<string | null | undefined> {
  const updates = Array.from({ length: Math.max(length, slot) }, () => undefined as string | null | undefined)
  updates[slot - 1] = null
  return updates
}

function formatRankedRoleConfig(config: Awaited<ReturnType<typeof getRankedRoleConfig>>): string {
  const lines: string[] = []
  for (let index = 0; index < config.tiers.length; index++) {
    const tier = createRankedRoleTierId(index + 1)
    const roleId = getConfiguredRankedRoleId(config, tier)
    if (!roleId) continue
    lines.push(`${index + 1}. <@&${roleId}>`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No ranked roles configured yet.'
}

function formatRankedRolePreview(
  preview: Awaited<ReturnType<typeof previewRankedRoles>>,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string {
  const lines = [
    '**Ranked role preview**',
    formatRankedRoleDistribution(preview.distribution, config),
    `Unranked: ${preview.unrankedCount}`,
  ]

  if (preview.missingConfigTiers.length > 0) {
    lines.push(`Missing current role mappings: ${preview.missingConfigTiers.map(tier => formatRankedRoleSlotLabel(tier)).join(', ')}`)
  }

  const changes = preview.playerPreviews.filter(player => player.status !== 'kept')
  if (changes.length === 0) return lines.join('\n')

  lines.push('', '**Changes**')
  for (const player of changes.slice(0, 12)) {
    lines.push(formatRankedRoleChangeLine(player, config))
  }
  if (changes.length > 12) lines.push(`...and ${changes.length - 12} more`)
  return lines.join('\n')
}

function formatRankedRoleSyncResult(
  result: Awaited<ReturnType<typeof syncRankedRoles>>,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string {
  const lines = [
    '**Ranked roles synced**',
    `Updated members: ${result.appliedDiscordChanges}`,
    formatRankedRoleDistribution(result.distribution, config),
    `Unranked: ${result.unrankedCount}`,
  ]

  if (result.missingConfigTiers.length > 0) {
    lines.push(`Missing current role mappings: ${result.missingConfigTiers.map(tier => formatRankedRoleSlotLabel(tier)).join(', ')}`)
  }

  return lines.join('\n')
}

function formatRankedRoleChangeLine(
  player: Awaited<ReturnType<typeof previewRankedRoles>>['playerPreviews'][number],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string {
  const previous = player.previousAssignment
    ? `${formatRankedRoleReference(config, player.previousAssignment.tier)}${player.previousAssignment.sourceMode ? ` (${formatLeaderboardModeLabel(player.previousAssignment.sourceMode, player.previousAssignment.sourceMode)})` : ''}`
    : 'none'
  const next = `${formatRankedRoleReference(config, player.assignment.tier)}${player.assignment.sourceMode ? ` (${formatLeaderboardModeLabel(player.assignment.sourceMode, player.assignment.sourceMode)})` : ''}`
  const pending = player.pendingDemotion ? ` - demotion hold ${player.pendingDemotion.belowKeepSyncs}/7` : ''
  return `- ${player.displayName}: ${previous} -> ${next}${pending}`
}

function formatRankedRoleDistribution(
  distribution: Awaited<ReturnType<typeof previewRankedRoles>>['distribution'],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string {
  const parts: string[] = []
  for (let index = 0; index < config.tiers.length; index++) {
    const tier = createRankedRoleTierId(index + 1)
    parts.push(`${formatRankedRoleReference(config, tier)} ${distribution[tier] ?? 0}`)
  }
  return parts.join(' / ')
}

function formatRankedRoleReference(
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  tier: CompetitiveTier,
): string {
  const roleId = getConfiguredRankedRoleId(config, tier)
  if (roleId) return `<@&${roleId}>`
  return getConfiguredRankedRoleLabel(config, tier) ?? formatRankedRoleSlotLabel(tier)
}
