import { afterEach, describe, expect, test } from 'bun:test'
import { openCivBlitzModDownload, requestCivBlitzModDownloadUrl } from '../src/client/lib/civblitz-mod-download'
import { cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'
import { configureClientPlatform } from '../src/client/platform/runtime'

const originalFetch = globalThis.fetch
const originalOpen = window.open

afterEach(() => {
  globalThis.fetch = originalFetch
  window.open = originalOpen
  clearActivitySessionToken()
  configureClientPlatform('discord-embedded', 'token')
})

describe('CivBlitz mod download URL', () => {
  test('exchanges the activity session for a match-scoped download ticket', async () => {
    cacheActivitySessionToken('signed-session', 3600)
    try {
      const requests: Request[] = []
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(new URL(String(input), 'https://activity.example'), init))
        return Response.json({ ticket: 'short-lived-ticket', expiresIn: 120 })
      }) as typeof fetch

      expect(await requestCivBlitzModDownloadUrl('match/with spaces', fetchImpl, 'https://activity.example')).toBe(
        'https://activity.example/api/match/match%2Fwith%20spaces/civblitz/download?civBlitzDownloadTicket=short-lived-ticket',
      )
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.headers.get('X-CivUp-Activity-Session')).toBe('signed-session')
      expect(new URL(requests[0]!.url).pathname).toBe('/api/match/match%2Fwith%20spaces/civblitz/download-ticket')
    }
    finally {
      clearActivitySessionToken()
    }
  })

  test('opens cookie-authenticated web downloads synchronously without exchanging a ticket', async () => {
    const opened: string[] = []
    globalThis.fetch = (async () => {
      throw new Error('Web download unexpectedly fetched a ticket')
    }) as unknown as typeof fetch
    window.open = ((url?: string | URL) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
    configureClientPlatform('web', 'cookie')

    const opening = openCivBlitzModDownload('match/web')
    expect(opened).toEqual(['http://localhost/api/match/match%2Fweb/civblitz/download'])
    await opening
  })
})
