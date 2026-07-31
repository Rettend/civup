<<<<<<< New base: feat: save file analyzer
import { buildDiscordAvatarUrl } from '@civup/utils'

export interface DiscordAuthEnvironment {
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
}

interface DiscordTokenSuccessResponse {
  access_token?: string
  expires_in?: number
}

interface DiscordTokenErrorResponse {
  error?: string
  error_description?: string
}

interface DiscordUserResponse {
  id?: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

interface DiscordIdentityResponse extends DiscordUserResponse {
  nick?: string | null
  guildAvatar?: string | null
  guildId?: string | null
}

interface DiscordGuildMemberResponse {
  nick?: string | null
  avatar?: string | null
  roles?: unknown
  user?: DiscordUserResponse | null
}

interface DiscordCurrentUserGuildResponse {
  id?: string
  name?: string
  icon?: string | null
  owner?: boolean
  permissions?: string
}

export type DiscordTokenExchangeResult
  = | { ok: true, accessToken: string, expiresIn?: number }
    | { ok: false, status: number, detail: string, retryAfter: string | null, rateLimited: boolean }

export type DiscordIdentityResult
  = | {
    ok: true
    userId: string
    displayName: string | null
    avatarUrl: string
    guildId: string | null
    guildName: string | null
    guildIconUrl: string | null
    guildRoleIds: string[]
    guildPermissions: string | null
  }
    | { ok: false, status: 403 | 502, error: string }

export async function exchangeDiscordAuthorizationCode(
  env: DiscordAuthEnvironment,
  input: { code: string, redirectUri: string, codeVerifier?: string },
): Promise<DiscordTokenExchangeResult> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
  })
  if (input.codeVerifier) body.set('code_verifier', input.codeVerifier)

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const retryAfter = response.headers.get('Retry-After') ?? response.headers.get('X-RateLimit-Reset-After')
  if (!response.ok) {
    const detailRaw = await response.text()
    let detailJson: DiscordTokenErrorResponse | null = null
    try {
      detailJson = JSON.parse(detailRaw) as DiscordTokenErrorResponse
    }
    catch {}
    const detail = detailJson?.error_description ?? detailJson?.error ?? detailRaw ?? 'Token exchange failed'
    return {
      ok: false,
      status: response.status,
      detail,
      retryAfter,
      rateLimited: response.status === 429 || /rate limit/i.test(detail),
    }
  }

  const payload = await response.json<DiscordTokenSuccessResponse>()
  if (!payload.access_token) {
    return { ok: false, status: 502, detail: 'Token exchange returned no access token', retryAfter: null, rateLimited: false }
  }
  return { ok: true, accessToken: payload.access_token, expiresIn: payload.expires_in }
}

export async function loadDiscordIdentity(
  accessToken: string,
  approvedGuildIds: readonly string[],
  requestedGuildId?: string | null,
): Promise<DiscordIdentityResult> {
  let user: DiscordIdentityResponse
  let guildPermissions: string | null = null
  let sourceGuild: DiscordCurrentUserGuildResponse | null = null
  let guildRoleIds: string[] = []
  if (approvedGuildIds.length > 0) {
    const authorization = { Authorization: `Bearer ${accessToken}` }
    const requested = requestedGuildId?.trim() || null
    if (requested && !approvedGuildIds.includes(requested)) {
      return { ok: false, status: 403, error: 'This activity is not available in this Discord server' }
    }
    const guilds = await loadCurrentUserApprovedGuilds(accessToken, approvedGuildIds, requested)
    if (!guilds) return { ok: false, status: 502, error: 'Failed to verify Discord permissions' }
    sourceGuild = requested
      ? guilds.find(candidate => candidate.id === requested) ?? null
      : approvedGuildIds.flatMap(guildId => guilds.find(candidate => candidate.id === guildId) ?? [])[0] ?? null
    if (!sourceGuild?.id) return { ok: false, status: 403, error: 'This activity is only available in an approved Discord server' }

    const memberResponse = await fetch(`https://discord.com/api/v10/users/@me/guilds/${sourceGuild.id}/member`, { headers: authorization })
    if (!memberResponse.ok) {
      if (memberResponse.status === 403 || memberResponse.status === 404) {
        return { ok: false, status: 403, error: 'This activity is only available in an approved Discord server' }
      }
      return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    }
    guildPermissions = normalizeDiscordPermissions(sourceGuild.permissions, sourceGuild.owner === true)
    if (!guildPermissions) return { ok: false, status: 502, error: 'Failed to verify Discord permissions' }

    const member = await memberResponse.json<DiscordGuildMemberResponse>()
    if (!member.user) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    guildRoleIds = normalizeGuildRoleIds(member.roles)
    user = { ...member.user, nick: member.nick ?? null, guildAvatar: member.avatar ?? null, guildId: sourceGuild.id }
  }
  else {
    const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    user = await response.json<DiscordIdentityResponse>()
  }

  const userId = typeof user.id === 'string' ? user.id.trim() : ''
  if (!userId) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
  return {
    ok: true,
    userId,
    displayName: resolveDiscordDisplayName(user),
    avatarUrl: buildDiscordIdentityAvatarUrl(user, userId),
    guildId: sourceGuild?.id ?? null,
    guildName: normalizeOptionalDiscordName(sourceGuild?.name),
    guildIconUrl: buildDiscordGuildIconUrl(sourceGuild),
    guildRoleIds,
    guildPermissions,
  }
}

