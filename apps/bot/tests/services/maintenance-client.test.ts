import type { RankedRoleMaintenanceResult } from '../../src/maintenance/ranked-role-maintenance.ts'
import { describe, expect, test } from 'bun:test'
import { cron_ranked_roles } from '../../src/cron/cleanup.ts'
import { requestCivBlitzModArchive, requestLeaderboardMaintenance, requestRankedRoleMaintenance } from '../../src/maintenance/maintenance-client.ts'

describe('maintenance client', () => {
  test('builds the maintenance object requests for each operation', async () => {
    const objectNames: string[] = []
    const requests: Request[] = []
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
        objectNames.push(name)
        return { name }
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init)
            requests.push(request)
            if (new URL(request.url).pathname === '/civblitz/generate') {
              return new Response(new Uint8Array([0x50, 0x4B]), { headers: { 'Content-Type': 'application/zip' } })
            }
            if (new URL(request.url).pathname === '/leaderboards/refresh') return Response.json({ refreshed: true })
            return Response.json(result)
          },
        }
      },
    } as unknown as DurableObjectNamespace

    await expect(requestRankedRoleMaintenance(namespace, 'apply-pending')).resolves.toEqual(result)
    await expect(requestLeaderboardMaintenance(namespace)).resolves.toEqual({ refreshed: true })
    const civBlitzInput = {
      matchId: 'match-1',
      leaderDataVersion: 'live' as const,
      excludeBbgExpanded: true,
      seats: [],
    }
    const response = await requestCivBlitzModArchive(namespace, civBlitzInput)

    expect(objectNames).toEqual(['global', 'global', 'civblitz:match-1'])
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/ranked-roles/apply-pending',
      '/leaderboards/refresh',
      '/civblitz/generate',
    ])
    expect(requests.every(request => request.method === 'POST')).toBe(true)
    expect(await requests[2]?.json()).toEqual(civBlitzInput)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
  })

  test('requires the maintenance binding', async () => {
    await expect(requestRankedRoleMaintenance(undefined, 'sync')).rejects.toThrow('MaintenanceDO binding is required')
    await expect(requestLeaderboardMaintenance(undefined)).rejects.toThrow('MaintenanceDO binding is required')
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
