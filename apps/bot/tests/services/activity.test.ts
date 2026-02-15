import { describe, expect, test } from 'bun:test'
import {
  clearActivityMappings,
  getMatchForUser,
  storeMatchMapping,
  storeUserMatchMappings,
} from '../../src/services/activity.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('activity mapping behavior', () => {
  test('getMatchForUser resolves active mapping', async () => {
    const { kv } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1'], 'match-1')

    await expect(getMatchForUser(kv, 'user-1')).resolves.toBe('match-1')
  })

  test('getMatchForUser removes stale user mapping when match mapping is gone', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1'], 'match-1')
    await clearActivityMappings(kv, 'match-1', ['user-1'], 'channel-1')

    resetOperations()
    await expect(getMatchForUser(kv, 'user-1')).resolves.toBeNull()

    const staleCleanupDeletes = operations.filter(op => op.type === 'delete' && op.key === 'activity-user:user-1')
    expect(staleCleanupDeletes).toHaveLength(1)
  })

  test('clearActivityMappings skips eager user deletes', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1', 'user-2'], 'match-1')

    resetOperations()
    await clearActivityMappings(kv, 'match-1', ['user-1', 'user-2'], 'channel-1')

    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(deleteKeys).toContain('activity-match:match-1')
    expect(deleteKeys).toContain('activity:channel-1')
    expect(deleteKeys).not.toContain('activity-user:user-1')
    expect(deleteKeys).not.toContain('activity-user:user-2')
  })
})
