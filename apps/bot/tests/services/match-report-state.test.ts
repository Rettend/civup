import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { matches, matchParticipants, players, seasons } from '@civup/db'
import { reportMatch } from '../../src/services/match/report.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('reporting a match that is not ready', () => {
  test.each([
    ['cancelled', 'This match was cancelled. You cannot report a result for it.'],
    ['drafting', 'Finish the draft before reporting the result.'],
  ])('reports the actual %s state before checking season correction rules', async (status, message) => {
    const { db, sqlite } = await createTestDatabase()
    const now = Date.now()
    try {
      await db.insert(seasons).values({
        id: 's9',
        name: 'Season 9',
        seasonNumber: 9,
        startsAt: now - 60_000,
        active: true,
        ratingSystem: 'rp',
        isolatedRatingsEnabled: true,
        publicReadsEnabled: true,
      })
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', createdAt: now },
        { id: 'p2', displayName: 'Player Two', createdAt: now },
      ])
      await db.insert(matches).values({
        id: 'recent-match',
        gameMode: '1v1',
        status,
        seasonId: 's9',
        createdAt: now - 1000,
        draftData: JSON.stringify({ completedAt: now - 500, state: { status: 'complete' } }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'recent-match', playerId: 'p1', team: 0 },
        { matchId: 'recent-match', playerId: 'p2', team: 1 },
      ])

      const result = await reportMatch(db, createTestKv(), {
        matchId: 'recent-match',
        reporterId: 'p1',
        placements: 'A',
      })

      expect(result).toEqual({ error: message })
      const [match] = await db.select().from(matches).where(eq(matches.id, 'recent-match'))
      expect(match?.status).toBe(status)
      const participants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'recent-match'))
      expect(participants.every(player => player.placement == null && player.ratingAfterMu == null)).toBe(true)
    } finally {
      sqlite.close()
    }
  })
})
