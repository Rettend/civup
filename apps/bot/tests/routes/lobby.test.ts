import { matches, players, tournamentMatches, tournamentPlayers, tournaments } from '@civup/db'
import { getMaxLeaderPoolSize } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot } from '../../src/routes/activity.ts'
import { registerLobbyRoutes } from '../../src/routes/lobby/index.ts'
import { getLobbyForUser } from '../../src/services/activity/index.ts'
import { buildActivityOverviewSnapshotFromDirectory } from '../../src/services/activity/session-state.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { buildTestLobbyEnv, createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyDraftConfig, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const originalMathRandom = Math.random
const TITAN_ROLE_ID = '99999999999999999'
const GLADIATOR_ROLE_ID = '11111111111111111'

afterEach(() => {
  globalThis.fetch = originalFetch
  Math.random = originalMathRandom
})

function activityRuntimeOptions(kv: KVNamespace) {
  const runtime = getExistingTestLobbyRuntime(kv)
  return { db: runtime.d1, sessionNamespace: runtime.sessionNamespace }
}

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
      playerId: 'guest',
      displayName: 'Guest',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'guest'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'guest', null, null], withMember ?? lobby)
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
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({
        userId: 'guest',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'Guest',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.memberPlayerIds).toEqual(['host', 'guest'])
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
    await startTestSessionDraft(kv, liveLobby.id, liveLobby)

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
    expect((await getLobbyById(kv, openLobby.id))?.memberPlayerIds).toEqual(['host'])
  })

  test('direct lobby joins allow players from draft-complete active lobbies', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const liveLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-live',
      messageId: 'message-live',
    })
    const openLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-open',
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
    const draftingLobby = await startTestSessionDraft(kv, liveLobby.id, liveLobby)
    await setLobbyStatus(kv, liveLobby.id, 'active', draftingLobby ?? liveLobby)
    await getExistingTestLobbyRuntime(kv).db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: Date.now() }) }).where(eq(matches.id, liveLobby.id))

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

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

    expect(joinResponse.status).toBe(200)
    expect((await getLobbyById(kv, openLobby.id))?.memberPlayerIds).toEqual(['host', 'player-1'])
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
      playerId: 'guest',
      displayName: 'Guest',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '1v1', {
      playerId: 'target-host',
      displayName: 'Target Host',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['source-host', 'guest'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['source-host', 'guest'], populatedSource ?? sourceLobby)
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const joinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({
        userId: 'guest',
        lobbyId: targetLobby.id,
        targetSlot: 1,
        displayName: 'Guest',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(200)
    await expect(joinResponse.json()).resolves.toMatchObject({
      transferNotice: 'Moved you from your previous 1v1 lobby.',
    })
    expect((await getLobbyById(kv, sourceLobby.id))?.memberPlayerIds).toEqual(['source-host'])
    expect((await getLobbyById(kv, targetLobby.id))?.memberPlayerIds).toEqual(['target-host', 'guest'])
    expect(await getLobbyForUser(getExistingTestLobbyRuntime(kv).db, 'guest')).toBe(targetLobby.id)
  })

  test('direct lobby joins block hosts from abandoning players in another open lobby', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'guest',
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
      playerId: 'guest',
      displayName: 'Guest',
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

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['guest', 'ally'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['guest', 'ally'], populatedSource ?? sourceLobby)

    const joinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({
        userId: 'guest',
        lobbyId: targetLobby.id,
        targetSlot: 1,
        displayName: 'Guest',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(joinResponse.status).toBe(400)
    await expect(joinResponse.json()).resolves.toEqual({
      error: 'You are hosting another open lobby with other players. Cancel it first.',
    })
  })

  test('slot removal only removes the selected player', async () => {
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
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
      partyIds: ['player-2'],
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
      partyIds: ['player-1'],
    })

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-1', 'player-2'], lobby)
    await setLobbySlots(kv, lobby.id, ['host', 'player-1', 'player-2', null], withMembers ?? lobby)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/remove', {
      method: 'POST',
      headers: buildAuthHeaders('player-1', 'Player 1'),
      body: JSON.stringify({ userId: 'player-1', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    expect((await getLobbyById(kv, lobby.id))?.slots).toEqual(['host', null, 'player-2', null])
  })

  test('arrange route accepts shuffle-teams', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    for (const [index, playerId] of ['host', 'p2', 'p3', 'p4'].entries()) {
      await addToQueue(kv, '2v2', {
        playerId,
        displayName: playerId,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'p2', 'p3', 'p4'], lobby)
    await setLobbySlots(kv, lobby.id, ['host', 'p2', 'p3', 'p4'], withMembers ?? lobby)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    Math.random = () => 0

    const response = await app.request('/api/lobby/2v2/arrange', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({ userId: 'host', lobbyId: lobby.id, strategy: 'shuffle-teams' }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.slots).toEqual(expect.arrayContaining(['host', 'p2', 'p3', 'p4']))
    expect(updatedLobby?.slots).not.toEqual(['host', 'p2', 'p3', 'p4'])
  })

  test('arrange route rejects shuffle-teams in FFA', async () => {
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

    const response = await app.request('/api/lobby/ffa/arrange', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({ userId: 'host', lobbyId: lobby.id, strategy: 'shuffle-teams' }),
    }, buildEnv(kv))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Shuffle teams is only available in team lobbies.' })
  })

  test('start route randomizes first pick for tournament 1v1 lobbies', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)
    const hostId = '1000000000000001'
    const opponentId = '1000000000000002'

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId,
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '1v1', {
      playerId: hostId,
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: opponentId,
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, [hostId, opponentId], lobby)
    await setLobbySlots(kv, lobby.id, [hostId, opponentId], withMembers ?? lobby)

    const { db } = getExistingTestLobbyRuntime(kv)
    const now = Date.now()
    await db.insert(players).values([
      { id: hostId, displayName: 'Host', avatarUrl: null, createdAt: now },
      { id: opponentId, displayName: 'Player 2', avatarUrl: null, createdAt: now },
    ])
    await db.insert(tournaments).values({
      id: 'tournament-route-test',
      name: 'Test Cup',
      mode: '1v1',
      status: 'qualifier',
      scoring: 'open_win_rate',
      rematchPolicy: 'warn',
      minGames: 6,
      topCut: 8,
      roleId: null,
      createdById: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(tournamentPlayers).values([
      { tournamentId: 'tournament-route-test', seed: 1, playerId: hostId, displayName: 'Host', avatarUrl: null, confirmed: true, linkedAt: now, createdAt: now, updatedAt: now },
      { tournamentId: 'tournament-route-test', seed: 2, playerId: opponentId, displayName: 'Player 2', avatarUrl: null, confirmed: true, linkedAt: now, createdAt: now, updatedAt: now },
    ])
    await db.insert(tournamentMatches).values({
      sessionId: lobby.id,
      tournamentId: 'tournament-route-test',
      matchId: null,
      stage: 'qualifier',
      status: 'open',
      playerOneId: hostId,
      playerTwoId: null,
      winnerId: null,
      createdAt: now,
      updatedAt: now,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    Math.random = () => 0

    const response = await app.request('/api/lobby/1v1/start', {
      method: 'POST',
      headers: buildAuthHeaders(hostId, 'Host'),
      body: JSON.stringify({ userId: hostId, lobbyId: lobby.id }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.status).toBe('drafting')
    expect(updatedLobby?.slots).toEqual([opponentId, hostId])
    expect(updatedLobby?.lastArrange?.strategy).toBe('shuffle-teams')
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

  test('config route clears matchmaking rank bounds when enabling CivBlitz', async () => {
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
    const withMinRole = await setLobbyMinRole(kv, lobby.id, 'tier3', lobby)
    const withMaxRole = await setLobbyMaxRole(kv, lobby.id, 'tier2', withMinRole ?? lobby)
    expect(withMaxRole).not.toBeNull()

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        civBlitz: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const configuredLobby = await response.json()
    expect(configuredLobby.minRole).toBeNull()
    expect(configuredLobby.maxRole).toBeNull()
    expect(configuredLobby.lobbyRank).toBeNull()
    expect(configuredLobby.draftConfig.civBlitz).toBe(true)
  })

  test('config route reopens closed lobbies in the activity overview', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const runtime = getExistingTestLobbyRuntime(kv)

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

    const closeResponse = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({ userId: 'host', lobbyId: lobby.id, closed: true }),
    }, buildEnv(kv))
    expect(closeResponse.status).toBe(200)
    await expect(closeResponse.json()).resolves.toMatchObject({ draftConfig: { closed: true } })
    expect((await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1'))?.options).toContainEqual(expect.objectContaining({ id: lobby.id, status: 'closed' }))

    const openResponse = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({ userId: 'host', lobbyId: lobby.id, closed: false }),
    }, buildEnv(kv))
    expect(openResponse.status).toBe(200)
    await expect(openResponse.json()).resolves.toMatchObject({ draftConfig: { closed: false } })
    expect((await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1'))?.options).toContainEqual(expect.objectContaining({ id: lobby.id, status: 'open' }))
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

  test('config route lets slotted non-host players update only the Steam lobby link', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'guest'], lobby)
    await setLobbySlots(kv, lobby.id, ['host', 'guest', null, null], withMembers ?? lobby)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({
        userId: 'guest',
        lobbyId: lobby.id,
        steamLobbyLink: 'steam://joinlobby/289070/22222222222222222/76561198000000000',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/22222222222222222/76561198000000000')
  })

  test('config route rejects spectator Steam lobby link updates', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'guest'], lobby)
    await setLobbySlots(kv, lobby.id, ['host', 'guest', null, null], withMembers ?? lobby)

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('spectator', 'Spectator'),
      body: JSON.stringify({
        userId: 'spectator',
        lobbyId: lobby.id,
        steamLobbyLink: 'steam://joinlobby/289070/33333333333333333/76561198000000000',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(403)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.steamLobbyLink).toBeNull()
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
      mapVoteEnabled: false,
      blindBans: true,
      blindPicks: false,
      simultaneousPick: false,
      permanentAlly: false,
      redDeath: false,
      dealOptionsSize: null,
      civBlitz: false,
      civBlitzOptionCount: 4,
      civBlitzExcludeBbgExpanded: true,
      randomDraft: false,
      hiddenDraft: false,
      duplicateFactions: false,
      closed: false,
    })
    expect(updatedLobby?.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
  })

  test('config route clamps beta leader pool when switching back to live data', async () => {
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

    const betaMax = getMaxLeaderPoolSize('beta')
    const liveMax = getMaxLeaderPoolSize('live')
    expect(betaMax).toBeGreaterThan(liveMax)

    const configuredLobby = await setLobbyDraftConfig(kv, lobby.id, {
      ...lobby.draftConfig,
      leaderPoolSize: betaMax,
      leaderDataVersion: 'beta',
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
        leaderDataVersion: 'live',
        leaderPoolSize: betaMax,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      draftConfig: {
        leaderDataVersion: 'live',
        leaderPoolSize: liveMax,
      },
    })
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.leaderDataVersion).toBe('live')
    expect(updatedLobby?.draftConfig.leaderPoolSize).toBe(liveMax)
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

  test('config route updates FFA map vote and simultaneous pick toggles', async () => {
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
        mapVoteEnabled: true,
        simultaneousPick: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.mapVoteEnabled).toBe(true)
    expect(updatedLobby?.draftConfig.simultaneousPick).toBe(true)
  })

  test('config route does not edit the lobby message for pick and ban visibility changes', async () => {
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

    let discordMessageEdits = 0
    globalThis.fetch = (async (input) => {
      if (String(input).includes('/channels/channel-1/messages/message-1')) discordMessageEdits += 1
      return new Response(JSON.stringify({ id: 'message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        ...lobby.draftConfig,
        blindBans: false,
        blindPicks: true,
        minRole: null,
        maxRole: null,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await flushBackgroundTasks()

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.blindBans).toBe(false)
    expect(updatedLobby?.draftConfig.blindPicks).toBe(true)
    expect(discordMessageEdits).toBe(0)
  })

  test('config route still edits the lobby message for rendered config changes', async () => {
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

    let discordMessageEdits = 0
    globalThis.fetch = (async (input) => {
      if (String(input).includes('/channels/channel-1/messages/message-1')) discordMessageEdits += 1
      return new Response(JSON.stringify({ id: 'message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        closed: true,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await flushBackgroundTasks()

    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.draftConfig.closed).toBe(true)
    expect(discordMessageEdits).toBe(1)
  })

  test('config route expands and preserves regular FFA target size', async () => {
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

    const expandResponse = await app.request('/api/lobby/ffa/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        targetSize: 12,
      }),
    }, buildEnv(kv))

    expect(expandResponse.status).toBe(200)
    await expect(expandResponse.json()).resolves.toMatchObject({ targetSize: 12 })
    expect((await getLobbyById(kv, lobby.id))?.slots).toHaveLength(12)

    const configResponse = await app.request('/api/lobby/ffa/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        mapVoteEnabled: true,
      }),
    }, buildEnv(kv))

    expect(configResponse.status).toBe(200)
    await expect(configResponse.json()).resolves.toMatchObject({ targetSize: 12 })
    expect((await getLobbyById(kv, lobby.id))?.slots).toHaveLength(12)
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

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)
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

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)
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

  test('removing yourself from a slot clears lobby membership so you can rejoin', async () => {
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
      playerId: 'guest',
      displayName: 'Guest',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'guest'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'guest'], withMember ?? lobby)
    expect(withSlots).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const removeResponse = await app.request('/api/lobby/1v1/remove', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({ userId: 'guest', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    expect(await getLobbyForUser(getExistingTestLobbyRuntime(kv).db, 'guest')).toBeNull()

    const rejoinResponse = await app.request('/api/lobby/1v1/place', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({
        userId: 'guest',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'Guest',
        avatarUrl: null,
      }),
    }, buildEnv(kv))

    expect(rejoinResponse.status).toBe(200)
    const updatedLobby = await getLobbyById(kv, lobby.id)
    expect(updatedLobby?.memberPlayerIds).toEqual(['host', 'guest'])
  })

  test('removing yourself keeps the current lobby available for spectating', async () => {
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
      playerId: 'guest',
      displayName: 'Guest',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const withMember = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'guest'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'guest'], withMember ?? lobby)
    expect(withSlots).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const removeResponse = await app.request('/api/lobby/1v1/remove', {
      method: 'POST',
      headers: buildAuthHeaders('guest', 'Guest'),
      body: JSON.stringify({ userId: 'guest', slot: 1, lobbyId: lobby.id }),
    }, buildEnv(kv))
    expect(removeResponse.status).toBe(200)

    const snapshot = await buildActivityLaunchSnapshot('token', 'secret', kv, lobby.channelId, 'guest', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toContainEqual(expect.objectContaining({ kind: 'lobby', id: lobby.id }))
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

  test('mode changes preserve closed lobbies', async () => {
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

    const closedLobby = await setLobbyDraftConfig(kv, lobby.id, { ...lobby.draftConfig, closed: true }, lobby)
    expect(closedLobby?.draftConfig.closed).toBe(true)

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
        nextMode: '3v3',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mode: '3v3',
      draftConfig: { closed: true },
    })
    expect((await getLobbyById(kv, lobby.id))?.draftConfig.closed).toBe(true)
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

  test('mode changes preserve blind bans off when the destination FFA mode supports them', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '3v3',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '3v3', {
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
      blindBans: false,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    }, lobby)
    expect(configuredLobby).not.toBeNull()

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await app.request('/api/lobby/3v3/mode', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        nextMode: 'ffa',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mode: 'ffa',
      draftConfig: { blindBans: false },
    })
    expect((await getLobbyById(kv, lobby.id))?.draftConfig.blindBans).toBe(false)
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

  test('mode changes use canonical member ids instead of slotted queue residue', async () => {
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

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2', 'p3', 'p4', 'p5'], lobby)
    await setLobbySlots(kv, lobby.id, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], withMembers ?? lobby)

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
    expect(updatedLobby?.memberPlayerIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(updatedLobby?.slots.filter((playerId): playerId is string => playerId != null)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(updatedLobby?.slots).not.toContain('p6')
  })

  test('lobby config defaults blind bans on and preserves false for supported modes', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    const lobby = await createLobby(kv, {
      mode: '3v3',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '3v3', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    expect((await getLobbyById(kv, lobby.id))?.draftConfig.blindBans).toBe(true)

    const response = await app.request('/api/lobby/3v3/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        blindBans: false,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      draftConfig: { blindBans: false },
    })
    expect((await getLobbyById(kv, lobby.id))?.draftConfig.blindBans).toBe(false)
  })

  test('lobby config preserves blind bans false for 1v1', async () => {
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
        blindBans: false,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      draftConfig: { blindBans: false },
    })
    expect((await getLobbyById(kv, lobby.id))?.draftConfig.blindBans).toBe(false)
  })

  test('lobby config preserves FFA draft bans and forces blind bans on for unsupported modes and sizes', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const ffaLobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'ffa-host',
      channelId: 'channel-ffa',
      messageId: 'message-ffa',
    })
    await addToQueue(kv, 'ffa', {
      playerId: 'ffa-host',
      displayName: 'FFA Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const ffaResponse = await app.request('/api/lobby/ffa/config', {
      method: 'POST',
      headers: buildAuthHeaders('ffa-host', 'FFA Host'),
      body: JSON.stringify({
        userId: 'ffa-host',
        lobbyId: ffaLobby.id,
        blindBans: false,
      }),
    }, buildEnv(kv))

    expect(ffaResponse.status).toBe(200)
    await expect(ffaResponse.json()).resolves.toMatchObject({
      draftConfig: { blindBans: false },
    })
    expect((await getLobbyById(kv, ffaLobby.id))?.draftConfig.blindBans).toBe(false)

    const redDeathLobby = await createLobby(kv, {
      mode: '3v3',
      hostId: 'red-death-host',
      channelId: 'channel-red-death',
      messageId: 'message-red-death',
    })
    await addToQueue(kv, '3v3', {
      playerId: 'red-death-host',
      displayName: 'Red Death Host',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const redDeathResponse = await app.request('/api/lobby/3v3/config', {
      method: 'POST',
      headers: buildAuthHeaders('red-death-host', 'Red Death Host'),
      body: JSON.stringify({
        userId: 'red-death-host',
        lobbyId: redDeathLobby.id,
        blindBans: false,
        redDeath: true,
      }),
    }, buildEnv(kv))

    expect(redDeathResponse.status).toBe(200)
    await expect(redDeathResponse.json()).resolves.toMatchObject({
      draftConfig: { blindBans: true, redDeath: true },
    })
    expect((await getLobbyById(kv, redDeathLobby.id))?.draftConfig.blindBans).toBe(true)

    const oversizedLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'oversized-host',
      channelId: 'channel-oversized',
      messageId: 'message-oversized',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'oversized-host',
      displayName: 'Oversized Host',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const oversizedResponse = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('oversized-host', 'Oversized Host'),
      body: JSON.stringify({
        userId: 'oversized-host',
        lobbyId: oversizedLobby.id,
        blindBans: false,
        targetSize: 8,
      }),
    }, buildEnv(kv))

    expect(oversizedResponse.status).toBe(200)
    await expect(oversizedResponse.json()).resolves.toMatchObject({
      draftConfig: { blindBans: true },
      targetSize: 8,
    })
    const updatedOversizedLobby = await getLobbyById(kv, oversizedLobby.id)
    expect(updatedOversizedLobby?.draftConfig.blindBans).toBe(true)
    expect(updatedOversizedLobby?.slots).toEqual(['oversized-host', null, null, null, null, null, null, null])
  })

  test('lobby config shrink applies blind bans against the destination 2v2 size', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerLobbyRoutes(app as any)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

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

    const expandedLobby = await setLobbySlots(kv, lobby.id, ['host', null, null, null, null, null, null, null], lobby)
    expect(expandedLobby?.draftConfig.blindBans).toBe(true)

    const response = await app.request('/api/lobby/2v2/config', {
      method: 'POST',
      headers: buildAuthHeaders('host', 'Host'),
      body: JSON.stringify({
        userId: 'host',
        lobbyId: lobby.id,
        targetSize: 4,
        blindBans: false,
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      draftConfig: { blindBans: false },
      targetSize: 4,
    })
    expect((await getLobbyById(kv, lobby.id))?.draftConfig.blindBans).toBe(false)
    expect((await getLobbyById(kv, lobby.id))?.slots).toEqual(['host', null, null, null])
  })
})

function buildEnv(kv: KVNamespace) {
  return buildTestLobbyEnv(kv, {
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  }) as any
}

function buildAuthHeaders(userId: string, displayName = userId): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-CivUp-Internal-Secret': 'secret',
    'X-CivUp-Activity-User-Id': userId,
    'X-CivUp-Activity-Display-Name': displayName,
  }
}

async function flushBackgroundTasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
