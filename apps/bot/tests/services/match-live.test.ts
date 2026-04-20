import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { findPersistedLiveMatchIdsForPlayers } from '../../src/services/match/live.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('live match lookup', () => {
  test('finds live matches for players through the D1 adapter', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Player Three', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values([
        { id: 'live-1', gameMode: '1v1', status: 'active', createdAt: 10, completedAt: null, seasonId: null, draftData: null },
        { id: 'done-1', gameMode: '1v1', status: 'completed', createdAt: 20, completedAt: 30, seasonId: null, draftData: null },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'live-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'live-1', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'done-1', playerId: 'p3', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const liveMatchIds = await findPersistedLiveMatchIdsForPlayers(createTestD1Adapter(db), ['p1', 'p2', 'p3'])

      expect(liveMatchIds).toEqual(new Map([
        ['p1', 'live-1'],
        ['p2', 'live-1'],
      ]))
    }
    finally {
      sqlite.close()
    }
  })
})

function createTestD1Adapter(db: Awaited<ReturnType<typeof createTestDatabase>>['db']): D1Database {
  const sqlite = (db as { $client?: { query?: (sql: string) => { all: (...values: unknown[]) => unknown[] } } }).$client
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all<T = Record<string, unknown>>() {
              return { results: sqlite?.query?.(query).all(...values) as T[] | undefined }
            },
          }
        },
      }
    },
  } as D1Database
}
