import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { arrangeLobbySlots } from '../../src/services/lobby/arrange.ts'

describe('lobby arrange helpers', () => {
  test('randomize shuffles the full team slot order', () => {
    const result = arrangeLobbySlots({
      mode: '2v2',
      strategy: 'randomize',
      slots: ['p1', 'p2', 'p3', null],
      queueEntries: [entry('p1'), entry('p2'), entry('p3')],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.slots).toEqual(['p2', 'p3', null, 'p1'])
  })

  test('shuffle-teams redistributes players evenly across active teams', () => {
    const result = arrangeLobbySlots({
      mode: '3v3',
      strategy: 'shuffle-teams',
      slots: ['a', 'b', 'c', 'd', null, null],
      queueEntries: [entry('a'), entry('b'), entry('c'), entry('d')],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    const teamA = result.slots.slice(0, 3).filter((playerId): playerId is string => playerId != null)
    const teamB = result.slots.slice(3, 6).filter((playerId): playerId is string => playerId != null)
    expect(teamA).toEqual(['c', 'd'])
    expect(teamB).toEqual(['a', 'b'])
  })

  test('shuffle-teams can move the first slotted player onto another displayed team', () => {
    const result = arrangeLobbySlots({
      mode: '2v2',
      strategy: 'shuffle-teams',
      slots: ['host', 'p2', 'p3', 'p4'],
      queueEntries: [entry('host'), entry('p2'), entry('p3'), entry('p4')],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.slots.slice(0, 2)).toEqual(['p3', 'p4'])
    expect(result.slots.slice(2, 4)).toEqual(['host', 'p2'])
  })

  test('auto-balance keeps teams even for partial lobbies without party constraints', () => {
    const result = arrangeLobbySlots({
      mode: '3v3',
      strategy: 'balance',
      slots: ['a', 'b', 'c', 'd', null, null],
      queueEntries: [entry('a'), entry('b'), entry('c'), entry('d')],
      ratingsByPlayerId: new Map([
        ['a', { mu: 40, sigma: 2 }],
        ['b', { mu: 38, sigma: 2 }],
        ['c', { mu: 21, sigma: 2 }],
        ['d', { mu: 20, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    const teamA = new Set(result.slots.slice(0, 3).filter((playerId): playerId is string => playerId != null))
    const teamB = new Set(result.slots.slice(3, 6).filter((playerId): playerId is string => playerId != null))
    expect(teamA.size).toBe(2)
    expect(teamB.size).toBe(2)
    expect(teamA.has('a') && teamA.has('b')).toBe(false)
  })

  test('auto-balance can split former party-mates across teams', () => {
    const result = arrangeLobbySlots({
      mode: '2v2',
      strategy: 'balance',
      slots: ['p1', 'p2', 'p3', 'p4'],
      queueEntries: [
        entry('p1', ['p2']),
        entry('p2', ['p1']),
        entry('p3'),
        entry('p4'),
      ],
      ratingsByPlayerId: new Map([
        ['p1', { mu: 40, sigma: 2 }],
        ['p2', { mu: 39, sigma: 2 }],
        ['p3', { mu: 21, sigma: 2 }],
        ['p4', { mu: 20, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.slots).toEqual(['p1', 'p4', 'p2', 'p3'])
  })

  test('randomize shuffles FFA seats including gaps', () => {
    const result = arrangeLobbySlots({
      mode: 'ffa',
      strategy: 'randomize',
      slots: ['p1', null, 'p2', 'p3', null],
      queueEntries: [entry('p1'), entry('p2'), entry('p3')],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.slots).toEqual([null, 'p2', 'p3', null, 'p1'])
  })

  test('shuffle-teams rejects FFA lobbies', () => {
    const result = arrangeLobbySlots({
      mode: 'ffa',
      strategy: 'shuffle-teams',
      slots: ['p1', 'p2', null, null],
      queueEntries: [entry('p1'), entry('p2')],
    })

    expect(result).toEqual({ error: 'Shuffle teams is only available in team lobbies.' })
  })

  test('auto-balance orders FFA seats weakest first and strongest last', () => {
    const result = arrangeLobbySlots({
      mode: 'ffa',
      strategy: 'balance',
      slots: ['strong', null, 'weak', 'mid', null],
      queueEntries: [entry('strong'), entry('weak'), entry('mid')],
      ratingsByPlayerId: new Map([
        ['strong', { mu: 40, sigma: 2 }],
        ['mid', { mu: 28, sigma: 2 }],
        ['weak', { mu: 20, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.slots).toEqual(['weak', 'mid', 'strong', null, null])
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
