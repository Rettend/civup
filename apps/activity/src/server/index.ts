interface Env {
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  BOT_HOST?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // POST /api/token — Discord OAuth code → access_token exchange
    if (url.pathname === '/api/token' && request.method === 'POST') {
      return handleTokenExchange(request, env)
    }

    // GET /api/match/:channelId and /api/match/user/:userId — proxy to bot API
    if (request.method === 'GET' && (url.pathname.startsWith('/api/match/') || url.pathname.startsWith('/api/match/user/'))) {
      return handleMatchProxy(url, env)
    }

    // All other routes fall through to static assets (SPA).
    // The `not_found_handling: "single-page-application"` in wrangler.jsonc
    // ensures non-asset routes serve index.html.
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>

async function handleMatchProxy(url: URL, env: Env): Promise<Response> {
  try {
    const botHost = normalizeHost(env.BOT_HOST)
    const targetUrl = `${botHost}${url.pathname}${url.search}`
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

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

function normalizeHost(host?: string): string {
  const raw = (host && host.trim()) || 'http://localhost:8787'
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `https://${raw}`
  return withProtocol.replace(/\/$/, '')
}
