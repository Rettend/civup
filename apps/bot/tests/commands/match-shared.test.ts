import { describe, expect, test } from 'bun:test'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { createLobby, getLobby, setLobbyMinRole } from '../../src/services/lobby/index.ts'
import { getQueueState } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
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
    )

    const conflict = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '2v2',
      [
        joinEntry('p1', 'Player One', ['p3']),
        joinEntry('p3', 'Player Three', ['p1']),
      ],
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
    )

    const outcome = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [
        joinEntry('p1', 'Player One', ['p2', 'p3']),
        joinEntry('p2', 'Player Two', ['p1', 'p3']),
        joinEntry('p3', 'Player Three', ['p1', 'p2']),
      ],
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
    )

    const outcome = await joinLobbyAndMaybeStartMatch(
      { env: { KV: kv } },
      '3v3',
      [
        joinEntry('p1', 'Player One', ['p2']),
        joinEntry('p2', 'Player Two', ['p1']),
      ],
    )

    expect('error' in outcome).toBe(false)

    const lobby = await getLobby(kv, '3v3')
    expect(lobby?.slots).toEqual(['host', 'p1', 'p2', null, null, null])
  })

  test('role-gated lobbies reject players without the configured minimum role', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })

    await setLobbyMinRole(kv, lobby.id, 'tier2')
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: '11111111111111111',
    })

    await withMockGuildMemberRoles({ challenger: [] }, async () => {
      const outcome = await joinLobbyAndMaybeStartMatch(
        { env: { KV: kv, DISCORD_TOKEN: 'token' } },
        '2v2',
        [joinEntry('challenger', 'Challenger', [])],
      )

      expect('error' in outcome).toBe(true)
      if ('error' in outcome) expect(outcome.error).toContain('requires at least')
    })
  })

  test('role-gated lobbies are skipped when another compatible lobby exists', async () => {
    const { kv } = createTrackedKv()
    const gatedLobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
    })
    const openLobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host-2',
      channelId: 'draft-channel',
      messageId: 'message-2',
    })

    await setLobbyMinRole(kv, gatedLobby.id, 'tier2')
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: '11111111111111111',
    })

    await withMockGuildMemberRoles({ challenger: [] }, async () => {
      const outcome = await joinLobbyAndMaybeStartMatch(
        { env: { KV: kv, DISCORD_TOKEN: 'token' } },
        '2v2',
        [joinEntry('challenger', 'Challenger', [])],
      )

      expect('error' in outcome).toBe(false)
      if ('error' in outcome) return
      expect(outcome.lobby.id).toBe(openLobby.id)
    })
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

async function withMockGuildMemberRoles(
  rolesByUserId: Record<string, string[]>,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = String(input)
    const match = url.match(/\/guilds\/[^/]+\/members\/([^/?]+)/)
    const userId = match?.[1]
    return new Response(JSON.stringify({ roles: userId ? (rolesByUserId[userId] ?? []) : [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await run()
  }
  finally {
    globalThis.fetch = originalFetch
  }
}
