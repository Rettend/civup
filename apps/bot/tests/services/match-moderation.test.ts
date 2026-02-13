import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { buildLeaderboard } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { cancelMatchByModerator, reportMatch, resolveMatchByModerator } from '../../src/services/match.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match moderation recalculation', () => {
  test('resolve on a past 1v1 match recalculates downstream ratings and keeps leaderboard populated', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: 'B',
        resolvedAt: 10_000,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m1', 'm2', 'm3'])

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      expect(duelRatings).toHaveLength(2)
      expect(duelRatings.every(row => row.gamesPlayed === 3)).toBe(true)

      const p1 = duelRatings.find(row => row.playerId === 'p1')
      const p2 = duelRatings.find(row => row.playerId === 'p2')
      expect(p1?.wins).toBe(1)
      expect(p2?.wins).toBe(2)

      const leaderboardEntries = buildLeaderboard(
        duelRatings.map(row => ({
          playerId: row.playerId,
          mu: row.mu,
          sigma: row.sigma,
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
        })),
      )
      expect(leaderboardEntries.length).toBeGreaterThan(0)

      const [m2p1] = await db
        .select({
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
        })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm2'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m2p1?.ratingBeforeMu).not.toBeCloseTo(27, 5)

      const resolvedM1 = await db
        .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'm1'))

      const m1P1 = resolvedM1.find(row => row.playerId === 'p1')
      const m1P2 = resolvedM1.find(row => row.playerId === 'p2')
      expect(m1P1?.placement).toBe(2)
      expect(m1P2?.placement).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('cancel on a completed 1v1 match removes it from track and recalculates later matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await cancelMatchByModerator(db, kv, {
        matchId: 'm1',
        cancelledAt: 10_000,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m2', 'm3'])

      const [matchRow] = await db
        .select({ status: matches.status })
        .from(matches)
        .where(eq(matches.id, 'm1'))
        .limit(1)

      expect(matchRow?.status).toBe('cancelled')

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      const p1 = duelRatings.find(row => row.playerId === 'p1')
      const p2 = duelRatings.find(row => row.playerId === 'p2')
      expect(p1?.gamesPlayed).toBe(2)
      expect(p2?.gamesPlayed).toBe(2)
      expect(p1?.wins).toBe(1)
      expect(p2?.wins).toBe(1)

      const [m2p1] = await db
        .select({
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
        })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm2'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m2p1?.ratingBeforeMu).not.toBeCloseTo(27, 5)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve accepts winner mention for 1v1 moderation', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: '<@p2>',
        resolvedAt: 10_000,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const resolvedM1 = await db
        .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'm1'))

      const m1P1 = resolvedM1.find(row => row.playerId === 'p1')
      const m1P2 = resolvedM1.find(row => row.playerId === 'p2')
      expect(m1P1?.placement).toBe(2)
      expect(m1P2?.placement).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('report rejects FFA users not in the match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveFfaMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'ffa1',
        reporterId: 'p1',
        placements: '<@p1>\n<@p2>\n<@p3>\n<@p4>\n<@p5>\n<@p6>\n<@outsider>',
      })

      expect('error' in result).toBe(true)
      if (!('error' in result)) return
      expect(result.error).toContain('is not part of match')
    }
    finally {
      sqlite.close()
    }
  })
})

async function seedThreeCompletedDuels(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values([
    { id: 'm1', gameMode: '1v1', status: 'completed', createdAt: 1000, completedAt: 2000, seasonId: null, draftData: null },
    { id: 'm2', gameMode: '1v1', status: 'completed', createdAt: 3000, completedAt: 4000, seasonId: null, draftData: null },
    { id: 'm3', gameMode: '1v1', status: 'completed', createdAt: 5000, completedAt: 6000, seasonId: null, draftData: null },
  ])

  await db.insert(matchParticipants).values([
    // m1: p1 beats p2
    { matchId: 'm1', playerId: 'p1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 27, ratingAfterSigma: 7.9 },
    { matchId: 'm1', playerId: 'p2', team: 1, civId: 'greece', placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 23, ratingAfterSigma: 7.9 },

    // m2: p1 beats p2 again
    { matchId: 'm2', playerId: 'p1', team: 0, civId: 'india', placement: 1, ratingBeforeMu: 27, ratingBeforeSigma: 7.9, ratingAfterMu: 28, ratingAfterSigma: 7.5 },
    { matchId: 'm2', playerId: 'p2', team: 1, civId: 'japan', placement: 2, ratingBeforeMu: 23, ratingBeforeSigma: 7.9, ratingAfterMu: 22, ratingAfterSigma: 7.5 },

    // m3: p2 beats p1
    { matchId: 'm3', playerId: 'p1', team: 0, civId: 'france', placement: 2, ratingBeforeMu: 28, ratingBeforeSigma: 7.5, ratingAfterMu: 26, ratingAfterSigma: 7.2 },
    { matchId: 'm3', playerId: 'p2', team: 1, civId: 'china', placement: 1, ratingBeforeMu: 22, ratingBeforeSigma: 7.5, ratingAfterMu: 24, ratingAfterSigma: 7.2 },
  ])

  await db.insert(playerRatings).values([
    { playerId: 'p1', mode: 'duel', mu: 26, sigma: 7.2, gamesPlayed: 3, wins: 2, lastPlayedAt: 6000 },
    { playerId: 'p2', mode: 'duel', mu: 24, sigma: 7.2, gamesPlayed: 3, wins: 1, lastPlayedAt: 6000 },
  ])
}

async function seedActiveFfaMatch(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
    { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
    { id: 'p4', displayName: 'P4', avatarUrl: null, createdAt: 1 },
    { id: 'p5', displayName: 'P5', avatarUrl: null, createdAt: 1 },
    { id: 'p6', displayName: 'P6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values({
    id: 'ffa1',
    gameMode: 'ffa',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: null,
  })

  await db.insert(matchParticipants).values([
    { matchId: 'ffa1', playerId: 'p1', team: null, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p2', team: null, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p3', team: null, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p4', team: null, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p5', team: null, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p6', team: null, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}
