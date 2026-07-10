import { afterEach, describe, expect, test } from 'bun:test'
import { buildActivitySessionHeaders, cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'
import { bootstrapBrowserSession } from '../src/client/platform/browser-platform'
import { configureClientPlatform, getAuthTransport } from '../src/client/platform/runtime'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearActivitySessionToken()
  configureClientPlatform('discord-embedded', 'token')
})

describe('browser client platform', () => {
  test('bootstraps identity and context in one cookie-authenticated request', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(new URL(String(input), window.location.origin), init))
      return Response.json({
        identity: { userId: 'player-1', displayName: 'Player', avatarUrl: null },
        context: { status: 'ended', sessionId: 'stable-session', matchId: 'match-1', phase: 'cancelled' },
      })
    }) as typeof fetch

    const bootstrap = await bootstrapBrowserSession('stable/session')
    expect(bootstrap.identity.userId).toBe('player-1')
    expect(bootstrap.context).toEqual(expect.objectContaining({ sessionId: 'stable-session', matchId: 'match-1' }))
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/browser/session/stable%2Fsession')
    expect(getAuthTransport()).toBe('cookie')
  })

  test('cookie transport never exposes the cached embedded token in request headers', () => {
    cacheActivitySessionToken('embedded-secret')
    configureClientPlatform('web', 'cookie')
    expect(buildActivitySessionHeaders().has('X-CivUp-Activity-Session')).toBe(false)

    configureClientPlatform('discord-embedded', 'token')
    expect(buildActivitySessionHeaders().get('X-CivUp-Activity-Session')).toBe('embedded-secret')
  })
})
