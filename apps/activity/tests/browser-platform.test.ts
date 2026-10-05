import { ApiError } from '@civup/utils'
import { waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildActivitySessionHeaders, cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'
import { openExternalLink } from '../src/client/platform/external-links'
import { bootstrapBrowserChannel, bootstrapBrowserSession, BrowserLaunchValidationError } from '../src/client/platform/browser-platform'
import { configureClientPlatform, getAuthTransport } from '../src/client/platform/runtime'

const originalFetch = globalThis.fetch
const originalOpen = window.open

afterEach(() => {
  globalThis.fetch = originalFetch
  window.open = originalOpen
  clearActivitySessionToken()
  configureClientPlatform('discord-embedded', 'token')
  window.history.replaceState(null, '', '/')
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

  test.each([
    [403, 'Session is not in the configured Discord server'],
    [403, 'This activity is only available in the configured Discord server'],
    [404, 'Session not found'],
    [404, 'Session is unavailable'],
    [503, 'Browser access is disabled'],
    [503, 'Browser access is not configured'],
  ])('preserves the deliberate browser validation %s: %s', async (status, message) => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: message }, { status }))
    const bootstrap = bootstrapBrowserSession('session-1')
    await expect(bootstrap).rejects.toBeInstanceOf(BrowserLaunchValidationError)
    await expect(bootstrap).rejects.toMatchObject({ message, status })
  })

  test.each([
    [500, { error: 'Database driver failed at an internal path' }],
    [403, { error: 'Unexpected upstream exception' }],
    [403, { error: '' }],
    [404, { error: { message: 'Session not found' } }],
    [503, { error: 'Unexpected upstream exception' }],
    [500, { error: 'Browser access is disabled' }],
    [200, null],
  ])('keeps unexpected response details in a diagnostic API error (%s)', async (status, payload) => {
    globalThis.fetch = vi.fn(async () => Response.json(payload, { status }))
    const bootstrap = bootstrapBrowserChannel('channel-1')
    await expect(bootstrap).rejects.toBeInstanceOf(ApiError)
    await expect(bootstrap).rejects.not.toBeInstanceOf(BrowserLaunchValidationError)
    await expect(bootstrap).rejects.toMatchObject({ status, data: payload })
  })

  test('preserves the OAuth redirect and does not resolve an unauthorized bootstrap', async () => {
    window.history.replaceState(null, '', '/web/session/session-1?view=draft#players')
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'Unauthorized activity session' }, { status: 401 }))
    let settled = false
    void bootstrapBrowserSession('session-1').then(() => { settled = true }, () => { settled = true })
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(
      '/api/auth/discord?returnTo=%2Fweb%2Fsession%2Fsession-1%3Fview%3Ddraft%23players',
    ))
    expect(settled).toBe(false)
  })

  test('treats one web navigation attempt as definitive even when noopener returns null', async () => {
    const opened: string[] = []
    window.open = ((url?: string | URL) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
    configureClientPlatform('web', 'cookie')

    await expect(openExternalLink('https://example.com/download')).resolves.toBe(true)
    expect(opened).toEqual(['https://example.com/download'])
  })
})
