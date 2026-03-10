import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerActivityRoutes, resolveLobbyJoinEligibility } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot } from '../../src/routes/lobby/snapshot.ts'
import { getUserActivityTarget, storeUserActivityTarget } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, setLobbyMinRole } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('activity lobby join eligibility', () => {
  test('returns the first empty slot when the viewer can join', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', lobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-2', lobby, snapshot)

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })

  test('allows direct activity joins even when the viewer misses the matchmaking min rank', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    await setLobbyMinRole(kv, lobby.id, 'tier2')
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: '11111111111111111',
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const storedLobby = await getLobbyById(kv, lobby.id)
    expect(storedLobby).not.toBeNull()

    const gatedLobby = await buildOpenLobbySnapshot(kv, '2v2', storedLobby!)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-2', storedLobby!, gatedLobby)

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })
})

describe('activity target selection', () => {
  test('returns a fresh snapshot when a clicked target is already gone', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerActivityRoutes(app as any)

    await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await storeUserActivityTarget(kv, 'channel-1', ['spectator-1'], { kind: 'match', id: 'missing-match' })

    const response = await app.request('/api/activity/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: 'channel-1',
        userId: 'spectator-1',
        kind: 'match',
        id: 'missing-match',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const snapshot = await response.json() as {
      selection: null
      options: Array<{ kind: string, status: string, id: string }>
    }

    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: expect.any(String),
        status: 'open',
      }),
    ])
    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-1')).resolves.toBeNull()
  })
})

function buildEnv(kv: KVNamespace) {
  return {
    KV: kv,
    DB: {} as any,
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
  } as any
}
