import type { CommandResponse } from '@discord/embedded-app-sdk'
import { api, ApiError } from '@civup/utils'
import { DiscordSDK } from '@discord/embedded-app-sdk'
import { relayDevLog } from './lib/dev-log'

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

interface AuthorizeErrorPayload {
  code?: number
  message?: string
}

export const discordSdk = new DiscordSDK(CLIENT_ID)
let setupInFlight: Promise<Auth> | null = null

function getStorage(type: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    return type === 'local' ? window.localStorage : window.sessionStorage
  }
  catch {
    return null
  }
}

function readCachedTokenFromStorage(storage: Storage | null): CachedToken | null {
  if (!storage) return null

  try {
    const raw = storage.getItem(AUTH_TOKEN_CACHE_KEY)
    if (!raw) return null

    const cached = JSON.parse(raw) as CachedToken
    if (!cached.accessToken || !cached.expiresAt) {
      storage.removeItem(AUTH_TOKEN_CACHE_KEY)
      return null
    }

    if (Date.now() >= cached.expiresAt - TOKEN_EXPIRY_SAFETY_MS) {
      storage.removeItem(AUTH_TOKEN_CACHE_KEY)
      return null
    }

    return cached
  }
  catch {
    storage.removeItem(AUTH_TOKEN_CACHE_KEY)
    return null
  }
}

function writeCachedTokenToStorage(storage: Storage | null, payload: CachedToken) {
  if (!storage) return

  try {
    storage.setItem(AUTH_TOKEN_CACHE_KEY, JSON.stringify(payload))
  }
  catch {}
}

function clearCachedTokenFromStorage(storage: Storage | null) {
  if (!storage) return

  try {
    storage.removeItem(AUTH_TOKEN_CACHE_KEY)
  }
  catch {}
}

function readCachedToken(): string | null {
  const sessionToken = readCachedTokenFromStorage(getStorage('session'))
  if (sessionToken) return sessionToken.accessToken

  const localToken = readCachedTokenFromStorage(getStorage('local'))
  if (!localToken) return null

  writeCachedTokenToStorage(getStorage('session'), localToken)
  return localToken.accessToken
}

function cacheToken(accessToken: string, expiresIn?: number) {
  const expiresAt = Date.now() + (
    typeof expiresIn === 'number' && expiresIn > 0
      ? expiresIn * 1000
      : FALLBACK_TOKEN_LIFETIME_MS
  )

  const payload: CachedToken = { accessToken, expiresAt }
  writeCachedTokenToStorage(getStorage('session'), payload)
  writeCachedTokenToStorage(getStorage('local'), payload)
}

function clearCachedToken() {
  clearCachedTokenFromStorage(getStorage('session'))
  clearCachedTokenFromStorage(getStorage('local'))
}

async function authenticateWithToken(accessToken: string): Promise<Auth> {
  relayDevLog('info', 'Authenticating with Discord access token')
  const auth = await discordSdk.commands.authenticate({ access_token: accessToken })
  if (!auth) throw new Error('Discord authenticate command failed')
  return auth
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  if (typeof error === 'string' && error.trim().length > 0) return error
  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') return serialized
  }
  catch {}
  return 'Unknown error'
}

function getRedirectUri(): string {
  if (typeof window === 'undefined') return ''
  return window.location.origin
}

async function setupDiscordSdkInternal(): Promise<Auth> {
  relayDevLog('info', 'Waiting for Discord SDK ready')
  await discordSdk.ready()
  relayDevLog('info', 'Discord SDK ready', {
    channelId: discordSdk.channelId,
    guildId: discordSdk.guildId,
    instanceId: discordSdk.instanceId,
  })

  const cachedToken = readCachedToken()
  if (cachedToken) {
    try {
      relayDevLog('info', 'Using cached Discord access token')
      return await authenticateWithToken(cachedToken)
    }
    catch (error) {
      relayDevLog('warn', 'Cached Discord access token failed, clearing it', error)
      clearCachedToken()
    }
  }

  relayDevLog('info', 'Requesting Discord authorization code')
  const redirectUri = getRedirectUri()
  let code: string
  try {
    const response = await discordSdk.commands.authorize({
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
    code = response.code
  }
  catch (error) {
    const payload = error as AuthorizeErrorPayload
    relayDevLog('error', 'Discord authorize command failed', {
      redirectUri,
      code: payload?.code ?? null,
      message: payload?.message ?? describeError(error),
    })
    throw error
  }
  relayDevLog('info', 'Received Discord authorization code')

  let payload: TokenExchangeResponse
  try {
    relayDevLog('info', 'Exchanging Discord authorization code for access token')
    payload = await api.post<TokenExchangeResponse>('/api/token', {
      code,
      redirectUri,
    })
  }
  catch (err: any) {
    if (!(err instanceof ApiError)) throw err

    const errPayload = err.data as TokenExchangeResponse | undefined
    const detail = errPayload?.detail ?? errPayload?.error
    const retryAfter = err.headers?.get('Retry-After') ?? errPayload?.retry_after
    const rateLimited = err.status === 429
      || errPayload?.rate_limited === true
      || (detail ? /rate limit/i.test(detail) : false)

    if (rateLimited) {
      const retryHint = retryAfter
        ? ` Retry after about ${retryAfter} second(s).`
        : ' Wait a bit and try launching again.'
      throw new Error(`Discord token exchange is rate limited.${retryHint}`)
    }

    throw new Error(detail
      ? `Token exchange failed: ${err.status} (${detail})`
      : `Token exchange failed: ${err.status}`)
  }

  if (!payload.access_token) {
    throw new Error('Token exchange succeeded but access_token was missing')
  }

  relayDevLog('info', 'Received Discord access token payload', {
    expiresIn: payload.expires_in ?? null,
  })
  cacheToken(payload.access_token, payload.expires_in)

  return authenticateWithToken(payload.access_token)
}

export async function setupDiscordSdk(): Promise<Auth> {
  if (setupInFlight) return setupInFlight
  setupInFlight = setupDiscordSdkInternal()
    .catch((error) => {
      relayDevLog('error', 'Discord SDK setup failed', error)
      throw new Error(describeError(error))
    })
    .finally(() => {
      setupInFlight = null
    })
  return setupInFlight
}
