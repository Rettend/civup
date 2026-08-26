import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerLobbyRoutes } from '../../src/routes/lobby/index.ts'

describe('debug lobby fill gate', () => {
  test('hides the authenticated route unless the explicit flag is enabled', async () => {
    const app = new Hono()
    registerLobbyRoutes(app as any)
    const headers = {
      'X-CivUp-Internal-Secret': 'secret',
      'X-CivUp-Activity-User-Id': 'user-1',
      'X-CivUp-Activity-Guild-Id': '111111111111111111',
    }
    const env = {
      CIVUP_SECRET: 'secret',
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
    }

    expect((await app.request('/api/lobby/2v2/fill-test', { headers }, env as any)).status).toBe(404)
    expect((await app.request('/api/lobby/2v2/fill-test', { headers }, { ...env, ENABLE_DEBUG_LOBBY_FILL: 'off' } as any)).status).toBe(404)
    expect((await app.request('/api/lobby/2v2/fill-test', { headers }, { ...env, ENABLE_DEBUG_LOBBY_FILL: 'true' } as any)).status).toBe(204)
  })
})
