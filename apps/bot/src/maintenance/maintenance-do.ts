import type { Env } from '../env.ts'
import { DurableObject } from 'cloudflare:workers'
import { MaintenanceQueue } from './maintenance-queue.ts'
import { runRankedRoleMaintenance } from './ranked-role-maintenance.ts'

export class MaintenanceDO extends DurableObject<Env['Bindings']> {
  private maintenanceQueue = new MaintenanceQueue()

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

    const pathname = new URL(request.url).pathname
    const action = pathname === '/ranked-roles/sync'
      ? 'sync'
      : pathname === '/ranked-roles/apply-pending'
        ? 'apply-pending'
        : null
    if (!action) return Response.json({ error: 'Maintenance action not found' }, { status: 404 })

    const maintenance = this.maintenanceQueue.run(() => runRankedRoleMaintenance(this.env, action))

    try {
      return Response.json(await maintenance)
    }
    catch (error) {
      console.error(`[maintenance-do] Failed to run ${action}:`, error)
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }
}
