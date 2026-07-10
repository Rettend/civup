import {
  CIVUP_ACTIVITY_AVATAR_URL_HEADER,
  CIVUP_ACTIVITY_DISPLAY_NAME_HEADER,
  CIVUP_ACTIVITY_SESSION_HEADER,
  CIVUP_ACTIVITY_SESSION_QUERY_PARAM,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
  isDev,
  normalizeHost,
  verifyActivitySession,
} from '@civup/utils'
import { BROWSER_SESSION_COOKIE, clearBrowserSessionCookie, handleBrowserOAuthRequest, hasExactBrowserOrigin, readCookie, resolveBrowserAccessConfiguration } from './browser-auth.ts'
import { exchangeDiscordAuthorizationCode, loadDiscordIdentity } from './discord-auth.ts'

interface Env {
  ACTIVITY_PUBLIC_ORIGIN?: string
  ALLOWED_DISCORD_GUILD_ID?: string
  CIVUP_SECRET?: string
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  ASSETS?: Fetcher
  BOT?: Fetcher
  BOT_HOST?: string
}

interface DevLogPayload {
  timestamp?: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  message?: string
  href?: string
  userAgent?: string
  meta?: unknown
}

interface ActivityProxySession {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  source: 'header' | 'query' | 'cookie'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    try {
      const browserOAuthResponse = await handleBrowserOAuthRequest(request, env)
      if (browserOAuthResponse) return browserOAuthResponse
      if (url.pathname === '/api/auth/me' && request.method === 'GET') return await handleAuthMe(request, env)
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') return await handleAuthLogout(request, env)
      // POST /api/token — Discord OAuth code → access_token exchange
      if (url.pathname === '/api/token' && request.method === 'POST') {
        return await handleTokenExchange(request, env)
      }
      if (url.pathname === '/api/dev-log' && request.method === 'POST') {
        return await handleDevLog(request)
      }
      if (url.pathname.startsWith('/api/parties/')) {
        return await handlePartyProxy(request, url, env)
      }
      if (url.pathname.startsWith('/api/browser/')) {
        return await handleBrowserBootstrap(request, url, env)
      }
      if (
        url.pathname.startsWith('/api/activity/')
        || url.pathname.startsWith('/api/match/')
        || url.pathname.startsWith('/api/lobby/')
        || url.pathname.startsWith('/api/lobby-ranks/')
        || url.pathname.startsWith('/api/uploads/')
      ) {
        return await handleMatchProxy(request, url, env)
      }
      return serveSpaNavigation(request, url, env)
    }
    catch (error) {
      console.error('[activity:req:error]', request.method, url.pathname, error)
      throw error
    }
  },
} satisfies ExportedHandler<Env>

function serveSpaNavigation(request: Request, url: URL, env: Env): Response | Promise<Response> {
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !url.pathname.startsWith('/web/') || !env.ASSETS) {
    return new Response(null, { status: 404 })
  }

  return env.ASSETS.fetch(new Request(new URL('/', url), request))
}

async function handleDevLog(request: Request): Promise<Response> {
  try {
    const payload = await request.json<DevLogPayload>()
    const level = payload.level ?? 'info'
    const message = payload.message ?? 'No message'
    const context = {
      timestamp: payload.timestamp ?? new Date().toISOString(),
      href: payload.href ?? '-',
      userAgent: payload.userAgent ?? request.headers.get('User-Agent') ?? '-',
      meta: payload.meta ?? null,
    }

    const prefix = '[activity-dev-log]'
    if (level === 'error') console.error(prefix, message, context)
    else if (level === 'warn') console.warn(prefix, message, context)
    // eslint-disable-next-line no-console
    else console.log(prefix, `[${level}]`, message, context)

    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  catch (err) {
    console.warn('[activity-dev-log] Invalid payload', err)
    return json({ error: 'Invalid dev log payload' }, 400)
  }
}

async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const session = await requireActivitySession(request, env)
  if (session instanceof Response) return session
  const response = json({ userId: session.userId, displayName: session.displayName, avatarUrl: session.avatarUrl })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  const config = resolveBrowserAccessConfiguration(env)
  if (!config) return json({ error: 'Browser access is not configured' }, 503)
  if (!hasExactBrowserOrigin(request, config)) return json({ error: 'Invalid request origin' }, 403)
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearBrowserSessionCookie(), 'Cache-Control': 'no-store' },
  })
}

