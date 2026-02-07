interface Env {
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  BOT_HOST?: string
  PARTY_HOST?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // POST /api/token — Discord OAuth code → access_token exchange
    if (url.pathname === '/api/token' && request.method === 'POST') {
      return handleTokenExchange(request, env)
    }

    // /api/parties/* — proxy HTTP + WebSocket to PartyKit
    if (url.pathname.startsWith('/api/parties/')) {
      return handlePartyProxy(request, url, env)
    }

    // /api/match/* — proxy match lookup/reporting calls to bot API
    if (url.pathname.startsWith('/api/match/')) {
      return handleMatchProxy(request, url, env)
    }

    // All other routes fall through to static assets (SPA).
    // The `not_found_handling: "single-page-application"` in wrangler.jsonc
    // ensures non-asset routes serve index.html.
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>

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

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text()
      console.error('Discord token exchange failed:', tokenResponse.status, detail)
      return json({ error: 'Token exchange failed' }, 502)
    }

    const { access_token } = await tokenResponse.json<{ access_token: string }>()
    return json({ access_token })
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
