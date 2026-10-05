import type { Env } from '../env.ts'
import type { DivisionRolePreparation } from '../services/ranked/division-role-preparation.ts'
import { DurableObject } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { createDb, divisionRankPolicies } from '@civup/db'
import { getKvStore } from '../services/kv/batch.ts'
import { refreshDirtyLeaderboards } from '../services/leaderboard/message.ts'
import { nextDivisionWakeAt } from '../services/ranked/division-projection.ts'
import {
  activateDivisionRanks,
  calculateDueDivisionRanks,
  captureDivisionRanks,
  divisionRankStatus,
  getDivisionRankPolicy,
  maintainDivisionRanks,
  scanDivisionMembers,
  scopeDivisionMemberships,
  stageDivisionRanks,
} from '../services/ranked/division-rank-runtime.ts'
import { refreshRankedPopulation } from '../services/ranked/division-refresh.ts'
import {
  divisionRolePreparationKey,
  prepareDivisionRoles,
  resolveDivisionRoleCreation,
} from '../services/ranked/division-role-preparation.ts'
import { getRankedRoleConfig } from '../services/ranked/roles.ts'
import { generateCivBlitzModResponse } from './civblitz-maintenance.ts'
import { DIVISION_MAINTENANCE_PROTOCOL } from './division-protocol.ts'
import { MaintenanceQueue } from './maintenance-queue.ts'
import { runRankedRoleMaintenance } from './ranked-role-maintenance.ts'

export class MaintenanceDO extends DurableObject<Env['Bindings']> {
  private maintenanceQueue = new MaintenanceQueue()

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

    const pathname = new URL(request.url).pathname
    if (pathname === '/ranked-roles/wake') {
      const body = await request.json<{ guildId?: string }>()
      if (!body.guildId || (this.env.ALLOWED_DISCORD_GUILD_ID && body.guildId !== this.env.ALLOWED_DISCORD_GUILD_ID))
        return Response.json({ error: 'Invalid guild.' }, { status: 400 })
      return this.runMaintenance('division wake', async () => {
        const policy = await getDivisionRankPolicy(createDb(this.env.DB), body.guildId!)
        if (policy?.phase !== 'active') return { scheduled: false }
        await this.ctx.storage.put(`division-alarm:${body.guildId}`, true)
        const alarm = await this.ctx.storage.getAlarm()
        if (alarm == null || alarm > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 1000)
        return { scheduled: true }
      })
    }
    if (pathname === '/ranked-roles/division-policy') {
      const guildId = this.env.ALLOWED_DISCORD_GUILD_ID
      if (!guildId) return Response.json({ error: 'A configured guild is required.' }, { status: 409 })
      const body = await request.json<{ action?: string; digest?: string; at?: number }>().catch(() => null)
      return this.runMaintenance('division policy', async () => {
        const db = createDb(this.env.DB)
        if (body?.action === 'status')
          return {
            ...(await divisionRankStatus(db, guildId)),
            runtimeProtocol: DIVISION_MAINTENANCE_PROTOCOL,
            preparation: (await this.ctx.storage.get(divisionRolePreparationKey(guildId))) ?? null,
          }
        if (body?.action === 'stage') {
          const preparation = await this.ctx.storage.get<DivisionRolePreparation>(divisionRolePreparationKey(guildId))
          if (!preparation) throw new Error('Prepare division roles first.')
          return stageDivisionRanks(db, this.env.KV, preparation)
        }
        const policy = await getDivisionRankPolicy(db, guildId)
        if (!policy) throw new Error('Stage the policy first.')
        if (body?.action === 'scope') return scopeDivisionMemberships(db, this.env.KV, policy)
        if (body?.action === 'scan')
          return {
            ...(await scanDivisionMembers(db, this.env.DISCORD_TOKEN, policy)),
            ...(await divisionRankStatus(db, guildId)),
          }
        if (body?.action === 'capture') return captureDivisionRanks(db, guildId)
        if (body?.action === 'refresh-ranked') {
          const result = await refreshRankedPopulation(db, this.env.KV, policy)
          await this.armDivisionGuild(guildId)
          return result
        }
        if (body?.action === 'calculate') {
          if (policy.phase === 'active') throw new Error('Use apply after activating the policy.')
          const result = await calculateDueDivisionRanks(db, policy, Date.now())
          return { ...result, ...(await divisionRankStatus(db, guildId)) }
        }
        if (body?.action === 'activate')
          return activateDivisionRanks(
            db,
            this.env.KV,
            this.env.DISCORD_TOKEN,
            guildId,
            this.env.DISCORD_APPLICATION_ID,
            body.digest ?? '',
          )
        if (body?.action === 'apply')
          return {
            ...(await maintainDivisionRanks(db, this.env.KV, this.env.DISCORD_TOKEN, policy)),
            ...(await divisionRankStatus(db, guildId)),
          }
        throw new Error('Unsupported division policy action.')
      })
    }
    if (
      pathname === '/ranked-roles/prepare-divisions' ||
      pathname === '/ranked-roles/division-status' ||
      pathname === '/ranked-roles/resolve-division-creation'
    ) {
      const guildId = this.env.ALLOWED_DISCORD_GUILD_ID
      if (!guildId) return Response.json({ error: 'A configured guild is required.' }, { status: 409 })
      return this.runMaintenance('division role preparation', async () => {
        if (pathname.endsWith('/division-status'))
          return { preparation: (await this.ctx.storage.get(divisionRolePreparationKey(guildId))) ?? null }
        if (pathname.endsWith('/resolve-division-creation')) {
          const body = await request.json<{ roleId?: string }>().catch(() => null)
          if (!body?.roleId || !/^\d{17,20}$/.test(body.roleId)) throw new Error('Supply the reviewed role ID.')
          return resolveDivisionRoleCreation({
            store: this.ctx.storage,
            token: this.env.DISCORD_TOKEN,
            guildId,
            roleId: body.roleId,
          })
        }
        return prepareDivisionRoles({
          store: this.ctx.storage,
          kv: this.env.KV,
          token: this.env.DISCORD_TOKEN,
          guildId,
          botUserId: this.env.DISCORD_APPLICATION_ID,
          config: await getRankedRoleConfig(this.env.KV, guildId),
        })
      })
    }
    if (pathname === '/civblitz/generate') {
      let input: unknown
      try {
        input = await request.json()
      } catch {
        return Response.json({ error: 'Invalid JSON payload' }, { status: 400 })
      }
      return this.runResponse('CivBlitz mod generation', async () => generateCivBlitzModResponse(input))
    }

