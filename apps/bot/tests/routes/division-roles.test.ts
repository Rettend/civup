import type { Env } from '../../src/env.ts'
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { DIVISION_MAINTENANCE_PROTOCOL } from '../../src/maintenance/division-protocol.ts'
import { registerDivisionRoleRoutes } from '../../src/routes/division-roles.ts'

test('division maintenance refuses unsigned, non-admin, and other-guild requests before accessing the runtime', async () => {
  const app = new Hono<Env>()
  registerDivisionRoleRoutes(app)
  const env = { CIVUP_SECRET: 'test-secret', ALLOWED_DISCORD_GUILD_ID: '123456789012345678' } as Env['Bindings']
  const headers = {
    'Content-Type': 'application/json',
    [CIVUP_INTERNAL_SECRET_HEADER]: 'test-secret',
    [CIVUP_ACTIVITY_USER_ID_HEADER]: '123456789012345679',
    [CIVUP_ACTIVITY_GUILD_ID_HEADER]: env.ALLOWED_DISCORD_GUILD_ID,
    [CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER]: '8',
  }
  const request = (overrides: Record<string, string>, action = 'prepare') =>
    app.request(
      '/api/activity/admin/division-roles',
      {
        method: 'POST',
        headers: { ...headers, ...overrides },
        body: JSON.stringify({ action }),
      },
      env,
    )
  expect((await request({ [CIVUP_INTERNAL_SECRET_HEADER]: 'wrong' })).status).toBe(401)
  expect((await request({ [CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER]: '0' })).status).toBe(403)
  expect((await request({ [CIVUP_ACTIVITY_GUILD_ID_HEADER]: '123456789012345680' })).status).toBe(403)
  expect((await request({}, 'unknown')).status).toBe(400)
})

test('status distinguishes HTTP-route readiness from runtime readiness, and scope reaches the serialized owner', async () => {
  const app = new Hono<Env>()
  registerDivisionRoleRoutes(app)
  const forwarded: Array<{ path: string; body: unknown }> = []
  const work: Promise<unknown>[] = []
  const env = {
    CIVUP_SECRET: 'test-secret',
    ALLOWED_DISCORD_GUILD_ID: '123456789012345678',
    MaintenanceDO: {
      idFromName(name: string) {
        expect(name).toBe('global')
        return name
      },
      get() {
        return {
          async fetch(request: Request) {
            const body = await request.json<{ action: string }>()
            forwarded.push({ path: new URL(request.url).pathname, body })
            return Response.json(
              body.action === 'status'
                ? { phase: 'prepared', runtimeProtocol: 'older-runtime' }
                : { pendingRoles: 807 },
            )
          },
        }
      },
    },
  } as unknown as Env['Bindings']
  const headers = {
    'Content-Type': 'application/json',
    [CIVUP_INTERNAL_SECRET_HEADER]: 'test-secret',
    [CIVUP_ACTIVITY_USER_ID_HEADER]: '123456789012345679',
    [CIVUP_ACTIVITY_GUILD_ID_HEADER]: env.ALLOWED_DISCORD_GUILD_ID,
    [CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER]: '8',
  }
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      work.push(promise)
    },
    passThroughOnException() {},
  } as ExecutionContext
  const status = await app.request(
    '/api/activity/admin/division-roles',
    { method: 'POST', headers, body: JSON.stringify({ action: 'status' }) },
    env,
    ctx,
  )
  expect(await status.json()).toEqual({
    phase: 'prepared',
    runtimeProtocol: 'older-runtime',
    routeProtocol: DIVISION_MAINTENANCE_PROTOCOL,
  })
  const scope = await app.request(
    '/api/activity/admin/division-roles',
    { method: 'POST', headers, body: JSON.stringify({ action: 'scope' }) },
    env,
    ctx,
  )
  expect(scope.status).toBe(200)
  expect(await scope.json()).toEqual({ pendingRoles: 807 })
  expect(forwarded).toEqual([
    { path: '/ranked-roles/division-policy', body: { action: 'status' } },
    { path: '/ranked-roles/division-policy', body: { action: 'scope' } },
  ])
  await Promise.all(work)
})