async function loadCurrentUserApprovedGuilds(
  accessToken: string,
  approvedGuildIds: readonly string[],
  requestedGuildId: string | null,
): Promise<DiscordCurrentUserGuildResponse[] | null> {
  const approved = new Set(approvedGuildIds)
  const found: DiscordCurrentUserGuildResponse[] = []
  let after: string | null = null

  while (true) {
    const url = new URL('https://discord.com/api/v10/users/@me/guilds')
    url.searchParams.set('limit', '200')
    if (after) url.searchParams.set('after', after)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    const page = await response.json<DiscordCurrentUserGuildResponse[]>()
    if (!Array.isArray(page)) return null
    for (const guild of page) {
      if (guild.id && approved.has(guild.id)) found.push(guild)
    }
    if (requestedGuildId && found.some(guild => guild.id === requestedGuildId)) return found
    if (!requestedGuildId && found.length > 0) return found
    if (page.length < 200) return found
    const nextAfter = page.at(-1)?.id ?? null
    if (!nextAfter || nextAfter === after) return found
    after = nextAfter
  }
}

function normalizeGuildRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((roleId): roleId is string => typeof roleId === 'string' && /^\d+$/.test(roleId)))]
}

function buildDiscordGuildIconUrl(guild: DiscordCurrentUserGuildResponse | null): string | null {
  if (!guild?.id || !guild.icon) return null
  const ext = guild.icon.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=64`
}

function normalizeDiscordPermissions(value: string | undefined, isOwner: boolean): string | null {
  if (!value || !/^\d+$/.test(value)) return null
  try {
    const permissions = BigInt(value)
    return (isOwner ? permissions | (1n << 3n) : permissions).toString()
  }
  catch {
    return null
  }
}

function resolveDiscordDisplayName(user: DiscordIdentityResponse): string | null {
  return normalizeOptionalDiscordName(user.nick)
    ?? normalizeOptionalDiscordName(user.global_name)
    ?? normalizeOptionalDiscordName(user.username)
}

function normalizeOptionalDiscordName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

function buildDiscordIdentityAvatarUrl(user: DiscordIdentityResponse, userId: string): string {
  if (user.guildId && user.guildAvatar) {
    const ext = user.guildAvatar.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/guilds/${user.guildId}/users/${userId}/avatars/${user.guildAvatar}.${ext}?size=128`
  }
  return buildDiscordAvatarUrl(userId, user.avatar ?? null)
}
|||||||
=======
import { buildDiscordAvatarUrl } from '@civup/utils'

export interface DiscordAuthEnvironment {
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
}

interface DiscordTokenSuccessResponse {
  access_token?: string
  expires_in?: number
}

interface DiscordTokenErrorResponse {
  error?: string
  error_description?: string
}

