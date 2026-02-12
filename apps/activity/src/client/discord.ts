import type { CommandResponse } from '@discord/embedded-app-sdk'
import { DiscordSDK } from '@discord/embedded-app-sdk'

export type Auth = CommandResponse<'authenticate'>

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string
const AUTH_TOKEN_CACHE_KEY = 'civup.discord.access-token'
const TOKEN_EXPIRY_SAFETY_MS = 30_000
const FALLBACK_TOKEN_LIFETIME_MS = 5 * 60 * 1000

interface TokenExchangeResponse {
  access_token?: string
  expires_in?: number
  detail?: string
  retry_after?: string
  rate_limited?: boolean
  error?: string
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

export const discordSdk = new DiscordSDK(CLIENT_ID)
let setupInFlight: Promise<Auth> | null = null

function readCachedToken(): string | null {
  if (typeof window === 'undefined') return null

  const raw = window.sessionStorage.getItem(AUTH_TOKEN_CACHE_KEY)
  if (!raw) return null

  try {
    const cached = JSON.parse(raw) as CachedToken
    if (!cached.accessToken || !cached.expiresAt) {
      window.sessionStorage.removeItem(AUTH_TOKEN_CACHE_KEY)
      return null
    }

    if (Date.now() >= cached.expiresAt - TOKEN_EXPIRY_SAFETY_MS) {
      window.sessionStorage.removeItem(AUTH_TOKEN_CACHE_KEY)
      return null
    }

    return cached.accessToken
  }
  catch {
    window.sessionStorage.removeItem(AUTH_TOKEN_CACHE_KEY)
    return null
  }
}

function cacheToken(accessToken: string, expiresIn?: number) {
  if (typeof window === 'undefined') return

  const expiresAt = Date.now() + (
    typeof expiresIn === 'number' && expiresIn > 0
      ? expiresIn * 1000
      : FALLBACK_TOKEN_LIFETIME_MS
  )

  const payload: CachedToken = { accessToken, expiresAt }
  window.sessionStorage.setItem(AUTH_TOKEN_CACHE_KEY, JSON.stringify(payload))
}

function clearCachedToken() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(AUTH_TOKEN_CACHE_KEY)
}

async function authenticateWithToken(accessToken: string): Promise<Auth> {
  const auth = await discordSdk.commands.authenticate({ access_token: accessToken })
  if (!auth) throw new Error('Discord authenticate command failed')
  return auth
}

async function setupDiscordSdkInternal(): Promise<Auth> {
  await discordSdk.ready()

  const cachedToken = readCachedToken()
  if (cachedToken) {
    try {
      return await authenticateWithToken(cachedToken)
    }
    catch {
      clearCachedToken()
    }
  }

  const { code } = await discordSdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: [
      'identify',
      'guilds',
      'guilds.members.read',
      'rpc.voice.read',
    ],
  })

  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })

  if (!response.ok) {
    let payload: TokenExchangeResponse | null = null
    try {
      payload = await response.json() as TokenExchangeResponse
    }
    catch {}

    const detail = payload?.detail ?? payload?.error
    const retryAfter = response.headers.get('Retry-After') ?? payload?.retry_after
    const rateLimited = response.status === 429
      || payload?.rate_limited === true
      || (detail ? /rate limit/i.test(detail) : false)

    if (rateLimited) {
      const retryHint = retryAfter
        ? ` Retry after about ${retryAfter} second(s).`
        : ' Wait a bit and try launching again.'
      throw new Error(`Discord token exchange is rate limited.${retryHint}`)
    }

    throw new Error(detail
      ? `Token exchange failed: ${response.status} (${detail})`
      : `Token exchange failed: ${response.status}`)
  }

  const payload = await response.json() as TokenExchangeResponse
  if (!payload.access_token) {
    throw new Error('Token exchange succeeded but access_token was missing')
  }

  cacheToken(payload.access_token, payload.expires_in)

  return authenticateWithToken(payload.access_token)
}

export async function setupDiscordSdk(): Promise<Auth> {
  if (setupInFlight) return setupInFlight
  setupInFlight = setupDiscordSdkInternal().finally(() => {
    setupInFlight = null
  })
  return setupInFlight
}
