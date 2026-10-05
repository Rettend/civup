import { expect, test } from 'bun:test'
import { createDb, divisionRankPolicies, divisionRankStates, playerRatings, players, seasons } from '@civup/db'
import { PUBLIC_RATING_BANDS, resolveOverallRank } from '@civup/rating'
import { refreshRankedPopulation } from '../../src/services/ranked/division-refresh.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('deployment catch-up skips untouched Unranked players and queues only changed ranked roles', async () => {
  const { sqlite } = await createTestDatabase()
  const db = createDb(createSqliteD1Database(sqlite)),
    kv = createTestKv(),
    now = Date.now()
  try {
    const ids = ['changed', 'same', ...Array.from({ length: 100 }, (_, i) => `unranked-${i}`)]
    await db.insert(players).values(ids.map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasons).values({
      id: 'season',
      name: 'Season',
      seasonNumber: 9,
      startsAt: 0,
      active: true,
      ratingSystem: 'rp',
      publicReadsEnabled: true,
    })
    const roleIdsByMinimum = Object.fromEntries(PUBLIC_RATING_BANDS.map(b => [b.minimum, `role-${b.minimum}`]))
    await db.insert(divisionRankPolicies).values({
      guildId: 'guild',
      seasonId: 'season',
      phase: 'active',
      version: 'best-mode-quality-v1',
      updatedAt: now,
      configJson: JSON.stringify({ preparation: { roleIdsByMinimum, unrankedRoleId: 'regular' } }),
    })
    for (const id of ids) {
      const ranked = !id.startsWith('unranked')
      const result = resolveOverallRank({
        modes: ranked ? [{ mode: 'duel', rating: 1100, effectiveGames: 50 }] : [],
        recent: { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 },
        lifetimeEliteWins: 0,
        lifetimeHighRankWins: 0,
        now,
      })
      await db.insert(divisionRankStates).values({
        guildId: 'guild',
        playerId: id,
        nextCheckAt: null,
        resultJson: JSON.stringify({ ...result, policyVersion: 'best-mode-quality-v1' }),
        appliedRoleId: ranked ? roleIdsByMinimum[id === 'changed' ? 1200 : 1100] : 'regular',
      })
      if (ranked)
        await db.insert(playerRatings).values({ playerId: id, mode: 'duel', publicRating: 1100, effectiveGames: 50 })
    }
    sqlite.exec(
      'update division_rank_states set source_revision=coalesce((select revision from division_rank_sources where player_id=division_rank_states.player_id),0), next_check_at=null',
    )
    const before = (await db.select().from(divisionRankStates)).filter(row => row.playerId.startsWith('unranked'))
    const policy = (await db.select().from(divisionRankPolicies))[0]!
    expect(await refreshRankedPopulation(db, kv, policy, now)).toEqual({ calculated: 2, blocked: null, remaining: 0 })
    const after = await db.select().from(divisionRankStates)
    expect(after.filter(row => row.playerId.startsWith('unranked'))).toEqual(before)
    expect(after.filter(row => row.pending).map(row => row.playerId)).toEqual(['changed'])
    expect(await refreshRankedPopulation(db, kv, policy, now)).toEqual({ calculated: 0, blocked: null, remaining: 0 })
  } finally {
    sqlite.close()
  }
})