async function handleBrowserBootstrap(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!resolveBrowserAccessConfiguration(env)) return json({ error: 'Browser access is not configured' }, 503)
  const session = await requireActivitySession(request, env)
  if (session instanceof Response) return session

  const targetPath = buildTargetPath(url, url.pathname.replace(/^\/api\/browser/, '/api/activity'))
  let upstream: Response
  if (env.BOT && shouldUseBotServiceBinding(request, env)) {
    upstream = await env.BOT.fetch(buildProxyRequest(`https://civup-bot.internal${targetPath}`, request, env, session))
  }
  else {
    const botHost = normalizeHost(env.BOT_HOST, 'http://localhost:8787')
    upstream = await fetch(buildProxyRequest(`${botHost}${targetPath}`, request, env, session))
  }
  const payload = await upstream.json<unknown>().catch(() => null)
  if (!upstream.ok) return json(payload ?? { error: 'Browser context failed' }, upstream.status)
  const response = json({
    identity: { userId: session.userId, displayName: session.displayName, avatarUrl: session.avatarUrl },
    context: payload,
  })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function handleMatchProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await requireActivitySession(request, env)
    if (session instanceof Response) return session
    const originError = validateCookieAuthenticatedRequest(request, session, env)
    if (originError) return originError

    const targetPath = buildTargetPath(url)
    let response: Response
    const botService = env.BOT

    if (botService && shouldUseBotServiceBinding(request, env)) {
      targetUrl = `service:civup-bot${targetPath}`
      response = await botService.fetch(buildProxyRequest(`https://civup-bot.internal${targetPath}`, request, env, session))
    }
    else {
      const botHost = normalizeHost(env.BOT_HOST, 'http://localhost:8787')
      targetUrl = `${botHost}${targetPath}`
      response = await fetch(buildProxyRequest(targetUrl, request, env, session))
    }

    if (shouldStreamProxyResponse(request, url, response)) {
      return streamProxyResponse(response)
    }

    const nullBody = isNullBodyStatus(response.status)
    const body = nullBody ? null : await response.text()
    if (!response.ok) {
      if (shouldWarnForMatchProxy(request.method, url.pathname, response.status)) {
        console.warn('[activity] Match proxy upstream non-OK', {
          targetUrl,
          status: response.status,
          bodyPreview: body?.slice(0, 200) ?? '',
        })
      }
    }

    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  }
  catch (err) {
    console.error('Match lookup proxy error:', { targetUrl, err })
    return json({ error: 'Match lookup proxy failed' }, 502)
  }
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

function shouldStreamProxyResponse(request: Request, url: URL, response: Response): boolean {
  return request.method.toUpperCase() === 'GET'
    && response.ok
    && url.pathname.startsWith('/api/uploads/')
    && url.pathname.endsWith('/download')
}

function streamProxyResponse(response: Response): Response {
  const headers = new Headers()
  for (const name of ['content-type', 'content-length', 'content-disposition', 'etag']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    headers,
  })
}

function shouldUseBotServiceBinding(request: Request, env: Env): boolean {
  if (!env.BOT) return false
  if (isDev({ viteDev: getImportMetaDev(), host: request.url, configuredHosts: [env.BOT_HOST] })) return false

  return true
}

function getImportMetaDev(): boolean | undefined {
  return import.meta.env?.DEV
}

async function handlePartyProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await requireActivitySession(request, env)
    if (session instanceof Response) return session
    const originError = validateCookieAuthenticatedRequest(request, session, env)
    if (originError) return originError

    const targetPath = buildPartyProxyTargetPath(url)
    const resolvedTargetPath = buildTargetPath(url, targetPath)
    const botService = env.BOT
    if (botService && shouldUseBotServiceBinding(request, env)) {
      targetUrl = `service:civup-bot${resolvedTargetPath}`
      return await botService.fetch(buildProxyRequest(`https://civup-bot.internal${resolvedTargetPath}`, request, env, session))
    }

    const botHost = normalizeHost(env.BOT_HOST, 'http://localhost:8787')
    targetUrl = `${botHost}${resolvedTargetPath}`
    return await fetch(buildProxyRequest(targetUrl, request, env, session))
  }
  catch (err) {
    console.error('Party proxy error:', { targetUrl, err })
    return json({ error: 'Party proxy failed' }, 502)
  }
}

function buildPartyProxyTargetPath(url: URL): string {
  const targetPath = url.pathname.replace(/^\/api\/parties/, '/parties')
  const mainPrefix = '/parties/main/'
  if (!targetPath.startsWith(mainPrefix)) return targetPath

  const roomAndRest = targetPath.slice(mainPrefix.length)
  const slashIndex = roomAndRest.indexOf('/')
  const room = slashIndex === -1 ? roomAndRest : roomAndRest.slice(0, slashIndex)
  if (!room) return targetPath

  const namespace = url.searchParams.has('accessToken') || !isLikelyDiscordSnowflake(room)
    ? 'session'
    : 'activity'
  return `/parties/${namespace}/${roomAndRest}`
}

function isLikelyDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}

