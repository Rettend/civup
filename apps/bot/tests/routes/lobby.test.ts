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

  test('direct lobby joins reject players who are already in a live match', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const liveLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-live',
    })
    const openLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-open',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await attachLobbyMatch(kv, liveLobby.id, 'match-1', liveLobby)

    const joinResponse = await app.request('/api/lobby/2v2/place', {
      method: 'POST',
      headers: buildAuthHeaders('player-1', 'Player 1'),
      body: JSON.stringify({
        userId: 'player-1',
        lobbyId: openLobby.id,
        targetSlot: 1,
        displayName: 'Player 1',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(400)
    await expect(joinResponse.json()).resolves.toEqual({ error: 'That player is already in a live match.' })
    expect(await getPlayerQueueMode(kv, 'player-1')).toBe('2v2')
    expect((await getLobbyById(kv, openLobby.id))?.memberPlayerIds).toEqual(['host'])
  })

  test('direct lobby joins move a player from another open lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'source-host',
      channelId: 'channel-source',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'target-host',
      channelId: 'channel-target',
      messageId: 'message-target',
    })

    await addToQueue(kv, '1v1', {
      playerId: 'source-host',
      displayName: 'Source Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '1v1', {
      playerId: 'target-host',
      displayName: 'Target Host',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['source-host', 'pleb'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['source-host', 'pleb'], populatedSource ?? sourceLobby)
    await storeUserLobbyMappings(kv, ['pleb'], sourceLobby.id)
    await storeUserActivityTarget(kv, sourceLobby.channelId, ['pleb'], { kind: 'lobby', id: sourceLobby.id })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const joinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('pleb', 'Pleb'),
      body: JSON.stringify({
        userId: 'pleb',
        lobbyId: targetLobby.id,
        targetSlot: 1,
        displayName: 'Pleb',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(200)
    await expect(joinResponse.json()).resolves.toMatchObject({
      transferNotice: 'Moved you from your previous 1v1 lobby.',
    })
    expect((await getLobbyById(kv, sourceLobby.id))?.memberPlayerIds).toEqual(['source-host'])
    expect((await getLobbyById(kv, targetLobby.id))?.memberPlayerIds).toEqual(['target-host', 'pleb'])
    expect(await getLobbyForUser(kv, 'pleb')).toBe(targetLobby.id)
  })

  test('direct lobby joins block hosts from abandoning players in another open lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'pleb',
      channelId: 'channel-source',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'target-host',
      channelId: 'channel-target',
      messageId: 'message-target',
    })

    await addToQueue(kv, '1v1', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: 'ally',
      displayName: 'Ally',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '1v1', {
      playerId: 'target-host',
      displayName: 'Target Host',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['pleb', 'ally'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['pleb', 'ally'], populatedSource ?? sourceLobby)

    const joinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('pleb', 'Pleb'),
      body: JSON.stringify({
        userId: 'pleb',
        lobbyId: targetLobby.id,
        targetSlot: 1,
        displayName: 'Pleb',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(400)
    await expect(joinResponse.json()).resolves.toEqual({
      error: 'You are hosting another open lobby with other players. Cancel it first.',
    })
  })

  test('seat moves ignore stale live-match conflicts for players already in the target lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const liveLobby = await createLobby(kv, {
      mode: '4v4',
      hostId: 'live-host',
      channelId: 'channel-live',
      messageId: 'message-live',
    })
    const targetLobby = await createLobby(kv, {
      mode: '4v4',
      hostId: 'host',
      channelId: 'channel-target',
      messageId: 'message-target',
    })

    await addToQueue(kv, '4v4', {
      playerId: 'live-host',
      displayName: 'Live Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '4v4', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '4v4', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })
    await addToQueue(kv, '4v4', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 3,
    })

    const populatedLiveLobby = await setLobbyMemberPlayerIds(kv, liveLobby.id, ['live-host', 'player-1', 'player-2'], liveLobby)
    await setLobbySlots(kv, liveLobby.id, ['live-host', 'player-1', 'player-2', null, null, null, null, null], populatedLiveLobby ?? liveLobby)
    await attachLobbyMatch(kv, liveLobby.id, 'match-1', populatedLiveLobby ?? liveLobby)

    const populatedTargetLobby = await setLobbyMemberPlayerIds(kv, targetLobby.id, ['host', 'player-1', 'player-2'], targetLobby)
    await setLobbySlots(kv, targetLobby.id, ['host', 'player-1', 'player-2', null, null, null, null, null], populatedTargetLobby ?? targetLobby)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const selfMoveResponse = await app.request('/api/lobby/4v4/place', {
      method: 'POST',
      headers: buildAuthHeaders('player-1', 'Player 1'),
      body: JSON.stringify({
        userId: 'player-1',
        lobbyId: targetLobby.id,
        targetSlot: 4,
      }),
    }, buildEnv(kv))

    expect(selfMoveResponse.status).toBe(200)

    const hostMoveResponse = await app.request('/api/lobby/4v4/place', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: targetLobby.id,
        playerId: 'player-2',
        targetSlot: 5,
      }),
    }, buildEnv(kv))

    expect(hostMoveResponse.status).toBe(200)
    expect((await getLobbyById(kv, targetLobby.id))?.slots).toEqual(['host', null, null, null, 'player-1', 'player-2', null, null])
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
      redDeath: false,
      dealOptionsSize: 2,
      randomDraft: false,
      duplicateFactions: false,
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
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    })
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
  })

  test('config route allows clearing Red Death factions to server default', async () => {
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
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      simultaneousPick: false,
      redDeath: true,
      dealOptionsSize: 4,
      randomDraft: false,
      duplicateFactions: false,
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
        dealOptionsSize: null,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.dealOptionsSize).toBeNull()
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

  test('config route updates the base-game random draft toggle', async () => {
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

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/1v1/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        randomDraft: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.randomDraft).toBe(true)
    expect(updatedLobby?.draftConfig.redDeath).toBe(false)
  })

  test('config route updates the base-game duplicate leaders toggle', async () => {
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

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/1v1/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        duplicateFactions: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.duplicateFactions).toBe(true)
    expect(updatedLobby?.draftConfig.redDeath).toBe(false)
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

  test('mode changes keep the host seat order when already slotted', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '4v4',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '4v4', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const otherPlayers = ['p1', 'p2', 'p3', 'p5', 'p6']
    for (let index = 0; index < otherPlayers.length; index++) {
      const playerId = otherPlayers[index]
      await addToQueue(kv, '4v4', {
        playerId,
        displayName: playerId,
        avatarUrl: null,
        joinedAt: Date.now() + index + 1,
      })
    }

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', ...otherPlayers], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['p1', 'p2', 'p3', 'host', 'p5', 'p6', null, null], withMembers ?? lobby)
    expect(withSlots).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/4v4/mode', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        nextMode: '3v3',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('3v3')
    expect(updatedLobby?.slots).toEqual(['p1', 'p2', 'p3', 'host', 'p5', 'p6'])
  })

  test('mode changes keep Red Death config when switching base modes', async () => {
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
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      simultaneousPick: false,
      redDeath: true,
      dealOptionsSize: 4,
      randomDraft: true,
      duplicateFactions: false,
    }, lobby)
    expect(configuredLobby).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/mode', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        nextMode: '1v1',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('1v1')
    expect(updatedLobby?.draftConfig.redDeath).toBe(true)
    expect(updatedLobby?.draftConfig.randomDraft).toBe(true)
    expect(updatedLobby?.draftConfig.duplicateFactions).toBe(false)
  })

  test('mode changes force duplicate factions for Red Death 6v6', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '5v5',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '5v5', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const configuredLobby = await setLobbyDraftConfig(kv, lobby.id, {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      simultaneousPick: false,
      redDeath: true,
      dealOptionsSize: 4,
      randomDraft: false,
      duplicateFactions: false,
    }, lobby)
    expect(configuredLobby).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/5v5/mode', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        nextMode: '6v6',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('6v6')
    expect(updatedLobby?.draftConfig.redDeath).toBe(true)
    expect(updatedLobby?.draftConfig.duplicateFactions).toBe(true)
  })

  test('mode changes clear FFA simultaneous pick when switching to another mode', async () => {
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

    const configuredLobby = await setLobbyDraftConfig(kv, lobby.id, {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      redDeath: false,
      simultaneousPick: true,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    }, lobby)
    expect(configuredLobby).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/ffa/mode', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        nextMode: '1v1',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('1v1')
    expect(updatedLobby?.draftConfig.simultaneousPick).toBe(false)
  })

  test('mode changes preserve the current team split when expanding team size', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '3v3',
      hostId: 'p1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    for (let index = 0; index < playerIds.length; index++) {
      const playerId = playerIds[index]
      await addToQueue(kv, '3v3', {
        playerId,
        displayName: playerId,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, playerIds, lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], withMembers ?? lobby)
    expect(withSlots).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/3v3/mode', {
      method: 'POST',
      headers: buildAuthHeaders('p1', 'P1'),
      body: JSON.stringify({
        userId: 'p1',
        lobbyId: lobby.id,
        nextMode: '4v4',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('4v4')
    expect(updatedLobby?.slots).toEqual(['p1', 'p2', 'p3', null, 'p4', 'p5', 'p6', null])
  })

  test('mode changes expand 2v2 to fit the current player count', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '3v3',
      hostId: 'p1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    for (let index = 0; index < playerIds.length; index++) {
      const playerId = playerIds[index]
      await addToQueue(kv, '3v3', {
        playerId,
        displayName: playerId,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, playerIds, lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], withMembers ?? lobby)
    expect(withSlots).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/3v3/mode', {
      method: 'POST',
      headers: buildAuthHeaders('p1', 'P1'),
      body: JSON.stringify({
        userId: 'p1',
        lobbyId: lobby.id,
        nextMode: '2v2',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.mode).toBe('2v2')
    expect(updatedLobby?.slots).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', null, null])
    expect(updatedLobby?.memberPlayerIds).toEqual(playerIds)
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
