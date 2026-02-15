import { describe, expect, test } from 'bun:test'
import { getMatchIdForMessage, storeMatchMessageMapping } from '../../src/services/match-message.ts'
import { createTestKv } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('match message mapping', () => {
  test('stores and retrieves match ID by message ID', async () => {
    const kv = createTestKv()

    await storeMatchMessageMapping(kv, 'message-1', 'match-1')

    await expect(getMatchIdForMessage(kv, 'message-1')).resolves.toBe('match-1')
    await expect(getMatchIdForMessage(kv, 'message-unknown')).resolves.toBeNull()
  })

  test('skips KV write when mapping already matches', async () => {
    const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

    await storeMatchMessageMapping(kv, 'message-1', 'match-1')
    resetOperations()
    await storeMatchMessageMapping(kv, 'message-1', 'match-1')

    const writes = operations.filter(op => op.type === 'put')
    expect(writes).toHaveLength(0)
  })
})
