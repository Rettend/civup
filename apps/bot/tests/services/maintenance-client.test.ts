import type { RankedRoleMaintenanceResult } from '../../src/maintenance/ranked-role-maintenance.ts'
import { describe, expect, test } from 'bun:test'
import { cron_ranked_roles } from '../../src/cron/cleanup.ts'
import { requestRankedRoleMaintenance } from '../../src/maintenance/maintenance-client.ts'

describe('maintenance client', () => {
  test('routes ranked role work through the global maintenance object', async () => {
    let objectName: string | null = null
    let capturedRequest: Request | null = null
    const result: RankedRoleMaintenanceResult = {
      action: 'apply-pending',
      guilds: 1,
      qualifiedPlayers: 0,
      attemptedDiscordChanges: 1,
      appliedDiscordChanges: 1,
      pendingDiscordChanges: 0,
      elapsedMs: 12,
    }
    const namespace = {
      idFromName(name: string) {
        objectName = name
        return { name }
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            capturedRequest = input instanceof Request ? input : new Request(input, init)
            return Response.json(result)
          },
        }
      },
    } as unknown as DurableObjectNamespace

    await expect(requestRankedRoleMaintenance(namespace, 'apply-pending')).resolves.toEqual(result)
    expect(objectName).toBe('global')
    expect(capturedRequest?.method).toBe('POST')
    expect(new URL(capturedRequest?.url ?? '').pathname).toBe('/ranked-roles/apply-pending')
  })

  test('requires the maintenance binding', async () => {
    await expect(requestRankedRoleMaintenance(undefined, 'sync')).rejects.toThrow('MaintenanceDO binding is required')
  })

  test('uses one trigger for the daily sync and ten retries', async () => {
    const actions: string[] = []
    const namespace = {
      idFromName() {
        return {}
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL) {
            const action = new URL(input instanceof Request ? input.url : input.toString()).pathname.split('/').at(-1) ?? ''
            actions.push(action)
            return Response.json({
              action,
              guilds: 0,
              qualifiedPlayers: 0,
              attemptedDiscordChanges: 0,
              appliedDiscordChanges: 0,
              pendingDiscordChanges: 0,
              elapsedMs: 0,
            })
          },
        }
      },
    } as unknown as DurableObjectNamespace

    expect(cron_ranked_roles.cron).toBe('0 0,2,4,6,8,10,12,14,16,18,20 * * *')
    await cron_ranked_roles.handler({
      env: { MaintenanceDO: namespace },
      interaction: { scheduledTime: Date.UTC(2026, 6, 16, 0) },
    } as any)
    await cron_ranked_roles.handler({
      env: { MaintenanceDO: namespace },
      interaction: { scheduledTime: Date.UTC(2026, 6, 16, 2) },
    } as any)

    expect(actions).toEqual(['sync', 'apply-pending'])
  })
})
