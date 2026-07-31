import {
  ACTIVITY_VERSION_OUTDATED_MESSAGE,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
} from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import activityWorker from '../src/server'

const SECRET = 'server-party-proxy-secret'
const GUILD_ID = '1234044388733095946'
type ActivityEnv = Parameters<typeof activityWorker.fetch>[1]
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('activity party proxy', () => {
  test('proxies launch lookups through the bot service binding', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1', 'Player One')

    const response = await activityWorker.fetch(new Request(
      'https://civup-activity.thepeace.workers.dev/api/activity/launch/1496817844812386365/player-1',
      {
        headers: {
          'x-civup-activity-session': token,
        },
      },
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(forwardedRequests).toHaveLength(1)
    const forwarded = requireForwardedRequest(forwardedRequests)
    expect(new URL(forwarded.url).pathname).toBe('/api/activity/launch/1496817844812386365/player-1')
    expect(forwarded.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe(SECRET)
    expect(forwarded.headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)).toBe('player-1')
  })

  test('rejects unsupported websocket namespaces', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1', 'Player One')

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/unknown/Fqo0_8B9f4Xz?_pk=socket-1&accessToken=draft-room.v1.test&activitySession=${encodeURIComponent(token)}`,
      {
        headers: {
          'connection': 'Upgrade',
          'sec-websocket-key': 'test-key',
          'sec-websocket-version': '13',
          'upgrade': 'websocket',
        },
      },
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(404)
    expect(await response.json() as unknown).toEqual({ error: ACTIVITY_VERSION_OUTDATED_MESSAGE })
    expect(forwardedRequests).toHaveLength(0)
  })

  test('forwards canonical selected-session websocket paths', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1', 'Player One')

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/session/Fqo0_8B9f4Xz?_pk=socket-1&accessToken=draft-room.v1.test&activitySession=${encodeURIComponent(token)}`,
      {
        headers: {
          'connection': 'Upgrade',
          'sec-websocket-key': 'test-key',
          'sec-websocket-version': '13',
          'upgrade': 'websocket',
        },
      },
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    expect(forwardedRequests).toHaveLength(1)
    const forwarded = requireForwardedRequest(forwardedRequests)
    const forwardedUrl = new URL(forwarded.url)
    expect(forwardedUrl.pathname).toBe('/parties/session/Fqo0_8B9f4Xz')
    expect(forwardedUrl.searchParams.get('accessToken')).toBe('draft-room.v1.test')
    expect(forwardedUrl.searchParams.has('activitySession')).toBe(false)
    expect(forwarded.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe(SECRET)
    expect(forwarded.headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)).toBe('player-1')
  })

  test('forwards the canonical Activity feed room unchanged', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1')

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/activity/overview?_pk=socket-2&activitySession=${encodeURIComponent(token)}`,
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    expect(forwardedRequests).toHaveLength(1)
    expect(new URL(requireForwardedRequest(forwardedRequests).url).pathname).toBe('/parties/activity/overview')
  })

  test('rejects noncanonical Activity feed rooms', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1')

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/activity/1496817844812386365?_pk=socket-3&activitySession=${encodeURIComponent(token)}`,
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(404)
    expect(await response.json() as unknown).toEqual({ error: ACTIVITY_VERSION_OUTDATED_MESSAGE })
    expect(forwardedRequests).toHaveLength(0)
  })

  test('uses the fixed local bot origin for recognized development hosts', async () => {
    const forwardedRequests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      forwardedRequests.push(new Request(input, init))
      return new Response('local')
    }) as typeof fetch
    const token = await createTestActivitySession('player-1')

    const response = await activityWorker.fetch(new Request(
      'http://activity-dev.localhost/api/activity/launch/channel/player-1',
      { headers: { 'x-civup-activity-session': token } },
    ), { ...createEnv([]), BOT: undefined })

    expect(response.status).toBe(200)
    expect(forwardedRequests).toHaveLength(1)
    expect(forwardedRequests[0]!.url).toBe('http://127.0.0.1:8787/api/activity/launch/channel/player-1')
  })

  test('returns 503 instead of using public fetch when the production binding is absent', async () => {
    const token = await createTestActivitySession('player-1')
    const response = await activityWorker.fetch(new Request(
      'https://activity.example.com/api/activity/launch/channel/player-1',
      { headers: { 'x-civup-activity-session': token } },
    ), { ...createEnv([]), BOT: undefined })

    expect(response.status).toBe(503)
    expect(await response.json() as unknown).toEqual({ error: 'Bot service is not configured' })
  })

  test('streams upload bodies and init metadata through the service binding', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1')
    const metadata = { fileName: 'autosaves.zip', fileSizeBytes: 123, channelId: 'channel-1', matchId: 'match-1' }
    const response = await activityWorker.fetch(new Request(
      'https://activity.example.com/api/uploads/autosaves/init',
      {
        method: 'POST',
        headers: { 'x-civup-activity-session': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      },
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    const forwarded = requireForwardedRequest(forwardedRequests)
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('Content-Type')).toBe('application/json')
    expect(await forwarded.json() as unknown).toEqual(metadata)
  })

  test('preserves a safe upload part content length through the service binding', async () => {
    const forwardedRequests: Request[] = []
    const token = await createTestActivitySession('player-1')
    const response = await activityWorker.fetch(new Request(
      'https://activity.example.com/api/uploads/autosaves/upload-1/parts/1',
      {
        method: 'PUT',
        headers: {
          'x-civup-activity-session': token,
          'Content-Length': '4',
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    const forwarded = requireForwardedRequest(forwardedRequests)
    expect(forwarded.headers.get('Content-Length')).toBe('4')
    expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})

function createEnv(forwardedRequests: Request[]): ActivityEnv {
  return {
    BOT: {
      async fetch(request: Request) {
        forwardedRequests.push(request)
        return new Response('ok')
      },
    } as unknown as Fetcher,
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_CLIENT_ID: 'test-client',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
  }
}

function createTestActivitySession(userId: string, displayName: string | null = null) {
  return createActivitySession(SECRET, {
    userId,
    displayName,
    avatarUrl: null,
    guildId: GUILD_ID,
    guildPermissions: '0',
  })
}

function requireForwardedRequest(requests: Request[]): Request {
  const request = requests[0]
  if (!request) throw new Error('Expected a forwarded request')
  return request
}
