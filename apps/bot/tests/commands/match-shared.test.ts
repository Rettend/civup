import { matches, matchParticipants, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { findActiveMatchIdsForPlayers, joinLobbyAndMaybeStartMatch, preflightMatchCreateQueueState } from '../../src/commands/match/shared.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyLastActivityAt, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots } from '../../src/services/lobby/index.ts'
import { hostKey } from '../../src/services/lobby/keys.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const TITAN_ROLE_ID = '99999999999999999'
const GLADIATOR_ROLE_ID = '11111111111111111'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('joinLobbyAndMaybeStartMatch', () => {
  test('keeps matchmaking min rank as a /match join gate', async () => {
    const { kv } = createTrackedKv()
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
    await setLobbyMinRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: '',
    }])

    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('requires at least')
  })

  test('allows direct lobby joins to bypass matchmaking min rank', async () => {
    const { kv } = createTrackedKv()
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
    await setLobbyMinRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: '',
    }], {
      preferredLobbyId: lobby.id,
      skipMatchmakingRankGate: true,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.stage).toBe('open')
    expect(result.lobby.memberPlayerIds).toContain('pleb')
  })

  test('keeps matchmaking max rank as a /match join gate', async () => {
    const { kv } = createTrackedKv()
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
    await setLobbyMaxRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: TITAN_ROLE_ID,
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [TITAN_ROLE_ID] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'titan',
      displayName: 'Titan',
      avatarUrl: '',
    }])

    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('allows up to')
  })

  test('allows direct lobby joins to bypass matchmaking max rank', async () => {
    const { kv } = createTrackedKv()
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
    await setLobbyMaxRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: TITAN_ROLE_ID,
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [TITAN_ROLE_ID] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'titan',
      displayName: 'Titan',
      avatarUrl: '',
    }], {
      preferredLobbyId: lobby.id,
      skipMatchmakingRankGate: true,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.stage).toBe('open')
    expect(result.lobby.memberPlayerIds).toContain('titan')
  })

  test('still allows joins before hourly inactivity cleanup runs', async () => {
    const { kv } = createTrackedKv()
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
      joinedAt: Date.now() - 61 * 60 * 1000,
    })
    await setLobbyLastActivityAt(kv, lobby.id, Date.now() - 61 * 60 * 1000, lobby)

    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: '',
    }])

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.stage).toBe('open')
    expect(result.lobby.memberPlayerIds).toContain('pleb')
  })

  test('repairs stale member ids when a queued player is already slotted in the target lobby', async () => {
    const { kv } = createTrackedKv()
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
    })

    await setLobbySlots(kv, lobby.id, ['host', 'player-1', null, null], lobby)

    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: '',
    }], {
      preferredLobbyId: lobby.id,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.lobby.id).toBe(lobby.id)
    expect((await getLobbyById(kv, lobby.id))?.memberPlayerIds).toEqual(['host', 'player-1'])
    expect((await getLobbyById(kv, lobby.id))?.slots).toEqual(['host', 'player-1', null, null])
  })

  test('keeps already slotted queued players when another player joins a lobby with stale member ids', async () => {
    const { kv } = createTrackedKv()
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
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    await setLobbySlots(kv, lobby.id, ['host', 'player-1', null, null], lobby)

    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: '',
    }], {
      preferredLobbyId: lobby.id,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.lobby.id).toBe(lobby.id)
    expect((await getLobbyById(kv, lobby.id))?.memberPlayerIds).toEqual(['host', 'player-1', 'player-2'])
    expect((await getLobbyById(kv, lobby.id))?.slots).toEqual(['host', 'player-1', 'player-2', null])
  })

  test('ignores orphan open lobbies and still joins when group constraints are gone', async () => {
    const { kv } = createTrackedKv()
    await createLobby(kv, {
      mode: '2v2',
      hostId: 'orphan-host',
      channelId: 'channel-orphan',
      messageId: 'message-orphan',
    })
    const crowdedLobby = await createLobby(kv, {
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
      playerId: 'ally',
      displayName: 'Ally',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'enemy',
      displayName: 'Enemy',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedLobby = await setLobbyMemberPlayerIds(kv, crowdedLobby.id, ['host', 'ally', 'enemy'], crowdedLobby)
    await setLobbySlots(kv, crowdedLobby.id, ['host', 'ally', 'enemy', null], populatedLobby ?? crowdedLobby)

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: '',
    }, {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: '',
    }])

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.lobby.id).toBe(crowdedLobby.id)
    expect(result.lobby.slots).toEqual(['host', 'ally', 'enemy', 'player-1'])
    expect(result.lobby.memberPlayerIds).toEqual(['host', 'ally', 'enemy', 'player-1', 'player-2'])
  })

  test('rejects joins for players who are already in a live match', async () => {
    const { kv } = createTrackedKv()
    const liveLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'player-1',
      channelId: 'channel-1',
      messageId: 'message-live',
    })
    await createLobby(kv, {
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

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: '',
    }], {
      liveMatchPlayerIds: new Set(['player-1']),
    })

    expect(result).toEqual({ error: '<@player-1> is already in a live match.' })
  })

  test('moves a player from another open lobby into the preferred lobby', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'source-host',
      channelId: 'channel-source',
      messageId: 'message-source',
    })
    const targetLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'target-host',
      channelId: 'channel-target',
      messageId: 'message-target',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'source-host',
      displayName: 'Source Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'target-host',
      displayName: 'Target Host',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['source-host', 'pleb'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['source-host', 'pleb', null, null], populatedSource ?? sourceLobby)

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: '',
    }], {
      preferredLobbyId: targetLobby.id,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.lobby.id).toBe(targetLobby.id)
    expect((await getLobbyById(kv, sourceLobby.id))?.memberPlayerIds).toEqual(['source-host'])
    expect((await getLobbyById(kv, targetLobby.id))?.memberPlayerIds).toEqual(['target-host', 'pleb'])
  })

})

