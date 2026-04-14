import { describe, expect, test } from 'bun:test'
import { getLobbyForUser, getUserActivityTarget, storeUserLobbyState } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, setLobbyMemberPlayerIds, setLobbySlots } from '../../src/services/lobby/index.ts'
import { leaveOpenLobbyForLobbyJoin } from '../../src/services/lobby/transfer.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby transfer', () => {
  test('leaving a source lobby does not clear a newer channel target', async () => {
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

    await storeUserLobbyState(kv, 'channel-1', ['player-1'], sourceLobby.id)
    await storeUserLobbyState(kv, 'channel-1', ['player-1'], targetLobby.id, { pendingJoin: true })

    const result = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['player-1'],
      '2v2',
    )

    expect(result).toEqual({
      ok: true,
      transferredFrom: {
        lobbyId: sourceLobby.id,
        mode: '2v2',
      },
    })
    expect(await getLobbyForUser(kv, 'player-1')).toBeNull()
    await expect(getUserActivityTarget(kv, 'channel-1', 'player-1')).resolves.toEqual({
      kind: 'lobby',
      id: targetLobby.id,
      pendingJoin: true,
      selectedAt: expect.any(Number),
    })
  })
})
