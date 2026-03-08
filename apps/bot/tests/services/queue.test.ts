import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  clearQueue,
  getPlayerQueueMode,
  getQueueState,
  removeFromQueue,
  removeFromQueueAndUnlinkParty,
  setQueueEntries,
} from '../../src/services/queue/index.ts'
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

  test('removeFromQueueAndUnlinkParty removes one player and unlinks teammate', async () => {
    const { kv } = createTrackedKv()

    await setQueueEntries(kv, '2v2', [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
      entry('p3'),
    ])

    const removed = await removeFromQueueAndUnlinkParty(kv, 'p1')
    expect(removed.mode).toBe('2v2')
    expect(removed.removedPlayerIds).toEqual(['p1'])

    const mode = await getPlayerQueueMode(kv, 'p2')
    expect(mode).toBe('2v2')

    const queue = await getQueueState(kv, '2v2')
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['p2', 'p3'])
    expect(queue.entries[0]?.partyIds).toBeUndefined()
  })

  test('removeFromQueueAndUnlinkParty shrinks a 3-stack to a 2-stack', async () => {
    const { kv } = createTrackedKv()

    await setQueueEntries(kv, '3v3', [
      entry('p1', ['p2', 'p3']),
      entry('p2', ['p1', 'p3']),
      entry('p3', ['p1', 'p2']),
      entry('p4'),
    ])

    const removed = await removeFromQueueAndUnlinkParty(kv, 'p1')
    expect(removed.mode).toBe('3v3')
    expect(removed.removedPlayerIds).toEqual(['p1'])

    const queue = await getQueueState(kv, '3v3')
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['p2', 'p3', 'p4'])
    expect(queue.entries[0]?.partyIds).toEqual(['p3'])
    expect(queue.entries[1]?.partyIds).toEqual(['p2'])
    const p4Mode = await getPlayerQueueMode(kv, 'p4')
    expect(p4Mode).toBe('3v3')
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

function entry(playerId: string, partyIds?: string[]): QueueEntry {
  return {
    playerId,
    displayName: playerId.toUpperCase(),
    avatarUrl: null,
    joinedAt: 100,
    partyIds,
  }
}
