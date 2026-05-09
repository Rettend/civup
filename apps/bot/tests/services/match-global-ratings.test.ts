import { matches, matchParticipants, playerRatingEvents, playerRatings, playerRatingSeeds, players } from '@civup/db'
import { calculateRatings, createRating, DEFAULT_MU, DEFAULT_SIGMA, IMPORTED_GAME_EFFECTIVE_WEIGHT } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { recalculateGlobalRatings, recalculateLeaderboardMode, reportMatch } from '../../src/services/match/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = 'p1'
const VILLAIN_ID = 'p2'
const ALLY_ID = 'p3'
const OTHER_ID = 'p4'

describe('match global ratings', () => {
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true }

  test('recalculation ignores manual seed rows in production runtime', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(db)
      await db.insert(playerRatingSeeds).values({
        playerId: HERO_ID,
        mode: 'duel',
        mu: DEFAULT_MU + 10,
        sigma: DEFAULT_SIGMA,
        eligibleForRanked: true,
        fadeGamesRemaining: 10,
        source: 'manual-role',
        note: 'legacy seed ignored by runtime',
        createdAt: NOW,
        updatedAt: NOW,
      })
      await seedCompletedDuel(db, { matchId: 'm1', completedAt: NOW, isOld: false })

      const result = await recalculateLeaderboardMode(db, 'duel')
      expect('error' in result).toBe(false)
      if ('error' in result) return

      const hero = await loadParticipant(db, 'm1', HERO_ID)
      const rating = await loadPlayerRating(db, HERO_ID, 'duel')
      expect(hero?.ratingBeforeMu).toBeCloseTo(DEFAULT_MU, 6)
      expect(rating?.gamesPlayed).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('imported matches count as visible partial evidence', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(db)
      await seedCompletedDuel(db, { matchId: 'old-1', completedAt: NOW, isOld: true })

      const result = await recalculateLeaderboardMode(db, 'duel')
      expect('error' in result).toBe(false)
      if ('error' in result) return

      const rating = await loadPlayerRating(db, HERO_ID, 'duel')
      const hero = await loadParticipant(db, 'old-1', HERO_ID)
      const [fullHeroUpdate] = calculateRatings({
        type: 'team',
        teams: [
          { players: [createRating(HERO_ID)] },
          { players: [createRating(VILLAIN_ID)] },
        ],
      })
      const expectedImportedMu = DEFAULT_MU + (((fullHeroUpdate?.after.mu ?? DEFAULT_MU) - DEFAULT_MU) * IMPORTED_GAME_EFFECTIVE_WEIGHT)
      expect(rating?.gamesPlayed).toBe(1)
      expect(rating?.importedGames).toBe(1)
      expect(rating?.effectiveGames).toBe(0.5)
      expect(hero?.ratingAfterMu).toBeCloseTo(expectedImportedMu, 6)
      expect(rating?.lastPlayedAt).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('reportMatch writes mode and global summary rows', async () => {
    const { db, sqlite } = await createTestDatabase()
      const kv = createTestKv()

      try {
        await seedDuelPlayers(db)
        await kv.put('ranked-roles:current-assignments:guild-1', JSON.stringify({
          byPlayerId: {
            [VILLAIN_ID]: { tier: 'tier1', sourceMode: null },
          },
        }))
        await seedActiveDuel(db, 'active-1', NOW)

        const result = await reportMatch(db, kv, {
          matchId: 'active-1',
          reporterId: HERO_ID,
          placements: `<@${HERO_ID}>`,
        }, { ...directTerminalOptions, rankedRoleGuildId: 'guild-1' })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const modeRating = await loadPlayerRating(db, HERO_ID, 'duel')
      const globalRating = await loadPlayerRating(db, HERO_ID, 'global')
      const modeEvent = await loadPlayerRatingEvent(db, 'active-1', HERO_ID, 'duel')
      const globalEvent = await loadPlayerRatingEvent(db, 'active-1', HERO_ID, 'global')
      expect(modeRating?.gamesPlayed).toBe(1)
      expect(globalRating?.gamesPlayed).toBe(1)
      expect(globalRating?.effectiveGames).toBe(1)
      expect(globalRating?.winsVsTier1).toBe(1)
      expect(globalRating?.winsVsTier2Plus).toBe(1)
      expect(globalRating?.effectiveWinsVsTier1).toBe(1)
      expect(globalRating?.effectiveWinsVsTier2Plus).toBe(1)
      expect(modeEvent?.winsVsTier1Delta).toBe(0)
      expect(modeEvent?.effectiveWinsVsTier1Delta).toBe(0)
      expect(globalEvent?.winsVsTier1Delta).toBe(1)
      expect(globalEvent?.effectiveWinsVsTier1Delta).toBe(1)
      expect(globalEvent?.effectiveGamesDelta).toBe(1)
      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('global recalculation rebuilds the canonical global scope', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(db)
      await seedCompletedDuel(db, { matchId: 'm1', completedAt: NOW - 1_000, isOld: false })
      await seedCompletedDuel(db, { matchId: 'old-1', completedAt: NOW, isOld: true })

      const result = await recalculateGlobalRatings(db, {
        opponentTierByPlayerId: new Map([[VILLAIN_ID, 'tier2']]),
      })
      expect('error' in result).toBe(false)
      if ('error' in result) return

      const rating = await loadPlayerRating(db, HERO_ID, 'global')
      const oldEvent = await loadPlayerRatingEvent(db, 'old-1', HERO_ID, 'global')
      expect(rating?.gamesPlayed).toBe(2)
      expect(rating?.importedGames).toBe(1)
      expect(rating?.effectiveGames).toBe(1.5)
      expect(rating?.winsVsTier1).toBe(0)
      expect(rating?.winsVsTier2Plus).toBe(2)
      expect(rating?.effectiveWinsVsTier1).toBe(0)
      expect(rating?.effectiveWinsVsTier2Plus).toBe(1.5)
      expect(oldEvent?.importedGamesDelta).toBe(1)
      expect(oldEvent?.effectiveGamesDelta).toBe(0.5)
      expect(oldEvent?.effectiveWinsVsTier2PlusDelta).toBe(0.5)
    }
    finally {
      sqlite.close()
    }
  })

  test('effective quality wins are weighted by winner team size', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedTeamPlayers(db)
      await seedCompletedTeamMatch(db, { matchId: 'team-1', completedAt: NOW, isOld: false })

      const result = await recalculateGlobalRatings(db, {
        opponentTierByPlayerId: new Map([[VILLAIN_ID, 'tier2']]),
      })
      expect('error' in result).toBe(false)
      if ('error' in result) return

      const rating = await loadPlayerRating(db, HERO_ID, 'global')
      const event = await loadPlayerRatingEvent(db, 'team-1', HERO_ID, 'global')
      expect(rating?.winsVsTier2Plus).toBe(1)
      expect(rating?.effectiveWinsVsTier2Plus).toBe(0.5)
      expect(event?.effectiveWinsVsTier2PlusDelta).toBe(0.5)
    }
    finally {
      sqlite.close()
    }
  })
})

