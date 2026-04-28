import { PARTYSERVER_NAMESPACE_HEADER, PARTYSERVER_ROOM_HEADER, verifySessionAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { sessionDirectory } from '@civup/db'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { buildActivityLaunchSnapshot, registerActivityRoutes, resolveLobbyJoinEligibility, selectActivityTargetForUser } from '../../src/routes/activity.ts'
import { storeActivityLaunchTargetSelection } from '../../src/services/activity/launch-target.ts'
import { buildOpenLobbySnapshot, buildOpenLobbySnapshotFromParts, resolveOpenLobbyFromBody } from '../../src/routes/lobby/snapshot.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { buildTestLobbyEnv, createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const TITAN_ROLE_ID = '99999999999999999'
const activityNamespaces = new WeakMap<KVNamespace, DurableObjectNamespace>()

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
    await startTestSessionDraft(kv, liveLobby.id, liveLobby)

    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'player-1', {
      kind: 'lobby',
      id: openLobby.id,
    }, activityRuntimeOptions(kv))
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    const snapshot = selected.snapshot
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
    await startTestSessionDraft(kv, liveLobby.id, liveLobby)

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

  test('blocks joining when the active match is not yet reportable', async () => {
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
    const draftingLobby = await startTestSessionDraft(kv, liveLobby.id, liveLobby)
    await setLobbyStatus(kv, liveLobby.id, 'active', draftingLobby ?? liveLobby)

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', openLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', openLobby, snapshot, {
      db: activityRuntimeOptions(kv).db,
    })

    expect(eligibility).toEqual({
      canJoin: false,
      blockedReason: 'You are already in a live match.',
      pendingSlot: null,
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

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', targetLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', targetLobby, snapshot, activityRuntimeOptions(kv))

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })

  test('ignores stale open-lobby member residue when evaluating another lobby', async () => {
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
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const staleSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['host-1', 'player-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['host-1', null, null, null], staleSource ?? sourceLobby)

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', targetLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', targetLobby, snapshot, activityRuntimeOptions(kv))

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

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', targetLobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-1', targetLobby, snapshot, activityRuntimeOptions(kv))

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
  test('rejects a clicked target when it is already gone', async () => {
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
  })

  test('resolves the viewer canonical lobby without user lobby mappings', async () => {
    const { kv } = createTrackedKv()
    const app = new Hono()
    registerActivityRoutes(app as any)

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })
    await createLobby(kv, {
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
    const hostQueueEntry = {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    }
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      queueEntries: [hostQueueEntry],
    })
    await kv.put(leaderboardModeSnapshotKey('duo'), JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      rows: [
        { playerId: 'host-1', mu: 31, sigma: 3, gamesPlayed: 12, wins: 7, lastPlayedAt: null },
      ],
    }))

    const snapshot = await buildOpenLobbySnapshotFromParts(kv, '2v2', lobby, [hostQueueEntry], lobby.slots)
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

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toHaveLength(1)
    expect(snapshot.options[0]).toEqual(expect.objectContaining({
      kind: 'lobby',
      channelId: 'channel-1',
      isHost: false,
      isMember: false,
    }))
  })

  test('prefers the viewer\'s current lobby by canonical membership', async () => {
    const { kv } = createTrackedKv()
    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })
    await createLobby(kv, {
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

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, currentLobby.channelId, 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('lobby')
    if (snapshot.selection?.kind !== 'lobby') return

    expect(snapshot.selection.option.id).toBe(currentLobby.id)
    expect(snapshot.selection.option.isMember).toBe(true)
  })

  test('prefers an open lobby over an old reportable active match for default focus', async () => {
    const { kv } = createTrackedKv()
    const oldMatchLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-active',
    })
    await addToQueue(kv, '2v2', { playerId: 'player-1', displayName: 'Player 1', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 })
    const draftingLobby = await startTestSessionDraft(kv, oldMatchLobby.id, oldMatchLobby)
    await setLobbyStatus(kv, oldMatchLobby.id, 'active', draftingLobby ?? oldMatchLobby)

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, currentLobby.channelId, 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'match', id: oldMatchLobby.id, status: 'active', isMember: true }),
      expect.objectContaining({ kind: 'lobby', id: currentLobby.id, isHost: true }),
    ]))
    expect(snapshot.selection?.kind).toBe('lobby')
    expect(snapshot.selection?.option.id).toBe(currentLobby.id)
  })

  test('does not auto-open a lone reportable active match', async () => {
    const { kv } = createTrackedKv()
    const oldMatchLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-active',
    })
    await addToQueue(kv, '2v2', { playerId: 'player-1', displayName: 'Player 1', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 })
    const draftingLobby = await startTestSessionDraft(kv, oldMatchLobby.id, oldMatchLobby)
    await setLobbyStatus(kv, oldMatchLobby.id, 'active', draftingLobby ?? oldMatchLobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, oldMatchLobby.channelId, 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual([expect.objectContaining({ kind: 'match', id: oldMatchLobby.id, status: 'active', isMember: true })])
  })

  test('opens a clicked reportable active match from a launch target hint', async () => {
    const { kv } = createTrackedKv()
    const matchLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-active',
    })
    await addToQueue(kv, '2v2', { playerId: 'player-1', displayName: 'Player 1', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 })
    const draftingLobby = await startTestSessionDraft(kv, matchLobby.id, matchLobby)
    await setLobbyStatus(kv, matchLobby.id, 'active', draftingLobby ?? matchLobby)

    await storeActivityLaunchTargetSelection(activityRuntimeOptions(kv).activityNamespace, 'secret', 'channel-1', 'player-1', { kind: 'match', id: matchLobby.id })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, matchLobby.channelId, 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(matchLobby.id)
    expect(snapshot.selection.option.id).toBe(matchLobby.id)

    const reopened = await buildActivityLaunchSnapshot(undefined, 'secret', kv, matchLobby.channelId, 'player-1', activityRuntimeOptions(kv))
    expect(reopened.selection?.kind).toBe('match')
    if (reopened.selection?.kind !== 'match') return
    expect(reopened.selection.matchId).toBe(matchLobby.id)
  })

  test('opens a clicked reported match as an already-reported activity target', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-reported',
    })

    await createDbFromRuntime(kv).update(sessionDirectory).set({
      phase: 'reported',
      matchId: lobby.id,
      updatedAt: Date.now(),
      closedAt: Date.now(),
    }).where(eq(sessionDirectory.sessionId, lobby.id))
    await storeActivityLaunchTargetSelection(activityRuntimeOptions(kv).activityNamespace, 'secret', 'button-channel', 'player-1', { kind: 'match', id: lobby.id })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(lobby.id)
    expect(snapshot.selection.option.status).toBe('completed')
    expect(snapshot.selection.sessionAccessToken).toBeNull()
    expect(snapshot.options).toEqual([expect.objectContaining({ kind: 'match', id: lobby.id, status: 'completed' })])
  })

  test('opens a clicked reportable active match when Discord launch channel differs from the button interaction channel', async () => {
    const { kv } = createTrackedKv()
    const matchLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'activity-channel',
      messageId: 'message-active',
    })
    await addToQueue(kv, '2v2', { playerId: 'player-1', displayName: 'Player 1', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 })
    const draftingLobby = await startTestSessionDraft(kv, matchLobby.id, matchLobby)
    await setLobbyStatus(kv, matchLobby.id, 'active', draftingLobby ?? matchLobby)

    await storeActivityLaunchTargetSelection(activityRuntimeOptions(kv).activityNamespace, 'secret', 'button-interaction-channel', 'player-1', { kind: 'match', id: matchLobby.id })

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'activity-channel', 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(matchLobby.id)
  })

  test('keeps a clicked match launch hint when an early hydrate cannot see the target', async () => {
    const { kv } = createTrackedKv()
    const matchLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-active',
    })
    await addToQueue(kv, '2v2', { playerId: 'player-1', displayName: 'Player 1', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 })
    const draftingLobby = await startTestSessionDraft(kv, matchLobby.id, matchLobby)
    await setLobbyStatus(kv, matchLobby.id, 'active', draftingLobby ?? matchLobby)

    await storeActivityLaunchTargetSelection(activityRuntimeOptions(kv).activityNamespace, 'secret', 'button-interaction-channel', 'player-1', { kind: 'match', id: matchLobby.id })

    const staleHydrate = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'empty-channel', 'player-1', activityRuntimeOptions(kv))
    expect(staleHydrate.selection).toBeNull()

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'player-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(matchLobby.id)
  })

  test('keeps open lobby options when queue metadata is missing', async () => {
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
    await startTestSessionDraft(kv, liveLobby.id, liveLobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'lobby',
        id: invalidLobby.id,
        participantCount: 1,
      }),
      expect.objectContaining({
        kind: 'match',
        id: liveLobby.id,
      }),
    ]))
    await expect(resolveOpenLobbyFromBody(createDbFromRuntime(kv), '2v2', { lobbyId: invalidLobby.id })).resolves.toEqual(expect.objectContaining({
      id: invalidLobby.id,
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

    await startTestSessionDraft(kv, lobby.id, lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: lobby.id,
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

    await startTestSessionDraft(kv, lobby.id, lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'host-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(lobby.id)
    expect(snapshot.selection.steamLobbyLink).toBe('steam://joinlobby/289070/12345678901234567/76561198000000000')
    expect(snapshot.selection.sessionAccessToken).not.toBeNull()
    await expect(verifySessionAccessToken('secret', snapshot.selection.sessionAccessToken, {
      sessionId: lobby.id,
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

    await startTestSessionDraft(kv, lobby.id, lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'host-1', activityRuntimeOptions(kv))
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return

    await expect(verifySessionAccessToken('secret', snapshot.selection.sessionAccessToken, {
      sessionId: lobby.id,
      userId: 'host-1',
      nowMs: Date.now() + 5 * 60 * 60 * 1000,
    })).resolves.not.toBeNull()
  })

  test('allows authenticated spectators to open live session targets read-only when selected', async () => {
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

    await startTestSessionDraft(kv, lobby.id, lobby)

    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, lobby.channelId, 'spectator-1', {
      kind: 'match',
      id: lobby.id,
    }, activityRuntimeOptions(kv))
    expect(selected.ok).toBe(true)
    if (!selected.ok) return

    const snapshot = selected.snapshot
    expect(snapshot.selection?.kind).toBe('match')
    if (snapshot.selection?.kind !== 'match') return
    expect(snapshot.selection.matchId).toBe(lobby.id)
    expect(snapshot.selection.sessionAccessToken).not.toBeNull()
    await expect(verifySessionAccessToken('secret', snapshot.selection.sessionAccessToken, {
      sessionId: lobby.id,
      userId: 'spectator-1',
    })).resolves.not.toBeNull()
  })

  test('does not auto-select spectator matches without local target state', async () => {
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
    await startTestSessionDraft(kv, lobby.id, lobby)

    const snapshot = await buildActivityLaunchSnapshot(undefined, 'secret', kv, lobby.channelId, 'spectator-1', activityRuntimeOptions(kv))
    expect(snapshot.selection).toBeNull()
    expect(snapshot.options).toEqual([expect.objectContaining({ kind: 'match', id: lobby.id })])
  })

  test('selectActivityTargetForUser returns a valid spectator lobby snapshot', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: lobby.id,
    }, activityRuntimeOptions(kv))
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.id).toBe(lobby.id)
  })

  test('selecting a full lobby from overview is spectator-only and does not take a slot', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const playerIds = ['host-1', 'player-2', 'player-3', 'player-4']
    for (let index = 0; index < playerIds.length; index++) {
      await addToQueue(kv, '2v2', {
        playerId: playerIds[index]!,
        displayName: `Player ${index + 1}`,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }
    const fullLobby = await setLobbyMemberPlayerIds(kv, lobby.id, playerIds, lobby)
    await setLobbySlots(kv, lobby.id, playerIds, fullLobby ?? lobby)

    const options = activityRuntimeOptions(kv)
    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: lobby.id,
    }, options)
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.isMember).toBe(false)
    if (selected.snapshot.selection?.kind === 'lobby') {
      expect(selected.snapshot.selection.lobby.memberPlayerIds).not.toContain('spectator-1')
    }
    expect(selected.snapshot.options.find(option => option.id === lobby.id)?.isMember).toBe(false)

    const reopened = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', options)
    expect(reopened.selection?.kind).toBe('lobby')
    expect(reopened.selection?.option.id).toBe(lobby.id)
    expect(reopened.selection?.option.isMember).toBe(false)
    expect(reopened.options.find(option => option.id === lobby.id)?.isMember).toBe(false)

    const persistedLobby = await getLobbyById(kv, lobby.id)
    expect(persistedLobby?.memberPlayerIds).not.toContain('spectator-1')
    expect(persistedLobby?.slots).not.toContain('spectator-1')
  })

  test('selecting an open lobby from overview is spectator-only without taking an empty slot', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const playerIds = ['host-1', 'player-2']
    for (let index = 0; index < playerIds.length; index++) {
      await addToQueue(kv, '2v2', {
        playerId: playerIds[index]!,
        displayName: `Player ${index + 1}`,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }
    const partialLobby = await setLobbyMemberPlayerIds(kv, lobby.id, playerIds, lobby)
    await setLobbySlots(kv, lobby.id, ['host-1', 'player-2', null, null], partialLobby ?? lobby)

    const options = activityRuntimeOptions(kv)
    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: lobby.id,
    }, options)
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.isMember).toBe(false)
    expect(selected.snapshot.selection?.joinEligibility.canJoin).toBe(true)
    expect(selected.snapshot.selection?.joinEligibility.pendingSlot).toBe(2)

    const persistedLobby = await getLobbyById(kv, lobby.id)
    expect(persistedLobby?.memberPlayerIds).not.toContain('spectator-1')
    expect(persistedLobby?.slots).not.toContain('spectator-1')

    const reopened = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', options)
    expect(reopened.selection?.kind).toBe('lobby')
    expect(reopened.selection?.option.id).toBe(lobby.id)
    expect(reopened.selection?.option.isMember).toBe(false)
    expect(reopened.options.find(option => option.id === lobby.id)?.isMember).toBe(false)
  })

  test('uses the authoritative SessionDO roster when a spectator directory projection is stale', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const playerIds = ['host-1', 'player-2', 'player-3', 'player-4']
    for (let index = 0; index < playerIds.length; index++) {
      await addToQueue(kv, '2v2', {
        playerId: playerIds[index]!,
        displayName: `Player ${index + 1}`,
        avatarUrl: null,
        joinedAt: Date.now() + index,
      })
    }
    const fullLobby = await setLobbyMemberPlayerIds(kv, lobby.id, playerIds, lobby)
    await setLobbySlots(kv, lobby.id, playerIds, fullLobby ?? lobby)

    const options = activityRuntimeOptions(kv)
    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: lobby.id,
    }, options)
    expect(selected.ok).toBe(true)

    await createDbFromRuntime(kv).update(sessionDirectory).set({
      rosterJson: JSON.stringify({
        participants: [...playerIds.map((playerId, index) => ({
          playerId,
          displayName: `Player ${index + 1}`,
          avatarUrl: null,
          joinedAt: index + 1,
          slotIndex: index,
        })), {
          playerId: 'spectator-1',
          displayName: 'Spectator One',
          avatarUrl: null,
          joinedAt: 99,
          slotIndex: null,
        }],
        slots: playerIds,
      }),
    }).where(eq(sessionDirectory.sessionId, lobby.id))

    const reopened = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', options)
    expect(reopened.selection?.kind).toBe('lobby')
    expect(reopened.selection?.option.id).toBe(lobby.id)
    expect(reopened.selection?.option.isMember).toBe(false)
    expect(reopened.options.find(option => option.id === lobby.id)?.isMember).toBe(false)
  })

  test('selecting another lobby from overview keeps an existing lobby membership read-only', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'source-host',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'target-host',
      channelId: 'channel-1',
      messageId: 'message-target',
    })

    await addToQueue(kv, '2v2', { playerId: 'source-host', displayName: 'Source Host', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '2v2', { playerId: 'spectator-1', displayName: 'Spectator One', avatarUrl: null, joinedAt: Date.now() + 1 })
    const sourceWithSpectator = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['source-host', 'spectator-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['source-host', 'spectator-1', null, null], sourceWithSpectator ?? sourceLobby)

    const targetPlayerIds = ['target-host', 'player-2', 'player-3', 'player-4']
    for (let index = 0; index < targetPlayerIds.length; index++) {
      await addToQueue(kv, '2v2', {
        playerId: targetPlayerIds[index]!,
        displayName: `Target Player ${index + 1}`,
        avatarUrl: null,
        joinedAt: Date.now() + 10 + index,
      })
    }
    const fullTarget = await setLobbyMemberPlayerIds(kv, targetLobby.id, targetPlayerIds, targetLobby)
    await setLobbySlots(kv, targetLobby.id, targetPlayerIds, fullTarget ?? targetLobby)

    const options = activityRuntimeOptions(kv)
    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'spectator-1', {
      kind: 'lobby',
      id: targetLobby.id,
    }, options)

    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.id).toBe(targetLobby.id)
    expect(selected.snapshot.selection?.option.isMember).toBe(false)
    expect(selected.snapshot.options.find(option => option.id === sourceLobby.id)?.isMember).toBe(true)

    const sourceAfter = await getLobbyById(kv, sourceLobby.id)
    const targetAfter = await getLobbyById(kv, targetLobby.id)
    expect(sourceAfter?.memberPlayerIds).toContain('spectator-1')
    expect(sourceAfter?.slots).toContain('spectator-1')
    expect(targetAfter?.memberPlayerIds).not.toContain('spectator-1')
    expect(targetAfter?.slots).not.toContain('spectator-1')

    const reopened = await buildActivityLaunchSnapshot(undefined, 'secret', kv, 'channel-1', 'spectator-1', options)
    expect(reopened.selection?.kind).toBe('lobby')
    expect(reopened.selection?.option.id).toBe(targetLobby.id)
    expect(reopened.selection?.option.isMember).toBe(false)
    expect(reopened.options.find(option => option.id === sourceLobby.id)?.isMember).toBe(true)
  })

  test('selecting another lobby from overview does not cancel a solo hosted lobby', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'target-host',
      channelId: 'channel-1',
      messageId: 'message-target',
    })

    await addToQueue(kv, '1v1', { playerId: 'host-1', displayName: 'Host One', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '1v1', { playerId: 'target-host', displayName: 'Target Host', avatarUrl: null, joinedAt: Date.now() + 1 })
    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['host-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['host-1', null], populatedSource ?? sourceLobby)

    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'host-1', {
      kind: 'lobby',
      id: targetLobby.id,
    }, activityRuntimeOptions(kv))

    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.id).toBe(targetLobby.id)
    expect(selected.snapshot.selection?.option.isMember).toBe(false)
    expect(selected.snapshot.selection?.option.isHost).toBe(false)

    const sourceAfter = await getLobbyById(kv, sourceLobby.id)
    const targetAfter = await getLobbyById(kv, targetLobby.id)
    expect(sourceAfter?.status).toBe('open')
    expect(sourceAfter?.memberPlayerIds).toEqual(['host-1'])
    expect(sourceAfter?.slots).toEqual(['host-1', null])
    expect(targetAfter?.status).toBe('open')
    expect(targetAfter?.memberPlayerIds).not.toContain('host-1')
    expect(targetAfter?.slots).not.toContain('host-1')
  })

  test('selecting another lobby from overview does not move a seated player', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'source-host',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'target-host',
      channelId: 'channel-1',
      messageId: 'message-target',
    })

    await addToQueue(kv, '1v1', { playerId: 'source-host', displayName: 'Source Host', avatarUrl: null, joinedAt: Date.now() })
    await addToQueue(kv, '1v1', { playerId: 'player-1', displayName: 'Player One', avatarUrl: null, joinedAt: Date.now() + 1 })
    await addToQueue(kv, '1v1', { playerId: 'target-host', displayName: 'Target Host', avatarUrl: null, joinedAt: Date.now() + 2 })
    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['source-host', 'player-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['source-host', 'player-1'], populatedSource ?? sourceLobby)

    const selected = await selectActivityTargetForUser(undefined, 'secret', kv, 'channel-1', 'player-1', {
      kind: 'lobby',
      id: targetLobby.id,
    }, activityRuntimeOptions(kv))

    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.snapshot.selection?.kind).toBe('lobby')
    expect(selected.snapshot.selection?.option.id).toBe(targetLobby.id)
    expect(selected.snapshot.selection?.option.isMember).toBe(false)

    const sourceAfter = await getLobbyById(kv, sourceLobby.id)
    const targetAfter = await getLobbyById(kv, targetLobby.id)
    expect(sourceAfter?.memberPlayerIds).toEqual(['source-host', 'player-1'])
    expect(sourceAfter?.slots).toEqual(['source-host', 'player-1'])
    expect(targetAfter?.memberPlayerIds).not.toContain('player-1')
    expect(targetAfter?.slots).not.toContain('player-1')
  })
})

