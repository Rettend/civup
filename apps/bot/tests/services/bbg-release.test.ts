import { createDb, civStatTotals, matches, matchCivStatContributions } from '@civup/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'bun:test'
import { getStoredCivLeaderboardDisplayConfig, getStoredCivLeaderboardSnapshot, rebuildCivLeaderboardSnapshots, reconcileCivLeaderboardMatchContribution, selectReleaseContributions, setCivLeaderboardDisplayConfig } from '../../src/services/leaderboard/civ-snapshot.ts'
import { advanceCivReleaseProjection } from '../../src/services/leaderboard/civ-release.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'

test('release samples use at most 1000 games, replace oldest beta games globally, and restore after cancellation', () => {
  const row = (matchId: string, source: string, modeScope: string, completedAt: number) => ({ matchId, source, modeScope, completedAt })
  const beta = [row('old', 'beta', 'duel', 1), row('new', 'beta', 'duel', 3), row('squad', 'beta', 'squad', 2)]
  const live = [row('live', 'live', 'duel', 3)]
  expect(selectReleaseContributions([...beta, ...live]).map(row => row.matchId)).toEqual(['live', 'new', 'squad'])
  expect(selectReleaseContributions(beta).map(row => row.matchId)).toEqual(['new', 'squad', 'old'])
  expect(selectReleaseContributions([...beta, ...live, row('live2', 'live', 'duel', 4)]).filter(row => row.source === 'beta').map(row => row.matchId)).toEqual(['new'])
  const manyBeta = Array.from({ length: 1100 }, (_, i) => row(`beta${i}`, 'beta', 'duel', i))
  expect(selectReleaseContributions(manyBeta)).toHaveLength(1000)
  const manyLive = Array.from({ length: 1000 }, (_, i) => row(`live${i}`, 'live', 'duel', i + 2000))
  expect(selectReleaseContributions([...manyBeta, ...manyLive]).some(row => row.source === 'beta')).toBe(false)
})

test('release snapshots preserve historical beta identity and exclude pre-release live drafts reported late', async () => {
  const { sqlite } = await createTestDatabase()
  const db = createDb(createSqliteD1Database(sqlite))
  const kv = createTestKv()
  try {
    await db.insert(civStatTotals).values({ scope: 'history-initialized', completedMatchCount: 0, updatedAt: 1 })
    for (const [id, source, createdAt, completedAt] of [
      ['beta1', 'beta', 100, 200], ['beta2', 'beta', 300, 400], ['late-old', 'live', 500, 1100], ['live', 'live', 1100, 1200],
    ] as const) {
      await db.insert(matches).values({ id, gameMode: '1v1', status: 'completed', createdAt, completedAt, draftData: JSON.stringify({ leaderDataVersion: source, state: { availableCivIds: ['rome-trajan'] } }) })
      await reconcileCivLeaderboardMatchContribution(db, id, completedAt)
    }
    expect((await db.select().from(matchCivStatContributions).where(eq(matchCivStatContributions.matchId, 'beta1')))[0]!.source).toBe('beta')
    await setCivLeaderboardDisplayConfig(kv, { version: 1, label: 'BBG release', liveFrom: 1000, betaFrom: 0, betaUntil: 1000, pendingBetaFrom: 1000, betaReplacement: 'one-for-one', betaSeedMatchIds: ['beta1', 'beta2'] })
    while (!await advanceCivReleaseProjection(db, await getStoredCivLeaderboardDisplayConfig(kv))) {}
    const snapshot = (await rebuildCivLeaderboardSnapshots(db, kv, ['duel'], 1400)).get('duel')!
    expect(snapshot.completedMatchCount).toBe(2)
    expect(snapshot.periodId).toBe('BBG release:1000')
    expect((await getStoredCivLeaderboardSnapshot(kv, 'duel'))?.periodId).toBe(snapshot.periodId)
    await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, 'live'))
    await reconcileCivLeaderboardMatchContribution(db, 'live', 1500)
    while (!await advanceCivReleaseProjection(db, await getStoredCivLeaderboardDisplayConfig(kv))) {}
    expect((await rebuildCivLeaderboardSnapshots(db, kv, ['duel'], 1600)).get('duel')!.completedMatchCount).toBe(2)
  }
  finally { sqlite.close() }
})
