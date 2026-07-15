<<<<<<< New base: feat: save file analyzer
import { afterEach, describe, expect, test } from 'bun:test'
import { handleSetup } from '../../src/commands/admin/setup.ts'
import { buildSettingsPanel, updateSettingsPreference } from '../../src/commands/settings.ts'
import { buildBrowserChannelUrl, buildBrowserSessionUrl, getBrowserAccessState, resetBrowserAccessStateCache, resolveBrowserAccessConfig, resolveInteractionLaunchMode } from '../../src/services/activity/browser-access.ts'
import { respondWithPreferredLaunch } from '../../src/services/activity/launch-response.ts'

const ROLE_ID = '123456789012345678'
const GUILD_ID = '1234044388733095946'
const USER_ID = '111111111111111111'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetBrowserAccessStateCache()
})

describe('browser preference role', () => {
  test('defaults to Activity and caches setup state instead of reading KV per click', async () => {
    const kv = createKv()
    const env = configuredEnv(kv.namespace)

    await expect(resolveInteractionLaunchMode(env, undefined)).resolves.toEqual({ ok: true, mode: 'activity', config: null })
    await expect(resolveInteractionLaunchMode(env, undefined)).resolves.toEqual({ ok: true, mode: 'activity', config: null })
    expect(kv.getCount).toBe(1)
  })

  test('uses interaction roles when browser access is enabled in setup state', async () => {
    const env = configuredEnv(createEnabledKv().namespace)
    const config = await resolveBrowserAccessConfig(env)
    expect(await resolveInteractionLaunchMode(env, [])).toEqual({ ok: true, mode: 'activity', config })
    expect(await resolveInteractionLaunchMode(env, [ROLE_ID])).toEqual({ ok: true, mode: 'browser', config })
    expect(await resolveInteractionLaunchMode(env, null)).toEqual(expect.objectContaining({ ok: false }))
  })

  test('requires a valid public origin and builds credential-free canonical URLs', async () => {
    expect(await resolveBrowserAccessConfig({ ...configuredEnv(createEnabledKv().namespace), ACTIVITY_PUBLIC_ORIGIN: undefined })).toBeNull()
    const config = await resolveBrowserAccessConfig(configuredEnv(createEnabledKv().namespace))
    expect(config).not.toBeNull()
    expect(buildBrowserSessionUrl(config!, 'session/id')).toBe('https://activity.example.com/web/session/session%2Fid')
    expect(buildBrowserChannelUrl(config!, 'channel id')).toBe('https://activity.example.com/web/channel/channel%20id')
  })

  test('renders a persistent settings panel with both idempotent mode buttons', async () => {
    const payload = JSON.parse(JSON.stringify(await buildSettingsPanel(configuredEnv(createEnabledKv().namespace), [ROLE_ID])))
    expect(payload.embeds[0].description).toContain('Current launch mode: **Web browser**')
    expect(payload.components[0].components).toEqual([
      expect.objectContaining({ label: 'Discord Activity', style: 2 }),
      expect.objectContaining({ label: 'Web browser', style: 1 }),
    ])
  })

  test('returns Activity callback while disabled and browser link without launch-target storage when enabled', async () => {
    const activityCalls: string[] = []
    const activityContext = createContext(configuredEnv(createKv().namespace), [], activityCalls)
    const activityResponse = await respondWithPreferredLaunch(activityContext as any, {
      destination: { kind: 'session', sessionId: 'canonical-session' },
      activityChannelId: 'channel-1',
      activityUserId: 'player-1',
      activityTarget: { kind: 'match', id: 'match-1' },
    })
    expect(await activityResponse.text()).toBe('activity')
    expect(activityCalls).toEqual(['activity'])

    const browserCalls: string[] = []
    const browserContext = createContext(configuredEnv(createEnabledKv().namespace), [ROLE_ID], browserCalls)
    const browserResponse = await respondWithPreferredLaunch(browserContext as any, {
      destination: { kind: 'session', sessionId: 'canonical-session' },
      activityChannelId: 'channel-1',
      activityUserId: 'player-1',
      activityTarget: { kind: 'match', id: 'match-1' },
    })
    const payload = await browserResponse.json() as any
    expect(payload.components[0].components[0]).toEqual(expect.objectContaining({
      label: 'Open in Browser',
      style: 5,
      url: 'https://activity.example.com/web/session/canonical-session',
    }))
    expect(payload.embeds).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain('activitySession')
    expect(browserCalls).toEqual([])
  })

  test('admin setup creates or renames a zero-permission role and preserves it when disabled', async () => {
    const kv = createKv()
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === 'GET') return Response.json([])
      return Response.json({ id: ROLE_ID })
    }) as typeof fetch

    await handleSetup(createAdminSetupContext(kv.namespace, 'on'))
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST'])
    expect(await requests[1]!.json()).toEqual({
      name: 'Web Browser',
      permissions: '0',
      hoist: false,
      mentionable: false,
    })
    expect(await getBrowserAccessState(kv.namespace)).toEqual({ enabled: true, preferenceRoleId: ROLE_ID })

    requests.length = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === 'GET') {
        return Response.json([{
          id: ROLE_ID,
          name: 'Legacy Browser',
          permissions: '0',
          managed: false,
          hoist: false,
          mentionable: false,
        }])
      }
      return Response.json({ id: ROLE_ID, name: 'Web Browser' })
    }) as typeof fetch
    await handleSetup(createAdminSetupContext(kv.namespace, 'on'))
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH'])
    expect(await requests[1]!.json()).toEqual({ name: 'Web Browser' })

    await handleSetup(createAdminSetupContext(kv.namespace, 'off'))
    expect(await getBrowserAccessState(kv.namespace)).toEqual({ enabled: false, preferenceRoleId: ROLE_ID })
  })

  test('settings buttons idempotently add or remove only the configured role', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 204 })
    }) as typeof fetch

    await updateSettingsPreference(createSettingsContext([]), 'browser')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('PUT')
    expect(requests[0]!.url).toEndWith(`/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}`)

    await updateSettingsPreference(createSettingsContext([ROLE_ID]), 'activity')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.method).toBe('DELETE')

    await updateSettingsPreference(createSettingsContext([ROLE_ID]), 'browser')
    expect(requests).toHaveLength(2)
  })
})

