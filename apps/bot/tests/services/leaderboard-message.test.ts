import { leaderboardMessageStates, playerRatings, players, seasons } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { archiveSeasonLeaderboards, upsertLeaderboardMessagesForChannel } from '../../src/services/leaderboard/message.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch

describe('leaderboard message service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('archives the current leaderboard and creates a fresh live message on season end', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-1')

    await db.insert(players).values({
      id: '100010000000000001',
      displayName: 'Player One',
      avatarUrl: null,
      createdAt: NOW,
    })
    await db.insert(playerRatings).values({
      playerId: '100010000000000001',
      mode: 'ffa',
      mu: 35,
      sigma: 6,
      gamesPlayed: 8,
      wins: 5,
      lastPlayedAt: NOW,
    })
    await db.insert(seasons).values({
      id: 'season-9',
      seasonNumber: 9,
      name: 'Season 9',
      startsAt: NOW - 10_000,
      endsAt: null,
      active: true,
    })

    const postPayloads: any[] = []
    const patchPayloads: any[] = []
    let messageCounter = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-1/messages')) {
        messageCounter += 1
        const payload = JSON.parse(String(init.body))
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: `message-${messageCounter}` }), { status: 200 })
      }
      if (init?.method === 'PATCH' && url.includes('/channels/channel-1/messages/')) {
        const payload = JSON.parse(String(init.body))
        patchPayloads.push(payload)
        return new Response('{}', { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await upsertLeaderboardMessagesForChannel(db, kv, 'token', 'channel-1')
    await db.update(seasons).set({ active: false, endsAt: NOW + 1 }).where(eq(seasons.id, 'season-9'))
    await archiveSeasonLeaderboards(db, kv, 'token', 'Season 9')

    expect(postPayloads).toHaveLength(2)
    expect(patchPayloads).toHaveLength(1)
    expect(JSON.stringify(patchPayloads[0].embeds)).toContain('Season 9 FFA Leaderboard')
    expect(JSON.stringify(postPayloads[1].embeds)).toContain('FFA Leaderboard')
    expect(JSON.stringify(postPayloads[1].embeds)).not.toContain('Season 9 FFA Leaderboard')
    expect(JSON.stringify(postPayloads[1].embeds)).toContain('<@100010000000000001>')

    const [state] = await db.select().from(leaderboardMessageStates).limit(1)
    expect(state?.messageId).toBe('message-2')

    sqlite.close()
  })
})
