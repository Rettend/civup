import { describe, expect, test } from 'bun:test'
import { tournamentMatches, tournaments } from '@civup/db'
import { getLobbyForUser } from '../../src/services/activity/index.ts'
import { leaveOpenLobbyForLobbyJoin } from '../../src/services/lobby/transfer.ts'
import { createLobby, getLobbyById, getTestLobbyRuntime, setLobbyMemberPlayerIds, setLobbySlots } from '../helpers/lobby-runtime.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby transfer', () => {
  test('leaving a source lobby removes canonical membership without touching another lobby', async () => {
    const { kv } = createTrackedKv()

    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-1',
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

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['host-1', 'player-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['host-1', 'player-1', null, null], populatedSource ?? sourceLobby)

    const runtime = await getTestLobbyRuntime(kv)
    const result = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['player-1'],
      '2v2',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )

    expect(result).toEqual({
      ok: true,
      transferredFrom: {
        lobbyId: sourceLobby.id,
        mode: '2v2',
      },
    })
    expect(await getLobbyForUser(runtime.db, 'player-1')).toBeNull()
  })

  test('one-player source transfers cancel the source through the canonical session', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
      queueEntries: [{ playerId: 'host-1', displayName: 'Host 1', avatarUrl: null, joinedAt: 1 }],
    })
    await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-target',
      queueEntries: [{ playerId: 'host-2', displayName: 'Host 2', avatarUrl: null, joinedAt: 1 }],
    })
    const runtime = await getTestLobbyRuntime(kv)

    const result = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['host-1'],
      '1v1',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )

    expect(result).toEqual({
      ok: true,
      transferredFrom: {
        lobbyId: sourceLobby.id,
        mode: '1v1',
      },
    })
    expect('deferredSource' in result && result.deferredSource).toBe(false)
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBeNull()
    expect((await getLobbyById(kv, sourceLobby.id))?.status).toBe('cancelled')
  })

  test('does not transfer players out of a tournament-linked source lobby', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
      queueEntries: [{ playerId: 'host-1', displayName: 'Host 1', avatarUrl: null, joinedAt: 1 }],
    })
    const runtime = await getTestLobbyRuntime(kv)
    const now = Date.now()
    await runtime.db.insert(tournaments).values({
      id: 'locked-cup',
      name: 'Locked Cup',
      mode: '1v1',
      status: 'qualifier',
      scoring: 'open_win_rate',
      rematchPolicy: 'warn',
      minGames: 1,
      topCut: 2,
      roleId: null,
      createdById: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    await runtime.db.insert(tournamentMatches).values({
      sessionId: sourceLobby.id,
      tournamentId: 'locked-cup',
      matchId: null,
      stage: 'qualifier',
      status: 'open',
      playerOneId: null,
      playerTwoId: null,
      winnerId: null,
      entryOneId: null,
      entryTwoId: null,
      winnerEntryId: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      sourceLobby,
      ['host-1'],
      '1v1',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )

    expect(result).toEqual({ ok: false, error: 'Tournament rosters are locked. Cancel the tournament lobby before joining another lobby.' })
    expect((await getLobbyById(kv, sourceLobby.id))?.status).toBe('open')
  })
})