function configuredEnv(kv: KVNamespace): any {
  return {
    ACTIVITY_PUBLIC_ORIGIN: 'https://activity.example.com',
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_TOKEN: 'bot-token',
    KV: kv,
  }
}

function createSettingsContext(roles: string[]) {
  return {
    env: configuredEnv(createEnabledKv().namespace),
    interaction: {
      guild_id: GUILD_ID,
      member: { roles, user: { id: USER_ID, username: 'Player' } },
    },
    flags: () => ({ res: (payload: unknown) => Response.json(payload) }),
    update: () => ({
      res: (payload: unknown) => Response.json(payload),
      resDefer: async (callback: (context: { followup: (payload: unknown) => Promise<void> }) => Promise<void>) => {
        await callback({ followup: async () => {} })
        return new Response(null, { status: 204 })
      },
    }),
  }
}

function createAdminSetupContext(kv: KVNamespace, value: 'on' | 'off') {
  const context: any = {
    env: configuredEnv(kv),
    var: { target: 'browser', value },
    interaction: { guild_id: GUILD_ID },
    executionCtx: { waitUntil: () => {} },
    followup: async () => {},
  }
  context.flags = () => ({ resDefer: (callback: (deferred: any) => Promise<void>) => callback(context) })
  return context
}

function createEnabledKv() {
  return createKv({ enabled: true, preferenceRoleId: ROLE_ID })
}

function createKv(initialState?: { enabled: boolean, preferenceRoleId: string | null }) {
  const values = new Map<string, string>()
  if (initialState) values.set('system:browser-access', JSON.stringify(initialState))
  const result = {
    getCount: 0,
    namespace: null as unknown as KVNamespace,
  }
  result.namespace = {
    get: async (key: string, type?: string) => {
      result.getCount++
      const value = values.get(key) ?? null
      return type === 'json' && value ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  } as unknown as KVNamespace
  return result
}

function createContext(env: any, roles: string[], calls: string[]) {
  return {
    env,
    interaction: { member: { roles } },
    flags: () => ({ res: (payload: unknown) => Response.json(payload) }),
    resActivity: () => {
      calls.push('activity')
      return new Response('activity')
    },
  }
}
|||||||
=======
import { afterEach, describe, expect, test } from 'bun:test'
import { handleSetup } from '../../src/commands/admin/setup.ts'
import { buildSettingsPanel, updateSettingsPreference } from '../../src/commands/settings.ts'
import { buildBrowserChannelUrl, buildBrowserSessionUrl, getBrowserAccessState, resetBrowserAccessStateCache, resolveBrowserAccessConfig, resolveInteractionLaunchMode } from '../../src/services/activity/browser-access.ts'
import { respondWithPreferredLaunch } from '../../src/services/activity/launch-response.ts'

const ROLE_ID = '123456789012345678'
const GUILD_ID = '1234044388733095946'
const USER_ID = '111111111111111111'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetBrowserAccessStateCache()
})

