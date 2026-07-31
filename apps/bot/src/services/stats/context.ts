import type { ApprovedDiscordGuildEnvironment } from '@civup/utils'
import { resolveApprovedDiscordGuildConfiguration } from '@civup/utils'

export type StatsKey = `server:${string}`

export interface StatsContext {
  guildId: string
  primaryGuildId: string
  statsKey: StatsKey
  seasonPolicy: 'ppl-seasons' | 'all-time'
}

export function createStatsContext(guildId: string, primaryGuildId: string): StatsContext {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Stats guild ID is missing or invalid')
  if (!/^\d{17,20}$/.test(primaryGuildId)) throw new Error('Primary stats guild ID is missing or invalid')
  return {
    guildId,
    primaryGuildId,
    statsKey: `server:${guildId}`,
    seasonPolicy: guildId === primaryGuildId ? 'ppl-seasons' : 'all-time',
  }
}

export function resolveStatsContext(
  guildId: string | null | undefined,
  env: ApprovedDiscordGuildEnvironment,
): StatsContext {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  if (!config.ok) throw new Error(`Approved Discord server configuration is invalid: ${config.error}`)
  if (!guildId || !config.guildIds.includes(guildId)) throw new Error('Stats server is missing or not approved')
  return createStatsContext(guildId, config.primaryGuildId)
}

export function statsKeyForGuild(guildId: string): StatsKey {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Stats guild ID is missing or invalid')
  return `server:${guildId}`
}

export function requireStoredMatchGuildId(match: { guildId?: string | null }): string {
  if (!match.guildId || !/^\d{17,20}$/.test(match.guildId)) {
    throw new Error('Match ownership is missing; runtime ownership fallback is disabled')
  }
  return match.guildId
}
