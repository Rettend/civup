import { matchParticipants, matches, players, scopedMatchPlayerCivStatContributions, scopedPlayerCivStats, seasons } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildPlayerCivBackfillSql, buildPlayerCivBackfillValidationQueries } from '../../scripts/player-civ-backfill-shared.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const PRIMARY = '111111111111111111'
const PARTNER = '222222222222222222'

describe('scoped player-leader backfill', () => {
  test('rebuilds each server independently and keeps partner history all-time', async () => {
    const { db, sqlite } = await createTestDatabase()
    const primaryContext = createStatsContext(PRIMARY, PRIMARY)
    const partnerContext = createStatsContext(PARTNER, PRIMARY)
    await db.insert(players).values([
      { id: 'p1', displayName: 'P1', createdAt: 1 },
      { id: 'p2', displayName: 'P2', createdAt: 1 },
    ])
    await db.insert(seasons).values({ id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: 1, active: false })
    await db.insert(matches).values([
      { id: 'primary-match', guildId: PRIMARY, gameMode: '1v1', status: 'completed', seasonId: 'season-1', createdAt: 1, completedAt: 2 },
      { id: 'partner-match', guildId: PARTNER, gameMode: '1v1', status: 'completed', seasonId: 'season-1', createdAt: 3, completedAt: 4 },
    ])
    await db.insert(matchParticipants).values([
      { matchId: 'primary-match', playerId: 'p1', civId: 'rome-trajan', placement: 1 },
      { matchId: 'partner-match', playerId: 'p2', civId: 'rome-trajan', placement: 2 },
    ])

    sqlite.exec(buildPlayerCivBackfillSql(primaryContext, 10))
    sqlite.exec(buildPlayerCivBackfillSql(partnerContext, 11))
    sqlite.exec(buildPlayerCivBackfillSql(primaryContext, 12))

    const rows = await db.select().from(scopedPlayerCivStats)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ statsKey: primaryContext.statsKey, seasonId: 'season-1', playerId: 'p1', picks: 1, wins: 1 }),
      expect.objectContaining({ statsKey: partnerContext.statsKey, seasonId: '', playerId: 'p2', picks: 1, wins: 0 }),
    ]))
    expect(rows).toHaveLength(2)

    const [contribution] = await db.select().from(scopedMatchPlayerCivStatContributions).where(eq(scopedMatchPlayerCivStatContributions.matchId, 'primary-match')).limit(1)
    expect(JSON.parse(contribution!.contributionsJson)).toEqual([
      expect.objectContaining({ seasonId: 'season-1', playerId: 'p1' }),
    ])
    for (const context of [primaryContext, partnerContext]) {
      const validation = buildPlayerCivBackfillValidationQueries(context)
      expect((sqlite.query(validation.missingContributionMatches!).get() as { count: number }).count).toBe(0)
      expect((sqlite.query(validation.invalidContributionPayloads!).get() as { count: number }).count).toBe(0)
    }
    sqlite.close()
  })
})
