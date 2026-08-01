import {
  ACTIVITY_FEED_ROOM,
  ACTIVITY_VERSION_OUTDATED_MESSAGE,
  CIVUP_ACTIVITY_AVATAR_URL_HEADER,
  CIVUP_ACTIVITY_DISPLAY_NAME_HEADER,
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_ICON_URL_HEADER,
  CIVUP_ACTIVITY_GUILD_NAME_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_GUILD_ROLE_IDS_HEADER,
  CIVUP_ACTIVITY_SESSION_HEADER,
  CIVUP_ACTIVITY_SESSION_QUERY_PARAM,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
  createCivBlitzDownloadTicket,
  isDev,
  verifyActivitySession,
  verifyCivBlitzDownloadTicket,
  resolveApprovedDiscordGuildConfiguration,
} from '@civup/utils'
import { BROWSER_SESSION_COOKIE, clearBrowserSessionCookie, handleBrowserOAuthRequest, hasExactBrowserOrigin, readCookie, resolveBrowserAccessConfiguration } from './browser-auth.ts'
import { exchangeDiscordAuthorizationCode, loadDiscordIdentity } from './discord-auth.ts'

export interface Env {
  ACTIVITY_PUBLIC_ORIGIN?: string
  ALLOWED_DISCORD_GUILD_ID?: string
  ALLOWED_DISCORD_GUILD_IDS?: string
  CIVUP_SECRET?: string
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  ASSETS?: Fetcher
  BOT?: Fetcher
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
  guildId: string | null
  guildPermissions: string | null
  guildName: string | null
  guildIconUrl: string | null
  guildRoleIds: string[]
  source: 'header' | 'query' | 'cookie' | 'download-ticket'
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/api/public/leaderboards') return await handlePublicLeaderboardProxy(request, url, env, ctx)
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
      if (request.method === 'POST' && getCivBlitzDownloadTicketMatchId(url.pathname)) {
        return await handleCivBlitzDownloadTicket(request, url, env)
      }
      if (
        url.pathname.startsWith('/api/activity/')
        || url.pathname.startsWith('/api/match/')
        || url.pathname.startsWith('/api/lobby/')
        || url.pathname.startsWith('/api/game-settings/')
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
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !isSpaNavigationPath(url.pathname) || !env.ASSETS) {
    return new Response(null, { status: 404 })
  }

  return env.ASSETS.fetch(new Request(new URL('/', url), request))
}

export function isSpaNavigationPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/leaderboards' || pathname === '/rules' || pathname === '/creators') return true
  if (pathname === '/overview' || pathname === '/uploads') return true
  return /^\/(?:lobby|draft)\/[^/]+\/?$/.test(pathname)
    || /^\/web\/(?:session|channel)\/[^/]+\/?$/.test(pathname)
    || /^\/practice(?:\/[^/]+)?\/?$/.test(pathname)
}

async function handlePublicLeaderboardProxy(
  request: Request,
  url: URL,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'GET') return publicProxyError('Method not allowed', 405)

  const guildConfig = resolveApprovedDiscordGuildConfiguration(env)
  if (!guildConfig.ok) return publicProxyError('Public leaderboards are not configured', 503)

  const serverResult = parsePublicLeaderboardServer(url, guildConfig.primaryGuildId)
  if (!serverResult.ok) return publicProxyError(serverResult.error, 400)
  if (!guildConfig.guildIds.includes(serverResult.serverId)) return publicProxyError('Server is not approved', 403)

  const secret = env.CIVUP_SECRET?.trim() ?? ''
  if (!secret) return publicProxyError('Public leaderboards are not configured', 503)

  const cacheKey = new Request(canonicalPublicLeaderboardUrl(url, serverResult.serverId), { method: 'GET' })
  const cache = getDefaultCache()
  const cached = cache ? await matchPublicCache(cache, cacheKey) : undefined
  if (cached?.ok) return publicProxyResponse(cached)

  if (!env.BOT) return publicProxyError('Leaderboard service is not configured', 503)
  const upstreamUrl = `https://civup-bot.internal/api/public/leaderboards?server=${encodeURIComponent(serverResult.serverId)}`
  let upstream: Response
  try {
    upstream = await env.BOT.fetch(new Request(upstreamUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        [CIVUP_INTERNAL_SECRET_HEADER]: secret,
      },
    }))
  }
  catch (error) {
    console.error('[activity] Public leaderboard proxy failed', error)
    return publicProxyError('Leaderboard service is unavailable', 502)
  }
  const response = publicProxyResponse(upstream)
  if (response.ok && cache && ctx) ctx.waitUntil(putPublicCache(cache, cacheKey, response.clone()))
  return response
}

