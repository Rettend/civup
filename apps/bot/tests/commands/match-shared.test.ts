import { matches, matchParticipants, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { findBlockingDraftMatchIdsForPlayers, findReportableMatchIdsForPlayers, joinLobbyAndMaybeStartMatch, preflightMatchCreateSessionState, resolveReportableMatchIdForPlayer } from '../../src/commands/match/shared.ts'
import { hostKey } from '../../src/services/lobby/keys.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { buildTestLobbyEnv, createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyLastActivityAt, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots } from '../helpers/lobby-runtime.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
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
      env: buildTestLobbyEnv(kv),
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
      env: buildTestLobbyEnv(kv),
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
      env: buildTestLobbyEnv(kv),
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
      env: buildTestLobbyEnv(kv),
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
      env: buildTestLobbyEnv(kv),
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

  test('joins a queued player into the canonical roster despite old slot residue', async () => {
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
      env: buildTestLobbyEnv(kv),
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

  test('does not rebuild stale members from slotted queue residue', async () => {
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
      env: buildTestLobbyEnv(kv),
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
    expect((await getLobbyById(kv, lobby.id))?.memberPlayerIds).toEqual(['host', 'player-2'])
    expect((await getLobbyById(kv, lobby.id))?.slots).toEqual(['host', 'player-2', null, null])
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
      env: buildTestLobbyEnv(kv),
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
      env: buildTestLobbyEnv(kv),
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

describe('preflightMatchCreateSessionState', () => {
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

    const result = await preflightMatchCreateSessionState(getExistingTestLobbyRuntime(kv).db, 'player-1')

    expect(result.kind).toBe('block-open-lobby')
    if (result.kind !== 'block-open-lobby') return
    expect(result.lobby.id).toBe(lobby.id)
  })

  test('reuses a real hosted open lobby instead of treating it as a generic membership blocker', async () => {
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

    const result = await preflightMatchCreateSessionState(getExistingTestLobbyRuntime(kv).db, 'host')

    expect(result.kind).toBe('reuse-hosted-open-lobby')
    if (result.kind !== 'reuse-hosted-open-lobby') return
    expect(result.lobby.id).toBe(lobby.id)
  })
})

describe('match blocker/reportable discovery', () => {
  test('returns only blocking draft matches', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Player 3', avatarUrl: null, createdAt: 1 },
      ])

      await db.insert(matches).values([
        { id: 'draft-1', gameMode: '1v1', status: 'drafting', createdAt: 1, completedAt: null, seasonId: null, draftData: null },
        { id: 'active-complete-1', gameMode: '1v1', status: 'active', createdAt: 2, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 2 }) },
        { id: 'completed-1', gameMode: '1v1', status: 'completed', createdAt: 3, completedAt: 4, seasonId: null, draftData: null },
        { id: 'active-anomalous-2', gameMode: '1v1', status: 'active', createdAt: 4, completedAt: null, seasonId: null, draftData: null },
      ])

      await db.insert(matchParticipants).values([
        { matchId: 'draft-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'draft-1', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-complete-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-complete-1', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p3', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-anomalous-2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-anomalous-2', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const blockingMatchIdsByPlayer = await findBlockingDraftMatchIdsForPlayers(db, ['p1', 'p2', 'p3'])

      expect(blockingMatchIdsByPlayer).toEqual(new Map([
        ['p1', 'active-anomalous-2'],
        ['p2', 'active-anomalous-2'],
      ]))
    }
    finally {
      sqlite.close()
    }
  })

  test('returns reportable matches newest-first and excludes drafting/completed', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
      ])

      await db.insert(matches).values([
        { id: 'draft-1', gameMode: '1v1', status: 'drafting', createdAt: 1, completedAt: null, seasonId: null, draftData: null },
        { id: 'reportable-1', gameMode: '1v1', status: 'active', createdAt: 2, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 2 }) },
        { id: 'completed-1', gameMode: '1v1', status: 'completed', createdAt: 3, completedAt: 4, seasonId: null, draftData: JSON.stringify({ completedAt: 2 }) },
        { id: 'reportable-2', gameMode: '1v1', status: 'active', createdAt: 4, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 4 }) },
      ])

      await db.insert(matchParticipants).values([
        { matchId: 'draft-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-2', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const reportableMatchIdsByPlayer = await findReportableMatchIdsForPlayers(db, ['p1', 'p2'])

      expect(reportableMatchIdsByPlayer.get('p1')).toEqual(['reportable-2', 'reportable-1'])
      expect(reportableMatchIdsByPlayer.get('p2')).toEqual(['reportable-2'])
    }
    finally {
      sqlite.close()
    }
  })

  test('requires match_id when multiple reportable matches exist', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([{ id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 }])
      await db.insert(matches).values([
        { id: 'reportable-1', gameMode: '1v1', status: 'active', createdAt: 2, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 2 }) },
        { id: 'reportable-2', gameMode: '1v1', status: 'active', createdAt: 3, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 3 }) },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'reportable-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      await expect(resolveReportableMatchIdForPlayer(db, 'p1')).resolves.toEqual({
        matchId: null,
        error: 'You have multiple draft-complete matches to report. Pass `match_id` to pick the right one.',
      })
      await expect(resolveReportableMatchIdForPlayer(db, 'p1', 'reportable-1')).resolves.toEqual({
        matchId: 'reportable-1',
        error: null,
      })
    }
    finally {
      sqlite.close()
    }
  })
})
