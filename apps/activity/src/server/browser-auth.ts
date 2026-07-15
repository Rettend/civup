import { createActivitySession } from '@civup/utils'
import { exchangeDiscordAuthorizationCode, loadDiscordIdentity } from './discord-auth.ts'

export const BROWSER_SESSION_COOKIE = '__Host-civup-session'
export const OAUTH_TRANSACTION_COOKIE = '__Host-civup-oauth'
export const BROWSER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60
export const OAUTH_TRANSACTION_MAX_AGE_SECONDS = 10 * 60

export interface BrowserAuthEnvironment {
  ACTIVITY_PUBLIC_ORIGIN?: string
  ALLOWED_DISCORD_GUILD_ID?: string
  CIVUP_SECRET?: string
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
}

export interface BrowserAccessConfiguration {
  origin: string
  guildId: string
  secret: string
  clientId: string
  clientSecret: string
  callbackUri: string
}

interface OAuthTransaction {
  state: string
  verifier: string
  returnTo: string
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function handleBrowserOAuthRequest(request: Request, env: BrowserAuthEnvironment): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === '/api/auth/discord' && request.method === 'GET') return startBrowserOAuth(request, env)
  if (url.pathname === '/api/auth/discord/callback' && request.method === 'GET') return finishBrowserOAuth(request, env)
  return null
}

export function resolveBrowserAccessConfiguration(env: BrowserAuthEnvironment): BrowserAccessConfiguration | null {
  const origin = normalizeOrigin(env.ACTIVITY_PUBLIC_ORIGIN)
  const guildId = normalizeDiscordId(env.ALLOWED_DISCORD_GUILD_ID)
  const secret = env.CIVUP_SECRET?.trim() ?? ''
  const clientId = env.DISCORD_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim() ?? ''
  if (!origin || !guildId || !secret || !clientId || !clientSecret) return null
  return { origin, guildId, secret, clientId, clientSecret, callbackUri: `${origin}/api/auth/discord/callback` }
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? ''
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value || null
  }
  return null
}

export function browserSessionCookie(token: string): string {
  return `${BROWSER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${BROWSER_SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export function clearBrowserSessionCookie(): string {
  return `${BROWSER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function hasExactBrowserOrigin(request: Request, config: BrowserAccessConfiguration): boolean {
  return request.headers.get('Origin') === config.origin
}

export function validateBrowserReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/web/') || value.startsWith('//') || /[\r\n\\]/.test(value)) return null
  try {
    const url = new URL(value, 'https://civup.invalid')
    if (url.origin !== 'https://civup.invalid' || !url.pathname.startsWith('/web/')) return null
    return `${url.pathname}${url.search}${url.hash}`
  }
  catch {
    return null
  }
}

async function startBrowserOAuth(request: Request, env: BrowserAuthEnvironment): Promise<Response> {
  const config = resolveBrowserAccessConfiguration(env)
  if (!config) return unavailableResponse()
  const canonical = canonicalRedirect(request, config)
  if (canonical) return canonical

  const requestUrl = new URL(request.url)
  const returnTo = validateBrowserReturnPath(requestUrl.searchParams.get('returnTo'))
  if (!returnTo) return json({ error: 'returnTo must be a local /web/ path' }, 400)

  const state = randomBase64Url(32)
  const verifier = randomBase64Url(48)
  const challenge = await sha256Base64Url(verifier)
  const transaction = await signTransaction(config.secret, {
    state,
    verifier,
    returnTo,
    exp: Date.now() + OAUTH_TRANSACTION_MAX_AGE_SECONDS * 1000,
  })
  const authorize = new URL('https://discord.com/oauth2/authorize')
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.callbackUri,
    scope: 'identify guilds guilds.members.read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  return new Response(null, {
    status: 302,
    headers: {
      'Location': authorize.toString(),
      'Set-Cookie': transactionCookie(transaction),
      'Cache-Control': 'no-store',
    },
  })
}

