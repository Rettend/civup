import { playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildLeaderboardCommandPayload } from '../../src/commands/leaderboard.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('leaderboard command payload', () => {
  test('shows all leaderboard modes that currently have ranked players', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(playerRatings).values([
        { playerId: 'p1', mode: 'ffa', mu: 30, sigma: 5, gamesPlayed: 6, wins: 3, lastPlayedAt: 1 },
        { playerId: 'p2', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 7, wins: 4, lastPlayedAt: 1 },
        { playerId: 'p3', mode: 'duel', mu: 29, sigma: 5, gamesPlayed: 2, wins: 2, lastPlayedAt: 1 },
      ])

      const payload = await buildLeaderboardCommandPayload(db, kv, null)
      const titles = payload.embeds?.map(embed => embed.toJSON().title) ?? []

      expect(titles).toEqual(['Duo Leaderboard', 'FFA Leaderboard'])
      expect(payload.content).toBeUndefined()
    }
    finally {
      sqlite.close()
    }
  })

  test('returns plain text when no leaderboard mode has enough games yet', async () => {
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

      const payload = await buildLeaderboardCommandPayload(db, kv, null)

      expect(payload.embeds).toBeUndefined()
      expect(payload.content).toBe('No players with enough games to rank yet.')
    }
    finally {
      sqlite.close()
    }
  })

  test('still shows the requested mode when filtered explicitly', async () => {
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

      const payload = await buildLeaderboardCommandPayload(db, kv, 'ffa')
      const embed = payload.embeds?.[0]?.toJSON()

      expect(payload.content).toBeUndefined()
      expect(payload.embeds).toHaveLength(1)
      expect(embed?.title).toBe('FFA Leaderboard')
      expect(embed?.description).toBe('No players with enough games to rank yet.')
    }
    finally {
      sqlite.close()
    }
  })
})
