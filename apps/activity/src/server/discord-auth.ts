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

export type DiscordTokenExchangeResult
  = | { ok: true, accessToken: string, expiresIn?: number }
    | { ok: false, status: number, detail: string, retryAfter: string | null, rateLimited: boolean }

export type DiscordIdentityResult
  = | { ok: true, userId: string, displayName: string | null, avatarUrl: string }
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
  const url = allowedGuildId
    ? `https://discord.com/api/v10/users/@me/guilds/${allowedGuildId}/member`
    : 'https://discord.com/api/v10/users/@me'
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) {
    if (allowedGuildId && (response.status === 403 || response.status === 404)) {
      return { ok: false, status: 403, error: 'This activity is only available in the configured Discord server' }
    }
    return { ok: false, status: 502, error: 'Failed to verify Discord user' }
  }

  let user: DiscordIdentityResponse
  if (allowedGuildId) {
    const member = await response.json<DiscordGuildMemberResponse>()
    if (!member.user) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
    user = { ...member.user, nick: member.nick ?? null, guildAvatar: member.avatar ?? null, guildId: allowedGuildId }
  }
  else {
    user = await response.json<DiscordIdentityResponse>()
  }

  const userId = typeof user.id === 'string' ? user.id.trim() : ''
  if (!userId) return { ok: false, status: 502, error: 'Failed to verify Discord user' }
  return {
    ok: true,
    userId,
    displayName: resolveDiscordDisplayName(user),
    avatarUrl: buildDiscordIdentityAvatarUrl(user, userId),
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
