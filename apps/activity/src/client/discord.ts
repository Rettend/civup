import type { CommandResponse } from '@discord/embedded-app-sdk'
import { api, ApiError } from '@civup/utils'
import { DiscordSDK } from '@discord/embedded-app-sdk'
import { relayDevLog } from './lib/dev-log'

export type Auth = CommandResponse<'authenticate'>

export interface DiscordSetupOptions {
  onStage?: (stage: string) => void
}

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

function updateSetupStage(options: DiscordSetupOptions, stage: string, meta?: unknown) {
  options.onStage?.(stage)
  relayDevLog('info', `Discord setup: ${stage}`, meta)
}

async function withPendingWarning<T>(
  promise: Promise<T>,
  warningMessage: string,
  warningMeta?: unknown,
  warningAfterMs = 12_000,
): Promise<T> {
  let settled = false
  const timeout = setTimeout(() => {
    if (settled) return
    relayDevLog('warn', warningMessage, warningMeta)
  }, warningAfterMs)

  try {
    return await promise
  }
  finally {
    settled = true
    clearTimeout(timeout)
  }
}

async function authenticateWithToken(accessToken: string, options: DiscordSetupOptions): Promise<Auth> {
  updateSetupStage(options, 'Authenticating with Discord access token')
  const auth = await withPendingWarning(
    discordSdk.commands.authenticate({ access_token: accessToken }),
    'Discord authenticate command is still pending',
  )
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

async function setupDiscordSdkInternal(options: DiscordSetupOptions = {}): Promise<Auth> {
  updateSetupStage(options, 'Waiting for Discord SDK ready')
  await withPendingWarning(
    discordSdk.ready(),
    'Discord SDK ready() is still pending',
    {
      channelId: discordSdk.channelId,
      guildId: discordSdk.guildId,
      instanceId: discordSdk.instanceId,
    },
    15_000,
  )
  updateSetupStage(options, 'Discord SDK ready', {
    channelId: discordSdk.channelId,
    guildId: discordSdk.guildId,
    instanceId: discordSdk.instanceId,
  })

  const cachedToken = readCachedToken()
  if (cachedToken) {
    try {
      updateSetupStage(options, 'Using cached Discord access token')
      return await authenticateWithToken(cachedToken, options)
    }
    catch (error) {
      relayDevLog('warn', 'Cached Discord access token failed, clearing it', error)
      clearCachedToken()
    }
  }

  updateSetupStage(options, 'Requesting Discord authorization code')
  const redirectUri = getRedirectUri()
  let code: string
  try {
    const response = await withPendingWarning(discordSdk.commands.authorize({
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
    }), 'Discord authorize command is still pending', { redirectUri })
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
  updateSetupStage(options, 'Received Discord authorization code')

  let payload: TokenExchangeResponse
  try {
    updateSetupStage(options, 'Exchanging Discord authorization code for access token')
    payload = await withPendingWarning(api.post<TokenExchangeResponse>('/api/token', {
      code,
      redirectUri,
    }), 'Discord token exchange is still pending', { redirectUri })
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

  updateSetupStage(options, 'Received Discord access token payload', {
    expiresIn: payload.expires_in ?? null,
  })
  cacheToken(payload.access_token, payload.expires_in)

  return authenticateWithToken(payload.access_token, options)
}

export async function setupDiscordSdk(options: DiscordSetupOptions = {}): Promise<Auth> {
  if (setupInFlight) return setupInFlight
  setupInFlight = setupDiscordSdkInternal(options)
    .catch((error) => {
      relayDevLog('error', 'Discord SDK setup failed', error)
      throw new Error(describeError(error))
    })
    .finally(() => {
      setupInFlight = null
    })
  return setupInFlight
}
