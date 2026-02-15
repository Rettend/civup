import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  clearQueue,
  getPlayerQueueMode,
  removeFromQueue,
  setQueueEntries,
} from '../../src/services/queue.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('queue service KV write behavior', () => {
  test('setQueueEntries only writes changed player mappings', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2')])
    resetOperations()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p3')])

    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)

    expect(putKeys).toContain('queue:ffa')
    expect(putKeys).toContain('player-queue:p3')
    expect(putKeys).not.toContain('player-queue:p1')
    expect(deleteKeys).toEqual(['player-queue:p2'])
  })

  test('setQueueEntries is a no-op when entries are unchanged', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()
    const entries = [entry('p1'), entry('p2')]

    await setQueueEntries(kv, 'ffa', entries)
    resetOperations()

    await setQueueEntries(kv, 'ffa', entries)

    expect(operations).toHaveLength(0)
  })

  test('removeFromQueue deletes player mapping once', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2')])
    resetOperations()

    const removedMode = await removeFromQueue(kv, 'p1')
    expect(removedMode).toBe('ffa')

    const p1Deletes = operations.filter(op => op.type === 'delete' && op.key === 'player-queue:p1')
    expect(p1Deletes).toHaveLength(1)
  })

  test('clearQueue deletes removed player mappings once each', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1'), entry('p2'), entry('p3')])
    resetOperations()

    await clearQueue(kv, 'ffa', ['p1', 'p2'])

    const p1Deletes = operations.filter(op => op.type === 'delete' && op.key === 'player-queue:p1')
    const p2Deletes = operations.filter(op => op.type === 'delete' && op.key === 'player-queue:p2')
    expect(p1Deletes).toHaveLength(1)
    expect(p2Deletes).toHaveLength(1)
  })

  test('getPlayerQueueMode recovers from expired player mapping', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await setQueueEntries(kv, 'ffa', [entry('p1')])
    await kv.delete('player-queue:p1')
    resetOperations()

    await expect(getPlayerQueueMode(kv, 'p1')).resolves.toBe('ffa')

    const recachePuts = operations.filter(op => op.type === 'put' && op.key === 'player-queue:p1')
    expect(recachePuts).toHaveLength(1)
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
