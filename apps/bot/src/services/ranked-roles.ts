import type { CompetitiveTier } from '@civup/game'
import { COMPETITIVE_TIERS, competitiveTierMeetsMinimum, competitiveTierRank } from '@civup/game'
import { DiscordApiError } from './discord.ts'

export interface RankedRoleConfig {
  currentRoles: Record<CompetitiveTier, string | null>
  currentRoleMeta: Record<CompetitiveTier, {
    label: string | null
    color: string | null
  }>
}

interface StoredRankedRoleConfig {
  currentRoles?: Partial<Record<CompetitiveTier, unknown>>
  currentRoleMeta?: Partial<Record<CompetitiveTier, {
    label?: unknown
    color?: unknown
  }>>
}

interface DiscordGuildRole {
  id?: unknown
  name?: unknown
  color?: unknown
}

interface RankedRoleDisplaySource {
  name: string
  color: string | null
}

export interface RankedRoleVisual {
  tier: CompetitiveTier
  rank: number
  roleId: string | null
  label: string
  color: string | null
}

export const RANKED_ROLE_CONFIG_KEY_PREFIX = 'ranked-roles:config:'

export const RANKED_TIERS_BY_PRESTIGE = ['champion', 'legion', 'gladiator', 'squire', 'pleb'] as const satisfies readonly CompetitiveTier[]

const EMPTY_RANKED_ROLE_CONFIG: RankedRoleConfig = {
  currentRoles: {
    pleb: null,
    squire: null,
    gladiator: null,
    legion: null,
    champion: null,
  },
  currentRoleMeta: {
    pleb: { label: null, color: null },
    squire: { label: null, color: null },
    gladiator: { label: null, color: null },
    legion: { label: null, color: null },
    champion: { label: null, color: null },
  },
}

const DEFAULT_COMPETITIVE_TIER_LABELS: Record<CompetitiveTier, string> = {
  pleb: 'Pleb',
  squire: 'Squire',
  gladiator: 'Gladiator',
  legion: 'Legion',
  champion: 'Champion',
}

export async function getRankedRoleConfig(kv: KVNamespace, guildId: string): Promise<RankedRoleConfig> {
  const stored = await kv.get(configKey(guildId), 'json') as StoredRankedRoleConfig | null
  return normalizeRankedRoleConfig(stored)
}

export async function setRankedRoleCurrentRoles(
  kv: KVNamespace,
  guildId: string,
  updates: Partial<Record<CompetitiveTier, string | null>>,
  roleDisplayById?: Map<string, RankedRoleDisplaySource>,
): Promise<RankedRoleConfig> {
  const current = await getRankedRoleConfig(kv, guildId)
  const next: RankedRoleConfig = {
    currentRoles: { ...current.currentRoles },
    currentRoleMeta: {
      pleb: { ...current.currentRoleMeta.pleb },
      squire: { ...current.currentRoleMeta.squire },
      gladiator: { ...current.currentRoleMeta.gladiator },
      legion: { ...current.currentRoleMeta.legion },
      champion: { ...current.currentRoleMeta.champion },
    },
  }

  for (const tier of COMPETITIVE_TIERS) {
    if (!(tier in updates)) continue
    const roleId = normalizeRoleId(updates[tier])
    next.currentRoles[tier] = roleId
    const display = roleId ? roleDisplayById?.get(roleId) : null
    next.currentRoleMeta[tier] = {
      label: display?.name ?? null,
      color: display?.color ?? null,
    }
  }

  await kv.put(configKey(guildId), JSON.stringify(next))
  return next
}

export function getConfiguredRankedRoleId(config: RankedRoleConfig, tier: CompetitiveTier): string | null {
  return config.currentRoles[tier] ?? null
}

export function getMissingRankedRoleConfigTiers(config: RankedRoleConfig): CompetitiveTier[] {
  return COMPETITIVE_TIERS.filter(tier => !getConfiguredRankedRoleId(config, tier))
}

export function resolveCurrentCompetitiveTierFromRoleIds(
  roleIds: string[],
  config: RankedRoleConfig,
): CompetitiveTier | null {
  let best: CompetitiveTier | null = null

  for (const tier of COMPETITIVE_TIERS) {
    const roleId = getConfiguredRankedRoleId(config, tier)
    if (!roleId || !roleIds.includes(roleId)) continue
    if (!best || competitiveTierRank(tier) > competitiveTierRank(best)) best = tier
  }

  return best
}

export async function resolveMemberCurrentCompetitiveTier(
  token: string,
  guildId: string,
  userId: string,
  config: RankedRoleConfig,
): Promise<CompetitiveTier | null> {
  const roleIds = await fetchGuildMemberRoleIds(token, guildId, userId)
  return resolveCurrentCompetitiveTierFromRoleIds(roleIds, config)
}

export function getRankedRoleGateError(config: RankedRoleConfig, minRole: CompetitiveTier): string | null {
  return getConfiguredRankedRoleId(config, minRole)
    ? null
    : `Minimum rank ${fallbackRoleLabel(minRole)} is not configured yet. Ask an admin to run /admin ranked roles.`
}

