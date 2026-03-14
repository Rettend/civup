import { verifyDraftRoomAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot, registerActivityRoutes, resolveLobbyJoinEligibility } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot } from '../../src/routes/lobby/snapshot.ts'
import { getUserActivityTarget, storeUserActivityTarget } from '../../src/services/activity/index.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyMaxRole, setLobbyMinRole } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const TITAN_ROLE_ID = '99999999999999999'

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

  test('allows direct activity joins even when the viewer exceeds the matchmaking max rank', async () => {
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

    await setLobbyMaxRole(kv, lobby.id, 'tier2')
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: TITAN_ROLE_ID,
      tier2: '11111111111111111',
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [TITAN_ROLE_ID] }), {
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
      headers: buildAuthHeaders('spectator-1'),
      body: JSON.stringify({
        channelId: 'channel-1',
        userId: 'spectator-1',
        kind: 'match',
        id: 'missing-match',
      }),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    const snapshot = await response.json() as {
      selection: { kind: string, option: { kind: string, status: string, id: string } } | null
      options: Array<{ kind: string, status: string, id: string }>
    }

    expect(snapshot.selection).toEqual(expect.objectContaining({
      kind: 'lobby',
      option: expect.objectContaining({
        kind: 'lobby',
        status: 'open',
      }),
    }))
    expect(snapshot.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: expect.any(String),
        status: 'open',
      }),
    ])
    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-1')).resolves.toBeNull()
  })

  test('includes the Steam lobby link in open lobby snapshots', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', lobby)
    expect(snapshot.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
  })

  test('includes the Steam lobby link in live match activity selections', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
    })

    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'host-1')
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe('match-1')
    expect(snapshot.selection.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
    expect(snapshot.selection.roomAccessToken).not.toBeNull()
    await expect(verifyDraftRoomAccessToken('secret', snapshot.selection.roomAccessToken, {
      roomId: 'match-1',
      userId: 'host-1',
    })).resolves.not.toBeNull()
  })

  test('allows authenticated spectators to open live match targets read-only', async () => {
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

    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1')
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe('match-1')
    expect(snapshot.selection.roomAccessToken).not.toBeNull()
    await expect(verifyDraftRoomAccessToken('secret', snapshot.selection.roomAccessToken, {
      roomId: 'match-1',
      userId: 'spectator-1',
    })).resolves.not.toBeNull()
  })
})

function buildEnv(kv: KVNamespace) {
  return {
    KV: kv,
    DB: {} as any,
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  } as any
}

function buildAuthHeaders(userId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-CivUp-Internal-Secret': 'secret',
    'X-CivUp-Activity-User-Id': userId,
    'X-CivUp-Activity-Display-Name': userId,
  }
}
