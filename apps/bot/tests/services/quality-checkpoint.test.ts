import { createDb, divisionQualityCredits, divisionQualityInitializations, divisionRankPolicies, matches, playerRatingEvents, players, seasonMatchReports, seasons } from '@civup/db'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { initializeQualityCheckpointPage, prepareQualityCheckpoint } from '../../src/services/ranked/quality-checkpoint.ts'
import { runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('quality initialization pages resume and restart changed sources without publishing partial evidence', async () => {
  const { sqlite } = await createTestDatabase()
  const d1 = createSqliteD1Database(sqlite)
  const prepare = d1.prepare.bind(d1)
  const pagePlans: string[] = []
  d1.prepare = (query => ({ bind(...values: unknown[]) {
    if (query.includes('union all') && query.includes('player_rating_events.rowid')) pagePlans.push(JSON.stringify(sqlite.query(`EXPLAIN QUERY PLAN ${query}`).all(...values as any[])))
    return prepare(query).bind(...values)
  } })) as D1Database['prepare']
  const db = createDb(d1)
  try {
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 0 })
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-quality-v1', phase: 'prepared', configJson: '{}', updatedAt: 1000 })
    for (let i = 0; i < 205; i++) {
      const id = String(i).padStart(3, '0')
      await db.insert(matches).values({ id, gameMode: '1v1', createdAt: 0, status: 'completed' })
      await db.insert(playerRatingEvents).values({ matchId: id, playerId: 'p', mode: 'global', gameMode: '1v1', matchCreatedAt: 0, matchCompletedAt: 1000,
        effectiveGamesDelta: 1, ratingBeforeMu: 25, ratingBeforeSigma: 3, ratingAfterMu: 26, ratingAfterSigma: 3 })
    }
    expect(await initializeQualityCheckpointPage(db, 'guild', 'p', 1000)).toBe(false)
    expect(await db.select().from(divisionQualityCredits)).toHaveLength(100)
    expect(await initializeQualityCheckpointPage(db, 'guild', 'p', 1000)).toBe(false)
    expect(await db.select().from(divisionQualityCredits)).toHaveLength(200)
    expect(pagePlans).toHaveLength(1)
    expect(pagePlans[0]).toContain('match_created_at=? AND rowid>?')
    expect(pagePlans[0]).toContain('player_rating_events_player_scope_idx')
    await expect(prepareQualityCheckpoint(db, 'guild', 'p', 1000)).rejects.toThrow('still being prepared')
    await db.delete(playerRatingEvents).where(eq(playerRatingEvents.matchId, '000'))
    let pages = 0
    while (!await initializeQualityCheckpointPage(db, 'guild', 'p', 1000)) {
      if (++pages > 10) throw new Error('Initialization did not make bounded progress')
    }
    expect(pages).toBeGreaterThan(2)
    const ready = await prepareQualityCheckpoint(db, 'guild', 'p', 1000)
    expect(ready.recent.effectiveGames).toBe(204)
    expect(await db.select().from(divisionQualityCredits)).toHaveLength(204)
    await runAtomicSeasonBatch(db, ready.queries)
    expect(await db.select().from(divisionQualityInitializations)).toHaveLength(0)
  }
  finally { sqlite.close() }
})

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
    await expect(prepareQualityCheckpoint(db, 'guild', 'p', start)).rejects.toThrow('still being prepared')
    await initializeQualityCheckpointPage(db, 'guild', 'p', start)
    let checkpoint = await prepareQualityCheckpoint(db, 'guild', 'p', start)
    await runAtomicSeasonBatch(db, checkpoint.queries)
    // Lifecycle projection can dirty an event whose saved evidence is already correct.
    sqlite.exec("CREATE TRIGGER unchanged_credit_delete BEFORE DELETE ON division_quality_credits BEGIN SELECT RAISE(ABORT,'Unchanged credit was deleted'); END")
    sqlite.exec("CREATE TRIGGER unchanged_credit_update BEFORE UPDATE ON division_quality_credits BEGIN SELECT RAISE(ABORT,'Unchanged credit was updated'); END")
    await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'old'))
    const unchanged = await prepareQualityCheckpoint(db, 'guild', 'p', start, checkpoint.recent)
    expect(unchanged.recent).toEqual(checkpoint.recent)
    await runAtomicSeasonBatch(db, unchanged.queries)
    sqlite.exec('DROP TRIGGER unchanged_credit_delete; DROP TRIGGER unchanged_credit_update;')
    const now = start + 90 * 86_400_000
    await add('new', now)
    for (const [index, mutate] of [
      async () => {},
      async () => { await db.update(playerRatingEvents).set({ effectiveWinsVsTier1Delta: 0 }).where(eq(playerRatingEvents.matchId, 'old')) },
      async () => { await db.insert(seasonMatchReports).values({ matchId: 'new', seasonId: 's9', acceptedAt: start }) },
      async () => { await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, 'old')) },
      async () => { await db.delete(seasonMatchReports).where(eq(seasonMatchReports.matchId, 'new')) },
      async () => { await db.delete(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'new')) },
    ].entries()) {
      await mutate()
      checkpoint = await prepareQualityCheckpoint(db, 'guild', 'p', now, checkpoint.recent)
      await initializeQualityCheckpointPage(db, `reference-${index}`, 'p', now)
      const rebuilt = await prepareQualityCheckpoint(db, `reference-${index}`, 'p', now)
      for (const key of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) expect(checkpoint.recent[key]).toBeCloseTo(rebuilt.recent[key], 10)
      await runAtomicSeasonBatch(db, checkpoint.queries)
    }
    expect(checkpoint.recent.effectiveGames).toBe(0)
  }
  finally { sqlite.close() }
})
