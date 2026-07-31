import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_SESSION_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
} from '@civup/utils'
import { describe, expect, test } from 'bun:test'
import activityWorker from '../src/server'
import { BROWSER_SESSION_COOKIE } from '../src/server/browser-auth'

const ORIGIN = 'https://civup-activity.example.com'
const SECRET = 'browser-proxy-secret'
const GUILD_ID = '1234044388733095946'
type ActivityEnv = Parameters<typeof activityWorker.fetch>[1]

describe('browser cookie proxy', () => {
  test('serves the SPA entry document for stable browser routes', async () => {
    const assetRequests: Request[] = []
    const env = {
      ...createEnv([], new Response('unused')),
      ASSETS: {
        async fetch(request: Request) {
          assetRequests.push(request)
          return new Response('<!doctype html><title>Draft</title>', { headers: { 'Content-Type': 'text/html' } })
        },
      } as unknown as Fetcher,
    }
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/web/session/stable-session`), env)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Draft</title>')
    expect(new URL(assetRequests[0]!.url).pathname).toBe('/')
  })

  test('accepts cookie auth, strips credentials, and combines identity with direct context', async () => {
    const forwarded: Request[] = []
    const token = await createTestActivitySession({ userId: 'player-1', displayName: 'Player', avatarUrl: null })
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/browser/session/stable-session`, {
      headers: { Cookie: `${BROWSER_SESSION_COOKIE}=${token}` },
    }), createEnv(forwarded, Response.json({ status: 'ended', sessionId: 'stable-session', matchId: 'match-1', phase: 'cancelled' })))

    expect(response.status).toBe(200)
    expect(await response.json() as unknown).toEqual({
      identity: {
        userId: 'player-1',
        displayName: 'Player',
        avatarUrl: null,
        guildId: GUILD_ID,
        guildPermissions: '0',
        guildName: null,
        guildIconUrl: null,
        guildRoleIds: [],
      },
      context: { status: 'ended', sessionId: 'stable-session', matchId: 'match-1', phase: 'cancelled' },
    })
    const upstream = forwarded[0]!
    expect(new URL(upstream.url).pathname).toBe('/api/activity/session/stable-session')
    expect(upstream.headers.get('Cookie')).toBeNull()
    expect(upstream.headers.get(CIVUP_ACTIVITY_SESSION_HEADER)).toBeNull()
    expect(upstream.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe(SECRET)
  })

  test('requires exact Origin for cookie-authenticated unsafe requests and websocket upgrades', async () => {
    const token = await createActivitySession(SECRET, {
      userId: 'player-1',
      displayName: null,
      avatarUrl: null,
      guildId: '1234044388733095946',
      guildPermissions: '0',
      guildName: 'Partner Server',
      guildIconUrl: 'https://cdn.discordapp.com/icons/1234044388733095946/icon.png',
      guildRoleIds: ['222222222222222222'],
    })
    const cookie = `${BROWSER_SESSION_COOKIE}=${token}`
    const env = createEnv([], new Response('ok'))

    const crossOriginPost = await activityWorker.fetch(new Request(`${ORIGIN}/api/lobby/1v1/config`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    }), env)
    expect(crossOriginPost.status).toBe(403)

    const missingOriginSocket = await activityWorker.fetch(new Request(`${ORIGIN}/api/parties/session/stable-session`, {
      headers: { Cookie: cookie, Upgrade: 'websocket', Connection: 'Upgrade' },
    }), env)
    expect(missingOriginSocket.status).toBe(403)

    const sameOriginSocket = await activityWorker.fetch(new Request(`${ORIGIN}/api/parties/session/stable-session`, {
      headers: { Cookie: cookie, Origin: ORIGIN, Upgrade: 'websocket', Connection: 'Upgrade' },
    }), env)
    expect(sameOriginSocket.status).toBe(200)
  })

  test('keeps explicit embedded header auth working when browser auth is not configured', async () => {
    const forwarded: Request[] = []
    const token = await createTestActivitySession({ userId: 'embedded', displayName: null, avatarUrl: null })
    const env = { ...createEnv(forwarded, new Response('ok')), ACTIVITY_PUBLIC_ORIGIN: undefined }
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/activity/launch/channel/embedded`, {
      headers: { [CIVUP_ACTIVITY_SESSION_HEADER]: token },
    }), env)
    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(1)
  })

  test('streams player-data export pages without buffering them in the Activity Worker', async () => {
    const forwarded: Request[] = []
    const token = await createActivitySession(SECRET, {
      userId: 'data-admin',
      displayName: null,
      avatarUrl: null,
      guildId: '1234044388733095946',
      guildPermissions: '32',
    })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"phase":"players"}'))
        controller.close()
      },
    })
    const upstream = new Response(body, { headers: { 'Content-Type': 'application/json', ETag: 'page-etag' } })

    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/activity/admin/player-data-export?cursor=next`, {
      headers: { [CIVUP_ACTIVITY_SESSION_HEADER]: token },
    }), createEnv(forwarded, upstream))

    expect(await response.text()).toBe('{"phase":"players"}')
    expect(new URL(forwarded[0]!.url).searchParams.get('cursor')).toBe('next')
    expect(forwarded[0]!.headers.get(CIVUP_ACTIVITY_GUILD_ID_HEADER)).toBe('1234044388733095946')
    expect(forwarded[0]!.headers.get(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER)).toBe('32')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('ETag')).toBe('page-etag')
  })

  test('streams CivBlitz ZIP downloads through a short-lived match-scoped ticket', async () => {
    const forwarded: Request[] = []
    const token = await createActivitySession(SECRET, {
      userId: 'player-1',
      displayName: null,
      avatarUrl: null,
      guildId: '1234044388733095946',
      guildPermissions: '0',
      guildName: 'Partner Server',
      guildIconUrl: 'https://cdn.discordapp.com/icons/1234044388733095946/icon.png',
      guildRoleIds: ['222222222222222222'],
    })
    const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x00, 0xFF, 0x80, 0x01])
    const upstream = new Response(bytes, {
      headers: {
        'Content-Disposition': 'attachment; filename="civblitz-match.zip"',
        'Content-Length': String(bytes.byteLength),
        'Content-Type': 'application/zip',
        ETag: 'mod-etag',
      },
    })

    const ticketResponse = await activityWorker.fetch(new Request(`${ORIGIN}/api/match/match-1/civblitz/download-ticket`, {
      method: 'POST',
      headers: { [CIVUP_ACTIVITY_SESSION_HEADER]: token },
    }), createEnv(forwarded, upstream))
    const ticketPayload = await ticketResponse.json<{ ticket: string }>()
    expect(ticketResponse.status).toBe(200)
    expect(typeof ticketPayload.ticket).toBe('string')

    const response = await activityWorker.fetch(new Request(
      `${ORIGIN}/api/match/match-1/civblitz/download?civBlitzDownloadTicket=${encodeURIComponent(ticketPayload.ticket)}`,
    ), createEnv(forwarded, upstream))

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="civblitz-match.zip"')
    expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength))
    expect(response.headers.get('ETag')).toBe('mod-etag')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new URL(forwarded[0]!.url).pathname).toBe('/api/match/match-1/civblitz/download')
    expect(new URL(forwarded[0]!.url).search).toBe('')
    expect(forwarded[0]!.headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)).toBe('player-1')
    expect(forwarded[0]!.headers.get(CIVUP_ACTIVITY_GUILD_ID_HEADER)).toBe('1234044388733095946')
    expect(forwarded[0]!.headers.get(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER)).toBeNull()

    const wrongMatch = await activityWorker.fetch(new Request(
      `${ORIGIN}/api/match/match-2/civblitz/download?civBlitzDownloadTicket=${encodeURIComponent(ticketPayload.ticket)}`,
    ), createEnv([], upstream))
    expect(wrongMatch.status).toBe(401)

    const reusableSessionUrl = await activityWorker.fetch(new Request(
      `${ORIGIN}/api/match/match-1/civblitz/download?activitySession=${encodeURIComponent(token)}`,
    ), createEnv([], upstream))
    expect(reusableSessionUrl.status).toBe(401)
  })

  test('returns browser identity without exposing the session and clears logout only for exact origin', async () => {
    const token = await createTestActivitySession({ userId: 'player-1', displayName: 'Player', avatarUrl: null })
    const env = createEnv([], new Response('ok'))
    const me = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/me`, {
      headers: { Cookie: `${BROWSER_SESSION_COOKIE}=${token}` },
    }), env)
    expect(await me.json<any>()).toEqual({
      userId: 'player-1',
      displayName: 'Player',
      avatarUrl: null,
      guildId: GUILD_ID,
      guildPermissions: '0',
      guildName: null,
      guildIconUrl: null,
      guildRoleIds: [],
    })

    const rejectedLogout = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/logout`, {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }), env)
    expect(rejectedLogout.status).toBe(403)
    const logout = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/logout`, {
      method: 'POST', headers: { Origin: ORIGIN },
    }), env)
    expect(logout.status).toBe(204)
    expect(logout.headers.get('Set-Cookie')).toContain(`${BROWSER_SESSION_COOKIE}=;`)
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  test('rejects expired browser sessions', async () => {
    const token = await createTestActivitySession({ userId: 'player-1', displayName: null, avatarUrl: null }, {
      nowMs: Date.now() - 10_000,
      ttlSeconds: 1,
    })
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/auth/me`, {
      headers: { Cookie: `${BROWSER_SESSION_COOKIE}=${token}` },
    }), createEnv([], new Response('ok')))
    expect(response.status).toBe(401)
  })

  test('rejects an existing session after its source guild is removed from the allowlist', async () => {
    const token = await createActivitySession(SECRET, {
      userId: 'partner-player',
      displayName: null,
      avatarUrl: null,
      guildId: '222222222222222222',
      guildPermissions: '0',
    })
    const forwarded: Request[] = []
    const response = await activityWorker.fetch(new Request(`${ORIGIN}/api/activity/launch/channel/partner-player`, {
      headers: { [CIVUP_ACTIVITY_SESSION_HEADER]: token },
    }), createEnv(forwarded, new Response('ok')))

    expect(response.status).toBe(403)
    expect(forwarded).toHaveLength(0)
  })
})

function createTestActivitySession(
  identity: { userId: string, displayName: string | null, avatarUrl: string | null },
  options?: { nowMs?: number, ttlSeconds?: number },
) {
  return createActivitySession(SECRET, {
    ...identity,
    guildId: GUILD_ID,
    guildPermissions: '0',
  }, options)
}

function createEnv(forwarded: Request[], upstream: Response): ActivityEnv {
  return {
    ACTIVITY_PUBLIC_ORIGIN: ORIGIN,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    CIVUP_SECRET: SECRET,
    DISCORD_CLIENT_ID: '222222222222222222',
    DISCORD_CLIENT_SECRET: 'client-secret',
    BOT: {
      async fetch(request: Request) {
        forwarded.push(request)
        return upstream.clone()
      },
    } as unknown as Fetcher,
  }
}