describe('browser preference role', () => {
  test('defaults to Activity and caches setup state instead of reading KV per click', async () => {
    const kv = createKv()
    const env = configuredEnv(kv.namespace)

    await expect(resolveInteractionLaunchMode(env, undefined)).resolves.toEqual({ ok: true, mode: 'activity', config: null })
    await expect(resolveInteractionLaunchMode(env, undefined)).resolves.toEqual({ ok: true, mode: 'activity', config: null })
    expect(kv.getCount).toBe(1)
  })

  test('uses interaction roles when browser access is enabled in setup state', async () => {
    const env = configuredEnv(createEnabledKv().namespace)
    const config = await resolveBrowserAccessConfig(env)
    expect(await resolveInteractionLaunchMode(env, [])).toEqual({ ok: true, mode: 'activity', config })
    expect(await resolveInteractionLaunchMode(env, [ROLE_ID])).toEqual({ ok: true, mode: 'browser', config })
    expect(await resolveInteractionLaunchMode(env, null)).toEqual(expect.objectContaining({ ok: false }))
  })

  test('requires a valid public origin and builds credential-free canonical URLs', async () => {
    expect(await resolveBrowserAccessConfig({ ...configuredEnv(createEnabledKv().namespace), ACTIVITY_PUBLIC_ORIGIN: undefined })).toBeNull()
    const config = await resolveBrowserAccessConfig(configuredEnv(createEnabledKv().namespace))
    expect(config).not.toBeNull()
    expect(buildBrowserSessionUrl(config!, 'session/id')).toBe('https://activity.example.com/web/session/session%2Fid')
    expect(buildBrowserChannelUrl(config!, 'channel id')).toBe('https://activity.example.com/web/channel/channel%20id')
  })

  test('renders a persistent settings panel with both idempotent mode buttons', async () => {
    const payload = JSON.parse(JSON.stringify(await buildSettingsPanel(configuredEnv(createEnabledKv().namespace), [ROLE_ID])))
    expect(payload.embeds[0].description).toContain('Current launch mode: **Web browser**')
    expect(payload.components[0].components).toEqual([
      expect.objectContaining({ label: 'Discord Activity', style: 2 }),
      expect.objectContaining({ label: 'Web browser', style: 1 }),
    ])
  })

  test('returns Activity callback while disabled and browser link without launch-target storage when enabled', async () => {
    const activityCalls: string[] = []
    const activityContext = createContext(configuredEnv(createKv().namespace), [], activityCalls)
    const activityResponse = await respondWithPreferredLaunch(activityContext as any, {
      destination: { kind: 'session', sessionId: 'canonical-session' },
      activityChannelId: 'channel-1',
      activityUserId: 'player-1',
      activityTarget: { kind: 'match', id: 'match-1' },
    })
    expect(await activityResponse.text()).toBe('activity')
    expect(activityCalls).toEqual(['activity'])

    const browserCalls: string[] = []
    const browserContext = createContext(configuredEnv(createEnabledKv().namespace), [ROLE_ID], browserCalls)
    const browserResponse = await respondWithPreferredLaunch(browserContext as any, {
      destination: { kind: 'session', sessionId: 'canonical-session' },
      activityChannelId: 'channel-1',
      activityUserId: 'player-1',
      activityTarget: { kind: 'match', id: 'match-1' },
    })
    const payload = await browserResponse.json() as any
    expect(payload.components[0].components[0]).toEqual(expect.objectContaining({
      label: 'Open in Browser',
      style: 5,
      url: 'https://activity.example.com/web/session/canonical-session',
    }))
    expect(payload.embeds).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain('activitySession')
    expect(browserCalls).toEqual([])
  })

  test('admin setup creates or renames a zero-permission role and preserves it when disabled', async () => {
    const kv = createKv()
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === 'GET') return Response.json([])
      return Response.json({ id: ROLE_ID })
    }) as typeof fetch

    await handleSetup(createAdminSetupContext(kv.namespace, 'on'))
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST'])
    expect(await requests[1]!.json()).toEqual({
      name: 'Web Browser',
      permissions: '0',
      hoist: false,
      mentionable: false,
    })
    expect(await getBrowserAccessState(kv.namespace)).toEqual({ enabled: true, preferenceRoleId: ROLE_ID })

    requests.length = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === 'GET') {
        return Response.json([{
          id: ROLE_ID,
          name: 'Legacy Browser',
          permissions: '0',
          managed: false,
          hoist: false,
          mentionable: false,
        }])
      }
      return Response.json({ id: ROLE_ID, name: 'Web Browser' })
    }) as typeof fetch
    await handleSetup(createAdminSetupContext(kv.namespace, 'on'))
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH'])
    expect(await requests[1]!.json()).toEqual({ name: 'Web Browser' })

    await handleSetup(createAdminSetupContext(kv.namespace, 'off'))
    expect(await getBrowserAccessState(kv.namespace)).toEqual({ enabled: false, preferenceRoleId: ROLE_ID })
  })

  test('settings buttons idempotently add or remove only the configured role', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 204 })
    }) as typeof fetch

    await updateSettingsPreference(createSettingsContext([]), 'browser')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('PUT')
    expect(requests[0]!.url).toEndWith(`/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}`)

    await updateSettingsPreference(createSettingsContext([ROLE_ID]), 'activity')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.method).toBe('DELETE')

    await updateSettingsPreference(createSettingsContext([ROLE_ID]), 'browser')
    expect(requests).toHaveLength(2)
  })
})

