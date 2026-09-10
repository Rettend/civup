import { createDb, divisionRankPolicies, matches, playerRatingEvents, players, seasonMatchReports, seasons } from '@civup/db'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { prepareQualityCheckpoint } from '../../src/services/ranked/quality-checkpoint.ts'
import { runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('incremental quality agrees with a full rebuild after aging, correction, cancellation, and acceptance-date changes', async () => {
  const { sqlite } = await createTestDatabase()
  const db = createDb(createSqliteD1Database(sqlite))
  const start = 1_800_000_000_000
  try {
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 0 })
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-quality-v1', phase: 'prepared', configJson: '{}', updatedAt: start })
    async function add(id: string, at: number) {
      await db.insert(matches).values({ id, seasonId: 's9', gameMode: '1v1', createdAt: at, status: 'completed' })
      await db.insert(playerRatingEvents).values({ matchId: id, playerId: 'p', mode: 'global', gameMode: '1v1', matchCreatedAt: at, matchCompletedAt: at,
        effectiveGamesDelta: 1, effectiveWinsVsTier2PlusDelta: 2, effectiveWinsVsTier1Delta: 1,
        ratingBeforeMu: 25, ratingBeforeSigma: 3, ratingAfterMu: 26, ratingAfterSigma: 3 })
    }
    await add('old', start)
    let checkpoint = await prepareQualityCheckpoint(db, 'guild', 'p', start)
    await runAtomicSeasonBatch(db, checkpoint.queries)
    const now = start + 90 * 86_400_000
    await add('new', now)
    for (const mutate of [
      async () => {},
      async () => { await db.update(playerRatingEvents).set({ effectiveWinsVsTier1Delta: 0 }).where(eq(playerRatingEvents.matchId, 'old')) },
      async () => { await db.insert(seasonMatchReports).values({ matchId: 'new', seasonId: 's9', acceptedAt: start }) },
      async () => { await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, 'old')) },
      async () => { await db.delete(seasonMatchReports).where(eq(seasonMatchReports.matchId, 'new')) },
      async () => { await db.delete(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'new')) },
    ]) {
      await mutate()
      checkpoint = await prepareQualityCheckpoint(db, 'guild', 'p', now, checkpoint.recent)
      const rebuilt = await prepareQualityCheckpoint(db, 'guild', 'p', now)
      for (const key of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) expect(checkpoint.recent[key]).toBeCloseTo(rebuilt.recent[key], 10)
      await runAtomicSeasonBatch(db, checkpoint.queries)
    }
    expect(checkpoint.recent.effectiveGames).toBe(0)
  }
  finally { sqlite.close() }
})
