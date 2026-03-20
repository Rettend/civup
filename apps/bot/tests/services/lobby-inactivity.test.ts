import { afterEach, describe, expect, test } from 'bun:test'
import { buildActivityLaunchSnapshot } from '../../src/routes/activity.ts'
import { storeUserActivityTarget } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, setLobbyLastJoinedAt } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('activity launch with inactive lobbies', () => {
  test('drops inactive open lobbies from activity launch options', async () => {
    const { kv } = createTrackedKv()

    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch

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
      joinedAt: Date.now() - 31 * 60 * 1000,
    })
    await setLobbyLastJoinedAt(kv, lobby.id, Date.now() - 31 * 60 * 1000, lobby)
    await storeUserActivityTarget(kv, 'channel-1', ['host-1'], { kind: 'lobby', id: lobby.id })

    const snapshot = await buildActivityLaunchSnapshot('token', 'secret', kv, 'channel-1', 'host-1')

    expect(snapshot.options).toEqual([])
    expect(snapshot.selection).toBeNull()
    expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
  })
})
