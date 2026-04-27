import { afterEach, describe, expect, test } from 'bun:test'
import { buildActivityLaunchSnapshot } from '../../src/routes/activity.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyLastActivityAt } from '../helpers/lobby-runtime.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function activityRuntimeOptions(kv: KVNamespace) {
  const runtime = getExistingTestLobbyRuntime(kv)
  return { db: runtime.d1, sessionNamespace: runtime.sessionNamespace }
}

describe('activity launch with long-idle lobbies', () => {
  test('keeps open lobbies visible until cron cleanup runs', async () => {
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
      joinedAt: Date.now() - 61 * 60 * 1000,
    })
    await setLobbyLastActivityAt(kv, lobby.id, Date.now() - 61 * 60 * 1000, lobby)

    const snapshot = await buildActivityLaunchSnapshot('token', 'secret', kv, 'channel-1', 'host-1', activityRuntimeOptions(kv))

    expect(snapshot.options).toHaveLength(1)
    expect(snapshot.selection?.kind).toBe('lobby')
    expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
  })
})
