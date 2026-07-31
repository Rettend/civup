import type { RankedRoleMaintenanceAction, RankedRoleMaintenanceResult } from './ranked-role-maintenance.ts'
import type { CivBlitzModInput } from '@civup/civ6-mod'

const MAINTENANCE_OBJECT_NAME = 'global'

export interface LeaderboardMaintenanceResult {
  refreshed: boolean
}

export async function requestLeaderboardMaintenance(
  namespace: DurableObjectNamespace | null | undefined,
): Promise<LeaderboardMaintenanceResult> {
  if (!namespace) throw new Error('MaintenanceDO binding is required')

  const stub = namespace.get(namespace.idFromName(MAINTENANCE_OBJECT_NAME))
  const response = await stub.fetch(new Request('https://maintenance.local/leaderboards/refresh', { method: 'POST' }))
  if (!response.ok) {
    throw new Error(`Leaderboard maintenance failed: ${response.status} ${await response.text()}`)
  }

  const result = await response.json<LeaderboardMaintenanceResult>()
  if (typeof result.refreshed !== 'boolean') throw new Error('Leaderboard maintenance returned an invalid response')
  return result
}

export async function requestCivBlitzModArchive(
  namespace: DurableObjectNamespace | null | undefined,
  input: CivBlitzModInput,
): Promise<Response> {
  if (!namespace) throw new Error('MaintenanceDO binding is required')

  const stub = namespace.get(namespace.idFromName(`civblitz:${input.matchId}`))
  return stub.fetch(new Request('https://maintenance.local/civblitz/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function requestRankedRoleMaintenance(
  namespace: DurableObjectNamespace | null | undefined,
  action: RankedRoleMaintenanceAction,
): Promise<RankedRoleMaintenanceResult> {
  if (!namespace) throw new Error('MaintenanceDO binding is required')

  const stub = namespace.get(namespace.idFromName(MAINTENANCE_OBJECT_NAME))
  const response = await stub.fetch(new Request(`https://maintenance.local/ranked-roles/${action}`, { method: 'POST' }))
  if (!response.ok) {
    throw new Error(`Ranked role maintenance ${action} failed: ${response.status} ${await response.text()}`)
  }

  const result = await response.json<RankedRoleMaintenanceResult>()
  if (result.action !== action || typeof result.guilds !== 'number' || typeof result.pendingDiscordChanges !== 'number') {
    throw new Error(`Ranked role maintenance ${action} returned an invalid response`)
  }
  return result
}