function configuredEnv(kv: KVNamespace): any {
  return {
    ACTIVITY_PUBLIC_ORIGIN: 'https://activity.example.com',
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_TOKEN: 'bot-token',
    KV: kv,
  }
}

function createSettingsContext(roles: string[]) {
  return {
    env: configuredEnv(createEnabledKv().namespace),
    interaction: {
      guild_id: GUILD_ID,
      member: { roles, user: { id: USER_ID, username: 'Player' } },
    },
    flags: () => ({ res: (payload: unknown) => Response.json(payload) }),
    update: () => ({
      res: (payload: unknown) => Response.json(payload),
      resDefer: async (callback: (context: { followup: (payload: unknown) => Promise<void> }) => Promise<void>) => {
        await callback({ followup: async () => {} })
        return new Response(null, { status: 204 })
      },
    }),
  }
}

function createAdminSetupContext(kv: KVNamespace, value: 'on' | 'off') {
  const context: any = {
    env: configuredEnv(kv),
    var: { target: 'browser', value },
    interaction: { guild_id: GUILD_ID },
    executionCtx: { waitUntil: () => {} },
    followup: async () => {},
  }
  context.flags = () => ({ resDefer: (callback: (deferred: any) => Promise<void>) => callback(context) })
  return context
}

function createEnabledKv() {
  return createKv({ enabled: true, preferenceRoleId: ROLE_ID })
}

function createKv(initialState?: { enabled: boolean, preferenceRoleId: string | null }) {
  const values = new Map<string, string>()
  if (initialState) values.set('system:browser-access', JSON.stringify(initialState))
  const result = {
    getCount: 0,
    namespace: null as unknown as KVNamespace,
  }
  result.namespace = {
    get: async (key: string, type?: string) => {
      result.getCount++
      const value = values.get(key) ?? null
      return type === 'json' && value ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  } as unknown as KVNamespace
  return result
}

function createContext(env: any, roles: string[], calls: string[]) {
  return {
    env,
    interaction: { member: { roles } },
    flags: () => ({ res: (payload: unknown) => Response.json(payload) }),
    resActivity: () => {
      calls.push('activity')
      return new Response('activity')
    },
  }
}
>>>>>>> Current commit: feat: external browser draft WIP