function buildProxyRequest(targetUrl: string, request: Request, env: Env, session: ActivityProxySession): Request {
  const method = request.method.toUpperCase()
  const internalSecret = env.CIVUP_SECRET?.trim() ?? ''

  const headers = new Headers()
  for (const name of [
    'accept',
    'accept-language',
    'content-type',
    'user-agent',
    'x-civup-upload-filename',
    'x-civup-upload-channel-id',
    'x-civup-upload-match-id',
  ]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  headers.set(CIVUP_INTERNAL_SECRET_HEADER, internalSecret)
  headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, session.userId)
  if (session.displayName) headers.set(CIVUP_ACTIVITY_DISPLAY_NAME_HEADER, encodeURIComponent(session.displayName))
  if (session.avatarUrl) headers.set(CIVUP_ACTIVITY_AVATAR_URL_HEADER, session.avatarUrl)

  const upgrade = request.headers.get('upgrade')
  if (upgrade) {
    headers.set('upgrade', upgrade)
    const connection = request.headers.get('connection')
    if (connection) headers.set('connection', connection)

    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
  }

  const init: RequestInit = {
    method,
    headers,
    redirect: 'manual',
  }

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body
  }

  return new Request(targetUrl, init)
}

function shouldWarnForMatchProxy(method: string, pathname: string, status: number): boolean {
  if (status !== 404 || method.toUpperCase() !== 'GET') return true

  return !(
    pathname.startsWith('/api/activity/')
    || pathname.startsWith('/api/match/')
    || pathname.startsWith('/api/lobby/')
    || pathname.startsWith('/api/lobby-ranks/')
    || pathname.startsWith('/api/uploads/')
  )
}

async function handleTokenExchange(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json<{ code: string, redirectUri?: string }>()

    if (!body.code || typeof body.code !== 'string') {
      return json({ error: 'Missing or invalid "code" in request body' }, 400)
    }

    const requestUrl = new URL(request.url)
    const redirectUri = requestUrl.origin

    const internalSecret = env.CIVUP_SECRET?.trim() ?? ''
    if (internalSecret.length === 0) {
      console.error('Activity token exchange blocked because CIVUP_SECRET is missing')
      return json({ error: 'Activity auth is not configured' }, 503)
    }

    const token = await exchangeDiscordAuthorizationCode(env, { code: body.code, redirectUri })
    if (!token.ok) {
      console.error('Discord token exchange failed:', {
        status: token.status,
        retryAfter: token.retryAfter,
        redirectUri,
        detail: token.detail,
      })
      const response = json(
        {
          error: 'Token exchange failed',
          detail: token.detail,
          retry_after: token.retryAfter ?? undefined,
          rate_limited: token.rateLimited,
        },
        token.rateLimited ? 429 : token.status,
      )
      if (token.retryAfter) response.headers.set('Retry-After', token.retryAfter)
      return response
    }

    const allowedGuildId = normalizeGuildId(env.ALLOWED_DISCORD_GUILD_ID)
    const identity = await loadDiscordIdentity(token.accessToken, allowedGuildId)
    if (!identity.ok) return json({ error: identity.error }, identity.status)

    const sessionToken = await createActivitySession(internalSecret, {
      userId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    })

    const response = json({
      access_token: token.accessToken,
      expires_in: token.expiresIn,
      activity_session_token: sessionToken,
      activity_session_expires_in: 8 * 60 * 60,
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
  catch (err) {
    console.error('Token exchange error:', err)
    return json({ error: 'Internal server error' }, 500)
  }
}

async function requireActivitySession(request: Request, env: Env): Promise<ActivityProxySession | Response> {
  const requestUrl = new URL(request.url)
  const headerToken = request.headers.get(CIVUP_ACTIVITY_SESSION_HEADER)
  const queryToken = requestUrl.searchParams.get(CIVUP_ACTIVITY_SESSION_QUERY_PARAM)
  const explicitToken = headerToken ?? queryToken
  const config = resolveBrowserAccessConfiguration(env)
  const cookieToken = explicitToken ? null : config ? readCookie(request, BROWSER_SESSION_COOKIE) : null
  const token = explicitToken ?? cookieToken
  const session = await verifyActivitySession(env.CIVUP_SECRET, token)
  if (!session) {
    const response = json({ error: 'Unauthorized activity session' }, 401)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  return {
    userId: session.sub,
    displayName: session.name || null,
    avatarUrl: session.avatarUrl,
    source: headerToken ? 'header' : queryToken ? 'query' : 'cookie',
  }
}

function validateCookieAuthenticatedRequest(request: Request, session: ActivityProxySession, env: Env): Response | null {
  if (session.source !== 'cookie') return null
  const method = request.method.toUpperCase()
  const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  if (!isWebSocket && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) return null

  const config = resolveBrowserAccessConfiguration(env)
  if (config && hasExactBrowserOrigin(request, config)) return null
  const response = json({ error: 'Invalid request origin' }, 403)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

function buildTargetPath(url: URL, pathname = url.pathname): string {
  const searchParams = new URLSearchParams(url.search)
  searchParams.delete(CIVUP_ACTIVITY_SESSION_QUERY_PARAM)
  const search = searchParams.toString()
  return `${pathname}${search ? `?${search}` : ''}`
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeGuildId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}