function buildEnv(kv: KVNamespace) {
  return buildTestLobbyEnv(kv, {
    Activity: getTestActivityNamespace(kv),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'key',
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  }) as any
}

function activityRuntimeOptions(kv: KVNamespace) {
  const runtime = getExistingTestLobbyRuntime(kv)
  return { db: runtime.d1, sessionNamespace: runtime.sessionNamespace, activityNamespace: getTestActivityNamespace(kv), internalSecret: 'secret' }
}

function getTestActivityNamespace(kv: KVNamespace): DurableObjectNamespace {
  const existing = activityNamespaces.get(kv)
  if (existing) return existing
  const rooms = new Map<string, unknown>()
  const namespace = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const roomId = String(id)
      if (!rooms.has(roomId)) rooms.set(roomId, null)
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          if (request.headers.get(PARTYSERVER_ROOM_HEADER) !== roomId || request.headers.get(PARTYSERVER_NAMESPACE_HEADER) !== 'activity') {
            return new Response('Missing namespace or room headers', { status: 500 })
          }
          if (request.method === 'GET') return new Response(JSON.stringify({ target: rooms.get(roomId) ?? null }), { headers: { 'Content-Type': 'application/json' } })
          if (request.method === 'DELETE') {
            rooms.set(roomId, null)
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
          }
          if (request.method === 'POST') {
            rooms.set(roomId, await request.json())
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
          }
          return new Response('Method not allowed', { status: 405 })
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
  activityNamespaces.set(kv, namespace)
  return namespace
}

function createDbFromRuntime(kv: KVNamespace) {
  return getExistingTestLobbyRuntime(kv).db
}

function buildDb(
  liveMatches:
    | string[]
    | {
      liveMatchPlayerIds?: string[] | null
      liveMatchIds?: string[] | null
    }
    | null,
): D1Database {
  if (liveMatches == null) return {} as D1Database

  const config = Array.isArray(liveMatches)
    ? { liveMatchPlayerIds: liveMatches, liveMatchIds: [] }
    : liveMatches
  const livePlayerIdSet = new Set(config.liveMatchPlayerIds ?? [])
  const liveMatchIdSet = new Set(config.liveMatchIds ?? [])

  return {
    prepare(query?: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              if (typeof query === 'string' && query.includes('FROM matches') && query.includes('WHERE id IN')) {
                return {
                  results: values
                    .filter((value): value is string => typeof value === 'string' && liveMatchIdSet.has(value))
                    .map(id => ({ id })),
                }
              }

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
