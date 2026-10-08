import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError, CIVUP_ACTIVITY_SESSION_HEADER } from '@civup/utils'
import {
  activityApiGet,
  activityApiPost,
  activityFetch,
  configureActivitySessionRenewal,
} from '../src/client/lib/activity-request'
import {
  cacheActivitySessionToken,
  clearActivitySessionToken,
  getActivitySessionToken,
} from '../src/client/lib/activity-session'
import { uploadAutosaveMultipart } from '../src/client/lib/autosave-upload'
import { configureClientPlatform } from '../src/client/platform/runtime'

function rejectedSession() {
  return Response.json(
    { error: 'Reopen the activity to sign in again.' },
    {
      status: 401,
      headers: { 'X-CivUp-Activity-Session-Rejected': '1' },
    },
  )
}

beforeEach(() => {
  configureClientPlatform('discord-embedded', 'token')
  clearActivitySessionToken()
})

afterEach(() => {
  configureActivitySessionRenewal(null)
  clearActivitySessionToken()
  vi.useRealTimers()
})

describe('Activity request recovery', () => {
  test('renews after a long idle period before submitting a result', async () => {
    vi.useFakeTimers()
    cacheActivitySessionToken('old-token')
    vi.advanceTimersByTime(8 * 60 * 60 * 1000)
    const renew = vi.fn(async () => cacheActivitySessionToken('new-token'))
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(CIVUP_ACTIVITY_SESSION_HEADER)).toBe('new-token')
      return Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(activityApiPost('/api/match/match-1/report', { placements: ['player-1'] })).resolves.toEqual({
      ok: true,
    })
    expect(renew).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('replaces a rejected cached token and retries the same result once', async () => {
    cacheActivitySessionToken('reopened-stale-token')
    const renew = vi.fn(async () => cacheActivitySessionToken('new-token'))
    configureActivitySessionRenewal(renew)
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(init)
        return requests.length === 1 ? rejectedSession() : Response.json({ ok: true })
      }),
    )

    const body = { placements: ['player-1', 'player-2'] }
    await expect(activityApiPost('/api/match/match-1/report', body)).resolves.toEqual({ ok: true })
    expect(renew).toHaveBeenCalledOnce()
    expect(requests.map(request => new Headers(request.headers).get(CIVUP_ACTIVITY_SESSION_HEADER))).toEqual([
      'reopened-stale-token',
      'new-token',
    ])
    expect(requests.map(request => request.body)).toEqual([JSON.stringify(body), JSON.stringify(body)])
  })

  test('shares renewal across simultaneous rejections including a late old response', async () => {
    cacheActivitySessionToken('old-token')
    let releaseLateResponse!: () => void
    const lateResponse = new Promise<void>(resolve => {
      releaseLateResponse = resolve
    })
    const renew = vi.fn(async () => cacheActivitySessionToken('new-token'))
    configureActivitySessionRenewal(renew)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const token = new Headers(init.headers).get(CIVUP_ACTIVITY_SESSION_HEADER)
        if (token === 'new-token') return Response.json({ ok: true })
        if (url === '/late') await lateResponse
        return rejectedSession()
      }),
    )

    const first = activityApiGet('/first')
    const second = activityApiGet('/second')
    const late = activityApiGet('/late')
    await Promise.all([first, second])
    releaseLateResponse()
    await late
    expect(renew).toHaveBeenCalledOnce()
  })

  test('does not repeatedly retry a newly rejected token', async () => {
    cacheActivitySessionToken('old-token')
    const renew = vi.fn(async () => cacheActivitySessionToken('new-token'))
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async () => rejectedSession())
    vi.stubGlobal('fetch', fetchMock)

    await expect(activityApiPost('/report', {})).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(renew).toHaveBeenCalledOnce()
  })

  test.each([401, 403, 500])('never replays downstream failures (%s)', async status => {
    cacheActivitySessionToken('valid-token')
    const renew = vi.fn()
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async () => Response.json({ error: 'Action failed' }, { status }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(activityApiPost('/report', {})).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(renew).not.toHaveBeenCalled()
  })

  test('never replays an ambiguous network failure', async () => {
    cacheActivitySessionToken('valid-token')
    const renew = vi.fn()
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Network failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(activityApiPost('/report', {})).rejects.toThrow('Network failed')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(renew).not.toHaveBeenCalled()
  })

  test('keeps cookie requests free of embedded credentials and renewal', async () => {
    configureClientPlatform('web', 'cookie')
    cacheActivitySessionToken('embedded-token')
    const renew = vi.fn()
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).has(CIVUP_ACTIVITY_SESSION_HEADER)).toBe(false)
      return rejectedSession()
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(activityApiGet('/browser')).rejects.toMatchObject({ status: 401 })
    expect(renew).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('raw uploads rebuild headers while preserving their body on auth retry', async () => {
    cacheActivitySessionToken('old-token')
    configureActivitySessionRenewal(async () => cacheActivitySessionToken('new-token'))
    const body = new Blob(['saved game'])
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.body).toBe(body)
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream')
      return new Headers(init.headers).get(CIVUP_ACTIVITY_SESSION_HEADER) === 'old-token'
        ? rejectedSession()
        : new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await activityFetch('/upload', {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(response.status).toBe(204)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('failed renewal clears the rejected token and allows a later attempt', async () => {
    cacheActivitySessionToken('old-token')
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord unavailable'))
      .mockImplementationOnce(async () => cacheActivitySessionToken('new-token'))
    configureActivitySessionRenewal(renew)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) =>
        new Headers(init.headers).get(CIVUP_ACTIVITY_SESSION_HEADER) === 'old-token'
          ? rejectedSession()
          : Response.json({ ok: true }),
      ),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(activityApiGet('/match')).rejects.toThrow('Reopen the activity to sign in again.')
    expect(getActivitySessionToken()).toBeNull()
    await expect(activityApiGet('/match')).resolves.toEqual({ ok: true })
    expect(renew).toHaveBeenCalledTimes(2)
  })

  test('upload completion and cleanup do not repeat failed sign-in renewal', async () => {
    cacheActivitySessionToken('old-token')
    const renew = vi.fn(async () => {
      throw new Error('Discord unavailable')
    })
    configureActivitySessionRenewal(renew)
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/parts/1') ? Response.json({ partNumber: 1, etag: 'etag-1' }) : rejectedSession(),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      uploadAutosaveMultipart({
        file: new Blob(['save']),
        uploadId: 'upload-1',
        partSizeBytes: 100,
      }),
    ).rejects.toThrow('Reopen the activity to sign in again.')
    expect(renew).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/uploads/autosaves/upload-1/parts/1',
      '/api/uploads/autosaves/upload-1/complete',
    ])
  })

  test('retains credentials when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    cacheActivitySessionToken('memory-token')
    expect(getActivitySessionToken()).toBe('memory-token')
    clearActivitySessionToken()
    expect(getActivitySessionToken()).toBeNull()
  })
})
