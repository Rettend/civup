import type { Env } from '../../src/env.ts'
import { describe, expect, test } from 'bun:test'
import { EXPECTED_GUILD_COMMANDS } from '../../src/commands/expected.ts'
import { formatHealthReport, runHealthChecks } from '../../src/services/health.ts'

const APPLICATION_ID = '111111111111111111'
const GUILD_ID = '222222222222222222'
const PUBLIC_KEY = 'a'.repeat(64)
const ENDPOINT = 'https://bot.example.com/'
const ACTIVITY_ORIGIN = 'https://activity.example.com'
const FAILURE_SECRET = 'sentinel-health-check-secret'

describe('/admin health checks', () => {
  test('reports successful required and optional checks', async () => {
    const results = await runHealthChecks(createEnv(), { fetch: createFetch(), interactionEndpointUrl: ENDPOINT })
    expect(results.every(result => result.status === 'OK')).toBe(true)
    expect(formatHealthReport(results)).toContain('OK Discord application')
  })

  test('warns when optional R2 uploads are disabled', async () => {
    const results = await runHealthChecks(createEnv({ AUTOSAVE_UPLOADS: undefined }), { fetch: createFetch(), interactionEndpointUrl: ENDPOINT })
    expect(results.find(result => result.name === 'Saved game uploads')).toEqual({
      name: 'Saved game uploads', status: 'WARN', reason: 'disabled',
    })
  })

  test('reports Discord mismatch and Activity HTTP failures', async () => {
    const fetchMock = createFetch({ applicationId: '999999999999999999', activityStatus: 503 })
    const results = await runHealthChecks(createEnv(), { fetch: fetchMock, interactionEndpointUrl: ENDPOINT })
    expect(results.find(result => result.name === 'Discord application')).toEqual({
      name: 'Discord application', status: 'FAIL', reason: 'application ID does not match',
    })
    expect(results.find(result => result.name === 'Activity')).toEqual({
      name: 'Activity', status: 'FAIL', reason: 'HTTP 503',
    })
  })

  test('reports Discord HTTP status without exposing arbitrary errors', async () => {
    const results = await runHealthChecks(createEnv(), {
      fetch: createFetch({ discordApplicationStatus: 401 }), interactionEndpointUrl: ENDPOINT,
    })

    expect(results.find(result => result.name === 'Discord application')).toEqual({
      name: 'Discord application', status: 'FAIL', reason: 'Discord HTTP 401',
    })
  })

  test('renders unexpected failures concisely without leaking error details', async () => {
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error(`database failure\n${FAILURE_SECRET}`)
          },
        }),
      }),
    } as unknown as D1Database
    const results = await runHealthChecks(createEnv({ DB: failingDb }), {
      fetch: createFetch(), interactionEndpointUrl: ENDPOINT,
    })
    const report = formatHealthReport(results)

    expect(results.find(result => result.name === 'D1')).toEqual({
      name: 'D1', status: 'FAIL', reason: 'check failed',
    })
    expect(report.split('\n').find(line => line.startsWith('FAIL D1'))).toBe('FAIL D1 — check failed')
    expect(report).not.toContain(FAILURE_SECRET)
    expect(report).not.toContain('database failure')
  })

  test('fails config health when the primary guild setting is missing', async () => {
    const results = await runHealthChecks(createEnv({
      ALLOWED_DISCORD_GUILD_ID: undefined,
      ALLOWED_DISCORD_GUILD_IDS: GUILD_ID,
    }), { fetch: createFetch(), interactionEndpointUrl: ENDPOINT })

    expect(results.find(result => result.name === 'Config')).toEqual({
      name: 'Config', status: 'FAIL', reason: 'invalid primary guild ID',
    })
  })

  test('requires a successful Activity origin response', async () => {
    for (const activityStatus of [302, 404]) {
      const results = await runHealthChecks(createEnv(), {
        fetch: createFetch({ activityStatus }), interactionEndpointUrl: ENDPOINT,
      })
      expect(results.find(result => result.name === 'Activity')).toEqual({
        name: 'Activity', status: 'FAIL', reason: `HTTP ${activityStatus}`,
      })
    }
  })

  test('turns slow checks into concise timeout failures', async () => {
    const fetchMock = (() => new Promise<Response>(() => {})) as typeof fetch
    const results = await runHealthChecks(createEnv(), { fetch: fetchMock, interactionEndpointUrl: ENDPOINT, timeoutMs: 5 })
    expect(results.find(result => result.name === 'Discord application')).toEqual({
      name: 'Discord application', status: 'FAIL', reason: 'timed out',
    })
    expect(results.find(result => result.name === 'D1')?.status).toBe('OK')
  })

  test('validates the optional browser preference role when enabled', async () => {
    const roleId = '333333333333333333'
    const kv = {
      get: async (key: string, type?: string) => key === 'system:browser-access' && type === 'json'
        ? { enabled: true, preferenceRoleId: roleId }
        : null,
    } as unknown as KVNamespace
    const safeRole = { id: roleId, permissions: '0', managed: false, hoist: false, mentionable: false }
    const healthy = await runHealthChecks(createEnv({ KV: kv }), {
      fetch: createFetch({ roles: [safeRole] }), interactionEndpointUrl: ENDPOINT,
    })
    expect(healthy.find(result => result.name === 'Browser Access')?.status).toBe('OK')

    const unsafe = await runHealthChecks(createEnv({ KV: {
      get: kv.get.bind(kv),
    } as unknown as KVNamespace }), {
      fetch: createFetch({ roles: [{ ...safeRole, permissions: '8' }] }), interactionEndpointUrl: ENDPOINT,
    })
    expect(unsafe.find(result => result.name === 'Browser Access')).toEqual({
      name: 'Browser Access', status: 'FAIL', reason: 'preference role permissions are unsafe',
    })
  })

  test('fails browser health when stored intent is enabled but invalid', async () => {
    const kv = {
      get: async (key: string, type?: string) => key === 'system:browser-access' && type === 'json'
        ? { enabled: true, preferenceRoleId: 'not-a-role' }
        : null,
    } as unknown as KVNamespace
    const results = await runHealthChecks(createEnv({ KV: kv }), {
      fetch: createFetch(), interactionEndpointUrl: ENDPOINT,
    })
    expect(results.find(result => result.name === 'Browser Access')).toEqual({
      name: 'Browser Access', status: 'FAIL', reason: 'enabled configuration is invalid',
    })
  })
})

