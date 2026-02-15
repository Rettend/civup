import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  clearQueue,
  getPlayerQueueMode,
  removeFromQueue,
  setQueueEntries,
} from '../../src/services/queue.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('queue service KV behavior', () => {
  test('setQueueEntries only rewrites queue key when entries change', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2')])
    resetOperations()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p3')])

    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)

    expect(putKeys).toEqual(['queue:ffa'])
    expect(deleteKeys).toEqual([])
  })

  test('setQueueEntries is a no-op when entries are unchanged', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()
    const entries = [entry('p1'), entry('p2')]

    await setQueueEntries(kv, 'ffa', entries)
    resetOperations()

    await setQueueEntries(kv, 'ffa', entries)

    expect(operations).toHaveLength(0)
  })

  test('removeFromQueue rewrites queue state and returns mode', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2')])
    resetOperations()

    const removedMode = await removeFromQueue(kv, 'p1')
    expect(removedMode).toBe('ffa')

    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(putKeys).toEqual(['queue:ffa'])
    expect(deleteKeys).toEqual([])
  })

  test('clearQueue deletes queue key when all entries removed', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2')])
    resetOperations()

    await clearQueue(kv, 'ffa', ['p1', 'p2'])

    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(putKeys).toEqual([])
    expect(deleteKeys).toEqual(['queue:ffa'])
  })

  test('getPlayerQueueMode scans queues without KV writes', async () => {
    const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

    await setQueueEntries(kv, 'ffa', [entry('p1')])
    resetOperations()

    await expect(getPlayerQueueMode(kv, 'p1')).resolves.toBe('ffa')

    const writes = operations.filter(op => op.type === 'put' || op.type === 'delete')
    expect(writes).toHaveLength(0)
  })
})

function entry(playerId: string): QueueEntry {
  return {
    playerId,
    displayName: playerId.toUpperCase(),
    avatarUrl: null,
    joinedAt: 100,
  }
}
