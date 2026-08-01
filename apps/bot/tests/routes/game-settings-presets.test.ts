import type { Env } from '../../src/env.ts'
import type { CivLobbySettingsCommunityPreset } from '@civup/game'
import { OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE } from '@civup/game'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_DISPLAY_NAME_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerGameSettingsPresetRoutes } from '../../src/routes/game-settings-presets.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'secret'
const GUILD_ID = '111111111111111111'
const openDatabases: Array<Awaited<ReturnType<typeof createTestDatabase>>['sqlite']> = []

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close()
})

describe('game settings preset routes', () => {
  test('requires Activity authentication and rejects reserved names', async () => {
    const harness = await createHarness()
    expect((await harness.request('GET', '/api/game-settings/presets', undefined, null)).status).toBe(401)

    const reserved = await harness.request('POST', '/api/game-settings/presets', {
      name: 'My Official Default',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    })
    expect(reserved.status).toBe(400)
    expect(await reserved.json()).toEqual({ error: 'Preset names cannot use reserved Official or default wording.' })

    const oversized = await harness.request('POST', '/api/game-settings/presets', {
      name: 'Huge preset',
      profile: { ...OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE, padding: 'x'.repeat(20_000) },
    })
    expect(oversized.status).toBe(413)
  })

  test('enforces owner limits and normalized unique names', async () => {
    const harness = await createHarness()
    const first = await harness.request('POST', '/api/game-settings/presets', {
      name: 'Preset 0',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    })
    expect(first.status).toBe(201)
    const duplicate = await harness.request('POST', '/api/game-settings/presets', {
      name: '  preset   0  ',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'You already have a preset with that name.' })

    for (let index = 1; index < 10; index += 1) {
      const response = await harness.request('POST', '/api/game-settings/presets', {
        name: `Preset ${index}`,
        profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
      })
      expect(response.status).toBe(201)
    }

    const limited = await harness.request('POST', '/api/game-settings/presets', {
      name: 'Preset 11',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    })
    expect(limited.status).toBe(409)
    expect(await limited.json()).toEqual({ error: 'You can create up to 10 public presets.' })

    const otherOwner = await harness.request('POST', '/api/game-settings/presets', {
      name: 'Preset 0',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    }, 'other-owner')
    expect(otherOwner.status).toBe(201)
  })

  test('checks ownership and optimistic revisions for update and delete', async () => {
    const harness = await createHarness()
    const createdResponse = await harness.request('POST', '/api/game-settings/presets', {
      name: 'Team rules',
      profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
    })
    const created = await createdResponse.json<CivLobbySettingsCommunityPreset>()

    const forbidden = await harness.request('PATCH', `/api/game-settings/presets/${created.id}`, {
      revision: 1,
      name: 'Other rules',
    }, 'other-owner')
    expect(forbidden.status).toBe(403)

    const updatedResponse = await harness.request('PATCH', `/api/game-settings/presets/${created.id}`, {
      revision: 1,
      name: 'Team rules revised',
    })
    expect(updatedResponse.status).toBe(200)
    const updated = await updatedResponse.json<CivLobbySettingsCommunityPreset>()
    expect(updated.revision).toBe(2)

    const stale = await harness.request('PATCH', `/api/game-settings/presets/${created.id}`, {
      revision: 1,
      name: 'Stale write',
    })
    expect(stale.status).toBe(409)

    const staleDelete = await harness.request('DELETE', `/api/game-settings/presets/${created.id}`, { revision: 1 })
    expect(staleDelete.status).toBe(409)
    expect((await harness.request('DELETE', `/api/game-settings/presets/${created.id}`, { revision: 2 })).status).toBe(204)
  })
})

async function createHarness() {
  const { sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const app = new Hono<Env>()
  registerGameSettingsPresetRoutes(app)
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: createTestKv(),
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
  }
  return {
    request(method: string, path: string, body?: unknown, user: string | null = 'owner-user') {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (user) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, user)
        headers.set(CIVUP_ACTIVITY_DISPLAY_NAME_HEADER, user === 'owner-user' ? 'Owner' : 'Other owner')
        headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, GUILD_ID)
      }
      return app.fetch(new Request(`https://bot.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env)
    },
  }
}
