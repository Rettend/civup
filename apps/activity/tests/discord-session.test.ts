import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { authorize, authenticate, ready } = vi.hoisted(() => ({
  authorize: vi.fn(async () => ({ code: 'new-code' })),
  authenticate: vi.fn(async () => ({ user: { id: 'player-1', username: 'Player' } })),
  ready: vi.fn(async () => {}),
}))

vi.mock('@discord/embedded-app-sdk', () => ({
  DiscordSDK: class {
    ready = ready
    commands = { authorize, authenticate }
  },
}))
vi.mock('../src/client/lib/dev-log', () => ({ relayDevLog: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

function mockTokenExchange() {
  const fetchMock = vi.fn(async () =>
    Response.json({
      access_token: 'fresh-discord-token',
      expires_in: 604800,
      activity_session_token: 'fresh-activity-token',
      activity_session_expires_in: 28800,
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Discord session renewal', () => {
  test('forces a new exchange when Discord accepts a cached but server-rejected Activity session', async () => {
    const session = await import('../src/client/lib/activity-session')
    session.cacheActivitySessionToken('rejected-activity-token')
    window.sessionStorage.setItem(
      'civup.discord.access-token',
      JSON.stringify({
        accessToken: 'cached-discord-token',
        expiresAt: Date.now() + 604800000,
      }),
    )
    const fetchMock = mockTokenExchange()
    const { setupDiscordSdk, refreshDiscordSession } = await import('../src/client/discord')

    await setupDiscordSdk()
    expect(authenticate).toHaveBeenLastCalledWith({ access_token: 'cached-discord-token' })
    expect(fetchMock).not.toHaveBeenCalled()

    await refreshDiscordSession()
    expect(authorize).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(authenticate).toHaveBeenLastCalledWith({ access_token: 'fresh-discord-token' })
    expect(session.getActivitySessionToken()).toBe('fresh-activity-token')
  })

  test('does not reuse an in-memory authenticated user after the Activity token expires', async () => {
    vi.useFakeTimers()
    const fetchMock = mockTokenExchange()
    const { setupDiscordSdk } = await import('../src/client/discord')
    await setupDiscordSdk()
    vi.advanceTimersByTime(8 * 60 * 60 * 1000)
    await setupDiscordSdk()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  test('does not retain a previous user or new tokens after renewed SDK authentication fails', async () => {
    vi.useFakeTimers()
    const fetchMock = mockTokenExchange()
    const { setupDiscordSdk } = await import('../src/client/discord')
    const session = await import('../src/client/lib/activity-session')
    await setupDiscordSdk()
    vi.advanceTimersByTime(8 * 60 * 60 * 1000)
    authenticate.mockRejectedValueOnce(new Error('SDK authentication failed'))

    await expect(setupDiscordSdk()).rejects.toThrow('SDK authentication failed')
    expect(session.getActivitySessionToken()).toBeNull()
    expect(window.sessionStorage.getItem('civup.discord.access-token')).toBeNull()
    await expect(setupDiscordSdk()).resolves.toMatchObject({ user: { id: 'player-1' } })
    expect(authenticate).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('can sign in when storage reads and writes are blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    mockTokenExchange()
    const { setupDiscordSdk } = await import('../src/client/discord')
    await expect(setupDiscordSdk()).resolves.toMatchObject({ user: { id: 'player-1' } })
    const session = await import('../src/client/lib/activity-session')
    expect(session.getActivitySessionToken()).toBe('fresh-activity-token')
  })
})
