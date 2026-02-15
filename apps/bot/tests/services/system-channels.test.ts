import { describe, expect, test } from 'bun:test'
import {
  clearLeaderboardDirtyState,
  getLeaderboardDirtyState,
  markLeaderboardDirty,
} from '../../src/services/system-channels.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('leaderboard dirty state', () => {
  test('markLeaderboardDirty only writes once while dirty', async () => {
    const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

    const first = await markLeaderboardDirty(kv, 'report')
    resetOperations()
    const second = await markLeaderboardDirty(kv, 'report-again')

    expect(second.dirtyAt).toBe(first.dirtyAt)
    expect(second.reason).toBe(first.reason)
    expect(operations).toHaveLength(1)
    expect(operations[0]?.type).toBe('get')
  })

  test('clearLeaderboardDirtyState removes dirty marker', async () => {
    const { kv } = createTrackedKv()

    await markLeaderboardDirty(kv, 'report')
    expect(await getLeaderboardDirtyState(kv)).not.toBeNull()

    await clearLeaderboardDirtyState(kv)
    expect(await getLeaderboardDirtyState(kv)).toBeNull()
  })
})