interface DiscordUserResponse {
  id?: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

interface DiscordIdentityResponse extends DiscordUserResponse {
  nick?: string | null
  guildAvatar?: string | null
  guildId?: string | null
}

interface DiscordGuildMemberResponse {
  nick?: string | null
  avatar?: string | null
  user?: DiscordUserResponse | null
}

interface DiscordCurrentUserGuildResponse {
  id?: string
  owner?: boolean
  permissions?: string
}

export type DiscordTokenExchangeResult
  = | { ok: true, accessToken: string, expiresIn?: number }
    | { ok: false, status: number, detail: string, retryAfter: string | null, rateLimited: boolean }

export type DiscordIdentityResult
  = | {
    ok: true
    userId: string
    displayName: string | null
    avatarUrl: string
    guildId: string | null
    guildPermissions: string | null
  }
    | { ok: false, status: 403 | 502, error: string }

export async function exchangeDiscordAuthorizationCode(
  env: DiscordAuthEnvironment,
  input: { code: string, redirectUri: string, codeVerifier?: string },
): Promise<DiscordTokenExchangeResult> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
  })
  if (input.codeVerifier) body.set('code_verifier', input.codeVerifier)

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const retryAfter = response.headers.get('Retry-After') ?? response.headers.get('X-RateLimit-Reset-After')
  if (!response.ok) {
    const detailRaw = await response.text()
    let detailJson: DiscordTokenErrorResponse | null = null
    try {
      detailJson = JSON.parse(detailRaw) as DiscordTokenErrorResponse
    }
    catch {}
    const detail = detailJson?.error_description ?? detailJson?.error ?? detailRaw ?? 'Token exchange failed'
    return {
      ok: false,
      status: response.status,
      detail,
      retryAfter,
      rateLimited: response.status === 429 || /rate limit/i.test(detail),
    }
  }

  const payload = await response.json<DiscordTokenSuccessResponse>()
  if (!payload.access_token) {
    return { ok: false, status: 502, detail: 'Token exchange returned no access token', retryAfter: null, rateLimited: false }
  }
  return { ok: true, accessToken: payload.access_token, expiresIn: payload.expires_in }
}

export async function loadDiscordIdentity(accessToken: string, allowedGuildId: string | null): Promise<DiscordIdentityResult> {
  let user: DiscordIdentityResponse
  let guildPermissions: string | null = null
  if (allowedGuildId) {
    const authorization = { Authorization: `Bearer ${accessToken}` }
    const [memberResponse, guildsResponse] = await Promise.all([
      fetch(`https://discord.com/api/v10/users/@me/guilds/${allowedGuildId}/member`, { headers: authorization }),
      fetch('https://discord.com/api/v10/users/@me/guilds?limit=200', { headers: authorization }),
    ])
    if (!memberResponse.ok) {
      if (memberResponse.status === 403 || memberResponse.status === 404) {
        return { ok: false, status: 403, error: 'This activity is only available in the configured Discord server' }
      }
      return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    }
    if (!guildsResponse.ok) return { ok: false, status: 502, error: 'Failed to verify Discord permissions' }

    const guilds = await guildsResponse.json<DiscordCurrentUserGuildResponse[]>()
    if (!Array.isArray(guilds)) return { ok: false, status: 502, error: 'Failed to verify Discord permissions' }
    const guild = guilds.find(candidate => candidate.id === allowedGuildId)
    if (!guild) return { ok: false, status: 403, error: 'This activity is only available in the configured Discord server' }
    guildPermissions = normalizeDiscordPermissions(guild.permissions, guild.owner === true)
    if (!guildPermissions) return { ok: false, status: 502, error: 'Failed to verify Discord permissions' }

    const member = await memberResponse.json<DiscordGuildMemberResponse>()
    if (!member.user) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    user = { ...member.user, nick: member.nick ?? null, guildAvatar: member.avatar ?? null, guildId: allowedGuildId }
  }
  else {
    const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    user = await response.json<DiscordIdentityResponse>()
  }

  const userId = typeof user.id === 'string' ? user.id.trim() : ''
  if (!userId) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
  return {
    ok: true,
    userId,
    displayName: resolveDiscordDisplayName(user),
    avatarUrl: buildDiscordIdentityAvatarUrl(user, userId),
    guildId: allowedGuildId,
    guildPermissions,
  }
}

function normalizeDiscordPermissions(value: string | undefined, isOwner: boolean): string | null {
  if (!value || !/^\d+$/.test(value)) return null
  try {
    const permissions = BigInt(value)
    return (isOwner ? permissions | (1n << 3n) : permissions).toString()
  }
  catch {
    return null
  }
}

function resolveDiscordDisplayName(user: DiscordIdentityResponse): string | null {
  return normalizeOptionalDiscordName(user.nick)
    ?? normalizeOptionalDiscordName(user.global_name)
    ?? normalizeOptionalDiscordName(user.username)
}

function normalizeOptionalDiscordName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

function buildDiscordIdentityAvatarUrl(user: DiscordIdentityResponse, userId: string): string {
  if (user.guildId && user.guildAvatar) {
    const ext = user.guildAvatar.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/guilds/${user.guildId}/users/${userId}/avatars/${user.guildAvatar}.${ext}?size=128`
  }
  return buildDiscordAvatarUrl(userId, user.avatar ?? null)
}
>>>>>>> Current commit: feat: external browser draft WIP