function parsePublicLeaderboardServer(url: URL, defaultServerId: string): { ok: true, serverId: string } | { ok: false, error: string } {
  const entries = [...url.searchParams.entries()]
  if (entries.some(([key]) => key !== 'server') || entries.length > 1) {
    return { ok: false, error: 'Only one server query parameter is allowed' }
  }
  if (entries.length === 0) return { ok: true, serverId: defaultServerId }

  const serverId = entries[0]?.[1].trim() ?? ''
  return /^\d{17,20}$/.test(serverId)
    ? { ok: true, serverId }
    : { ok: false, error: 'Server query parameter is invalid' }
}

function canonicalPublicLeaderboardUrl(url: URL, serverId: string): string {
  const canonical = new URL('/api/public/leaderboards', url.origin)
  canonical.searchParams.set('server', serverId)
  return canonical.toString()
}

function publicProxyResponse(upstream: Response): Response {
  const headers = new Headers()
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', upstream.ok ? 'public, max-age=60, s-maxage=300' : 'no-store')
  return new Response(upstream.body, { status: upstream.status, headers })
}

function publicProxyError(error: string, status: number): Response {
  const response = json({ error }, status)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

function getDefaultCache(): Cache | undefined {
  return (globalThis as typeof globalThis & { caches?: { default?: Cache } }).caches?.default
}

async function matchPublicCache(cache: Cache, key: Request): Promise<Response | undefined> {
  try {
    return await cache.match(key)
  }
  catch (error) {
    console.warn('[activity] Public leaderboard edge cache read skipped', error)
    return undefined
  }
}

async function putPublicCache(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response)
  }
  catch (error) {
    console.warn('[activity] Public leaderboard edge cache write skipped', error)
  }
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
  const response = json({
    userId: session.userId,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    guildId: session.guildId,
    guildName: session.guildName,
    guildIconUrl: session.guildIconUrl,
    guildPermissions: session.guildPermissions,
    guildRoleIds: session.guildRoleIds,
  })
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
  const sourceGuildId = normalizeGuildId(url.searchParams.get('sourceGuild'))
  if (sourceGuildId && sourceGuildId !== session.guildId) {
    const response = json({ error: 'Sign in again to use this Discord server context' }, 401)
    response.headers.set('Set-Cookie', clearBrowserSessionCookie())
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const targetPath = buildTargetPath(url, url.pathname.replace(/^\/api\/browser/, '/api/activity'))
  const proxy = await fetchBotUpstream(request, targetPath, env, session)
  if ('error' in proxy) return proxy.error
  const upstream = proxy.response
  const payload = await upstream.json<unknown>().catch(() => null)
  if (!upstream.ok) return json(payload ?? { error: 'Browser context failed' }, upstream.status)
  const response = json({
    identity: {
      userId: session.userId,
      displayName: session.displayName,
      avatarUrl: session.avatarUrl,
      guildId: session.guildId,
      guildName: session.guildName,
      guildIconUrl: session.guildIconUrl,
      guildPermissions: session.guildPermissions,
      guildRoleIds: session.guildRoleIds,
    },
    context: payload,
  })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function handleMatchProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await resolveMatchProxySession(request, url, env)
    if (session instanceof Response) return session
    const originError = validateCookieAuthenticatedRequest(request, session, env)
    if (originError) return originError

    const targetPath = buildTargetPath(url)
    const proxy = await fetchBotUpstream(request, targetPath, env, session)
    if ('error' in proxy) return proxy.error
    targetUrl = proxy.targetUrl
    const response = proxy.response

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

async function handleCivBlitzDownloadTicket(request: Request, url: URL, env: Env): Promise<Response> {
  const matchId = getCivBlitzDownloadTicketMatchId(url.pathname)
  if (!matchId) return json({ error: 'Invalid CivBlitz download ticket request' }, 400)

  const session = await requireActivitySession(request, env)
  if (session instanceof Response) return session
  const originError = validateCookieAuthenticatedRequest(request, session, env)
  if (originError) return originError

  const secret = env.CIVUP_SECRET?.trim() ?? ''
  if (!secret) return json({ error: 'Activity auth is not configured' }, 503)

  const ticket = await createCivBlitzDownloadTicket(secret, {
    userId: session.userId,
    matchId,
    guildId: session.guildId,
  })
  const response = json({ ticket, expiresIn: 2 * 60 })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function resolveMatchProxySession(request: Request, url: URL, env: Env): Promise<ActivityProxySession | Response> {
  const matchId = request.method === 'GET' ? getCivBlitzDownloadMatchId(url.pathname) : null
  const ticket = matchId ? url.searchParams.get(CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM) : null
  if (!matchId) return requireActivitySession(request, env)
  if (!ticket) {
    if (!url.searchParams.has(CIVUP_ACTIVITY_SESSION_QUERY_PARAM)) return requireActivitySession(request, env)
    const response = json({ error: 'A scoped download ticket is required' }, 401)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const claims = await verifyCivBlitzDownloadTicket(env.CIVUP_SECRET, ticket, { matchId })
  if (!claims) {
    const response = json({ error: 'Invalid or expired download ticket' }, 401)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
  const guildConfig = resolveApprovedDiscordGuildConfiguration(env)
  if (!guildConfig.ok) return json({ error: 'Activity auth is not configured' }, 503)
  if (!claims.guildId || !guildConfig.guildIds.includes(claims.guildId)) {
    return json({ error: 'Activity source server is not approved' }, 403)
  }

  return {
    userId: claims.sub,
    displayName: null,
    avatarUrl: null,
    guildId: claims.guildId,
    guildPermissions: null,
    guildName: null,
    guildIconUrl: null,
    guildRoleIds: [],
    source: 'download-ticket',
  }
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

function shouldStreamProxyResponse(request: Request, url: URL, response: Response): boolean {
  return request.method.toUpperCase() === 'GET'
    && response.ok
    && (
      (url.pathname.startsWith('/api/uploads/') && url.pathname.endsWith('/download'))
      || url.pathname === '/api/activity/admin/player-data-export'
      || /^\/api\/match\/[^/]+\/civblitz\/download$/.test(url.pathname)
    )
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
    if (!targetPath) return json({ error: ACTIVITY_VERSION_OUTDATED_MESSAGE }, 404)
    const resolvedTargetPath = buildTargetPath(url, targetPath)
    const proxy = await fetchBotUpstream(request, resolvedTargetPath, env, session)
    if ('error' in proxy) return proxy.error
    targetUrl = proxy.targetUrl
    return proxy.response
  }
  catch (err) {
    console.error('Party proxy error:', { targetUrl, err })
    return json({ error: 'Party proxy failed' }, 502)
  }
}

async function fetchBotUpstream(
  request: Request,
  targetPath: string,
  env: Env,
  session: ActivityProxySession,
): Promise<{ response: Response, targetUrl: string } | { error: Response }> {
  if (isDev({ viteDev: getImportMetaDev(), host: request.url })) {
    const targetUrl = `http://127.0.0.1:8787${targetPath}`
    return { response: await fetch(buildProxyRequest(targetUrl, request, env, session)), targetUrl }
  }

  if (!env.BOT) return { error: json({ error: 'Bot service is not configured' }, 503) }
  return {
    response: await env.BOT.fetch(buildProxyRequest(`https://civup-bot.internal${targetPath}`, request, env, session)),
    targetUrl: `service:civup-bot${targetPath}`,
  }
}

function buildPartyProxyTargetPath(url: URL): string | null {
  const targetPath = url.pathname.replace(/^\/api\/parties/, '/parties')
  if (targetPath.startsWith('/parties/session/')) return targetPath
  if (targetPath === `/parties/activity/${ACTIVITY_FEED_ROOM}`) return targetPath
  return null
}

function buildProxyRequest(targetUrl: string, request: Request, env: Env, session: ActivityProxySession): Request {
  const method = request.method.toUpperCase()
  const internalSecret = env.CIVUP_SECRET?.trim() ?? ''

  const headers = new Headers()
  for (const name of [
    'accept',
    'accept-language',
    'content-length',
    'content-type',
    'user-agent',
  ]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  headers.set(CIVUP_INTERNAL_SECRET_HEADER, internalSecret)
  headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, session.userId)
  if (session.displayName) headers.set(CIVUP_ACTIVITY_DISPLAY_NAME_HEADER, encodeURIComponent(session.displayName))
  if (session.avatarUrl) headers.set(CIVUP_ACTIVITY_AVATAR_URL_HEADER, session.avatarUrl)
  if (session.guildId) headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, session.guildId)
  if (session.guildPermissions) headers.set(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER, session.guildPermissions)
  if (session.guildName) headers.set(CIVUP_ACTIVITY_GUILD_NAME_HEADER, encodeURIComponent(session.guildName))
  if (session.guildIconUrl) headers.set(CIVUP_ACTIVITY_GUILD_ICON_URL_HEADER, session.guildIconUrl)
  if (session.guildRoleIds.length > 0) headers.set(CIVUP_ACTIVITY_GUILD_ROLE_IDS_HEADER, encodeURIComponent(JSON.stringify(session.guildRoleIds)))

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
  let body: unknown
  try {
    body = await request.json()
  }
  catch {
    return json({ error: 'Invalid JSON request body' }, 400)
  }

  try {
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400)
    const input = body as { code?: unknown, guildId?: unknown }
    if (typeof input.code !== 'string' || input.code.length === 0) {
      return json({ error: 'Missing or invalid "code" in request body' }, 400)
    }

    const requestUrl = new URL(request.url)
    const redirectUri = requestUrl.origin

    const internalSecret = env.CIVUP_SECRET?.trim() ?? ''
    if (internalSecret.length === 0) {
      console.error('Activity token exchange blocked because CIVUP_SECRET is missing')
      return json({ error: 'Activity auth is not configured' }, 503)
    }

    const guildConfig = resolveApprovedDiscordGuildConfiguration(env)
    if (!guildConfig.ok) {
      console.error('Activity token exchange blocked because approved Discord server configuration is invalid:', guildConfig.error)
      return json({ error: 'Activity auth is not configured' }, 503)
    }

    const requestedGuildId = normalizeGuildId(input.guildId)
    if (!requestedGuildId) return json({ error: 'Missing or invalid Activity launch server' }, 400)
    if (!guildConfig.guildIds.includes(requestedGuildId)) return json({ error: 'This activity is not available in this Discord server' }, 403)

    const token = await exchangeDiscordAuthorizationCode(env, { code: input.code, redirectUri })
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

    const identity = await loadDiscordIdentity(token.accessToken, guildConfig.guildIds, requestedGuildId)
    if (!identity.ok) return json({ error: identity.error }, identity.status)

    const sessionToken = await createActivitySession(internalSecret, {
      userId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      guildId: identity.guildId,
      guildPermissions: identity.guildPermissions,
      guildName: identity.guildName,
      guildIconUrl: identity.guildIconUrl,
      guildRoleIds: identity.guildRoleIds,
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

  const guildConfig = resolveApprovedDiscordGuildConfiguration(env)
  if (!guildConfig.ok) {
    const response = json({ error: 'Activity auth is not configured' }, 503)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
  if (!session.guildId || !guildConfig.guildIds.includes(session.guildId)) {
    const response = json({ error: 'Activity source server is not approved' }, 403)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  return {
    userId: session.sub,
    displayName: session.name || null,
    avatarUrl: session.avatarUrl,
    guildId: session.guildId,
    guildPermissions: session.guildPermissions,
    guildName: session.guildName ?? null,
    guildIconUrl: session.guildIconUrl ?? null,
    guildRoleIds: session.guildRoleIds ?? [],
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
  searchParams.delete(CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM)
  const search = searchParams.toString()
  return `${pathname}${search ? `?${search}` : ''}`
}

function getCivBlitzDownloadTicketMatchId(pathname: string): string | null {
  return decodePathMatch(/^\/api\/match\/([^/]+)\/civblitz\/download-ticket$/, pathname)
}

function getCivBlitzDownloadMatchId(pathname: string): string | null {
  return decodePathMatch(/^\/api\/match\/([^/]+)\/civblitz\/download$/, pathname)
}

function decodePathMatch(pattern: RegExp, pathname: string): string | null {
  const encoded = pattern.exec(pathname)?.[1]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  }
  catch {
    return null
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeGuildId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^\d{17,20}$/.test(normalized) ? normalized : null
}
