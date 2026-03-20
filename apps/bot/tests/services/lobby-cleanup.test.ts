import type { QueueEntry } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { getLobbyForUser, storeUserLobbyState } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, pruneInactiveOpenLobbies, setLobbyLastJoinedAt, setLobbyMemberPlayerIds, setLobbySlots } from '../../src/services/lobby/index.ts'
import { getQueueState, setQueueEntries } from '../../src/services/queue/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('inactive lobby cleanup', () => {
  test('prunes inactive open lobbies, clears state, and updates the embed', async () => {
    const { kv } = createTrackedKv()
    const requests: Array<{ url: string, init?: RequestInit }> = []

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const now = 1_000_000
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setQueueEntries(kv, '2v2', [entry('host', now - 120_000), entry('player', now - 119_999)])
    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player'], lobby)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'player', null, null], withMembers ?? lobby)
    const staleLobby = await setLobbyLastJoinedAt(kv, lobby.id, now - 120_000, withSlots ?? withMembers ?? lobby)
    expect(staleLobby).not.toBeNull()

    await storeUserLobbyState(kv, 'channel-1', ['host', 'player'], staleLobby!.id)

    const pruned = await pruneInactiveOpenLobbies(kv, 'token', {
      queueTimeoutMs: 60_000,
      now,
    })

    expect(pruned).toEqual([{
      lobbyId: staleLobby!.id,
      mode: '2v2',
      removedPlayerIds: ['host', 'player'],
    }])
    expect(await getLobbyById(kv, staleLobby!.id)).toBeNull()
    expect(await getLobbyForUser(kv, 'host')).toBeNull()
    expect(await getLobbyForUser(kv, 'player')).toBeNull()
    expect((await getQueueState(kv, '2v2')).entries).toEqual([])

    const editRequest = requests.find(request => request.init?.method === 'PATCH')
    expect(editRequest).toBeDefined()
    const payload = JSON.parse(String(editRequest?.init?.body)) as {
      embeds?: unknown[]
      components?: unknown
    }
    expect(payload.components).toEqual([])
    expect(JSON.stringify(payload.embeds)).toContain('LOBBY TIMEOUT')
    expect(JSON.stringify(payload.embeds)).not.toContain('System')
  })

  test('leaves active open lobbies alone', async () => {
    const { kv } = createTrackedKv()
    let fetchCalls = 0

    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const now = 2_000_000
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setQueueEntries(kv, '2v2', [entry('host', now - 30_000)])
    await setLobbyLastJoinedAt(kv, lobby.id, now - 30_000, lobby)

    await expect(pruneInactiveOpenLobbies(kv, 'token', {
      queueTimeoutMs: 60_000,
      now,
    })).resolves.toEqual([])
    expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
    expect((await getQueueState(kv, '2v2')).entries.map(entry => entry.playerId)).toEqual(['host'])
    expect(fetchCalls).toBe(0)
  })
})

function entry(playerId: string, joinedAt: number): QueueEntry {
  return {
    playerId,
    displayName: playerId,
    avatarUrl: null,
    joinedAt,
  }
}
