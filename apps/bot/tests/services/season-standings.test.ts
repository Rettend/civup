import { createDb, playerRatings, players, seasonPeakDivisionRanks, seasonPeakModeRanks, seasonPeakRanks, seasonRatingStates, seasonStandingSnapshots, seasons } from '@civup/db'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { loadSeasonStandings } from '../../src/services/season/standings.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('historical standings are saved once, shared between players, and recovered from D1 on KV loss without reranking', async () => {
  const { sqlite } = await createTestDatabase()
  const queries: string[] = []
  const d1 = createSqliteD1Database({ prepare(query: string) { queries.push(query); return sqlite.prepare(query) }, exec: sqlite.exec.bind(sqlite) })
  const db = createDb(d1)
  const kv = createTestKv()
  try {
    await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0 })
    await db.insert(players).values(['a', 'b', 'new'].map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasonRatingStates).values(['b', 'a', 'new'].map(id => ({ seasonId: 's8', playerId: id, mode: 'duel', mu: id === 'new' ? 50 : 30, sigma: 3, evidence: { gamesPlayed: id === 'new' ? 1 : 10 }, updatedAt: 1 })))
    await db.insert(seasonPeakRanks).values({ seasonId: 's8', playerId: 'b', tier: 'tier2', achievedAt: 1 })
    await db.insert(seasonPeakModeRanks).values({ seasonId: 's8', playerId: 'b', mode: 'duel', tier: 'tier3', rating: 1200, achievedAt: 1 })
    const first = await loadSeasonStandings(db, kv, 's8')
    expect(first?.modes.find(row => row.playerId === 'a')?.position).toBe(1)
    expect(first?.modes.find(row => row.playerId === 'b')).toMatchObject({ position: 2, peakTier: 'tier3', peakRating: 1200 })
    expect(first?.modes.find(row => row.playerId === 'new')?.position).toBeNull()
    expect(first?.peaks).toEqual([{ playerId: 'b', tier: 'tier2', divisionMinimum: null }])
    expect(await db.select().from(seasonStandingSnapshots)).toHaveLength(1)

    queries.length = 0
    expect(await loadSeasonStandings(db, kv, 's8')).toEqual(first)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('from "seasons"')
    const emptyKv = createTestKv()
    queries.length = 0
    expect(await loadSeasonStandings(db, emptyKv, 's8')).toEqual(first)
    expect(queries).toHaveLength(2)
    expect(queries.join('\n')).not.toContain('season_rating_states')
    expect(queries.join('\n')).not.toContain('insert')

    // A late report changes historical positions without involving live ratings.
    await db.update(seasonRatingStates).set({ mu: 35 }).where(eq(seasonRatingStates.playerId, 'b'))
    expect((await loadSeasonStandings(db, kv, 's8'))?.modes.find(row => row.playerId === 'b')?.position).toBe(1)
    await db.delete(seasonRatingStates).where(eq(seasonRatingStates.playerId, 'b'))
    expect((await loadSeasonStandings(db, kv, 's8'))?.modes.some(row => row.playerId === 'b')).toBe(false)
    await db.update(seasonPeakRanks).set({ tier: 'tier1' })
    expect((await loadSeasonStandings(db, kv, 's8'))?.peaks).toEqual([{ playerId: 'b', tier: 'tier1', divisionMinimum: null }])

    await db.update(seasons).set({ finalizedAt: 3 }).where(eq(seasons.id, 's8'))
    await loadSeasonStandings(db, kv, 's8')
    expect((await db.select().from(seasonStandingSnapshots))[0]?.finalizedAt).toBe(3)
    await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 4, active: true })
    const revision = (await db.select().from(seasons).where(eq(seasons.id, 's8')))[0]!.standingsRevision
    await db.insert(playerRatings).values({ playerId: 'a', mode: 'duel', mu: 70 })
    await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId: 'a', mode: 'duel', mu: 70, sigma: 3, evidence: {}, updatedAt: 5 })
    expect((await db.select().from(seasons).where(eq(seasons.id, 's8')))[0]!.standingsRevision).toBe(revision)
    expect((await db.select().from(seasons).where(eq(seasons.id, 's9')))[0]!.standingsRevision).toBe(0)
  }
  finally { sqlite.close() }
})

test('standings publication failure preserves the saved snapshot and source races cannot poison an earlier revision key', async () => {
  const { db, sqlite } = await createTestDatabase()
  const kv = createTestKv()
  try {
    await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0 })
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasonRatingStates).values({ seasonId: 's8', playerId: 'p', mode: 'duel', mu: 30, sigma: 3, evidence: { gamesPlayed: 10 }, updatedAt: 1 })
    const get = kv.get.bind(kv)
    let raced = false
    kv.get = (async (...args: Parameters<typeof get>) => {
      if (!raced) { raced = true; await db.update(seasonRatingStates).set({ mu: 35 }) }
      return get(...args)
    }) as typeof kv.get
    await loadSeasonStandings(db, kv, 's8')
    const saved = (await db.select().from(seasonStandingSnapshots))[0]!
    const keys = await kv.list({ prefix: 'leaderboard:season-snapshot:' })
    expect(keys.keys.map(key => key.name)).toEqual([`leaderboard:season-snapshot:v1:s8:${saved.revision}`])
    const failedKv = createTestKv()
    failedKv.put = async () => { throw new Error('KV unavailable') }
    await expect(loadSeasonStandings(db, failedKv, 's8')).rejects.toThrow('KV unavailable')
    expect((await db.select().from(seasonStandingSnapshots))[0]).toEqual(saved)
    expect(await loadSeasonStandings(db, createTestKv(), 's8')).toEqual(JSON.parse(saved.payload))
  }
  finally { sqlite.close() }
})

test('historical RP snapshots never substitute hidden ratings or reuse unpublished standings', async () => {
  const { db, sqlite } = await createTestDatabase()
  const kv = createTestKv()
  try {
    await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 0, ratingSystem: 'rp', publicReadsEnabled: false })
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId: 'p', mode: 'duel', mu: 50, sigma: 3, evidence: { gamesPlayed: 10 }, updatedAt: 1 })
    expect(await loadSeasonStandings(db, kv, 's9')).toBeNull()
    await db.update(seasons).set({ publicReadsEnabled: true })
    await expect(loadSeasonStandings(db, kv, 's9')).rejects.toThrow('not ready')
    expect(await db.select().from(seasonStandingSnapshots)).toHaveLength(0)
    await db.update(seasonRatingStates).set({ publicRating: 1000 })
    expect((await loadSeasonStandings(db, kv, 's9'))?.modes[0]).toMatchObject({ rating: 1000, position: 1 })
    await db.insert(seasonPeakRanks).values({ seasonId: 's9', playerId: 'p', tier: 'tier2', achievedAt: 1 })
    await db.insert(seasonPeakDivisionRanks).values({ seasonId: 's9', playerId: 'p', minimum: 1400, achievedAt: 1 })
    expect((await loadSeasonStandings(db, kv, 's9'))?.peaks).toEqual([{ playerId: 'p', tier: 'tier2', divisionMinimum: 1400 }])
    await db.update(seasons).set({ publicReadsEnabled: false })
    expect(await loadSeasonStandings(db, kv, 's9')).toBeNull()
  }
  finally { sqlite.close() }
})
