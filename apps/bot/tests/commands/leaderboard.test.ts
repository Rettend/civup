import { playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildLeaderboardCommandImages } from '../../src/commands/leaderboard.ts'
import { rebuildLeaderboardModeSnapshot } from '../../src/services/leaderboard/snapshot.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('leaderboard command payload', () => {
  test('shows the requested mode', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await db.insert(playerRatings).values({
        playerId: 'p1',
        mode: 'ffa',
        mu: 30,
        sigma: 5,
        gamesPlayed: 2,
        wins: 1,
        lastPlayedAt: 1,
      })
      await rebuildLeaderboardModeSnapshot(db, kv, 'ffa')

      const payload = await buildLeaderboardCommandImages(db, kv, 'ffa')

      expect('content' in payload ? payload.content : undefined).toBeUndefined()
      expect('images' in payload ? payload.images : []).toHaveLength(1)
      if ('images' in payload) {
        expect(payload.images[0]?.mode).toBe('ffa')
        expect(isPng(payload.images[0]!.data)).toBe(true)
      }
    }
    finally {
      sqlite.close()
    }
  })

  test('does not rebuild when no cached snapshot exists', async () => {
    const kv = createTestKv()

    const { db, sqlite } = await createTestDatabase()
    const payload = await buildLeaderboardCommandImages(db, kv, 'ffa')

    expect('images' in payload ? payload.images : undefined).toBeUndefined()
    expect('content' in payload ? payload.content : undefined).toBe('Leaderboard snapshot is not available yet. Ask a moderator to run a leaderboard refresh.')
    sqlite.close()
  })
})

function isPng(bytes: Uint8Array): boolean {
  return Array.from(bytes.slice(0, 8)).join(',') === '137,80,78,71,13,10,26,10'
}
