import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { resolveJoinButtonLiveMatchId } from '../../src/commands/match/components.ts'
import { storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('resolveJoinButtonLiveMatchId', () => {
  test('resolves the clicked message match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([{ id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 }])
      await db.insert(matches).values([
        { id: 'match-from-message', gameMode: '1v1', status: 'active', createdAt: 1, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 1 }) },
        { id: 'match-from-user-map', gameMode: '1v1', status: 'drafting', createdAt: 2, completedAt: null, seasonId: null, draftData: null },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'match-from-message', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'match-from-user-map', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])
      await storeMatchMessageMapping(db, 'message-1', 'match-from-message')

      await expect(resolveJoinButtonLiveMatchId(kv, createTestD1Adapter(db), 'p1', 'message-1', db)).resolves.toBe('match-from-message')
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
