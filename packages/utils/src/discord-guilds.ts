export interface ApprovedDiscordGuildEnvironment {
  ALLOWED_DISCORD_GUILD_ID?: string
  ALLOWED_DISCORD_GUILD_IDS?: string
}

export type ApprovedDiscordGuildConfiguration
  = | { ok: true, primaryGuildId: string, guildIds: string[] }
    | { ok: false, error: string }

export interface DiscordGuildIdentity {
  id: string
  name?: string | null
  iconUrl?: string | null
}

const DISCORD_ID_PATTERN = /^\d{17,20}$/

export function getApprovedDiscordGuildIds(env: ApprovedDiscordGuildEnvironment): string[] {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  return config.ok ? config.guildIds : []
}

export function resolveApprovedDiscordGuildConfiguration(
  env: ApprovedDiscordGuildEnvironment,
): ApprovedDiscordGuildConfiguration {
  const primaryRaw = env.ALLOWED_DISCORD_GUILD_ID
  const primaryGuildId = normalizeDiscordGuildId(primaryRaw)
  if (!primaryGuildId) {
    return { ok: false, error: primaryRaw == null || primaryRaw.trim().length === 0 ? 'primary guild ID is missing' : 'primary guild ID is invalid' }
  }

  const configuredPartners = env.ALLOWED_DISCORD_GUILD_IDS
  if (configuredPartners == null) return { ok: true, primaryGuildId, guildIds: [primaryGuildId] }
  if (configuredPartners.trim().length === 0) return { ok: false, error: 'approved guild ID list is empty' }

  const partnerGuildIds: string[] = []
  for (const raw of configuredPartners.split(',')) {
    const guildId = normalizeDiscordGuildId(raw)
    if (!guildId) return { ok: false, error: 'approved guild ID list is invalid' }
    partnerGuildIds.push(guildId)
  }

  return {
    ok: true,
    primaryGuildId,
    guildIds: [...new Set([primaryGuildId, ...partnerGuildIds])],
  }
}

export function getLegacyPrimaryDiscordGuildId(env: ApprovedDiscordGuildEnvironment): string | null {
  return normalizeDiscordGuildId(env.ALLOWED_DISCORD_GUILD_ID)
}

export function isApprovedDiscordGuildId(
  guildId: string | null | undefined,
  env: ApprovedDiscordGuildEnvironment,
): boolean {
  if (!guildId) return false
  const config = resolveApprovedDiscordGuildConfiguration(env)
  return config.ok && config.guildIds.includes(guildId)
}

export function normalizeDiscordGuildId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return DISCORD_ID_PATTERN.test(normalized) ? normalized : null
}

export function normalizeDiscordGuildIdentity(value: unknown): DiscordGuildIdentity | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DiscordGuildIdentity>
  const id = normalizeDiscordGuildId(candidate.id)
  if (!id) return null
  const name = normalizeOptionalString(candidate.name)
  const iconUrl = normalizeOptionalHttpsUrl(candidate.iconUrl)
  return {
    id,
    ...(name ? { name } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  }
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized.length > 0 ? normalized : null
}

function normalizeOptionalHttpsUrl(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    return url.protocol === 'https:' ? url.toString() : null
  }
  catch {
    return null
  }
}
