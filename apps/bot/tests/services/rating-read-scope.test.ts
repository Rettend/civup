import { createDb, divisionRankPolicies, divisionRankStates, playerRatings, players, seasonRatingStates, seasons } from '@civup/db'
import { expect, test } from 'bun:test'
import { ensureLeaderboardModeSnapshots } from '../../src/services/leaderboard/snapshot.ts'
import { loadSelectedSeasonRatings } from '../../src/services/season/ratings.ts'
import { resolveSeasonSelection } from '../../src/services/season/selection.ts'
import { loadMatchOpponentTiers } from '../../src/services/ranked/match-tiers.ts'
import { currentRankAssignmentsKey, getCurrentRankAssignments } from '../../src/services/ranked/role-sync.ts'
import { nextDivisionWakeAt } from '../../src/services/ranked/division-projection.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('empty team leaderboards never rebuild ratings or read match history', async () => {
  const { sqlite } = await createTestDatabase()
  const queries: string[] = []
  const db = createDb(createSqliteD1Database({ prepare(query) { queries.push(query); return sqlite.prepare(query) }, exec: sqlite.exec.bind(sqlite) }))
  try {
    const snapshots = await ensureLeaderboardModeSnapshots(db, createTestKv(), ['duo', 'squad'])
    expect([...snapshots.values()].map(snapshot => snapshot.rows)).toEqual([[], []])
    expect(queries.join('\n')).not.toMatch(/\b(matches|match_participants|player_rating_events)\b/)
    expect(queries.join('\n')).not.toMatch(/(?:insert into|update|delete from) "player_ratings"/)
  }
  finally { sqlite.close() }
})

test('isolated season statistics use saved counters for current and historical views without reading matches', async () => {
  const { sqlite } = await createTestDatabase()
  const queries: string[] = []
  const db = createDb(createSqliteD1Database({ prepare(query) { queries.push(query); return sqlite.prepare(query) }, exec: sqlite.exec.bind(sqlite) }))
  try {
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasons).values([
      { id: 's8', name: 'Season 8', seasonNumber: 8, startsAt: 0, endsAt: 1000, isolatedRatingsEnabled: true },
      { id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 1000, active: true, ratingSystem: 'rp', publicReadsEnabled: true, isolatedRatingsEnabled: true },
    ])
    await db.insert(playerRatings).values({ playerId: 'p', mode: 'duel', gamesPlayed: 104, wins: 62, publicRating: 900 })
    await db.insert(seasonRatingStates).values([
      { seasonId: 's8', playerId: 'p', mode: 'duel', mu: 30, sigma: 3, seasonGames: 100, seasonWins: 60, evidence: { gamesPlayed: 100 }, updatedAt: 999 },
      { seasonId: 's9', playerId: 'p', mode: 'duel', mu: 30, sigma: 3, publicRating: 900, seasonGames: 4, seasonWins: 2, evidence: { gamesPlayed: 104 }, updatedAt: 2000 },
    ])
    queries.length = 0
    expect(await loadSelectedSeasonRatings(db, await resolveSeasonSelection(db, 'current'), ['p'])).toMatchObject([
      { gamesPlayed: 4, wins: 2, lifetimeGamesPlayed: 104, publicRating: 900 },
    ])
    expect(await loadSelectedSeasonRatings(db, await resolveSeasonSelection(db, 8), ['p'])).toMatchObject([
      { gamesPlayed: 100, wins: 60, lifetimeGamesPlayed: 100 },
    ])
    expect(queries.join('\n')).not.toMatch(/\b(matches|match_participants|player_rating_events)\b/)
  }
  finally { sqlite.close() }
})

test('missing division caches do not load the guild map and reports use current participant assignments', async () => {
  const { db, sqlite } = await createTestDatabase()
  const kv = createTestKv()
  try {
    await db.insert(players).values(['p', 'other', 'unranked'].map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 0, active: true })
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-one-division-v2', phase: 'active', configJson: '{}', updatedAt: 0 })
    await db.insert(divisionRankStates).values([
      { guildId: 'guild', playerId: 'p', resultJson: JSON.stringify({ band: { tier: 'tier3', minimum: 1000 } }), projectionPending: true },
      { guildId: 'guild', playerId: 'other', resultJson: JSON.stringify({ band: { tier: 'tier1', minimum: 1500 } }) },
      { guildId: 'guild', playerId: 'unranked', resultJson: JSON.stringify({ band: null }) },
    ])
    await kv.put('ranked-roles:config:guild', JSON.stringify({ tiers: Array.from({ length: 5 }, () => ({ roleId: null, label: null })), divisionPolicy: { version: 'best-mode-one-division-v2', roleIdsByMinimum: { 1000: 'role' } } }))
    await kv.put(currentRankAssignmentsKey('guild'), JSON.stringify({ byPlayerId: { p: { tier: 'tier1' } } }))
    const get = kv.get.bind(kv)
    kv.get = (async (...args: Parameters<typeof get>) => {
      if (args[0] === currentRankAssignmentsKey('guild')) throw new Error('Unexpected full guild map read')
      return get(...args)
    }) as typeof kv.get
    expect(await getCurrentRankAssignments(kv, 'guild', ['p', 'unranked'])).toEqual({ byPlayerId: {} })
    expect([...await loadMatchOpponentTiers(db, kv, 'guild', ['p', 'unranked'])]).toEqual([['p', 'tier3']])
  }
  finally { sqlite.close() }
})

test('one failed division calculation cannot delay another player deadline, and player invalidation uses an index', async () => {
  const { db, sqlite } = await createTestDatabase()
  try {
    await db.insert(players).values(['failed', 'due'].map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 0, active: true })
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-one-division-v2', phase: 'active', configJson: '{}', updatedAt: 0 })
    await db.insert(divisionRankStates).values([
      { guildId: 'guild', playerId: 'failed', nextCheckAt: 0, retryAt: 300000 },
      { guildId: 'guild', playerId: 'due', nextCheckAt: 5000, retryAt: 0 },
    ])
    expect(await nextDivisionWakeAt(db, 'guild', 2000)).toBe(5000)
    const plan = sqlite.query("EXPLAIN QUERY PLAN UPDATE division_rank_states SET next_check_at=0 WHERE player_id='due'").all()
    expect(JSON.stringify(plan)).toContain('SEARCH division_rank_states USING INDEX division_rank_states_player_idx')
  }
  finally { sqlite.close() }
})
