import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { arrangeLobbySlots } from '../../src/services/lobby/arrange.ts'

describe('lobby arrange helpers', () => {
  test('randomize keeps premades together and can repair split layouts', () => {
    const result = arrangeLobbySlots({
      mode: '2v2',
      strategy: 'randomize',
      slots: ['p1', 'p3', 'p2', 'p4'],
      queueEntries: [
        entry('p1', ['p2']),
        entry('p2', ['p1']),
        entry('p3', ['p4']),
        entry('p4', ['p3']),
      ],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    const teamA = new Set(result.slots.slice(0, 2).filter((playerId): playerId is string => playerId != null))
    const teamB = new Set(result.slots.slice(2, 4).filter((playerId): playerId is string => playerId != null))

    const firstPremadeOnA = teamA.has('p1') && teamA.has('p2')
    const firstPremadeOnB = teamB.has('p1') && teamB.has('p2')
    const secondPremadeOnA = teamA.has('p3') && teamA.has('p4')
    const secondPremadeOnB = teamB.has('p3') && teamB.has('p4')

    expect(firstPremadeOnA || firstPremadeOnB).toBe(true)
    expect(secondPremadeOnA || secondPremadeOnB).toBe(true)
  })

  test('auto-balance keeps teams even for partial lobbies', () => {
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

    const teamA = result.slots.slice(0, 3).filter((playerId): playerId is string => playerId != null)
    const teamB = result.slots.slice(3, 6).filter((playerId): playerId is string => playerId != null)

    expect(Math.abs(teamA.length - teamB.length)).toBe(0)
    expect(teamA.includes('a') && teamA.includes('b')).toBe(false)
  })

  test('auto-balance never splits premades', () => {
    const result = arrangeLobbySlots({
      mode: '3v3',
      strategy: 'balance',
      slots: ['p1', 'p2', 'p3', 'p4', 'p5', null],
      queueEntries: [
        entry('p1', ['p2']),
        entry('p2', ['p1']),
        entry('p3'),
        entry('p4'),
        entry('p5'),
      ],
      ratingsByPlayerId: new Map([
        ['p1', { mu: 34, sigma: 2 }],
        ['p2', { mu: 33, sigma: 2 }],
        ['p3', { mu: 28, sigma: 2 }],
        ['p4', { mu: 27, sigma: 2 }],
        ['p5', { mu: 26, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    const teamA = new Set(result.slots.slice(0, 3).filter((playerId): playerId is string => playerId != null))
    const teamB = new Set(result.slots.slice(3, 6).filter((playerId): playerId is string => playerId != null))

    const togetherOnA = teamA.has('p1') && teamA.has('p2')
    const togetherOnB = teamB.has('p1') && teamB.has('p2')
    expect(togetherOnA || togetherOnB).toBe(true)
  })

  test('auto-balance keeps a full quartet together in 4v4', () => {
    const result = arrangeLobbySlots({
      mode: '4v4',
      strategy: 'balance',
      slots: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', null],
      queueEntries: [
        entry('p1', ['p2', 'p3', 'p4']),
        entry('p2', ['p1', 'p3', 'p4']),
        entry('p3', ['p1', 'p2', 'p4']),
        entry('p4', ['p1', 'p2', 'p3']),
        entry('p5'),
        entry('p6'),
        entry('p7'),
      ],
      ratingsByPlayerId: new Map([
        ['p1', { mu: 34, sigma: 2 }],
        ['p2', { mu: 33, sigma: 2 }],
        ['p3', { mu: 32, sigma: 2 }],
        ['p4', { mu: 31, sigma: 2 }],
        ['p5', { mu: 28, sigma: 2 }],
        ['p6', { mu: 27, sigma: 2 }],
        ['p7', { mu: 26, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    const teamA = new Set(result.slots.slice(0, 4).filter((playerId): playerId is string => playerId != null))
    const teamB = new Set(result.slots.slice(4, 8).filter((playerId): playerId is string => playerId != null))

    const quartetOnA = teamA.has('p1') && teamA.has('p2') && teamA.has('p3') && teamA.has('p4')
    const quartetOnB = teamB.has('p1') && teamB.has('p2') && teamB.has('p3') && teamB.has('p4')
    expect(quartetOnA || quartetOnB).toBe(true)
  })

  test('randomize shuffles occupied FFA seats and compacts gaps', () => {
    const result = arrangeLobbySlots({
      mode: 'ffa',
      strategy: 'randomize',
      slots: ['p1', null, 'p2', 'p3', null],
      queueEntries: [entry('p1'), entry('p2'), entry('p3')],
      random: () => 0,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    expect(result.slots).toEqual(['p2', 'p3', 'p1', null, null])
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

  test('auto-balance orders duel seats weakest first', () => {
    const result = arrangeLobbySlots({
      mode: '1v1',
      strategy: 'balance',
      slots: ['strong', 'weak'],
      queueEntries: [entry('strong'), entry('weak')],
      ratingsByPlayerId: new Map([
        ['strong', { mu: 35, sigma: 2 }],
        ['weak', { mu: 18, sigma: 2 }],
      ]),
    })

    expect('error' in result).toBe(false)
    if ('error' in result) return

    expect(result.slots).toEqual(['weak', 'strong'])
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
