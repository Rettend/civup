import { describe, expect, test } from 'bun:test'
import { getMatchIdForMessage, listMatchMessageIds, storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'

describe('match message mapping', () => {
  test('stores and retrieves match ID by message ID', async () => {
    const { db } = await createTestDatabase()

    await storeMatchMessageMapping(db, 'message-1', 'match-1')

    await expect(getMatchIdForMessage(db, 'message-1')).resolves.toBe('match-1')
    await expect(getMatchIdForMessage(db, 'message-unknown')).resolves.toBeNull()
  })

  test('skips D1 write when mapping already matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const trackedSqlite = trackSqlite(sqlite)

    await storeMatchMessageMapping(db, 'message-1', 'match-1')
    trackedSqlite.reset()
    await storeMatchMessageMapping(db, 'message-1', 'match-1')
    trackedSqlite.restore()

    expect(trackedSqlite.counts.rowsWritten).toBe(0)
  })

  test('lists message IDs in stored order for a match', async () => {
    const { db } = await createTestDatabase()

    await storeMatchMessageMapping(db, 'message-b', 'match-1')
    await Bun.sleep(2)
    await storeMatchMessageMapping(db, 'message-a', 'match-1')
    await storeMatchMessageMapping(db, 'message-c', 'match-2')

    await expect(listMatchMessageIds(db, 'match-1')).resolves.toEqual(['message-b', 'message-a'])
  })
})
