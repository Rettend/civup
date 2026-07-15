import { afterEach, describe, expect, test } from 'bun:test'
import { verifyActivitySession } from '@civup/utils'
import activityWorker from '../src/server'
import { BROWSER_SESSION_COOKIE, OAUTH_TRANSACTION_COOKIE, validateBrowserReturnPath } from '../src/server/browser-auth'

const ORIGIN = 'https://civup-activity.example.com'
const GUILD_ID = '1234044388733095946'
const originalFetch = globalThis.fetch
type ActivityEnv = Parameters<typeof activityWorker.fetch>[1]

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('browser Discord OAuth', () => {
  test('starts canonical OAuth with random state, S256 PKCE, exact callback, scopes, and a signed cookie', async () => {
    const env = createEnv()
    const first = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/session-1')}`), env)
    const second = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/session-1')}`), env)

    expect(first.status).toBe(302)
    const authorization = new URL(first.headers.get('Location')!)
    expect(authorization.origin).toBe('https://discord.com')
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`)
    expect(authorization.searchParams.get('scope')).toBe('identify guilds guilds.members.read')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(authorization.searchParams.get('state')).not.toBe(new URL(second.headers.get('Location')!).searchParams.get('state'))
    expect(first.headers.get('Set-Cookie')).toContain(`${OAUTH_TRANSACTION_COOKIE}=`)
    expect(first.headers.get('Set-Cookie')).toContain('Max-Age=600')
    expect(first.headers.get('Set-Cookie')).toContain('HttpOnly')
    expect(first.headers.get('Set-Cookie')).toContain('Secure')
    expect(first.headers.get('Set-Cookie')).toContain('SameSite=Lax')
    expect(first.headers.get('Cache-Control')).toBe('no-store')
  })

  test('canonicalizes OAuth entry before setting a host-only cookie', async () => {
    const response = await activityWorker.fetch(new Request(`https://other.example/api/auth/discord?returnTo=${encodeURIComponent('/web/channel/1')}`), createEnv())
    expect(response.status).toBe(307)
    expect(response.headers.get('Location')).toBe(`${ORIGIN}/api/auth/discord?returnTo=%2Fweb%2Fchannel%2F1`)
    expect(response.headers.has('Set-Cookie')).toBe(false)
  })

  test('accepts the configured HTTPS host when Cloudflare Tunnel forwards it to local HTTP', async () => {
    const returnTo = encodeURIComponent('/web/session/session-1')
    const forwarded = await activityWorker.fetch(new Request(
      `http://civup-activity.example.com/api/auth/discord?returnTo=${returnTo}`,
      { headers: { 'X-Forwarded-Proto': 'https' } },
    ), createEnv())
    expect(forwarded.status).toBe(302)
    expect(new URL(forwarded.headers.get('Location')!).origin).toBe('https://discord.com')
    expect(forwarded.headers.get('Set-Cookie')).toContain(`${OAUTH_TRANSACTION_COOKIE}=`)

    const wrongHost = await activityWorker.fetch(new Request(
      `http://other.example/api/auth/discord?returnTo=${returnTo}`,
      { headers: { 'X-Forwarded-Proto': 'https' } },
    ), createEnv())
    expect(wrongHost.status).toBe(307)
    expect(wrongHost.headers.get('Location')).toBe(`${ORIGIN}/api/auth/discord?returnTo=%2Fweb%2Fsession%2Fsession-1`)
  })

  test('rejects unsafe return paths', () => {
    expect(validateBrowserReturnPath('/web/session/one?x=1')).toBe('/web/session/one?x=1')
    expect(validateBrowserReturnPath('https://evil.example/web/session/one')).toBeNull()
    expect(validateBrowserReturnPath('//evil.example/web/session/one')).toBeNull()
    expect(validateBrowserReturnPath('/api/auth/discord/callback')).toBeNull()
    expect(validateBrowserReturnPath('/web/../api/auth/discord/callback')).toBeNull()
  })

  test('completes OAuth with PKCE, verifies guild membership, and stores only the signed session cookie', async () => {
    const env = createEnv()
    const start = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/stable-session')}`), env)
    const authorization = new URL(start.headers.get('Location')!)
    const transactionCookie = cookiePair(start.headers.get('Set-Cookie')!, OAUTH_TRANSACTION_COOKIE)
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/oauth2/token')) {
        return Response.json({ access_token: 'provider-secret', expires_in: 3600 })
      }
      if (request.url.includes('/users/@me/guilds?')) {
        return Response.json([{ id: GUILD_ID, permissions: '32' }])
      }
      return Response.json({
        nick: 'PPL Player',
        avatar: 'guild-avatar',
        user: { id: '111111111111111111', username: 'player', global_name: 'Global Player', avatar: 'user-avatar' },
      })
    }) as typeof fetch

    const callback = await activityWorker.fetch(new Request(
      `${ORIGIN}/api/auth/discord/callback?code=oauth-code&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`,
      { headers: { Cookie: transactionCookie } },
    ), env)

    expect(callback.status).toBe(303)
    expect(callback.headers.get('Location')).toBe('/web/session/stable-session')
    expect(callback.headers.get('Set-Cookie')).toContain(`${BROWSER_SESSION_COOKIE}=`)
    expect(callback.headers.get('Set-Cookie')).not.toContain('provider-secret')
    const browserSession = cookiePair(callback.headers.get('Set-Cookie')!, BROWSER_SESSION_COOKIE).split('=')[1]!
    await expect(verifyActivitySession('browser-auth-secret', browserSession)).resolves.toEqual(expect.objectContaining({
      sub: '111111111111111111',
      name: 'PPL Player',
      avatarUrl: `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/111111111111111111/avatars/guild-avatar.png?size=128`,
      guildId: GUILD_ID,
      guildPermissions: '32',
    }))
    const tokenBody = await requests[0]!.clone().text()
    expect(tokenBody).toContain('code_verifier=')
    expect(tokenBody).toContain(`redirect_uri=${encodeURIComponent(`${ORIGIN}/api/auth/discord/callback`)}`)
    expect(requests[1]!.url).toContain(`/users/@me/guilds/${GUILD_ID}/member`)
    expect(requests[2]!.url).toContain('/users/@me/guilds?limit=200')
  })

  test('guild rejection and callback errors render a terminal no-store retry page without redirecting', async () => {
    const env = createEnv()
    const start = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/s1')}`), env)
    const authorization = new URL(start.headers.get('Location')!)
    const transactionCookie = cookiePair(start.headers.get('Set-Cookie')!, OAUTH_TRANSACTION_COOKIE)
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes('/oauth2/token')
      ? Response.json({ access_token: 'provider-secret' })
      : new Response('not a member', { status: 404 })) as typeof fetch

    const response = await activityWorker.fetch(new Request(
      `${ORIGIN}/api/auth/discord/callback?code=oauth-code&state=${authorization.searchParams.get('state')}`,
      { headers: { Cookie: transactionCookie } },
    ), env)
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Location')).toBeNull()
    expect(await response.text()).toContain('Try Discord sign-in again')

    const cancelStart = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/s1')}`), env)
    const cancelAuthorization = new URL(cancelStart.headers.get('Location')!)
    const cancelled = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord/callback?error=access_denied&state=${cancelAuthorization.searchParams.get('state')}`, {
      headers: { Cookie: cookiePair(cancelStart.headers.get('Set-Cookie')!, OAUTH_TRANSACTION_COOKIE) },
    }), env)
    expect(cancelled.status).toBe(400)
    expect(cancelled.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  test('fails closed for mismatched, tampered, expired, and replayed transaction state', async () => {
    const env = createEnv()
    const start = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=${encodeURIComponent('/web/session/s1')}`), env)
    const authorization = new URL(start.headers.get('Location')!)
    const transactionCookie = cookiePair(start.headers.get('Set-Cookie')!, OAUTH_TRANSACTION_COOKIE)

    const mismatch = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=wrong`, {
      headers: { Cookie: transactionCookie },
    }), env)
    expect(mismatch.status).toBe(400)
    expect(await mismatch.text()).toContain('state did not match')

    const tampered = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=${authorization.searchParams.get('state')}`, {
      headers: { Cookie: `${transactionCookie}x` },
    }), env)
    expect(tampered.status).toBe(400)
    expect(await tampered.text()).toContain('missing, expired, or invalid')

    const now = Date.now
    Date.now = () => now() + 11 * 60 * 1000
    try {
      const expired = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=${authorization.searchParams.get('state')}`, {
        headers: { Cookie: transactionCookie },
      }), env)
      expect(expired.status).toBe(400)
      expect(await expired.text()).toContain('missing, expired, or invalid')
    }
    finally {
      Date.now = now
    }

    const replayWithoutClearedCookie = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=${authorization.searchParams.get('state')}`), env)
    expect(replayWithoutClearedCookie.status).toBe(400)
  })

  test('is unavailable unless every browser auth setting is configured', async () => {
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/discord?returnTo=/web/session/s1`), {
      ...createEnv(),
      ACTIVITY_PUBLIC_ORIGIN: undefined,
    })
    expect(response.status).toBe(503)
  })

  test('keeps embedded token exchange response and redirect behavior unchanged', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/oauth2/token')) return Response.json({ access_token: 'embedded-provider-token', expires_in: 3600 })
      if (request.url.includes('/users/@me/guilds?')) return Response.json([{ id: GUILD_ID, permissions: '8' }])
      return Response.json({ user: { id: '111111111111111111', username: 'Player', avatar: null } })
    }) as typeof fetch

    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'embedded-code', redirectUri: 'ignored-client-value' }),
    }), createEnv())
    expect(response.status).toBe(200)
    const payload = await response.json<any>()
    expect(payload.access_token).toBe('embedded-provider-token')
    expect(payload.activity_session_token).toStartWith('session.v2.')
    const tokenBody = await requests[0]!.clone().text()
    expect(tokenBody).toContain(`redirect_uri=${encodeURIComponent(ORIGIN)}`)
    expect(tokenBody).not.toContain('code_verifier')
  })
})

function createEnv(): ActivityEnv {
  return {
    ACTIVITY_PUBLIC_ORIGIN: ORIGIN,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    CIVUP_SECRET: 'browser-auth-secret',
    DISCORD_CLIENT_ID: '222222222222222222',
    DISCORD_CLIENT_SECRET: 'client-secret',
  }
}

function cookiePair(setCookie: string, name: string): string {
  const match = setCookie.match(new RegExp(`${name}=[^;,]+`))
  if (!match) throw new Error(`Missing ${name} cookie`)
  return match[0]
}
