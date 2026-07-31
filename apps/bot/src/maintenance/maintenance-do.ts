import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { DurableObject } from 'cloudflare:workers'
import { resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { MaintenanceQueue } from './maintenance-queue.ts'
import { generateCivBlitzModResponse } from './civblitz-maintenance.ts'
import { runRankedRoleMaintenance } from './ranked-role-maintenance.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { refreshDirtyLeaderboards } from '../services/leaderboard/message.ts'
import { createStatsContext } from '../services/stats/context.ts'

const LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS = 15 * 60 * 1000

export class MaintenanceDO extends DurableObject<Env['Bindings']> {
  private maintenanceQueue = new MaintenanceQueue()

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

    const pathname = new URL(request.url).pathname
    if (pathname === '/civblitz/generate') {
      let input: unknown
      try {
        input = await request.json()
      }
      catch {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 })
      }
      return this.runResponse('CivBlitz mod generation', async () => generateCivBlitzModResponse(input))
    }

    if (pathname === '/leaderboards/refresh') {
      return this.runMaintenance('leaderboard refresh', async () => ({
        refreshed: await this.refreshConfiguredGuildLeaderboards(),
      }))
    }

    const action = pathname === '/ranked-roles/sync'
      ? 'sync'
      : pathname === '/ranked-roles/apply-pending'
        ? 'apply-pending'
        : null
    if (!action) return Response.json({ error: 'Maintenance action not found' }, { status: 404 })

    return this.runMaintenance(action, () => runRankedRoleMaintenance(this.env, action))
  }

  private async refreshConfiguredGuildLeaderboards(): Promise<boolean> {
    const config = resolveApprovedDiscordGuildConfiguration(this.env)
    if (!config.ok) throw new Error(`Approved Discord server configuration is invalid: ${config.error}`)
    const db = createDb(this.env.DB)
    const kv = getKvStore(this.env)
    let refreshed = false
    for (const guildId of config.guildIds) {
      try {
        refreshed = await refreshDirtyLeaderboards(db, kv, this.env.DISCORD_TOKEN, {
          channelScope: { guildId, legacyGuildId: config.primaryGuildId },
          statsContext: createStatsContext(guildId, config.primaryGuildId),
          minDirtyAgeMs: LEADERBOARD_REFRESH_MIN_DIRTY_AGE_MS,
          playerModeLimit: 1,
        }) || refreshed
      }
      catch (error) {
        console.error(`[maintenance-do] Failed to refresh leaderboards for guild ${guildId}:`, error)
      }
    }
    return refreshed
  }

  private async runMaintenance<T>(label: string, task: () => Promise<T>): Promise<Response> {
    return this.runResponse(label, async () => Response.json(await task()))
  }

  private async runResponse(label: string, task: () => Promise<Response>): Promise<Response> {
    const maintenance = this.maintenanceQueue.run(task)

    try {
      return await maintenance
    }
    catch (error) {
      console.error(`[maintenance-do] Failed to run ${label}:`, error)
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }
}
