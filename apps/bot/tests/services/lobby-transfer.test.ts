import { describe, expect, test } from 'bun:test'
import { getLobbyForUser } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, getTestLobbyRuntime, setLobbyMemberPlayerIds, setLobbySlots } from '../helpers/lobby-runtime.ts'
import { leaveOpenLobbyForLobbyJoin } from '../../src/services/lobby/transfer.ts'
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
    expect(await getLobbyForUser(kv, 'player-1')).toBeNull()
  })
})
