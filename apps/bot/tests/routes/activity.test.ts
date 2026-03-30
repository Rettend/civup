import { verifyDraftRoomAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot, registerActivityRoutes, resolveLobbyJoinEligibility, selectActivityTargetForUser } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot } from '../../src/routes/lobby/snapshot.ts'
import { getUserActivityTarget, handoffLobbySpectatorsToMatchActivity, storeUserActivityTarget, storeUserLobbyState } from '../../src/services/activity/index.ts'
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

  test('blocks joining another lobby after reopening while already in a live match', async () => {
    const { kv } = createTrackedKv()
    const liveLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-live',
    })
    const openLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
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
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await attachLobbyMatch(kv, liveLobby.id, 'match-1', liveLobby)
    await storeUserActivityTarget(kv, 'channel-1', ['player-1'], { kind: 'lobby', id: openLobby.id })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'player-1')
    expect(snapshot.selection?.kind).toBe('lobby')
    if (snapshot.selection?.kind !== 'lobby') return

    expect(snapshot.selection.option.id).toBe(openLobby.id)
    expect(snapshot.selection.joinEligibility).toEqual({
      canJoin: false,
      blockedReason: 'You are already in a live match.',
      pendingSlot: null,
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
  test('rejects a clicked target when it is already gone and clears the stale selection', async () => {
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

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'That target is no longer available.' })
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

  test('does not auto-select unrelated open lobbies for spectators', async () => {
    const { kv } = createTrackedKv()
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

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1')
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toHaveLength(1)
    expect(snapshot.options[0]).toEqual(expect.objectContaining({
      kind: 'lobby',
      channelId: 'channel-1',
      isHost: false,
      isMember: false,
    }))
  })

  test('does not auto-select unrelated live matches for spectators', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1')
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: 'match-1',
        isHost: false,
        isMember: false,
      }),
    ])
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

  test('keeps live match activity tokens valid for long games', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'host-1')
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return

    await expect(verifyDraftRoomAccessToken('secret', snapshot.selection.roomAccessToken, {
      roomId: 'match-1',
      userId: 'host-1',
      nowMs: Date.now() + 5 * 60 * 60 * 1000,
    })).resolves.not.toBeNull()
  })

  test('allows authenticated spectators to open live match targets read-only when selected', async () => {
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

    await expect(selectActivityTargetForUser(kv, lobby.channelId, 'spectator-1', {
      kind: 'match',
      id: 'match-1',
      activitySecret: 'secret',
    })).resolves.toEqual({ ok: true })

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

  test('promotes stale spectator lobby targets into the same lobby draft before handoff', async () => {
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
    await storeUserActivityTarget(kv, lobby.channelId, ['spectator-1'], { kind: 'lobby', id: lobby.id })
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
    await expect(getUserActivityTarget(kv, lobby.channelId, 'spectator-1')).resolves.toEqual(expect.objectContaining({
      kind: 'lobby',
      id: lobby.id,
    }))
  })

  test('retargeted lobby spectators launch straight into the draft', async () => {
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
    await storeUserActivityTarget(kv, 'channel-1', ['spectator-1'], { kind: 'lobby', id: lobby.id })
    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    await handoffLobbySpectatorsToMatchActivity(kv, lobby.channelId, lobby.id, lobby.memberPlayerIds, {
      matchId: 'match-1',
      lobbyId: lobby.id,
      mode: lobby.mode,
      activitySecret: 'secret',
    })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1')
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe('match-1')
    expect(snapshot.selection.roomAccessToken).not.toBeNull()
  })

  test('spectator lobby-state mappings also hand off into the draft', async () => {
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
    await storeUserLobbyState(kv, 'channel-1', ['spectator-1'], lobby.id)
    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    await handoffLobbySpectatorsToMatchActivity(kv, lobby.channelId, lobby.id, lobby.memberPlayerIds, {
      matchId: 'match-1',
      lobbyId: lobby.id,
      mode: lobby.mode,
      activitySecret: 'secret',
    })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1')
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe('match-1')
    expect(snapshot.selection.roomAccessToken).not.toBeNull()
  })

  test('selectActivityTargetForUser stores a valid spectator lobby target', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await expect(selectActivityTargetForUser(kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: lobby.id,
      activitySecret: 'secret',
    })).resolves.toEqual({ ok: true })

    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-1')).resolves.toEqual(expect.objectContaining({
      kind: 'lobby',
      id: lobby.id,
    }))
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
