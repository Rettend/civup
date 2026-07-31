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

interface Env {
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
<<<<<<< New base: chore: cleanup and simplify setup
<<<<<<< New base: feat: save file analyzer
  guildId: string | null
  guildPermissions: string | null
  guildName: string | null
  guildIconUrl: string | null
  guildRoleIds: string[]
  source: 'header' | 'query' | 'cookie' | 'download-ticket'
||||||| Common ancestor
=======
||||||| Common ancestor
=======
  guildId: string | null
  guildPermissions: string | null
>>>>>>> Current commit: fix: refresh ranked role colors
  source: 'header' | 'query' | 'cookie'
>>>>>>> Current commit: feat: external browser draft WIP
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
<<<<<<< New base: feat: save file analyzer
      if (url.pathname.startsWith('/api/browser/')) {
        return await handleBrowserBootstrap(request, url, env)
      }
      if (request.method === 'POST' && getCivBlitzDownloadTicketMatchId(url.pathname)) {
        return await handleCivBlitzDownloadTicket(request, url, env)
      }
||||||| Common ancestor
=======
      if (url.pathname.startsWith('/api/browser/')) {
        return await handleBrowserBootstrap(request, url, env)
      }
>>>>>>> Current commit: feat: external browser draft WIP
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

<<<<<<< New base: feat: save file analyzer
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

||||||| Common ancestor
=======
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
  const proxy = await fetchBotUpstream(request, targetPath, env, session)
  if ('error' in proxy) return proxy.error
  const upstream = proxy.response
  const payload = await upstream.json<unknown>().catch(() => null)
  if (!upstream.ok) return json(payload ?? { error: 'Browser context failed' }, upstream.status)
  const response = json({
    identity: { userId: session.userId, displayName: session.displayName, avatarUrl: session.avatarUrl },
    context: payload,
  })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

>>>>>>> Current commit: feat: external browser draft WIP
async function handleMatchProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await resolveMatchProxySession(request, url, env)
    if (session instanceof Response) return session
    const originError = validateCookieAuthenticatedRequest(request, session, env)
    if (originError) return originError

    const targetPath = buildTargetPath(url)
<<<<<<< New base: fix: mod resolve
    const proxy = await fetchBotUpstream(request, targetPath, env, session)
    if ('error' in proxy) return proxy.error
    targetUrl = proxy.targetUrl
    const response = proxy.response

