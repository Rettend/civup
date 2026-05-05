import {
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
  createActivitySession,
} from '@civup/utils'
import { describe, expect, test } from 'bun:test'
import activityWorker from '../src/server'

const SECRET = 'server-party-proxy-secret'
type ActivityEnv = Parameters<typeof activityWorker.fetch>[1]

describe('activity party proxy', () => {
  test('proxies launch lookups through the bot service binding', async () => {
    const forwardedRequests: Request[] = []
    const token = await createActivitySession(SECRET, { userId: 'player-1', displayName: 'Player One', avatarUrl: null })

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

  test('rewrites stale main selected-session websocket paths to SessionDO', async () => {
    const forwardedRequests: Request[] = []
    const token = await createActivitySession(SECRET, { userId: 'player-1', displayName: 'Player One', avatarUrl: null })

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/main/Fqo0_8B9f4Xz?_pk=socket-1&accessToken=draft-room.v1.test&activitySession=${encodeURIComponent(token)}`,
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

  test('rewrites stale main open-lobby rooms without access token to SessionDO', async () => {
    const forwardedRequests: Request[] = []
    const token = await createActivitySession(SECRET, { userId: 'player-1', displayName: null, avatarUrl: null })

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/main/lobby-short-id?_pk=socket-2&activitySession=${encodeURIComponent(token)}`,
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    expect(forwardedRequests).toHaveLength(1)
    expect(new URL(requireForwardedRequest(forwardedRequests).url).pathname).toBe('/parties/session/lobby-short-id')
  })

  test('rewrites stale main Discord channel rooms to the activity feed', async () => {
    const forwardedRequests: Request[] = []
    const token = await createActivitySession(SECRET, { userId: 'player-1', displayName: null, avatarUrl: null })

    const response = await activityWorker.fetch(new Request(
      `https://civup-activity.thepeace.workers.dev/api/parties/main/1496817844812386365?_pk=socket-3&activitySession=${encodeURIComponent(token)}`,
    ), createEnv(forwardedRequests))

    expect(response.status).toBe(200)
    expect(forwardedRequests).toHaveLength(1)
    expect(new URL(requireForwardedRequest(forwardedRequests).url).pathname).toBe('/parties/activity/1496817844812386365')
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
    BOT_HOST: 'https://civup-bot.thepeace.workers.dev',
    CIVUP_SECRET: SECRET,
    DISCORD_CLIENT_ID: 'test-client',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
  }
}

function requireForwardedRequest(requests: Request[]): Request {
  const request = requests[0]
  if (!request) throw new Error('Expected a forwarded request')
  return request
}
