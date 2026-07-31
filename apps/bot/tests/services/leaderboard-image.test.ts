import { players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildPlayerLeaderboardImageData, renderPlayerLeaderboardSvg } from '../../src/services/leaderboard/image.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW = 200 * DAY_MS

describe('player leaderboard image activity placement', () => {
  test('orders adjusted rows while keeping Elo visible and explaining the marker', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'stale', displayName: 'Stale Leader', avatarUrl: null, createdAt: 1 },
        { id: 'active', displayName: 'Active Challenger', avatarUrl: null, createdAt: 1 },
      ])

      const data = await buildPlayerLeaderboardImageData(db, 'duel', [
        { playerId: 'stale', mode: 'duel', mu: 40, sigma: 5, gamesPlayed: 10, wins: 7, lastPlayedAt: NOW - (120 * DAY_MS) },
        { playerId: 'active', mode: 'duel', mu: 39, sigma: 5, gamesPlayed: 10, wins: 6, lastPlayedAt: NOW },
      ], { now: NOW })

      expect(data.rows.map(row => row.playerId)).toEqual(['active', 'stale'])
      expect(data.rows[0]).toMatchObject({ rank: 1, rawRank: 2, inactivityOffset: 0 })
      expect(data.rows[1]).toMatchObject({ rank: 2, rawRank: 1, inactivityOffset: 1 })
      expect(data.rows[1]!.displayRating).toBeGreaterThan(data.rows[0]!.displayRating)

      const svg = await renderPlayerLeaderboardSvg(data, { avatarData: new Map() })
      expect(svg).toContain('↓1')
      expect(svg).toContain('↓N = activity placement adjustment')
      expect(svg.indexOf('Active Challenger')).toBeLessThan(svg.indexOf('Stale Leader'))
    }
    finally {
      sqlite.close()
    }
  })
})