    if (shouldStreamProxyResponse(request, url, response)) {
      return streamProxyResponse(response)
    }
||||||| Common ancestor
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
=======
    const proxy = await fetchBotUpstream(request, targetPath, env, session)
    if ('error' in proxy) return proxy.error
    targetUrl = proxy.targetUrl
    const response = proxy.response
>>>>>>> Current commit: chore: cleanup and simplify setup

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

<<<<<<< New base: chore: update leader desc
function shouldStreamProxyResponse(request: Request, url: URL, response: Response): boolean {
  return request.method.toUpperCase() === 'GET'
    && response.ok
    && (
      (url.pathname.startsWith('/api/uploads/') && url.pathname.endsWith('/download'))
      || url.pathname === '/api/activity/admin/player-data-export'
      || /^\/api\/match\/[^/]+\/civblitz\/download$/.test(url.pathname)
    )
}
||||||| Common ancestor
function shouldUseBotServiceBinding(request: Request, env: Env): boolean {
  if (!env.BOT) return false
  if (isDev({ viteDev: getImportMetaDev(), host: request.url, configuredHosts: [env.BOT_HOST] })) return false
=======
function shouldStreamProxyResponse(request: Request, url: URL, response: Response): boolean {
  return request.method.toUpperCase() === 'GET'
    && response.ok
    && (
      (url.pathname.startsWith('/api/uploads/') && url.pathname.endsWith('/download'))
      || url.pathname === '/api/activity/admin/player-data-export'
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

<<<<<<< New base: fix: mod resolve
function shouldUseBotServiceBinding(request: Request, env: Env): boolean {
  if (!env.BOT) return false
  if (isDev({ viteDev: getImportMetaDev(), host: request.url, configuredHosts: [env.BOT_HOST] })) return false
>>>>>>> Current commit: feat: catalog

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

||||||| Common ancestor
function shouldUseBotServiceBinding(request: Request, env: Env): boolean {
  if (!env.BOT) return false
  if (isDev({ viteDev: getImportMetaDev(), host: request.url, configuredHosts: [env.BOT_HOST] })) return false

  return true
}

=======
>>>>>>> Current commit: chore: cleanup and simplify setup
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
<<<<<<< New base: chore: update leader desc
  for (const name of [
    'accept',
    'accept-language',
    'content-length',
    'content-type',
    'user-agent',
  ]) {
||||||| Common ancestor
  for (const name of ['accept', 'accept-language', 'content-type', 'user-agent']) {
=======
  for (const name of [
    'accept',
    'accept-language',
    'content-length',
    'content-type',
    'user-agent',
  ]) {
>>>>>>> Current commit: feat: catalog
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
<<<<<<< New base: feat: save file analyzer
      userId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
<<<<<<< New base: chore: cleanup and simplify setup
      guildId: identity.guildId,
      guildPermissions: identity.guildPermissions,
||||||| Common ancestor
      userId,
      displayName: resolveDiscordDisplayName(discordUser),
      avatarUrl: buildDiscordIdentityAvatarUrl(discordUser, userId),
=======
      userId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
>>>>>>> Current commit: feat: external browser draft WIP
||||||| Common ancestor
=======
      guildId: identity.guildId,
      guildPermissions: identity.guildPermissions,
<<<<<<< New base: feat: auto shuffle
>>>>>>> Current commit: fix: refresh ranked role colors
||||||| Common ancestor
=======
      guildName: identity.guildName,
      guildIconUrl: identity.guildIconUrl,
      guildRoleIds: identity.guildRoleIds,
>>>>>>> Current commit: feat: add multi-server foundations
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
<<<<<<< New base: chore: cleanup and simplify setup
<<<<<<< New base: feat: save file analyzer
    guildId: session.guildId,
    guildPermissions: session.guildPermissions,
    source: headerToken ? 'header' : queryToken ? 'query' : 'cookie',
||||||| Common ancestor
=======
||||||| Common ancestor
=======
    guildId: session.guildId,
    guildPermissions: session.guildPermissions,
<<<<<<< New base: feat: auto shuffle
>>>>>>> Current commit: fix: refresh ranked role colors
||||||| Common ancestor
=======
    guildName: session.guildName ?? null,
    guildIconUrl: session.guildIconUrl ?? null,
    guildRoleIds: session.guildRoleIds ?? [],
>>>>>>> Current commit: feat: add multi-server foundations
    source: headerToken ? 'header' : queryToken ? 'query' : 'cookie',
>>>>>>> Current commit: feat: external browser draft WIP
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

<<<<<<< New base: feat: save file analyzer
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

<<<<<<< New base: feat: auto shuffle
||||||| Common ancestor
async function loadDiscordUser(accessToken: string, allowedGuildId: string | null): Promise<DiscordIdentityResponse | Response> {
  const url = allowedGuildId
    ? `https://discord.com/api/v10/users/@me/guilds/${allowedGuildId}/member`
    : 'https://discord.com/api/v10/users/@me'

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const detail = await response.text()
    console.error(allowedGuildId ? 'Discord guild member lookup failed:' : 'Discord user lookup failed:', {
      guildId: allowedGuildId,
      status: response.status,
      detail,
    })

    if (allowedGuildId && (response.status === 403 || response.status === 404)) {
      return json({ error: 'This activity is only available in the configured Discord server' }, 403)
    }

    return json({ error: 'Failed to verify Discord user' }, 502)
  }

  if (!allowedGuildId) {
    return response.json<DiscordIdentityResponse>()
  }

  const member = await response.json<DiscordGuildMemberResponse>()
  if (!member.user) {
    console.error('Discord guild member lookup returned no user payload', { guildId: allowedGuildId })
    return json({ error: 'Failed to verify Discord user' }, 502)
  }

  return {
    ...member.user,
    nick: member.nick ?? null,
    guildAvatar: member.avatar ?? null,
    guildId: allowedGuildId,
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
  if (user.guildId && user.guildAvatar) return buildDiscordGuildMemberAvatarUrl(user.guildId, userId, user.guildAvatar)
  return buildDiscordAvatarUrl(userId, user.avatar ?? null)
}

function buildDiscordGuildMemberAvatarUrl(guildId: string, userId: string, avatarHash: string): string {
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${avatarHash}.${ext}?size=128`
}

=======
>>>>>>> Current commit: feat: external browser draft WIP
function normalizeGuildId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
||||||| Common ancestor
function normalizeGuildId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
=======
function normalizeGuildId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^\d{17,20}$/.test(normalized) ? normalized : null
>>>>>>> Current commit: feat: add multi-server foundations
}
