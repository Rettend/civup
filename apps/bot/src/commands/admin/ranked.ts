import type { CompetitiveTier } from '@civup/game'
import type { AdminCommandContext, AdminVar } from './types.ts'
import { createDb } from '@civup/db'
import { formatLeaderboardModeLabel, parseLeaderboardMode } from '@civup/game'
import { fetchGuildRoles, formatRankedRoleSlotLabel, getConfiguredRankedRoleLabel, getRankedRoleConfig, RANKED_TIERS_BY_PRESTIGE, setRankedRoleCurrentRoles } from '../../services/ranked/roles.ts'
import { previewRankedRoles, syncRankedRoles } from '../../services/ranked/role-sync.ts'
import { buildResolvedRoleDisplayById, sendEphemeralResponse, sendTransientEphemeralResponse } from './shared.ts'

export function handleRankedRoles(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  const updates = buildRankedRoleUpdates(c.var)
  const resolvedRoleDisplayById = buildResolvedRoleDisplayById(c.interaction.data)

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const hasUpdates = Object.keys(updates).length > 0
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
    const config = hasUpdates
      ? await setRankedRoleCurrentRoles(c.env.KV, guildId, updates, roleDisplayById)
      : roleDisplayById
        ? await setRankedRoleCurrentRoles(c.env.KV, guildId, currentConfig.currentRoles, roleDisplayById)
        : currentConfig

    const actionPrefix = hasUpdates ? 'Updated current ranked roles:' : 'Current ranked roles:'
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
    const db = createDb(c.env.DB)
    const preview = await previewRankedRoles({ db, kv: c.env.KV, guildId })
    const config = await getRankedRoleConfig(c.env.KV, guildId)
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
    const db = createDb(c.env.DB)
    try {
      const result = await syncRankedRoles({
        db,
        kv: c.env.KV,
        guildId,
        token: c.env.DISCORD_TOKEN,
        applyDiscord: true,
      })
      const config = await getRankedRoleConfig(c.env.KV, guildId)
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

function buildRankedRoleUpdates(vars: AdminVar): Partial<Record<CompetitiveTier, string | null>> {
  const updates: Partial<Record<CompetitiveTier, string | null>> = {}
  const roleInputs = [vars.role1, vars.role2, vars.role3, vars.role4, vars.role5]
  for (let index = 0; index < roleInputs.length; index++) {
    const roleId = roleInputs[index]
    const tier = RANKED_TIERS_BY_PRESTIGE[index]
    if (!tier || !roleId) continue
    updates[tier] = roleId
  }
  return updates
}

function formatRankedRoleConfig(config: Awaited<ReturnType<typeof getRankedRoleConfig>>): string {
  return RANKED_TIERS_BY_PRESTIGE
    .map((tier, index) => `${index + 1}. ${config.currentRoles[tier] ? `<@&${config.currentRoles[tier]}>` : '`not set`'}`)
    .join('\n')
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
  return RANKED_TIERS_BY_PRESTIGE
    .map(tier => `${formatRankedRoleReference(config, tier)} ${distribution[tier]}`)
    .join(' / ')
}

function formatRankedRoleReference(
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  tier: CompetitiveTier,
): string {
  const roleId = config.currentRoles[tier]
  if (roleId) return `<@&${roleId}>`
  return getConfiguredRankedRoleLabel(config, tier) ?? formatRankedRoleSlotLabel(tier)
}
