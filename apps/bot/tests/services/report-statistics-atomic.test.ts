import { expect, test } from 'bun:test'
import {
  createDb,
  matches,
  matchParticipants,
  matchCivStatContributions,
  matchPlayerCivStatContributions,
  playerCivStats,
  civStats,
  players,
} from '@civup/db'
import { reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
import { reconcilePlayerCivStatMatchContribution } from '../../src/services/leaderboard/player-civ-stats.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test.each(['player', 'leaderboard'] as const)(
  '%s statistics roll back the contribution marker when totals fail, then retry without double counting',
  async kind => {
    const fixture = await createTestDatabase()
    const db = createDb(createSqliteD1Database(fixture.sqlite))
    const reconcile =
      kind === 'player' ? reconcilePlayerCivStatMatchContribution : reconcileCivLeaderboardMatchContribution
    const ledger = kind === 'player' ? matchPlayerCivStatContributions : matchCivStatContributions
    const totals = kind === 'player' ? playerCivStats : civStats
    const table = kind === 'player' ? 'player_civ_stats' : 'civ_stats'
    try {
      await db.insert(players).values({ id: 'p', displayName: 'P', createdAt: 0 })
      await db.insert(matches).values({
        id: 'm',
        gameMode: '1v1',
        status: 'completed',
        createdAt: 1,
        completedAt: 2,
        draftData: JSON.stringify({ leaderDataVersion: 'live', state: { availableCivIds: ['rome-trajan'] } }),
      })
      await db.insert(matchParticipants).values({ matchId: 'm', playerId: 'p', civId: 'rome-trajan', placement: 1 })
      fixture.sqlite.exec(
        `CREATE TRIGGER fail_totals BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'Injected totals failure'); END`,
      )
      await expect(reconcile(db, 'm', 100)).rejects.toThrow('Injected totals failure')
      expect(await db.select().from(ledger)).toHaveLength(0)
      expect(await db.select().from(totals)).toHaveLength(0)
      fixture.sqlite.exec('DROP TRIGGER fail_totals')
      await reconcile(db, 'm', 200)
      const once = await db.select().from(totals)
      expect(once.length).toBeGreaterThan(0)
      expect(once.every(row => row.picks === 1 && row.wins === 1)).toBe(true)
      await reconcile(db, 'm', 300)
      expect(await db.select().from(totals)).toEqual(once)
      expect(await db.select().from(ledger)).toHaveLength(1)
    } finally {
      fixture.sqlite.close()
    }
  },
)
