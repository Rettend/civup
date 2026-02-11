import { describe, expect, test } from 'bun:test'
import { getMatchIdForMessage, storeMatchMessageMapping } from '../../src/services/match-message.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('match message mapping', () => {
  test('stores and retrieves match ID by message ID', async () => {
    const kv = createTestKv()

    await storeMatchMessageMapping(kv, 'message-1', 'match-1')

    await expect(getMatchIdForMessage(kv, 'message-1')).resolves.toBe('match-1')
    await expect(getMatchIdForMessage(kv, 'message-unknown')).resolves.toBeNull()
  })
})
