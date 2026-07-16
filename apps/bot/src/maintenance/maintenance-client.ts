import type { RankedRoleMaintenanceAction, RankedRoleMaintenanceResult } from './ranked-role-maintenance.ts'

const MAINTENANCE_OBJECT_NAME = 'global'

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
