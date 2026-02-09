interface Env {
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // POST /api/token — Discord OAuth code → access_token exchange
    if (url.pathname === '/api/token' && request.method === 'POST') {
      return handleTokenExchange(request, env)
    }

    if (url.pathname === '/api/dev-log' && request.method === 'POST') {
      return handleDevLog(request)
    }

    // /api/parties/* — proxy HTTP + WebSocket to PartyKit
    if (url.pathname.startsWith('/api/parties/')) {
      return handlePartyProxy(request, url, env)
    }

    // /api/match/* and /api/lobby/* — proxy bot API calls
    if (url.pathname.startsWith('/api/match/') || url.pathname.startsWith('/api/lobby/')) {
      return handleMatchProxy(request, url, env)
    }

    // All other routes fall through to static assets (SPA).
    // The `not_found_handling: "single-page-application"` in wrangler.jsonc
    // ensures non-asset routes serve index.html.
    return new Response(null, { status: 404 })
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
  try {
    const botHost = normalizeHost(env.BOT_HOST, 'http://localhost:8787')
    const targetUrl = `${botHost}${url.pathname}${url.search}`
    const response = await fetch(new Request(targetUrl, request))

    const body = await response.text()
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  }
  catch (err) {
    console.error('Match lookup proxy error:', err)
    return json({ error: 'Match lookup proxy failed' }, 502)
  }
}

async function handlePartyProxy(request: Request, url: URL, env: Env): Promise<Response> {
  try {
    const partyHost = normalizeHost(env.PARTY_HOST, 'http://localhost:1999')
    const targetPath = url.pathname.replace(/^\/api\/parties/, '/parties')
    const targetUrl = `${partyHost}${targetPath}${url.search}`
    return fetch(new Request(targetUrl, request))
  }
  catch (err) {
    console.error('Party proxy error:', err)
    return json({ error: 'Party proxy failed' }, 502)
  }
}

async function handleTokenExchange(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json<{ code: string }>()

    if (!body.code || typeof body.code !== 'string') {
      return json({ error: 'Missing or invalid "code" in request body' }, 400)
    }

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: body.code,
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
      catch {
        // no-op
      }

      const detailMessage = detailJson?.error_description
        ?? detailJson?.error
        ?? detailRaw
        ?? 'Token exchange failed'

      const isRateLimited = tokenResponse.status === 429
        || /rate limit/i.test(detailMessage)

      console.error('Discord token exchange failed:', {
        status: tokenResponse.status,
        retryAfter,
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

    return json({
      access_token: payload.access_token,
      expires_in: payload.expires_in,
    })
  }
  catch (err) {
    console.error('Token exchange error:', err)
    return json({ error: 'Internal server error' }, 500)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeHost(host: string | undefined, fallback: string): string {
  const raw = (host && host.trim()) || fallback
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `${isLocalHost(raw) ? 'http' : 'https'}://${raw}`
  return withProtocol.replace(/\/$/, '')
}

function isLocalHost(host: string): boolean {
  const raw = host.trim().toLowerCase()
  return raw.includes('localhost') || raw.includes('127.0.0.1')
}
