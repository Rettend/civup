import { players, scopedPlayerRatings } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { getCalculatedRankGateError } from '../../src/services/ranked/admission.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const ORIGIN_GUILD_ID = '111111111111111111'
const QUALIFIED_PLAYER_ID = '666666666666666666'
const STATS_CONTEXT = createStatsContext(ORIGIN_GUILD_ID, ORIGIN_GUILD_ID)
const RANKED_ROLES = {
  tier5: '111111111111111111',
  tier4: '222222222222222222',
  tier3: '333333333333333333',
  tier2: '444444444444444444',
  tier1: '555555555555555555',
} as const

describe('calculated ranked role admission', () => {
  test('rejects an unranked player from a rank-gated lobby', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await setRankedRoleCurrentRoles(kv, ORIGIN_GUILD_ID, RANKED_ROLES)

    await expect(getCalculatedRankGateError(db, kv, STATS_CONTEXT, {
      minRole: 'tier5',
      maxRole: null,
    }, ['unranked-player'])).resolves.toBe('<@unranked-player> is unranked in this server and cannot join a rank-gated lobby.')

    sqlite.close()
  })

  test('uses the owning server standings instead of entrant Discord roles', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await setRankedRoleCurrentRoles(kv, ORIGIN_GUILD_ID, RANKED_ROLES)
    await db.insert(players).values({ id: QUALIFIED_PLAYER_ID, displayName: 'Qualified', avatarUrl: null, createdAt: 1 })
    await db.insert(scopedPlayerRatings).values([
      {
        statsKey: STATS_CONTEXT.statsKey,
        playerId: QUALIFIED_PLAYER_ID,
        mode: 'ffa',
        mu: 30,
        sigma: 6,
        gamesPlayed: 25,
        wins: 12,
        effectiveGames: 25,
        lastPlayedAt: 1,
      },
      {
        statsKey: STATS_CONTEXT.statsKey,
        playerId: QUALIFIED_PLAYER_ID,
        mode: 'global',
        mu: 30,
        sigma: 6,
        gamesPlayed: 25,
        wins: 12,
        effectiveGames: 25,
        winsVsTier1: 1,
        winsVsTier2Plus: 4,
        lastPlayedAt: 1,
      },
    ])

    await expect(getCalculatedRankGateError(db, kv, STATS_CONTEXT, {
      minRole: 'tier5',
      maxRole: null,
    }, [QUALIFIED_PLAYER_ID])).resolves.toBeNull()

    sqlite.close()
  })
})