function createEnv(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  const kv = {
    get: async () => null,
  } as unknown as KVNamespace
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }) }),
    } as unknown as D1Database,
    KV: kv,
    AUTOSAVE_UPLOADS: { list: async () => ({ objects: [], truncated: false }) } as unknown as R2Bucket,
    Activity: {} as DurableObjectNamespace,
    SessionDO: {} as DurableObjectNamespace,
    DISCORD_APPLICATION_ID: APPLICATION_ID,
    DISCORD_PUBLIC_KEY: PUBLIC_KEY,
    DISCORD_TOKEN: 'discord-secret-token',
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    ACTIVITY_PUBLIC_ORIGIN: ACTIVITY_ORIGIN,
    CIVUP_SECRET: 'shared-secret',
    ...overrides,
  }
}

function createFetch(options: { applicationId?: string, activityStatus?: number, discordApplicationStatus?: number, roles?: unknown[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin === ACTIVITY_ORIGIN) return new Response(null, { status: options.activityStatus ?? 200 })
    if (url.pathname.endsWith('/oauth2/applications/@me')) {
      if (options.discordApplicationStatus) return new Response(null, { status: options.discordApplicationStatus })
      return Response.json({
        id: options.applicationId ?? APPLICATION_ID,
        verify_key: PUBLIC_KEY,
        interactions_endpoint_url: ENDPOINT,
      })
    }
    if (url.pathname.endsWith(`/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`)) {
      return Response.json(EXPECTED_GUILD_COMMANDS)
    }
    if (url.pathname.endsWith(`/guilds/${GUILD_ID}/roles`)) return Response.json(options.roles ?? [])
    if (url.pathname.endsWith(`/guilds/${GUILD_ID}`)) return Response.json({ id: GUILD_ID })
    return new Response(null, { status: 404 })
  }) as typeof fetch
}
