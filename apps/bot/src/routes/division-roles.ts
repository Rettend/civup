import type { Env } from '../env.ts'
import type { Hono } from 'hono'
import { DIVISION_MAINTENANCE_PROTOCOL } from '../maintenance/division-protocol.ts'
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'

export function registerDivisionRoleRoutes(app: Hono<Env>) {
  app.post('/api/activity/admin/division-roles', async c => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    const body = await c.req
      .json<{ action?: string; roleId?: string; digest?: string; at?: number }>()
      .catch(() => null)
    if (
      !body?.action ||
      ![
        'prepare',
        'status',
        'resolve-creation',
        'stage',
        'scan',
        'scope',
        'capture',
        'calculate',
        'activate',
        'apply',
        'refresh-ranked',
      ].includes(body.action)
    )
      return c.json({ error: 'Unsupported division maintenance action.' }, 400)
    const namespace = c.env.MaintenanceDO
    if (!namespace) return c.json({ error: 'Maintenance runtime is required.' }, 503)
    const path =
      body.action === 'prepare'
        ? 'prepare-divisions'
        : body.action === 'resolve-creation'
          ? 'resolve-division-creation'
          : 'division-policy'
    const task = namespace.get(namespace.idFromName('global')).fetch(
      new Request(`https://maintenance.local/ranked-roles/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: body.action, roleId: body.roleId, digest: body.digest, at: body.at }),
      }),
    )
    c.executionCtx.waitUntil(task.then(() => {}))
    const response = await task
    if (body.action !== 'status' || !response.ok) return response
    return c.json({ ...(await response.json<Record<string, unknown>>()), routeProtocol: DIVISION_MAINTENANCE_PROTOCOL })
  })
}