    if (pathname === '/leaderboards/refresh') {
      return this.runMaintenance('leaderboard refresh', async () => ({
        refreshed: await refreshDirtyLeaderboards(createDb(this.env.DB), getKvStore(this.env), this.env.DISCORD_TOKEN, {
          playerModeLimit: 1,
        }),
      }))
    }

    const action =
      pathname === '/ranked-roles/sync' ? 'sync' : pathname === '/ranked-roles/apply-pending' ? 'apply-pending' : null
    if (!action) return Response.json({ error: 'Maintenance action not found' }, { status: 404 })

    return this.runMaintenance(action, async () => {
      const result = await runRankedRoleMaintenance(this.env, action)
      // Existing maintenance recovers lost notifications using indexed pending/deadline work.
      const policies = await createDb(this.env.DB)
        .select()
        .from(divisionRankPolicies)
        .where(eq(divisionRankPolicies.phase, 'active'))
      for (const policy of policies) if (policy.phase === 'active') await this.armDivisionGuild(policy.guildId)
      return result
    })
  }

  private async runMaintenance<T>(label: string, task: () => Promise<T>): Promise<Response> {
    return this.runResponse(label, async () => Response.json(await task()))
  }

  override async alarm(): Promise<void> {
    await this.maintenanceQueue.run(async () => {
      const guilds = await this.ctx.storage.list<boolean>({ prefix: 'division-alarm:' })
      let next: number | null = null
      for (const key of guilds.keys()) {
        const guildId = key.slice('division-alarm:'.length),
          db = createDb(this.env.DB)
        const policy = await getDivisionRankPolicy(db, guildId)
        if (policy?.phase !== 'active') {
          await this.ctx.storage.delete(key)
          continue
        }
        const result = await maintainDivisionRanks(db, this.env.KV, this.env.DISCORD_TOKEN, policy)
        const due = result.blocked ? Date.now() + 30_000 : await nextDivisionWakeAt(db, guildId)
        if (due != null) next = next == null ? due : Math.min(next, due)
        else await this.ctx.storage.delete(key)
      }
      if (next != null) await this.ctx.storage.setAlarm(next)
    })
  }

  private async armDivisionGuild(guildId: string) {
    const next = await nextDivisionWakeAt(createDb(this.env.DB), guildId)
    if (next == null) return
    await this.ctx.storage.put(`division-alarm:${guildId}`, true)
    const current = await this.ctx.storage.getAlarm()
    if (current == null || current > next) await this.ctx.storage.setAlarm(next)
  }

  private async runResponse(label: string, task: () => Promise<Response>): Promise<Response> {
    const maintenance = this.maintenanceQueue.run(task)

    try {
      return await maintenance
    } catch (error) {
      console.error(`[maintenance-do] Failed to run ${label}:`, error)
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }
}
