import { verifyDraftRoomAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActivityLaunchSnapshot, registerActivityRoutes, resolveLobbyJoinEligibility, selectActivityTargetForUser } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot, resolveOpenLobbyFromBody } from '../../src/routes/lobby/snapshot.ts'
import { getUserActivityTarget, handoffLobbySpectatorsToMatchActivity, storeMatchActivityState, storeUserActivityTarget, storeUserLobbyMappings, storeUserLobbyState } from '../../src/services/activity/index.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots } from '../../src/services/lobby/index.ts'
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

  test('ignores stale live-match lobbies when D1 shows no live match', async () => {
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
      channelId: 'channel-2',
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
    await attachLobbyMatch(kv, liveLobby.id, 'match-stale', liveLobby)

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', openLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', openLobby, snapshot, {
      db: buildDb([]),
    })

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })

  test('allows joining another open lobby when the viewer is not the source host', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-2',
      messageId: 'message-target',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['host-1', 'player-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['host-1', 'player-1', null, null], populatedSource ?? sourceLobby)
    await storeUserLobbyState(kv, sourceLobby.channelId, ['player-1'], sourceLobby.id)

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', targetLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', targetLobby, snapshot)

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })

  test('blocks joining another open lobby when the viewer is hosting players in the source lobby', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-2',
      messageId: 'message-target',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'ally-1',
      displayName: 'Ally 1',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['player-1', 'ally-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['player-1', 'ally-1', null, null], populatedSource ?? sourceLobby)
    await storeUserLobbyState(kv, sourceLobby.channelId, ['player-1'], sourceLobby.id)

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', targetLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', targetLobby, snapshot)

    expect(eligibility).toEqual({
      canJoin: false,
      blockedReason: 'You are hosting another open lobby with other players. Cancel it first.',
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

  test('ignores stale user lobby mappings that no longer include the viewer', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerActivityRoutes(app as any)

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })
    const staleLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-stale',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedCurrentLobby = await setLobbyMemberPlayerIds(kv, currentLobby.id, ['host-1', 'player-1'], currentLobby)
    await setLobbySlots(kv, currentLobby.id, ['host-1', 'player-1', null, null], populatedCurrentLobby ?? currentLobby)
    await storeUserLobbyMappings(kv, ['player-1'], staleLobby.id)

    const response = await app.request('/api/lobby/user/player-1', {
      headers: buildAuthHeaders('player-1'),
    }, buildEnv(kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ id: currentLobby.id }))
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

  test('includes cached balance ratings in open lobby snapshots', async () => {
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
    await kv.put(leaderboardModeSnapshotKey('duo'), JSON.stringify({
      updatedAt: Date.now(),
      rows: [
        { playerId: 'host-1', mu: 31, sigma: 3, gamesPlayed: 12, wins: 7, lastPlayedAt: null },
      ],
    }))

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', lobby)
    const hostEntry = snapshot.entries.find(entry => entry?.playerId === 'host-1') ?? null

    expect(hostEntry).toEqual(expect.objectContaining({
      playerId: 'host-1',
      balanceRating: {
        mu: 31,
        sigma: 3,
        gamesPlayed: 12,
      },
    }))
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

  test('prefers the viewer\'s current lobby over a stale open-lobby target in the same channel', async () => {
    const { kv } = createTrackedKv()
    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })
    const staleLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-stale',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedCurrentLobby = await setLobbyMemberPlayerIds(kv, currentLobby.id, ['host-1', 'player-1'], currentLobby)
    await setLobbySlots(kv, currentLobby.id, ['host-1', 'player-1', null, null], populatedCurrentLobby ?? currentLobby)
    await storeUserLobbyState(kv, currentLobby.channelId, ['player-1'], currentLobby.id)
    await storeUserActivityTarget(kv, currentLobby.channelId, ['player-1'], { kind: 'lobby', id: staleLobby.id })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, currentLobby.channelId, 'player-1')
    expect(snapshot.selection?.kind).toBe('lobby')
    if (snapshot.selection?.kind !== 'lobby') return

    expect(snapshot.selection.option.id).toBe(currentLobby.id)
    expect(snapshot.selection.option.isMember).toBe(true)
  })

  test('ignores invalid open lobbies with no queued host', async () => {
    const { kv } = createTrackedKv()
    const invalidLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-open',
    })
    const liveLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-live',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await attachLobbyMatch(kv, liveLobby.id, 'match-1', liveLobby)
    await storeMatchActivityState(kv, 'channel-1', ['spectator-1'], {
      matchId: 'match-1',
      lobbyId: liveLobby.id,
      mode: '2v2',
      activitySecret: 'secret',
    })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1')
    expect(snapshot.selection?.kind).toBe('match')
    expect(snapshot.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: 'match-1',
      }),
    ])
    await expect(resolveOpenLobbyFromBody(kv, '2v2', { lobbyId: invalidLobby.id })).resolves.toBeNull()
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
    DB: buildDb(null),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  } as any
}

function buildDb(liveMatchPlayerIds: string[] | null): D1Database {
  if (liveMatchPlayerIds == null) return {} as D1Database

  const livePlayerIdSet = new Set(liveMatchPlayerIds)
  return {
    prepare() {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return {
                results: values
                  .filter((value): value is string => typeof value === 'string' && livePlayerIdSet.has(value))
                  .map(playerId => ({ playerId, matchId: `match:${playerId}` })),
              }
            },
          }
        },
      }
    },
  } as D1Database
}

function buildAuthHeaders(userId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-CivUp-Internal-Secret': 'secret',
    'X-CivUp-Activity-User-Id': userId,
    'X-CivUp-Activity-Display-Name': userId,
  }
}
