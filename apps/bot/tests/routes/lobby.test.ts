import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot } from '../../src/routes/activity.ts'
import { registerLobbyRoutes } from '../../src/routes/lobby/index.ts'
import { getLobbyForUser, storeUserActivityTarget, storeUserLobbyMappings } from '../../src/services/activity/index.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyDraftConfig, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus } from '../../src/services/lobby/index.ts'
import { addToQueue, getPlayerQueueMode } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const TITAN_ROLE_ID = '99999999999999999'
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
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({ userId: 'host', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    const storedLobby = await getLobbyById(kv, lobby.id)
    expect(storedLobby?.memberPlayerIds).toEqual(['host'])

    const configResponse = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
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
      headers: buildAuthHeaders('pleb', 'Pleb'),
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

  test('direct lobby joins ignore matchmaking max rank', async () => {
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
      tier1: TITAN_ROLE_ID,
      tier2: GLADIATOR_ROLE_ID,
    })

    const gatedLobby = await getLobbyById(kv, lobby.id)
    expect(gatedLobby).not.toBeNull()
    await setLobbyMaxRole(kv, lobby.id, 'tier2', gatedLobby!)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const joinResponse = await app.request('/api/lobby/2v2/place', {
      method: 'POST',
      headers: buildAuthHeaders('titan', 'Titan'),
      body: JSON.stringify({
        userId: 'titan',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'Titan',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.memberPlayerIds).toEqual(['host', 'titan'])
  })

  test('config route stores matchmaking max rank', async () => {
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

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        maxRole: 'tier2',
        banTimerSeconds: null,
        pickTimerSeconds: null,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const configuredLobby = await response.json()
    expect(configuredLobby.maxRole).toBe('tier2')
  })

  test('config route swaps inverted matchmaking rank bounds', async () => {
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
      tier3: '22222222222222222',
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        minRole: 'tier2',
        maxRole: 'tier3',
        banTimerSeconds: null,
        pickTimerSeconds: null,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const configuredLobby = await response.json()
    expect(configuredLobby.minRole).toBe('tier3')
    expect(configuredLobby.maxRole).toBe('tier2')
  })

  test('config route rejects spoofed activity user IDs', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('attacker', 'Attacker'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        banTimerSeconds: null,
        pickTimerSeconds: null,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(403)
  })

  test('config route updates the Steam lobby link for the authenticated host', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
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

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        banTimerSeconds: null,
        pickTimerSeconds: null,
        steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
  })

  test('config route preserves existing timers when only the Steam lobby link changes', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
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

    const configuredLobby = await setLobbyDraftConfig(kv, lobby.id, {
      banTimerSeconds: 45,
      pickTimerSeconds: 60,
      leaderPoolSize: 12,
      leaderDataVersion: 'live',
      simultaneousPick: false,
    }, lobby)
    expect(configuredLobby).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig).toEqual({
      banTimerSeconds: 45,
      pickTimerSeconds: 60,
      leaderPoolSize: 12,
      leaderDataVersion: 'live',
      simultaneousPick: false,
    })
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
  })

  test('config route updates the FFA simultaneous pick toggle', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, 'ffa', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/ffa/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        simultaneousPick: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.simultaneousPick).toBe(true)
  })

  test('config route updates the Steam lobby link for an active hosted lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    expect(draftingLobby).not.toBeNull()
    const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)
    expect(activeLobby).not.toBeNull()

    const response = await app.request('/api/lobby/1v1/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
    expect(updatedLobby?.status).toBe('active')
  })

  test('config route rejects timer updates after the draft starts', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    expect(draftingLobby).not.toBeNull()

    const response = await app.request('/api/lobby/1v1/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        banTimerSeconds: 45,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Only the Steam lobby link can be updated after the draft starts.' })
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
      headers: buildAuthHeaders('pleb', 'Pleb'),
      body: JSON.stringify({ userId: 'pleb', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    expect(await getPlayerQueueMode(kv, 'pleb')).toBeNull()
    expect(await getLobbyForUser(kv, 'pleb')).toBeNull()

    const rejoinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('pleb', 'Pleb'),
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
      headers: buildAuthHeaders('pleb', 'Pleb'),
      body: JSON.stringify({ userId: 'pleb', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    const snapshot = await buildActivityLaunchSnapshot('token', 'secret', kv, lobby.channelId, 'pleb')
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
    CIVUP_SECRET: 'secret',
  } as any
}

function buildAuthHeaders(userId: string, displayName = userId): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-CivUp-Internal-Secret': 'secret',
    'X-CivUp-Activity-User-Id': userId,
    'X-CivUp-Activity-Display-Name': displayName,
  }
}
