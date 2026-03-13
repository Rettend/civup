import {
  buildDiscordAvatarUrl,
  CIVUP_ACTIVITY_AVATAR_URL_HEADER,
  CIVUP_ACTIVITY_SESSION_HEADER,
  CIVUP_ACTIVITY_SESSION_QUERY_PARAM,
  CIVUP_ACTIVITY_DISPLAY_NAME_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
  isDev,
  normalizeHost,
  verifyActivitySession,
} from '@civup/utils'

interface Env {
  CIVUP_SECRET?: string
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  BOT?: Fetcher
  BOT_HOST?: string
  PARTY_HOST?: string
}

interface DevLogPayload {
  timestamp?: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  message?: string
  href?: string
  userAgent?: string
  meta?: unknown
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

interface ActivityProxySession {
  userId: string
  displayName: string | null
  avatarUrl: string | null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    try {
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
      if (
        url.pathname.startsWith('/api/activity/')
        || url.pathname.startsWith('/api/match/')
        || url.pathname.startsWith('/api/lobby/')
        || url.pathname.startsWith('/api/lobby-ranks/')
      ) {
        return await handleMatchProxy(request, url, env)
      }
      return new Response(null, { status: 404 })
    }
    catch (error) {
      console.error('[activity:req:error]', request.method, url.pathname, error)
      throw error
    }
  },
} satisfies ExportedHandler<Env>

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

async function handleMatchProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await requireActivitySession(request, env)
    if (session instanceof Response) return session

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

    const body = await response.text()
    if (!response.ok) {
      if (shouldWarnForMatchProxy(request.method, url.pathname, response.status)) {
        console.warn('[activity] Match proxy upstream non-OK', {
          targetUrl,
          status: response.status,
          bodyPreview: body.slice(0, 200),
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

function shouldUseBotServiceBinding(request: Request, env: Env): boolean {
  if (!env.BOT) return false
  if (isDev({ viteDev: import.meta.env.DEV, host: request.url, configuredHosts: [env.BOT_HOST] })) return false

  return true
}

async function handlePartyProxy(request: Request, url: URL, env: Env): Promise<Response> {
  let targetUrl = ''
  try {
    const session = await requireActivitySession(request, env)
    if (session instanceof Response) return session

    const partyHost = normalizeHost(env.PARTY_HOST, 'http://localhost:1999')
    const targetPath = url.pathname.replace(/^\/api\/parties/, '/parties')
    targetUrl = `${partyHost}${buildTargetPath(url, targetPath)}`
    return fetch(buildProxyRequest(targetUrl, request, env, session))
  }
  catch (err) {
    console.error('Party proxy error:', { targetUrl, err })
    return json({ error: 'Party proxy failed' }, 502)
  }
}

function buildProxyRequest(targetUrl: string, request: Request, env: Env, session: ActivityProxySession): Request {
  const method = request.method.toUpperCase()
  const internalSecret = env.CIVUP_SECRET?.trim() ?? ''

  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'content-type', 'user-agent']) {
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

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: redirectUri,
      }),
    })

    const retryAfter = tokenResponse.headers.get('Retry-After')
      ?? tokenResponse.headers.get('X-RateLimit-Reset-After')

    if (!tokenResponse.ok) {
      const detailRaw = await tokenResponse.text()
      let detailJson: DiscordTokenErrorResponse | null = null
      try {
        detailJson = JSON.parse(detailRaw) as DiscordTokenErrorResponse
      }
      catch {}

      const detailMessage = detailJson?.error_description
        ?? detailJson?.error
        ?? detailRaw
        ?? 'Token exchange failed'

      const isRateLimited = tokenResponse.status === 429
        || /rate limit/i.test(detailMessage)

      console.error('Discord token exchange failed:', {
        status: tokenResponse.status,
        retryAfter,
        redirectUri,
        detail: detailMessage,
      })

      const response = json(
        {
          error: 'Token exchange failed',
          detail: detailMessage,
          retry_after: retryAfter ?? undefined,
          rate_limited: isRateLimited,
        },
        isRateLimited ? 429 : tokenResponse.status,
      )

      if (retryAfter) response.headers.set('Retry-After', retryAfter)
      return response
    }

    const payload = await tokenResponse.json<DiscordTokenSuccessResponse>()

    if (!payload.access_token) {
      console.error('Discord token exchange succeeded without access_token')
      return json({ error: 'Token exchange returned no access token' }, 502)
    }

    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${payload.access_token}`,
      },
    })

    if (!userResponse.ok) {
      const detail = await userResponse.text()
      console.error('Discord user lookup failed:', {
        status: userResponse.status,
        detail,
      })
      return json({ error: 'Failed to verify Discord user' }, 502)
    }

    const discordUser = await userResponse.json<DiscordUserResponse>()
    const userId = typeof discordUser.id === 'string' ? discordUser.id.trim() : ''
    if (!userId) {
      console.error('Discord user lookup returned no user ID')
      return json({ error: 'Failed to verify Discord user' }, 502)
    }

    const sessionToken = await createActivitySession(internalSecret, {
      userId,
      displayName: discordUser.global_name ?? discordUser.username ?? null,
      avatarUrl: buildDiscordAvatarUrl(userId, discordUser.avatar ?? null),
    })

    const response = json({
      access_token: payload.access_token,
      expires_in: payload.expires_in,
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
  const token = request.headers.get(CIVUP_ACTIVITY_SESSION_HEADER)
    ?? requestUrl.searchParams.get(CIVUP_ACTIVITY_SESSION_QUERY_PARAM)
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
  }
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
