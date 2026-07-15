import { describe, expect, test } from 'bun:test'
import { fetchActivityAdminCapabilities, NO_ACTIVITY_ADMIN_CAPABILITIES } from '../src/client/lib/admin-capabilities'

describe('Activity admin capabilities', () => {
  test('accepts explicit booleans from the authenticated capability route', async () => {
    const fetchImpl = (async () => Response.json({ autosaveCatalog: true, playerDataExport: true })) as unknown as typeof fetch
    expect(await fetchActivityAdminCapabilities(fetchImpl)).toEqual({ autosaveCatalog: true, playerDataExport: true })
  })

  test('fails closed for denied, malformed, and failed requests', async () => {
    const denied = (async () => Response.json({ error: 'Unauthorized' }, { status: 401 })) as unknown as typeof fetch
    const malformed = (async () => Response.json({ autosaveCatalog: 'yes', playerDataExport: 1 })) as unknown as typeof fetch
    const failed = (async () => { throw new Error('offline') }) as unknown as typeof fetch

    expect(await fetchActivityAdminCapabilities(denied)).toEqual(NO_ACTIVITY_ADMIN_CAPABILITIES)
    expect(await fetchActivityAdminCapabilities(malformed)).toEqual(NO_ACTIVITY_ADMIN_CAPABILITIES)
    expect(await fetchActivityAdminCapabilities(failed)).toEqual(NO_ACTIVITY_ADMIN_CAPABILITIES)
  })
})
