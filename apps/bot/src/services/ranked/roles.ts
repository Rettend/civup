import type { CompetitiveTier } from '@civup/game'
import { competitiveTierMeetsMaximum, competitiveTierMeetsMinimum, competitiveTierNumber, competitiveTierRank, isCompetitiveTier } from '@civup/game'
import { DiscordApiError } from '../discord/index.ts'

export interface RankedRoleTierConfig {
  roleId: string | null
  label: string | null
  color: string | null
}

export interface RankedRoleConfig {
  tiers: RankedRoleTierConfig[]
}

interface StoredRankedRoleConfig {
  tiers?: Array<{
    roleId?: unknown
    label?: unknown
    color?: unknown
  }>
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
export const DEFAULT_RANKED_ROLE_TIER_COUNT = 5
export const MIN_RANKED_ROLE_TIER_COUNT = 3
export const MAX_RANKED_ROLE_TIER_COUNT = 10

export function createRankedRoleTierId(rank: number): CompetitiveTier {
  return `tier${Math.max(1, Math.round(rank))}`
}

export function getRankedRoleTierCount(config: RankedRoleConfig): number {
  return config.tiers.length
}

export function getHighestRankedRoleTier(config: RankedRoleConfig): CompetitiveTier | null {
  return config.tiers.length > 0 ? createRankedRoleTierId(1) : null
}

export function getLowestRankedRoleTier(config: RankedRoleConfig): CompetitiveTier | null {
  return config.tiers.length > 0 ? createRankedRoleTierId(config.tiers.length) : null
}

export function hasConfiguredRankedRoleTier(config: RankedRoleConfig, tier: CompetitiveTier): boolean {
  const rank = rankedRoleNumber(tier)
  return rank >= 1 && rank <= config.tiers.length
}

export function parseConfiguredRankedRoleTier(config: RankedRoleConfig, value: unknown): CompetitiveTier | null {
  const tier = normalizeRankedRoleTierId(value)
  if (!tier) return null
  return hasConfiguredRankedRoleTier(config, tier) ? tier : null
}

export function normalizeRankedRoleTierId(value: unknown): CompetitiveTier | null {
  return normalizeTierKey(value)
}

export async function getRankedRoleConfig(kv: KVNamespace, guildId: string): Promise<RankedRoleConfig> {
  const stored = await kv.get(configKey(guildId), 'json') as StoredRankedRoleConfig | null
  return normalizeRankedRoleConfig(stored)
}

export async function setRankedRoleTierCount(
  kv: KVNamespace,
  guildId: string,
  tierCount: number,
): Promise<RankedRoleConfig> {
  const current = await getRankedRoleConfig(kv, guildId)
  const next = resizeRankedRoleConfig(current, tierCount)
  await kv.put(configKey(guildId), JSON.stringify(next))
  return next
}

export async function updateRankedRoleConfig(
  kv: KVNamespace,
  guildId: string,
  input: {
    tierCount?: number
    tierRoleIdsByRank?: Array<string | null | undefined>
  },
  roleDisplayById?: Map<string, RankedRoleDisplaySource>,
): Promise<RankedRoleConfig> {
  const current = await getRankedRoleConfig(kv, guildId)
  const next = resizeRankedRoleConfig(current, resolveNextTierCount(current, input))

  for (let index = 0; index < next.tiers.length; index++) {
    const update = input.tierRoleIdsByRank?.[index]
    if (update === undefined) continue
    const roleId = normalizeRoleId(update)
    const display = roleId ? roleDisplayById?.get(roleId) : null
    next.tiers[index] = {
      roleId,
      label: display?.name ?? null,
      color: display?.color ?? null,
    }
  }

  await kv.put(configKey(guildId), JSON.stringify(next))
  return next
}

export async function setRankedRoleCurrentRoles(
  kv: KVNamespace,
  guildId: string,
  updates: Partial<Record<CompetitiveTier, string | null>>,
  roleDisplayById?: Map<string, RankedRoleDisplaySource>,
): Promise<RankedRoleConfig> {
  const current = await getRankedRoleConfig(kv, guildId)
  const requestedRanks = Object.keys(updates)
    .map(normalizeTierKey)
    .filter((tier): tier is CompetitiveTier => tier != null)
    .map(tier => rankedRoleNumber(tier))
  const highestRank = requestedRanks.length > 0 ? Math.max(...requestedRanks) : current.tiers.length
  const next = resizeRankedRoleConfig(current, Math.max(current.tiers.length, highestRank))

  for (const [rawTier, rawRoleId] of Object.entries(updates)) {
    const tier = normalizeTierKey(rawTier)
    if (!tier) continue
    const index = rankedRoleNumber(tier) - 1
    const slot = next.tiers[index]
    if (!slot) continue

    const roleId = normalizeRoleId(rawRoleId)
    const display = roleId ? roleDisplayById?.get(roleId) : null
    next.tiers[index] = {
      roleId,
      label: display?.name ?? slot.label ?? null,
      color: display?.color ?? slot.color ?? null,
    }
  }

  await kv.put(configKey(guildId), JSON.stringify(next))
  return next
}

export function getConfiguredRankedRoleId(config: RankedRoleConfig, tier: CompetitiveTier): string | null {
  const slot = getRankedRoleTierConfig(config, tier)
  return slot?.roleId ?? null
}

export function getMissingRankedRoleConfigTiers(config: RankedRoleConfig): CompetitiveTier[] {
  return config.tiers
    .map((_tier, index) => createRankedRoleTierId(index + 1))
    .filter(tier => !getConfiguredRankedRoleId(config, tier))
}

export function resolveCurrentCompetitiveTierFromRoleIds(
  roleIds: string[],
  config: RankedRoleConfig,
): CompetitiveTier | null {
  let best: CompetitiveTier | null = null

  for (let index = 0; index < config.tiers.length; index++) {
    const tier = createRankedRoleTierId(index + 1)
    const roleId = config.tiers[index]?.roleId ?? null
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

export function getRankedRoleGateError(config: RankedRoleConfig, tier: CompetitiveTier, bound: 'min' | 'max' = 'min'): string | null {
  return getConfiguredRankedRoleId(config, tier)
    ? null
    : `This ${bound} rank is not configured yet. Ask an admin to run /admin ranked roles.`
}

export function buildRankedRoleVisuals(
  config: RankedRoleConfig,
  displayByRoleId?: Map<string, RankedRoleDisplaySource>,
): RankedRoleVisual[] {
  return config.tiers.flatMap((slot, index) => {
    if (!slot.roleId) return []
    const tier = createRankedRoleTierId(index + 1)
    const display = displayByRoleId?.get(slot.roleId)

    return [{
      tier,
      rank: index + 1,
      roleId: slot.roleId,
      label: display?.name ?? slot.label ?? slot.roleId,
      color: display?.color ?? slot.color ?? null,
    }]
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

export function formatRankedRoleSlotLabel(tierOrRank: CompetitiveTier | number): string {
  const rank = typeof tierOrRank === 'number' ? Math.max(1, Math.round(tierOrRank)) : Math.max(1, rankedRoleNumber(tierOrRank))
  return `Role ${rank}`
}

export function getConfiguredRankedRoleLabel(config: RankedRoleConfig, tier: CompetitiveTier): string | null {
  const label = getRankedRoleTierConfig(config, tier)?.label?.trim()
  return label && label.length > 0 ? label : formatRankedRoleSlotLabel(tier)
}

export function rankedRoleNumber(tier: CompetitiveTier): number {
  const normalized = normalizeTierKey(tier)
  return competitiveTierNumber(normalized ?? '') ?? 0
}

export function memberMeetsRankedRoleGate(
  roleIds: string[],
  minRole: CompetitiveTier | null,
  config: RankedRoleConfig,
  maxRole: CompetitiveTier | null = null,
): boolean {
  const currentTier = resolveCurrentCompetitiveTierFromRoleIds(roleIds, config)
  return competitiveTierMeetsMinimum(currentTier, minRole)
    && competitiveTierMeetsMaximum(currentTier, maxRole)
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

function getRankedRoleTierConfig(config: RankedRoleConfig, tier: CompetitiveTier): RankedRoleTierConfig | null {
  const index = rankedRoleNumber(tier) - 1
  return config.tiers[index] ?? null
}

function resizeRankedRoleConfig(config: RankedRoleConfig, requestedTierCount: number): RankedRoleConfig {
  const tierCount = clampTierCount(requestedTierCount)
  const tiers = Array.from({ length: tierCount }, (_value, index) => {
    const existing = config.tiers[index]
    return existing ? { ...existing } : createEmptyRankedRoleTierConfig()
  })
  return { tiers }
}

function normalizeRankedRoleConfig(raw: StoredRankedRoleConfig | null | undefined): RankedRoleConfig {
  if (!Array.isArray(raw?.tiers) || raw.tiers.length === 0) return createDefaultRankedRoleConfig()
  return resizeRankedRoleConfig({
    tiers: raw.tiers.map(tier => ({
      roleId: normalizeRoleId(tier?.roleId),
      label: normalizeOptionalLabel(tier?.label),
      color: normalizeOptionalLabel(tier?.color),
    })),
  }, raw.tiers.length)
}

function resolveNextTierCount(
  current: RankedRoleConfig,
  input: {
    tierCount?: number
    tierRoleIdsByRank?: Array<string | null | undefined>
  },
): number {
  if (typeof input.tierCount === 'number') return input.tierCount

  const highestConfiguredRank = current.tiers.reduce((best, tier, index) => tier.roleId ? index + 1 : best, 0)
  const highestProvidedRank = (input.tierRoleIdsByRank ?? []).reduce((best, roleId, index) => {
    return normalizeRoleId(roleId) ? index + 1 : best
  }, 0)
  const derivedTierCount = Math.max(highestConfiguredRank, highestProvidedRank)

  if (derivedTierCount > 0) return derivedTierCount
  return current.tiers.length
}

function createDefaultRankedRoleConfig(): RankedRoleConfig {
  return {
    tiers: Array.from({ length: DEFAULT_RANKED_ROLE_TIER_COUNT }, () => createEmptyRankedRoleTierConfig()),
  }
}

function createEmptyRankedRoleTierConfig(): RankedRoleTierConfig {
  return {
    roleId: null,
    label: null,
    color: null,
  }
}

function clampTierCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RANKED_ROLE_TIER_COUNT
  return Math.max(MIN_RANKED_ROLE_TIER_COUNT, Math.min(MAX_RANKED_ROLE_TIER_COUNT, Math.round(value)))
}

function normalizeTierKey(value: unknown): CompetitiveTier | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return isCompetitiveTier(trimmed) ? trimmed : null
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
