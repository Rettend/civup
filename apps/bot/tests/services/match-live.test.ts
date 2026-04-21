import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { findPersistedBlockingDraftMatchIdsForPlayers, findPersistedLiveMatchIdsForPlayers, findPersistedReportableMatchIdsForPlayers } from '../../src/services/match/live.ts'
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

  test('treats only drafting or incomplete active matches as blocking', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Player Three', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values([
        { id: 'draft-1', gameMode: '1v1', status: 'drafting', createdAt: 10, completedAt: null, seasonId: null, draftData: null },
        { id: 'active-complete', gameMode: '1v1', status: 'active', createdAt: 20, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 20 }) },
        { id: 'active-anomalous', gameMode: '1v1', status: 'active', createdAt: 30, completedAt: null, seasonId: null, draftData: null },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'draft-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-complete', playerId: 'p2', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-anomalous', playerId: 'p3', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const blockingMatchIds = await findPersistedBlockingDraftMatchIdsForPlayers(createTestD1Adapter(db), ['p1', 'p2', 'p3'])

      expect(blockingMatchIds).toEqual(new Map([
        ['p1', 'draft-1'],
        ['p3', 'active-anomalous'],
      ]))
    }
    finally {
      sqlite.close()
    }
  })

  test('returns reportable matches newest-first and excludes drafting/completed', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values([
        { id: 'draft-1', gameMode: '1v1', status: 'drafting', createdAt: 10, completedAt: null, seasonId: null, draftData: null },
        { id: 'reportable-1', gameMode: '1v1', status: 'active', createdAt: 20, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 20 }) },
        { id: 'completed-1', gameMode: '1v1', status: 'completed', createdAt: 30, completedAt: 31, seasonId: null, draftData: JSON.stringify({ completedAt: 25 }) },
        { id: 'reportable-2', gameMode: '1v1', status: 'active', createdAt: 40, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 40 }) },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'draft-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-1', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'completed-1', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'reportable-2', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const reportableMatchIds = await findPersistedReportableMatchIdsForPlayers(createTestD1Adapter(db), ['p1', 'p2'])

      expect(reportableMatchIds.get('p1')).toEqual(['reportable-2', 'reportable-1'])
      expect(reportableMatchIds.get('p2')).toEqual(['reportable-2'])
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
