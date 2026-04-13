import type { DraftState } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { activityOverviewKey, syncActivityOverviewSnapshot } from '../../src/services/activity/live-state.ts'
import { attachLobbyMatch, clearLobbyById, createLobby, getCurrentLobbyHostedBy, getLobbyByChannel, getLobbyById, getLobbyByMatch, getLobbyDraftRoster, reopenLobbyAfterTimedOutDraft, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus, storeLobbyDraftRoster } from '../../src/services/lobby/index.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { hostKey, idKey, LOBBY_TTL, matchKey } from '../../src/services/lobby/keys.ts'
import { lobbySnapshotKey, syncLobbyDerivedState } from '../../src/services/lobby/live-snapshot.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS } from '../../src/services/match/retention.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby service KV write behavior', () => {
  test('setLobbySlots skips KV writes when slots are unchanged', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    resetOperations()
    const result = await setLobbySlots(kv, lobby.id, [...lobby.slots])

    expect(result).not.toBeNull()
    expect(result?.updatedAt).toBe(lobby.updatedAt)
    expect(operations).toHaveLength(0)
  })

  test('setLobbySlots writes when slots change', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'

    resetOperations()
    const result = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(result).not.toBeNull()
    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    expect(putKeys).toContain(`lobby:mode:ffa:${lobby.id}`)
  })

  test('setLobbySlots rewrites the mode index value when revision changes', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    expect(await kv.get(`lobby:mode:ffa:${lobby.id}`)).toBe(String(lobby.revision))

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(updated).not.toBeNull()
    expect(await kv.get(`lobby:mode:ffa:${lobby.id}`)).toBe(String(updated?.revision))
  })

  test('setLobbySlots bumps revision when slots change', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(updated).not.toBeNull()
    expect(updated?.revision).toBe(lobby.revision + 1)
  })

  test('setLobbyStatus blocks invalid transition chain', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    resetOperations()
    const updated = await setLobbyStatus(kv, lobby.id, 'completed')

    expect(updated).toBeNull()
    expect(operations).toHaveLength(0)
  })

  test('getLobbyByChannel resolves mapped lobby', async () => {
    const { kv } = createTrackedKv()
    const created = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const byChannel = await getLobbyByChannel(kv, 'channel-1')
    expect(byChannel).not.toBeNull()
    expect(byChannel?.mode).toBe(created.mode)
    expect(byChannel?.hostId).toBe(created.hostId)
  })

  test('retains live lobby state longer than abandoned active matches', () => {
    expect(LOBBY_TTL * 1000).toBeGreaterThan(STALE_ACTIVE_MATCH_TIMEOUT_MS)
  })

  test('setLobbyMinRole persists the configured gate', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setLobbyMinRole(kv, lobby.id, 'tier3')
    const stored = await getLobbyById(kv, lobby.id)

    expect(stored?.minRole).toBe('tier3')
    expect(stored?.guildId).toBe('guild-1')
  })

  test('setLobbyMaxRole persists the configured cap', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setLobbyMaxRole(kv, lobby.id, 'tier2')
    const stored = await getLobbyById(kv, lobby.id)

    expect(stored?.maxRole).toBe('tier2')
    expect(stored?.guildId).toBe('guild-1')
  })

  test('publishes live snapshots for open lobby changes', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, 'ffa', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host-1', 'player-2'], lobby)
    const nextSlots = [...(withMembers?.slots ?? lobby.slots)]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots, withMembers ?? lobby)
    await syncLobbyDerivedState(kv, updated ?? withMembers ?? lobby)

    expect(updated).not.toBeNull()
    const snapshot = await kv.get(lobbySnapshotKey(lobby.id), 'json') as {
      revision?: unknown
      entries?: Array<{ playerId?: unknown, displayName?: unknown } | null>
    } | null

    expect(snapshot?.revision).toBe(updated?.revision)
    expect(snapshot?.entries?.[0]).toEqual({ playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: [] })
    expect(snapshot?.entries?.[1]).toEqual({ playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, partyIds: [] })
  })

  test('removes live snapshots when a lobby stops being open', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    expect(await kv.get(lobbySnapshotKey(lobby.id), 'json')).not.toBeNull()

    const updated = await setLobbyStatus(kv, lobby.id, 'drafting')
    await syncLobbyDerivedState(kv, updated ?? lobby)

    expect(await kv.get(lobbySnapshotKey(lobby.id), 'json')).toBeNull()
  })

  test('stores six players as the expanded 2v2 minimum start size', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const updated = await setLobbySlots(kv, lobby.id, ['host-1', null, null, null, null, null, null, null], lobby)
    await syncLobbyDerivedState(kv, updated ?? lobby)

    const snapshot = await kv.get(lobbySnapshotKey(lobby.id), 'json') as {
      minPlayers?: unknown
      targetSize?: unknown
    } | null

    expect(snapshot?.minPlayers).toBe(6)
    expect(snapshot?.targetSize).toBe(8)
  })

  test('stores live snapshots with attached balance ratings', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    await kv.put(leaderboardModeSnapshotKey('duo'), JSON.stringify({
      updatedAt: Date.now(),
      rows: [
        { playerId: 'host-1', mu: 31, sigma: 3, gamesPlayed: 12, wins: 7, lastPlayedAt: null },
      ],
    }))

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await syncLobbyDerivedState(kv, lobby)

    const snapshot = await kv.get(lobbySnapshotKey(lobby.id), 'json') as {
      entries?: Array<{ playerId?: unknown, balanceRating?: { mu?: unknown, sigma?: unknown, gamesPlayed?: unknown } } | null>
    } | null

    expect(snapshot?.entries?.[0]).toEqual({
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      partyIds: [],
      balanceRating: {
        mu: 31,
        sigma: 3,
        gamesPlayed: 12,
      },
    })
  })

  test('automatically refreshes the activity overview snapshot as lobby state changes', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, 'ffa', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    let overview = await kv.get(activityOverviewKey('channel-1'), 'json') as {
      options?: Array<{ kind?: unknown, participantCount?: unknown, status?: unknown, id?: unknown }>
    } | null
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: lobby.id,
        participantCount: 1,
        status: 'open',
      }),
    ])

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host-1', 'player-2'], lobby)
    const nextSlots = [...(withMembers?.slots ?? lobby.slots)]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots, withMembers ?? lobby)
    await syncLobbyDerivedState(kv, updated ?? withMembers ?? lobby)

    overview = await kv.get(activityOverviewKey('channel-1'), 'json') as {
      options?: Array<{ kind?: unknown, participantCount?: unknown, status?: unknown, id?: unknown }>
    } | null
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: lobby.id,
        participantCount: 2,
        status: 'open',
      }),
    ])

    const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', updated ?? withMembers ?? lobby)
    expect(draftingLobby).not.toBeNull()
    await syncLobbyDerivedState(kv, draftingLobby!)

    overview = await kv.get(activityOverviewKey('channel-1'), 'json') as {
      options?: Array<{ kind?: unknown, participantCount?: unknown, status?: unknown, id?: unknown }>
    } | null
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: 'match-1',
        participantCount: 2,
        status: 'drafting',
      }),
    ])

    const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)
    expect(activeLobby).not.toBeNull()
    await syncLobbyDerivedState(kv, activeLobby!)

    overview = await kv.get(activityOverviewKey('channel-1'), 'json') as {
      options?: Array<{ kind?: unknown, participantCount?: unknown, status?: unknown, id?: unknown }>
    } | null
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: 'match-1',
        participantCount: 2,
        status: 'active',
      }),
    ])
  })

  test('clearLobbyById removes active lobbies from the activity overview snapshot', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const activeLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    expect(activeLobby).not.toBeNull()
    await syncLobbyDerivedState(kv, activeLobby!)

    expect(await kv.get(activityOverviewKey('channel-1'), 'json')).toEqual(expect.objectContaining({
      options: [
        expect.objectContaining({
          kind: 'match',
          id: 'match-1',
          lobbyId: lobby.id,
        }),
      ],
    }))

    await clearLobbyById(kv, lobby.id, activeLobby!)

    expect(await kv.get(activityOverviewKey('channel-1'), 'json')).toBeNull()
  })

  test('builds and clears activity overview snapshots on demand for the channel', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await syncActivityOverviewSnapshot(kv, 'channel-1')
    const overview = await kv.get(activityOverviewKey('channel-1'), 'json') as {
      options?: Array<{ kind?: unknown, id?: unknown, hostId?: unknown }>
    } | null
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: lobby.id,
        hostId: 'host-1',
      }),
    ])

    const updated = await setLobbyStatus(kv, lobby.id, 'cancelled')
    await syncLobbyDerivedState(kv, updated ?? lobby)
    await syncActivityOverviewSnapshot(kv, 'channel-1')

    expect(await kv.get(activityOverviewKey('channel-1'), 'json')).toBeNull()
  })

  test('tracks the current hosted lobby without scanning all modes', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await expect(getCurrentLobbyHostedBy(kv, 'host-1')).resolves.toEqual(expect.objectContaining({
      id: lobby.id,
      status: 'open',
    }))

    const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    expect(draftingLobby).not.toBeNull()
    await expect(getCurrentLobbyHostedBy(kv, 'host-1')).resolves.toEqual(expect.objectContaining({
      id: lobby.id,
      status: 'drafting',
    }))
  })

  test('clears orphaned host and match indexes when the lobby record is gone', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    await kv.delete(idKey(lobby.id))

    await clearLobbyById(kv, lobby.id)

    await expect(kv.get(hostKey('host-1'))).resolves.toBeNull()
    await expect(getLobbyByMatch(kv, 'match-1')).resolves.toBeNull()
    await expect(kv.get(matchKey('match-1'))).resolves.toBeNull()
  })

  test('reopens a timed-out draft lobby without the failed picker', async () => {
    const { kv } = createTrackedKv()
    const createdAt = 1_700_000_000_000

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'ally-a', 'ally-b', 'ally-c', 'spectator'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'ally-a', 'ally-b', 'ally-c'], withMembers ?? lobby)
    const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', withSlots ?? withMembers ?? lobby)

    expect(draftingLobby).not.toBeNull()

    await storeLobbyDraftRoster(kv, lobby.id, [
      {
        playerId: 'host',
        displayName: 'Host',
        avatarUrl: null,
        joinedAt: createdAt,
        partyIds: ['ally-a'],
      },
      {
        playerId: 'ally-a',
        displayName: 'Ally A',
        avatarUrl: null,
        joinedAt: createdAt + 1,
        partyIds: ['host'],
      },
      {
        playerId: 'ally-b',
        displayName: 'Ally B',
        avatarUrl: null,
        joinedAt: createdAt + 2,
      },
      {
        playerId: 'ally-c',
        displayName: 'Ally C',
        avatarUrl: null,
        joinedAt: createdAt + 3,
      },
      {
        playerId: 'spectator',
        displayName: 'Spec',
        avatarUrl: null,
        joinedAt: createdAt + 4,
      },
    ])

    const timeoutState: DraftState = {
      matchId: 'match-1',
      formatId: 'default-2v2',
      seats: [
        { playerId: 'host', displayName: 'Host', avatarUrl: null, team: 0 },
        { playerId: 'ally-b', displayName: 'Ally B', avatarUrl: null, team: 1 },
        { playerId: 'ally-a', displayName: 'Ally A', avatarUrl: null, team: 0 },
        { playerId: 'ally-c', displayName: 'Ally C', avatarUrl: null, team: 1 },
      ],
      steps: [
        { action: 'ban', seats: [0, 1], count: 3, timer: 180 },
        { action: 'pick', seats: [0], count: 1, timer: 180 },
      ],
      currentStepIndex: 1,
      submissions: {},
      bans: [],
      picks: [],
      availableCivIds: ['civ-1', 'civ-2'],
      status: 'cancelled',
      cancelReason: 'timeout',
      pendingBlindBans: [],
    }

    const recovered = await reopenLobbyAfterTimedOutDraft(kv, draftingLobby!, timeoutState, {
      draftRoster: await getLobbyDraftRoster(kv, lobby.id),
      now: createdAt + 10,
    })

    expect(recovered).not.toBeNull()
    expect(recovered?.timedOutPlayerIds).toEqual(['host'])
    expect(recovered?.lobby.status).toBe('open')
    expect(recovered?.lobby.matchId).toBeNull()
    expect(recovered?.lobby.hostId).toBe('ally-a')
    expect(recovered?.lobby.memberPlayerIds).toEqual(['ally-a', 'ally-b', 'ally-c', 'spectator'])
    expect(recovered?.lobby.slots).toEqual([null, 'ally-a', 'ally-b', 'ally-c'])
    expect(recovered?.queueEntries).toEqual([
      {
        playerId: 'ally-a',
        displayName: 'Ally A',
        avatarUrl: null,
        joinedAt: createdAt + 1,
        partyIds: undefined,
      },
      {
        playerId: 'ally-b',
        displayName: 'Ally B',
        avatarUrl: null,
        joinedAt: createdAt + 2,
        partyIds: undefined,
      },
      {
        playerId: 'ally-c',
        displayName: 'Ally C',
        avatarUrl: null,
        joinedAt: createdAt + 3,
        partyIds: undefined,
      },
      {
        playerId: 'spectator',
        displayName: 'Spec',
        avatarUrl: null,
        joinedAt: createdAt + 4,
        partyIds: undefined,
      },
    ])

    const stored = await getLobbyById(kv, lobby.id)
    expect(stored?.status).toBe('open')
    expect(stored?.hostId).toBe('ally-a')
    expect(await kv.get(matchKey('match-1'))).toBeNull()
  })
})
