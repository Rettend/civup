import { describe, expect, test } from 'bun:test'
import { buildCivBlitzModDownloadUrl } from '../src/client/lib/civblitz-mod-download'
import { cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'

describe('CivBlitz mod download URL', () => {
  test('builds an authenticated same-origin external URL', () => {
    cacheActivitySessionToken('signed-session', 3600)
    try {
      expect(buildCivBlitzModDownloadUrl('match/with spaces', 'https://activity.example')).toBe(
        'https://activity.example/api/match/match%2Fwith%20spaces/civblitz/download?activitySession=signed-session',
      )
    }
    finally {
      clearActivitySessionToken()
    }
  })
})
