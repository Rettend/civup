import { expect, test } from 'bun:test'
import { matches, playerRatingEvents, playerRatings, players, seasonMatchReports, seasons } from '@civup/db'
import { previewOverallDivisionRanks } from '../../src/services/ranked/overall-preview.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('overall preview uses original acceptance dates, excludes cancellations, flags undated evidence, and never changes ratings', async () => {
  const { db, sqlite } = await createTestDatabase()
  const now = Date.now()
  try {
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasons).values({
      id: 's9',
      seasonNumber: 9,
      name: 'Season 9',
      startsAt: 0,
      active: true,
      ratingSystem: 'rp',
      publicReadsEnabled: true,
    })
    await db.insert(playerRatings).values([
      { playerId: 'p', mode: 'global', publicRating: 1250, effectiveGames: 100, winsVsTier1: 5, winsVsTier2Plus: 20 },
      { playerId: 'p', mode: 'duel', publicRating: 1102, effectiveGames: 100 },
    ])
    for (const id of ['saved', 'cancelled', 'undated']) {
      await db.insert(matches).values({
        id,
        seasonId: 's9',
        gameMode: '1v1',
        createdAt: 1,
        status: id === 'cancelled' ? 'cancelled' : 'completed',
      })
      await db.insert(playerRatingEvents).values({
        matchId: id,
        playerId: 'p',
        mode: 'global',
        gameMode: '1v1',
        matchCreatedAt: 1,
        matchCompletedAt: id === 'undated' ? null : now - 1000,
        effectiveGamesDelta: 1,
        effectiveWinsVsTier1Delta: 1,
        effectiveWinsVsTier2PlusDelta: 1,
        ratingBeforeMu: 25,
        ratingBeforeSigma: 3,
        ratingAfterMu: 26,
        ratingAfterSigma: 3,
      })
    }
    await db.insert(seasonMatchReports).values({ matchId: 'saved', seasonId: 's9', acceptedAt: now - 90 * 86_400_000 })
    const before = await db.select().from(playerRatings)
    const [preview] = await previewOverallDivisionRanks(db, ['p'], now)
    expect(preview!.recent.highRankWins).toBe(0.5)
    expect(preview!.recent.effectiveGames).toBe(0.5)
    expect(preview!.undatedMatchIds).toEqual(['undated'])
    expect(preview!.band?.minimum).toBe(1100)
    expect(await db.select().from(playerRatings)).toEqual(before)
  } finally {
    sqlite.close()
  }
})
