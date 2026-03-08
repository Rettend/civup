import type { EphemeralResponseTone } from '../../embeds/response'
import type { SystemChannelType } from '../../services/system/channels.ts'
import type { AdminVar, InteractionResolvedRoles } from './types.ts'
import { ephemeralResponseEmbed } from '../../embeds/response.ts'
import {
  sendEphemeralResponse as sendRawEphemeralResponse,
  sendTransientEphemeralResponse as sendRawTransientEphemeralResponse,
} from '../../services/response/ephemeral.ts'

export function getInteractionUserId(c: {
  interaction: {
    member?: { user?: { id?: string } }
    user?: { id?: string }
  }
}): string | null {
  return c.interaction.member?.user?.id ?? c.interaction.user?.id ?? null
}

export async function sendEphemeralResponse(
  c: Parameters<typeof sendRawEphemeralResponse>[0],
  message: string,
  tone: EphemeralResponseTone,
  options?: {
    components?: unknown
    autoDeleteMs?: number | null
  },
): Promise<void> {
  await sendRawEphemeralResponse(c, message, tone, {
    ...options,
    showButton: true,
  })
}

export async function sendTransientEphemeralResponse(
  c: Parameters<typeof sendRawTransientEphemeralResponse>[0],
  message: string,
  tone: EphemeralResponseTone,
): Promise<void> {
  await sendRawTransientEphemeralResponse(c, message, tone, { showButton: true })
}

export async function updateSeasonActionPrompt(
  c: { followup: (data?: any) => Promise<unknown> },
  message: string,
  tone: EphemeralResponseTone,
): Promise<void> {
  await c.followup({
    embeds: [ephemeralResponseEmbed(message, tone)],
    components: [],
  })
}

export function setupTargetLabel(target: SystemChannelType): string {
  if (target === 'draft') return 'Draft'
  if (target === 'archive') return 'Archive'
  if (target === 'rank-announcements') return 'Rank Announcements'
  return 'Leaderboard'
}

export function parseSetupTarget(value: string): SystemChannelType | null {
  if (value === 'draft' || value === 'archive' || value === 'leaderboard' || value === 'rank-announcements') return value
  return null
}

export function formatChannelMention(channelId: string | null): string {
  if (!channelId) return '`not set`'
  return `<#${channelId}>`
}

export function buildResolvedRoleDisplayById(data: unknown): Map<string, { name: string, color: string | null }> {
  const resolved = (data as InteractionResolvedRoles | undefined)?.resolved?.roles
  const displayById = new Map<string, { name: string, color: string | null }>()
  if (!resolved) return displayById

  for (const [roleId, role] of Object.entries(resolved)) {
    const name = typeof role?.name === 'string' && role.name.trim().length > 0 ? role.name : roleId
    const color = typeof role?.color === 'number' && Number.isFinite(role.color) && role.color > 0
      ? `#${Math.round(role.color).toString(16).padStart(6, '0').toUpperCase()}`
      : null
    displayById.set(roleId, { name, color })
  }

  return displayById
}

export function buildRankedRoleUpdates(vars: AdminVar): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  const roleInputs = [vars.role1, vars.role2, vars.role3, vars.role4, vars.role5]
  for (let index = 0; index < roleInputs.length; index++) {
    const roleId = roleInputs[index]
    if (!roleId) continue
    updates[String(index)] = roleId
  }
  return updates
}