describe('preflightMatchCreateQueueState', () => {
  test('heals a queue-only orphan and allows create to continue', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: 1,
      partyIds: ['ally'],
    })
    await addToQueue(kv, '2v2', {
      playerId: 'ally',
      displayName: 'Ally',
      avatarUrl: null,
      joinedAt: 2,
      partyIds: ['host'],
    })

    const result = await preflightMatchCreateQueueState(kv, '2v2', 'host')

    expect(result.kind).toBe('continue')
    expect(result.queue.entries.map(entry => entry.playerId)).toEqual(['ally'])
    expect(result.queue.entries[0]?.partyIds).toBeUndefined()
  })

  test('keeps blocking real membership in another open lobby', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: 2,
    })
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-1'], lobby)

    const result = await preflightMatchCreateQueueState(kv, 'ffa', 'player-1')

    expect(result.kind).toBe('block-open-lobby')
    if (result.kind !== 'block-open-lobby') return
    expect(result.lobby.id).toBe(lobby.id)
  })

  test('reuses a real hosted open lobby instead of treating it as a generic queue blocker', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: 1,
    })
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await kv.delete(hostKey('host'))

    const result = await preflightMatchCreateQueueState(kv, 'ffa', 'host')

    expect(result.kind).toBe('reuse-hosted-open-lobby')
    if (result.kind !== 'reuse-hosted-open-lobby') return
    expect(result.lobby.id).toBe(lobby.id)
  })

  test('heals a cross-mode queue-only orphan and keeps the requested queue empty', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: 1,
    })

    const result = await preflightMatchCreateQueueState(kv, 'ffa', 'host')

    expect(result.kind).toBe('continue')
    expect(result.queue.entries).toEqual([])
  })
})

describe('findActiveMatchIdsForPlayers', () => {
  test('returns only active matches and preserves newest-first ordering', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Player 3', avatarUrl: null, createdAt: 1 },
      ])

      await db.insert(matches).values([
        { id: 'draft-1', gameMode: '1v1', status: 'drafting', createdAt: 1, completedAt: null, seasonId: null, draftData: null },
        { id: 'active-1', gameMode: '1v1', status: 'active', createdAt: 2, completedAt: null, seasonId: null, draftData: null },
        { id: 'completed-1', gameMode: '1v1', status: 'completed', createdAt: 3, completedAt: 4, seasonId: null, draftData: null },
        { id: 'active-2', gameMode: '1v1', status: 'active', createdAt: 4, completedAt: null, seasonId: null, draftData: null },
      ])

      await db.insert(matchParticipants).values([
        { matchId: 'draft-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'draft-1', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-1', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p3', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-2', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const activeMatchIdsByPlayer = await findActiveMatchIdsForPlayers(db, ['p1', 'p2', 'p3'])

      expect(activeMatchIdsByPlayer.get('p1')).toEqual(['active-2', 'active-1'])
      expect(activeMatchIdsByPlayer.get('p2')).toEqual(['active-2', 'active-1'])
      expect(activeMatchIdsByPlayer.get('p3')).toBeUndefined()
    }
    finally {
      sqlite.close()
    }
  })
})