async function finishBrowserOAuth(request: Request, env: BrowserAuthEnvironment): Promise<Response> {
  const config = resolveBrowserAccessConfiguration(env)
  if (!config) return unavailableResponse()
  const canonical = canonicalRedirect(request, config)
  if (canonical) return canonical

  const url = new URL(request.url)
  const transaction = await verifyTransaction(config.secret, readCookie(request, OAUTH_TRANSACTION_COOKIE))
  const returnTo = transaction?.returnTo ?? '/web/'
  if (!transaction) return oauthError('This sign-in request is missing, expired, or invalid.', returnTo)
  if (!safeEqual(transaction.state, url.searchParams.get('state') ?? '')) return oauthError('Discord sign-in state did not match.', returnTo)
  if (url.searchParams.has('error')) return oauthError('Discord sign-in was cancelled.', returnTo)
  const code = url.searchParams.get('code')?.trim() ?? ''
  if (!code) return oauthError('Discord did not return an authorization code.', returnTo)

  try {
    const token = await exchangeDiscordAuthorizationCode(env, {
      code,
      redirectUri: config.callbackUri,
      codeVerifier: transaction.verifier,
    })
    if (!token.ok) {
      console.error('[browser-auth] Discord token exchange failed', { status: token.status, detail: token.detail })
      return oauthError('Discord sign-in could not be completed.', returnTo)
    }
    const identity = await loadDiscordIdentity(token.accessToken, config.guildId)
    if (!identity.ok) return oauthError(identity.status === 403 ? 'You must be a member of the configured Discord server.' : 'Discord membership could not be verified.', returnTo)

    const session = await createActivitySession(config.secret, identity)
    const headers = new Headers({ 'Location': returnTo, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', browserSessionCookie(session))
    headers.append('Set-Cookie', clearTransactionCookie())
    return new Response(null, { status: 303, headers })
  }
  catch (error) {
    console.error('[browser-auth] callback failed', error)
    return oauthError('Discord sign-in could not be completed.', returnTo)
  }
}

function canonicalRedirect(request: Request, config: BrowserAccessConfiguration): Response | null {
  const url = new URL(request.url)
  const canonical = new URL(config.origin)
  if (url.origin === config.origin || (url.host === canonical.host && canonical.protocol === 'https:' && isForwardedHttps(request))) return null
  return new Response(null, {
    status: 307,
    headers: { Location: `${config.origin}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' },
  })
}

function isForwardedHttps(request: Request): boolean {
  const forwardedProtocol = request.headers.get('X-Forwarded-Proto')?.split(',', 1)[0]?.trim().toLowerCase()
  if (forwardedProtocol === 'https') return true

  const visitor = request.headers.get('CF-Visitor')
  if (!visitor) return false
  try {
    return (JSON.parse(visitor) as { scheme?: unknown }).scheme === 'https'
  }
  catch {
    return false
  }
}

function oauthError(message: string, returnTo: string): Response {
  const retryPath = validateBrowserReturnPath(returnTo) ?? '/web/'
  const retry = `/api/auth/discord?returnTo=${encodeURIComponent(retryPath)}`
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CivUp sign-in failed</title><body><main><h1>CivUp sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(retry)}">Try Discord sign-in again</a></p></main></body></html>`
  return new Response(body, {
    status: 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': clearTransactionCookie(),
    },
  })
}

function unavailableResponse(): Response {
  return json({ error: 'Browser access is disabled or not configured' }, 503)
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

function transactionCookie(value: string): string {
  return `${OAUTH_TRANSACTION_COOKIE}=${value}; Path=/; Max-Age=${OAUTH_TRANSACTION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

function clearTransactionCookie(): string {
  return `${OAUTH_TRANSACTION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

async function signTransaction(secret: string, transaction: OAuthTransaction): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(transaction)))
  return `${payload}.${await hmac(secret, payload)}`
}

async function verifyTransaction(secret: string, value: string | null): Promise<OAuthTransaction | null> {
  if (!value) return null
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra || !safeEqual(signature, await hmac(secret, payload))) return null
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<OAuthTransaction>
    if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string' || typeof parsed.exp !== 'number') return null
    const returnTo = validateBrowserReturnPath(typeof parsed.returnTo === 'string' ? parsed.returnTo : null)
    if (!returnTo || parsed.exp <= Date.now()) return null
    return { state: parsed.state, verifier: parsed.verifier, returnTo, exp: parsed.exp }
  }
  catch {
    return null
  }
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let mismatch = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  return mismatch === 0
}

function normalizeOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  }
  catch {
    return null
  }
}

function normalizeDiscordId(value: string | undefined): string | null {
  const id = value?.trim() ?? ''
  return /^\d{17,20}$/.test(id) ? id : null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}
