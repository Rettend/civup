import { playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildLeaderboardCommandImages } from '../../src/commands/leaderboard.ts'
import { rebuildLeaderboardModeSnapshot } from '../../src/services/leaderboard/snapshot.ts'
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
        { playerId: 'p1', mode: 'ffa', mu: 30, sigma: 5, gamesPlayed: 10, wins: 3, lastPlayedAt: 1 },
        { playerId: 'p2', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 7, wins: 4, lastPlayedAt: 1 },
        { playerId: 'p3', mode: 'duel', mu: 29, sigma: 5, gamesPlayed: 2, wins: 2, lastPlayedAt: 1 },
      ])
      await rebuildLeaderboardModeSnapshot(db, kv, 'ffa')
      await rebuildLeaderboardModeSnapshot(db, kv, 'duo')
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel')

      const payload = await buildLeaderboardCommandImages(db, kv, null)
      const modes = 'images' in payload ? payload.images.map(image => image.mode) : []

      expect(modes).toEqual(['duo', 'ffa'])
      expect('content' in payload ? payload.content : undefined).toBeUndefined()
      if ('images' in payload) {
        expect(payload.images.every(image => isPng(image.data))).toBe(true)
      }
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
      await rebuildLeaderboardModeSnapshot(db, kv, 'ffa')

      const payload = await buildLeaderboardCommandImages(db, kv, null)

      expect('images' in payload ? payload.images : undefined).toBeUndefined()
      expect('content' in payload ? payload.content : undefined).toBe('No players with enough games to rank yet.')
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
