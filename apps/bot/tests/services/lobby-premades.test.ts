import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { arePremadeGroupsAdjacent, buildActivePremadeEdgeSet, buildSlottedPremadeGroups, compactSlottedPremadesForMode, moveSlottedPremadeGroup, rebuildQueueEntriesFromPremadeEdgeSet } from '../../src/services/lobby/premades.ts'

describe('lobby premade helpers', () => {
  test('buildActivePremadeEdgeSet keeps adjacent chain links for a trio', () => {
    const edges = buildActivePremadeEdgeSet('3v3', ['p1', 'p2', 'p3', null, null, null], [
      entry('p1', ['p2', 'p3']),
      entry('p2', ['p1', 'p3']),
      entry('p3', ['p1', 'p2']),
    ])

    expect([...edges]).toEqual([0, 1])
  })

  test('buildActivePremadeEdgeSet keeps adjacent chain links for a quartet', () => {
    const edges = buildActivePremadeEdgeSet('4v4', ['p1', 'p2', 'p3', 'p4', null, null, null, null], [
      entry('p1', ['p2', 'p3', 'p4']),
      entry('p2', ['p1', 'p3', 'p4']),
      entry('p3', ['p1', 'p2', 'p4']),
      entry('p4', ['p1', 'p2', 'p3']),
    ])

    expect([...edges]).toEqual([0, 1, 2])
  })

  test('rebuildQueueEntriesFromPremadeEdgeSet can split a trio into pair plus solo', () => {
    const queueEntries = [
      entry('p1', ['p2', 'p3']),
      entry('p2', ['p1', 'p3']),
      entry('p3', ['p1', 'p2']),
    ]

    const nextEntries = rebuildQueueEntriesFromPremadeEdgeSet(
      '3v3',
      ['p1', 'p2', 'p3', null, null, null],
      queueEntries,
      new Set([0]),
    )

    expect(nextEntries[0]?.partyIds).toEqual(['p2'])
    expect(nextEntries[1]?.partyIds).toEqual(['p1'])
    expect(nextEntries[2]?.partyIds).toBeUndefined()
  })

  test('rebuildQueueEntriesFromPremadeEdgeSet removes slotted to spectator links', () => {
    const queueEntries = [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
      entry('spectator', ['other']),
      entry('other', ['spectator']),
    ]

    const nextEntries = rebuildQueueEntriesFromPremadeEdgeSet(
      '2v2',
      ['p1', null, null, null],
      queueEntries,
      new Set(),
    )

    expect(nextEntries[0]?.partyIds).toBeUndefined()
    expect(nextEntries[1]?.partyIds).toBeUndefined()
    expect(nextEntries[2]?.partyIds).toEqual(['other'])
    expect(nextEntries[3]?.partyIds).toEqual(['spectator'])
  })

  test('arePremadeGroupsAdjacent rejects split premades', () => {
    const adjacent = arePremadeGroupsAdjacent('2v2', ['p1', 'p2', null, null], [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
    ])
    const split = arePremadeGroupsAdjacent('2v2', ['p1', null, 'p2', null], [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
    ])

    expect(adjacent).toBe(true)
    expect(split).toBe(false)
  })

  test('moveSlottedPremadeGroup moves a linked pair into empty contiguous slots', () => {
    const slots = ['p1', 'p2', null, null]
    const groups = buildSlottedPremadeGroups('2v2', slots, [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
    ])
    const pair = groups[0]
    if (!pair) throw new Error('Expected premade group')

    const moved = moveSlottedPremadeGroup('2v2', slots, pair, 0, 2)
    expect('error' in moved).toBe(false)
    if ('error' in moved) return

    expect(moved.slots).toEqual([null, null, 'p1', 'p2'])
  })

  test('moveSlottedPremadeGroup accepts dropping either member onto the destination block', () => {
    const slots = ['p1', 'p2', null, null]
    const groups = buildSlottedPremadeGroups('2v2', slots, [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
    ])
    const pair = groups[0]
    if (!pair) throw new Error('Expected premade group')

    const moved = moveSlottedPremadeGroup('2v2', slots, pair, 0, 3)
    expect('error' in moved).toBe(false)
    if ('error' in moved) return

    expect(moved.slots).toEqual([null, null, 'p1', 'p2'])
  })

  test('moveSlottedPremadeGroup rejects a crowded destination block', () => {
    const slots = ['p1', 'p2', null, null]
    const groups = buildSlottedPremadeGroups('2v2', slots, [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
    ])
    const pair = groups[0]
    if (!pair) throw new Error('Expected premade group')

    const moved = moveSlottedPremadeGroup('2v2', ['p1', 'p2', 'p3', null], pair, 0, 2)
    expect('error' in moved).toBe(true)
    if ('error' in moved) {
      expect(moved.error).toContain('open slots')
    }
  })

  test('moveSlottedPremadeGroup requires a contiguous destination block', () => {
    const slots = ['p1', 'p2', null, null, 'p3', null]
    const groups = buildSlottedPremadeGroups('3v3', slots, [
      entry('p1', ['p2']),
      entry('p2', ['p1']),
      entry('p3'),
    ])
    const pair = groups.find(group => group.playerIds.includes('p1'))
    if (!pair) throw new Error('Expected premade group')

    const moved = moveSlottedPremadeGroup('3v3', slots, pair, 0, 4)
    expect('error' in moved).toBe(true)
    if ('error' in moved) {
      expect(moved.error).toContain('open slots')
    }
  })

  test('compactSlottedPremadesForMode repacks partial premades when changing modes', () => {
    const compacted = compactSlottedPremadesForMode(
      '2v2',
      ['host', 'p1', 'p2'],
      [
        entry('host'),
        entry('p1', ['p2']),
        entry('p2', ['p1']),
      ],
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return

    expect(compacted.slots).toEqual(['host', null, 'p1', 'p2'])
  })

  test('compactSlottedPremadesForMode keeps a quartet together in 4v4', () => {
    const compacted = compactSlottedPremadesForMode(
      '4v4',
      ['host', 'p1', 'p2', 'p3', 'p4'],
      [
        entry('host'),
        entry('p1', ['p2', 'p3', 'p4']),
        entry('p2', ['p1', 'p3', 'p4']),
        entry('p3', ['p1', 'p2', 'p4']),
        entry('p4', ['p1', 'p2', 'p3']),
      ],
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return

    expect(compacted.slots).toEqual(['host', null, null, null, 'p1', 'p2', 'p3', 'p4'])
  })

  test('compactSlottedPremadesForMode keeps player order when shrinking team size', () => {
    const compacted = compactSlottedPremadesForMode(
      '3v3',
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      [
        entry('p1'),
        entry('p2'),
        entry('p3'),
        entry('p4'),
        entry('p5'),
        entry('p6'),
      ],
    )

    expect('error' in compacted).toBe(false)
    if ('error' in compacted) return

    expect(compacted.slots).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
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
