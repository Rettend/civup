import { activityFetch } from './activity-request'
import { buildActivitySessionHeaders } from './activity-session'

export interface ActivityAdminCapabilities {
  autosaveCatalog: boolean
  playerDataExport: boolean
}

export const NO_ACTIVITY_ADMIN_CAPABILITIES: ActivityAdminCapabilities = {
  autosaveCatalog: false,
  playerDataExport: false,
}

export async function fetchActivityAdminCapabilities(fetchImpl?: typeof fetch): Promise<ActivityAdminCapabilities> {
  try {
    const headers = { Accept: 'application/json' }
    const response = await (fetchImpl ?? activityFetch)('/api/activity/admin/capabilities', {
      cache: 'no-store',
      headers: fetchImpl ? buildActivitySessionHeaders(headers) : headers,
    })
    if (!response.ok) return NO_ACTIVITY_ADMIN_CAPABILITIES

    const payload: unknown = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return NO_ACTIVITY_ADMIN_CAPABILITIES
    const record = payload as Record<string, unknown>
    return {
      autosaveCatalog: record.autosaveCatalog === true,
      playerDataExport: record.playerDataExport === true,
    }
  } catch {
    return NO_ACTIVITY_ADMIN_CAPABILITIES
  }
}
