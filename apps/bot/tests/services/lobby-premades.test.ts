import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { compactSlottedPremadesForMode } from '../../src/services/lobby/premades.ts'

describe('lobby mode-compaction helpers', () => {
  test('re-packs players sequentially when changing into 2v2', () => {
    const compacted = compactSlottedPremadesForMode(
      '2v2',
      ['host', 'p1', 'p2'],
      [entry('host'), entry('p1', ['p2']), entry('p2', ['p1'])],
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return
    expect(compacted.slots).toEqual(['host', 'p1', 'p2', null])
  })

  test('preserves the current team split when expanding team size', () => {
    const compacted = compactSlottedPremadesForMode(
      '4v4',
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      [entry('p1'), entry('p2'), entry('p3'), entry('p4'), entry('p5'), entry('p6')],
      {
        sourceMode: '3v3',
        sourceSlots: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      },
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return
    expect(compacted.slots).toEqual(['p1', 'p2', 'p3', null, 'p4', 'p5', 'p6', null])
  })

  test('packs six players into expanded 2v2 without party constraints', () => {
    const compacted = compactSlottedPremadesForMode(
      '2v2',
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      [entry('p1'), entry('p2'), entry('p3'), entry('p4'), entry('p5'), entry('p6')],
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return
    expect(compacted.slots).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', null, null])
  })
})

function entry(playerId: string, partyIds?: string[]): QueueEntry {
  return {
    playerId,
    displayName: playerId,
    avatarUrl: null,
    joinedAt: 1,
    partyIds,
  }
}
