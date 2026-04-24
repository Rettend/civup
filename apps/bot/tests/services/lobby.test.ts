import type { DraftState } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildActivityOverviewSnapshotFromDirectory } from '../../src/services/activity/session-state.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { clearLobbyById, clearLobbyByMatch, createLobby, getCurrentLobbiesForPlayer, getCurrentLobbyHostedBy, getExistingTestLobbyRuntime, getLobbiesByMode, getLobbyByChannel, getLobbyById, getLobbyDraftRoster, reopenLobbyAfterTimedOutDraft, setLobbyDraftConfig, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus, startTestSessionDraft, storeLobbyDraftRoster } from '../helpers/lobby-runtime.ts'
import { channelIndexKey, hostKey, idKey, LOBBY_TTL, modeIndexKey } from '../../src/services/lobby/keys.ts'
import { syncLobbyDerivedState } from '../../src/services/lobby/live-snapshot.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS } from '../../src/services/match/retention.ts'
import { getSessionLobbyProjectionByMatch } from '../../src/services/session/index.ts'
import { getSeededRosterEntries, seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

test('normalizes unsupported map vote config off for ffa lobbies', async () => {
  const { kv } = createTrackedKv()
  const lobby = await createLobby(kv, {
    mode: 'ffa',
    hostId: 'host-1',
    channelId: 'channel-1',
    messageId: 'message-1',
  })

  const updated = await setLobbyDraftConfig(kv, lobby.id, {
    ...lobby.draftConfig,
    mapVoteEnabled: true,
  }, lobby)

  expect(updated?.draftConfig.mapVoteEnabled).toBe(false)
})

test('keeps supported map vote config for team lobbies', async () => {
  const { kv } = createTrackedKv()
  const lobby = await createLobby(kv, {
    mode: '2v2',
    hostId: 'host-1',
    channelId: 'channel-1',
    messageId: 'message-1',
  })

  const updated = await setLobbyDraftConfig(kv, lobby.id, {
    ...lobby.draftConfig,
    mapVoteEnabled: true,
  }, lobby)

  expect(updated?.draftConfig.mapVoteEnabled).toBe(true)
})

describe('lobby service KV write behavior', () => {
  test('setLobbySlots skips KV writes when slots are unchanged', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: '1v1',
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

  test('getLobbiesByMode repairs a missing mode index from canonical lobby records', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await kv.delete(modeIndexKey('ffa', lobby.id))

    await expect(getLobbiesByMode(kv, 'ffa')).resolves.toEqual([
      expect.objectContaining({
        id: lobby.id,
        mode: 'ffa',
      }),
    ])
    await expect(kv.get(modeIndexKey('ffa', lobby.id))).resolves.toBe(String(lobby.revision))
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

  test('builds live snapshots for open lobby changes', async () => {
    const { kv } = createTrackedKv()
    const queueEntries = [
      { playerId: 'host-1', displayName: 'Host', avatarUrl: null, joinedAt: Date.now() },
      { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: Date.now() + 1 },
    ]

    for (const entry of queueEntries) await addToQueue(kv, '1v1', entry)

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host-1', 'player-2'], lobby, { queueEntries })
    const nextSlots = [...(withMembers?.slots ?? lobby.slots)]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots, withMembers ?? lobby, { queueEntries })
    const snapshot = await syncLobbyDerivedState(kv, updated ?? withMembers ?? lobby, { queueEntries, slots: nextSlots })

    expect(updated).not.toBeNull()
    expect(snapshot?.revision).toBe(updated?.revision)
    expect(snapshot?.entries?.[0]).toEqual({ playerId: 'host-1', displayName: 'Host', avatarUrl: null })
    expect(snapshot?.entries?.[1]).toEqual({ playerId: 'player-2', displayName: 'Player 2', avatarUrl: null })
  })

  test('does not build live snapshots when a lobby stops being open', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '1v1', {
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

    expect(await syncLobbyDerivedState(kv, lobby)).not.toBeNull()

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)
    expect(draftingLobby).not.toBeNull()
    await expect(syncLobbyDerivedState(kv, draftingLobby ?? lobby)).resolves.toBeNull()
  })

  test('startTestSessionDraft derives the match id from the lobby id', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)

    expect(draftingLobby).toMatchObject({
      id: lobby.id,
      status: 'drafting',
      matchId: lobby.id,
    })
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
    const snapshot = await syncLobbyDerivedState(kv, updated ?? lobby)

    expect(snapshot?.minPlayers).toBe(6)
    expect(snapshot?.targetSize).toBe(8)
  })

  test('stores six players as the regular FFA minimum start size for 8 seats', async () => {
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

    const snapshot = await syncLobbyDerivedState(kv, lobby, { queueEntries: getSeededRosterEntries(kv, '2v2') })

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

    const snapshot = await syncLobbyDerivedState(kv, lobby, { queueEntries: getSeededRosterEntries(kv, '2v2') })

    expect(snapshot?.entries?.[0]).toEqual({
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      balanceRating: {
        mu: 31,
        sigma: 3,
        gamesPlayed: 12,
      },
    })
  })

  test('lobby snapshots ignore legacy party links', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
      partyIds: ['spectator'],
    })
    await addToQueue(kv, '2v2', {
      playerId: 'spectator',
      displayName: 'Spectator',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
      partyIds: ['host-1'],
    })

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const snapshot = await syncLobbyDerivedState(kv, lobby)

    const storedLobby = await getLobbyById(kv, lobby.id)
    expect(storedLobby?.memberPlayerIds).toEqual(['host-1'])
    expect(storedLobby?.slots).toEqual(['host-1', null, null, null])

    expect(snapshot?.entries?.map(entry => entry?.playerId ?? null)).toEqual(['host-1', null, null, null])
  })

  test('builds activity overview from the session directory', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '1v1', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '1v1', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const runtime = getExistingTestLobbyRuntime(kv)

    let overview = await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1')
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

    overview = await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1')
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'lobby',
        id: lobby.id,
        participantCount: 2,
        status: 'open',
      }),
    ])

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, updated ?? withMembers ?? lobby)
    expect(draftingLobby).not.toBeNull()
    await syncLobbyDerivedState(kv, draftingLobby!)

    overview = await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1')
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: lobby.id,
        participantCount: 2,
        status: 'drafting',
      }),
    ])

    const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)
    expect(activeLobby).not.toBeNull()
    await syncLobbyDerivedState(kv, activeLobby!)

    overview = await buildActivityOverviewSnapshotFromDirectory(runtime.db, 'channel-1')
    expect(overview?.options).toEqual([
      expect.objectContaining({
        kind: 'match',
        id: lobby.id,
        participantCount: 2,
        status: 'active',
      }),
    ])
  })

  test('tracks the current hosted lobby without scanning all modes', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

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

    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)
    expect(draftingLobby).not.toBeNull()
    await expect(getCurrentLobbyHostedBy(kv, 'host-1')).resolves.toEqual(expect.objectContaining({
      id: lobby.id,
      status: 'drafting',
    }))
  })

  test('keeps a hosted open lobby even when queue metadata is missing', async () => {
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
    await expect(kv.get(hostKey('host-1'))).resolves.toBe(lobby.id)
  })

  test('clears orphaned host and match indexes when the lobby record is gone', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await startTestSessionDraft(kv, lobby.id, lobby)

    await kv.delete(idKey(lobby.id))

    await clearLobbyById(kv, lobby.id)

    await expect(kv.get(hostKey('host-1'))).resolves.toBeNull()
    await expect(getLobbyById(kv, lobby.id)).resolves.toBeNull()
  })

  test('session lobby projection resolves same-id sessions', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const draftingLobby = await startTestSessionDraft(kv, lobby.id, lobby)
    const { db } = getExistingTestLobbyRuntime(kv)

    await expect(getSessionLobbyProjectionByMatch(db, lobby.id)).resolves.toEqual(expect.objectContaining({
      id: lobby.id,
      matchId: lobby.id,
    }))
    expect(draftingLobby?.matchId).toBe(lobby.id)
  })

  test('getLobbyByChannel repairs a missing channel index from the canonical lobby record', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await kv.delete(channelIndexKey('channel-1', lobby.id))

    await expect(getLobbyByChannel(kv, 'channel-1')).resolves.toEqual(expect.objectContaining({
      id: lobby.id,
      channelId: 'channel-1',
    }))
    await expect(kv.get(channelIndexKey('channel-1', lobby.id))).resolves.toBe(String(lobby.revision))
  })

  test('clearLobbyByMatch clears same-id sessions', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await startTestSessionDraft(kv, lobby.id, lobby)

    await clearLobbyByMatch(kv, lobby.id)

    await expect(getLobbyById(kv, lobby.id)).resolves.toBeNull()
    await expect(kv.get(hostKey('host-1'))).resolves.toBeNull()
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
    const draftingLobby = await startTestSessionDraft(kv, lobby.id, withSlots ?? withMembers ?? lobby)

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
      matchId: lobby.id,
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
  })
})