export function buildRankedRoleVisuals(
  config: RankedRoleConfig,
  displayByRoleId?: Map<string, RankedRoleDisplaySource>,
): RankedRoleVisual[] {
  return RANKED_TIERS_BY_PRESTIGE.map((tier, index) => {
    const roleId = getConfiguredRankedRoleId(config, tier)
    const display = roleId ? displayByRoleId?.get(roleId) : undefined
    const storedMeta = config.currentRoleMeta[tier]

    return {
      tier,
      rank: index + 1,
      roleId,
      label: display?.name ?? storedMeta.label ?? fallbackRoleLabel(tier),
      color: display?.color ?? storedMeta.color ?? null,
    }
  })
}

export async function resolveRankedRoleVisuals(
  token: string,
  guildId: string,
  config: RankedRoleConfig,
): Promise<RankedRoleVisual[]> {
  const roles = await fetchGuildRoles(token, guildId)
  const displayByRoleId = new Map<string, RankedRoleDisplaySource>()

  for (const role of roles) {
    displayByRoleId.set(role.id, {
      name: role.name,
      color: role.color,
    })
  }

  return buildRankedRoleVisuals(config, displayByRoleId)
}

export function fallbackRoleLabel(tier: CompetitiveTier): string {
  const rank = rankedRoleNumber(tier)
  return `Role ${rank}`
}

export function formatCompetitiveTierLabel(tier: CompetitiveTier): string {
  return DEFAULT_COMPETITIVE_TIER_LABELS[tier]
}

export function getRankedTierLabel(config: RankedRoleConfig, tier: CompetitiveTier): string {
  return config.currentRoleMeta[tier].label ?? formatCompetitiveTierLabel(tier)
}

export function rankedRoleNumber(tier: CompetitiveTier): number {
  const index = RANKED_TIERS_BY_PRESTIGE.indexOf(tier)
  return index >= 0 ? index + 1 : 5 - competitiveTierRank(tier)
}

export function memberMeetsRankedRoleGate(
  roleIds: string[],
  minRole: CompetitiveTier | null,
  config: RankedRoleConfig,
): boolean {
  const currentTier = resolveCurrentCompetitiveTierFromRoleIds(roleIds, config)
  return competitiveTierMeetsMinimum(currentTier, minRole)
}

export async function fetchGuildMemberRoleIds(token: string, guildId: string, userId: string): Promise<string[]> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  })

  if (response.status === 404) return []
  if (!response.ok) {
    const detail = await response.text()
    throw new DiscordApiError('fetch guild member', response.status, detail)
  }

  const payload = await response.json() as { roles?: unknown }
  if (!Array.isArray(payload.roles)) return []

  return payload.roles.filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)
}

export async function fetchGuildRoles(token: string, guildId: string): Promise<Array<{ id: string, name: string, color: string | null }>> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new DiscordApiError('fetch guild roles', response.status, detail)
  }

  const payload = await response.json() as unknown
  if (!Array.isArray(payload)) return []

  const roles: Array<{ id: string, name: string, color: string | null }> = []
  for (const rawRole of payload) {
    const normalized = normalizeDiscordGuildRole(rawRole as DiscordGuildRole)
    if (!normalized) continue
    roles.push(normalized)
  }

  return roles
}

function configKey(guildId: string): string {
  return `${RANKED_ROLE_CONFIG_KEY_PREFIX}${guildId}`
}

function normalizeRankedRoleConfig(raw: StoredRankedRoleConfig | null | undefined): RankedRoleConfig {
  const currentRoles = { ...EMPTY_RANKED_ROLE_CONFIG.currentRoles }
  const currentRoleMeta = {
    pleb: { ...EMPTY_RANKED_ROLE_CONFIG.currentRoleMeta.pleb },
    squire: { ...EMPTY_RANKED_ROLE_CONFIG.currentRoleMeta.squire },
    gladiator: { ...EMPTY_RANKED_ROLE_CONFIG.currentRoleMeta.gladiator },
    legion: { ...EMPTY_RANKED_ROLE_CONFIG.currentRoleMeta.legion },
    champion: { ...EMPTY_RANKED_ROLE_CONFIG.currentRoleMeta.champion },
  }

  for (const tier of COMPETITIVE_TIERS) {
    currentRoles[tier] = normalizeRoleId(raw?.currentRoles?.[tier])
    currentRoleMeta[tier] = {
      label: normalizeOptionalLabel(raw?.currentRoleMeta?.[tier]?.label),
      color: normalizeOptionalLabel(raw?.currentRoleMeta?.[tier]?.color),
    }
  }

  return { currentRoles, currentRoleMeta }
}

function normalizeRoleId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null
}

function normalizeOptionalLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeDiscordGuildRole(raw: DiscordGuildRole): { id: string, name: string, color: string | null } | null {
  const id = normalizeRoleId(raw.id)
  if (!id) return null

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0
    ? raw.name
    : id

  const color = normalizeDiscordRoleColor(raw.color)
  return { id, name, color }
}

function normalizeDiscordRoleColor(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.max(0, Math.round(value))
  if (rounded === 0) return null
  return `#${rounded.toString(16).padStart(6, '0').toUpperCase()}`
}