async function seedDuelPlayers(db: Awaited<ReturnType<typeof createTestDatabase>>['db']): Promise<void> {
  await db.insert(players).values([
    { id: HERO_ID, displayName: HERO_ID, avatarUrl: null, createdAt: NOW },
    { id: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, createdAt: NOW },
  ]).onConflictDoNothing()
}

async function seedTeamPlayers(db: Awaited<ReturnType<typeof createTestDatabase>>['db']): Promise<void> {
  await db.insert(players).values([
    { id: HERO_ID, displayName: HERO_ID, avatarUrl: null, createdAt: NOW },
    { id: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, createdAt: NOW },
    { id: ALLY_ID, displayName: ALLY_ID, avatarUrl: null, createdAt: NOW },
    { id: OTHER_ID, displayName: OTHER_ID, avatarUrl: null, createdAt: NOW },
  ]).onConflictDoNothing()
}

async function seedActiveDuel(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  completedAt: number,
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: '1v1',
    status: 'active',
    isOld: false,
    createdAt: completedAt,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt }),
  })
  await seedDuelParticipants(db, matchId, null)
}

async function seedCompletedDuel(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: { matchId: string, completedAt: number, isOld: boolean },
): Promise<void> {
  await db.insert(matches).values({
    id: input.matchId,
    gameMode: '1v1',
    status: 'completed',
    isOld: input.isOld,
    createdAt: input.completedAt,
    completedAt: input.completedAt,
    seasonId: null,
    draftData: null,
  })
  await seedDuelParticipants(db, input.matchId, 1)
}

async function seedCompletedTeamMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: { matchId: string, completedAt: number, isOld: boolean },
): Promise<void> {
  await db.insert(matches).values({
    id: input.matchId,
    gameMode: '2v2',
    status: 'completed',
    isOld: input.isOld,
    createdAt: input.completedAt,
    completedAt: input.completedAt,
    seasonId: null,
    draftData: null,
  })
  await db.insert(matchParticipants).values([
    { matchId: input.matchId, playerId: HERO_ID, team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: input.matchId, playerId: ALLY_ID, team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: input.matchId, playerId: VILLAIN_ID, team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: input.matchId, playerId: OTHER_ID, team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function seedDuelParticipants(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  heroPlacement: number | null,
): Promise<void> {
  await db.insert(matchParticipants).values([
    { matchId, playerId: HERO_ID, team: 0, civId: null, placement: heroPlacement, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId, playerId: VILLAIN_ID, team: 1, civId: null, placement: heroPlacement == null ? null : 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function loadParticipant(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  playerId: string,
) {
  const [participant] = await db
    .select()
    .from(matchParticipants)
    .where(and(
      eq(matchParticipants.matchId, matchId),
      eq(matchParticipants.playerId, playerId),
    ))
    .limit(1)
  return participant ?? null
}

async function loadPlayerRating(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerId: string,
  mode: string,
) {
  const [rating] = await db
    .select()
    .from(playerRatings)
    .where(and(
      eq(playerRatings.playerId, playerId),
      eq(playerRatings.mode, mode),
    ))
    .limit(1)
  return rating ?? null
}

async function loadPlayerRatingEvent(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  playerId: string,
  mode: string,
) {
  const [event] = await db
    .select()
    .from(playerRatingEvents)
    .where(and(
      eq(playerRatingEvents.matchId, matchId),
      eq(playerRatingEvents.playerId, playerId),
      eq(playerRatingEvents.mode, mode),
    ))
    .limit(1)
  return event ?? null
}
