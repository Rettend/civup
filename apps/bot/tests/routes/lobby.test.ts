import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot } from '../../src/routes/activity.ts'
import { registerLobbyRoutes } from '../../src/routes/lobby/index.ts'
import { getLobbyForUser, storeUserActivityTarget, storeUserLobbyMappings } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots } from '../../src/services/lobby/index.ts'
import { addToQueue, getPlayerQueueMode } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const GLADIATOR_ROLE_ID = '11111111111111111'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('lobby routes', () => {
  test('raising min rank ignores a player after they leave the lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'pleb'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'pleb', null, null], withMember ?? lobby)
    expect(withSlots).not.toBeNull()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async (input) => {
      const url = String(input)
      const match = url.match(/\/guilds\/[^/]+\/members\/([^/?]+)/)
      const userId = match?.[1]
      if (userId) {
        const roles = userId === 'host' ? [GLADIATOR_ROLE_ID] : []
        return new Response(JSON.stringify({ roles }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ id: 'message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const removeResponse = await app.request('/api/lobby/2v2/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'host', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    const storedLobby = await getLobbyById(kv, lobby.id)
    expect(storedLobby?.memberPlayerIds).toEqual(['host'])

    const configResponse = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        minRole: 'tier2',
        banTimerSeconds: null,
        pickTimerSeconds: null,
      }),
    }, buildEnv(kv))
    expect(configResponse.status).toBe(200)

    const configuredLobby = await configResponse.json()
    expect(configuredLobby.minRole).toBe('tier2')
  })

  test('direct lobby joins ignore matchmaking min rank', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    const gatedLobby = await getLobbyById(kv, lobby.id)
    expect(gatedLobby).not.toBeNull()
    await setLobbyMinRole(kv, lobby.id, 'tier2', gatedLobby!)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const joinResponse = await app.request('/api/lobby/2v2/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'pleb',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'Pleb',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.memberPlayerIds).toEqual(['host', 'pleb'])
  })

  test('removing yourself from a slot clears queue state so you can rejoin', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '1v1', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'pleb'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'pleb'], withMember ?? lobby)
    expect(withSlots).not.toBeNull()

    await storeUserLobbyMappings(kv, ['pleb'], lobby.id)
    await storeUserActivityTarget(kv, lobby.channelId, ['pleb'], { kind: 'lobby', id: lobby.id })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const removeResponse = await app.request('/api/lobby/1v1/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'pleb', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    expect(await getPlayerQueueMode(kv, 'pleb')).toBeNull()
    expect(await getLobbyForUser(kv, 'pleb')).toBeNull()

    const rejoinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'pleb',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'Pleb',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(rejoinResponse.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.memberPlayerIds).toEqual(['host', 'pleb'])
  })

  test('removing yourself keeps the current lobby selected for spectating', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '1v1', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'pleb'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'pleb'], withMember ?? lobby)
    expect(withSlots).not.toBeNull()

    await storeUserLobbyMappings(kv, ['pleb'], lobby.id)
    await storeUserActivityTarget(kv, lobby.channelId, ['pleb'], { kind: 'lobby', id: lobby.id })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const removeResponse = await app.request('/api/lobby/1v1/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'pleb', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    const snapshot = await buildActivityLaunchSnapshot('token', kv, lobby.channelId, 'pleb')
    expect(snapshot.selection?.kind).toBe('lobby')
    if (snapshot.selection?.kind !== 'lobby') return
    expect(snapshot.selection.lobby.id).toBe(lobby.id)
    expect(snapshot.selection.joinEligibility.canJoin).toBe(true)
  })
})

function buildEnv(kv: KVNamespace) {
  return {
    KV: kv,
    DB: {} as D1Database,
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
  } as any
}
