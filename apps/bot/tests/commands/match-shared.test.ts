import { describe, expect, test } from 'bun:test'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { createLobby, getLobby } from '../../src/services/lobby.ts'
import { getQueueState } from '../../src/services/queue.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('match shared grouped join behavior', () => {
  test('grouped join adds all players with teammate links', async () => {
    const { kv } = createTrackedKv()
    await createLobby(kv, {
      mode: '2v2',
      hostId: 'p1',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })

    const outcome = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '2v2',
      [
        joinEntry('p1', 'Player One', ['p2']),
        joinEntry('p2', 'Player Two', ['p1']),
      ],
      'draft-channel',
    )

    expect('error' in outcome).toBe(false)

    const queue = await getQueueState(kv, '2v2')
    expect(queue.entries).toHaveLength(2)
    expect(queue.entries[0]?.playerId).toBe('p1')
    expect(queue.entries[0]?.partyIds).toEqual(['p2'])
    expect(queue.entries[1]?.playerId).toBe('p2')
    expect(queue.entries[1]?.partyIds).toEqual(['p1'])

    const lobby = await getLobby(kv, '2v2')
    expect(lobby?.slots).toEqual(['p1', 'p2', null, null])
  })

  test('grouped join rejects conflicting existing teammate links', async () => {
    const { kv } = createTrackedKv()
    await createLobby(kv, {
      mode: '2v2',
      hostId: 'p1',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })

    await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '2v2',
      [
        joinEntry('p1', 'Player One', ['p2']),
        joinEntry('p2', 'Player Two', ['p1']),
      ],
      'draft-channel',
    )

    const conflict = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '2v2',
      [
        joinEntry('p1', 'Player One', ['p3']),
        joinEntry('p3', 'Player Three', ['p1']),
      ],
      'draft-channel',
    )

    expect('error' in conflict).toBe(true)
    if ('error' in conflict) {
      expect(conflict.error).toContain('already grouped with different teammates')
    }

    const queue = await getQueueState(kv, '2v2')
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['p1', 'p2'])
  })

  test('3v3 grouped join keeps a new premade on one team', async () => {
    const { kv } = createTrackedKv()
    await createLobby(kv, {
      mode: '3v3',
      hostId: 'host',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })

    await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [joinEntry('host', 'Host', [])],
      'draft-channel',
    )

    const outcome = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [
        joinEntry('p1', 'Player One', ['p2', 'p3']),
        joinEntry('p2', 'Player Two', ['p1', 'p3']),
        joinEntry('p3', 'Player Three', ['p1', 'p2']),
      ],
      'draft-channel',
    )

    expect('error' in outcome).toBe(false)

    const lobby = await getLobby(kv, '3v3')
    expect(lobby?.slots).toEqual(['host', null, null, 'p1', 'p2', 'p3'])
  })

  test('3v3 grouped join fills a partial team before starting a new team', async () => {
    const { kv } = createTrackedKv()
    await createLobby(kv, {
      mode: '3v3',
      hostId: 'host',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })

    await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [joinEntry('host', 'Host', [])],
      'draft-channel',
    )

    const outcome = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [
        joinEntry('p1', 'Player One', ['p2']),
        joinEntry('p2', 'Player Two', ['p1']),
      ],
      'draft-channel',
    )

    expect('error' in outcome).toBe(false)

    const lobby = await getLobby(kv, '3v3')
    expect(lobby?.slots).toEqual(['host', 'p1', 'p2', null, null, null])
  })
})

function joinEntry(playerId: string, displayName: string, partyIds: string[]): {
  playerId: string
  displayName: string
  avatarUrl: string
  partyIds: string[]
} {
  return {
    playerId,
    displayName,
    avatarUrl: `https://example.com/${playerId}.png`,
    partyIds,
  }
}
