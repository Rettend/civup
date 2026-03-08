import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { arrangeTeamLobbySlots } from '../../src/services/lobby/arrange.ts'

describe('lobby arrange helpers', () => {
  test('randomize keeps premades together and can repair split layouts', () => {
    const result = arrangeTeamLobbySlots({
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
    const result = arrangeTeamLobbySlots({
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
    const result = arrangeTeamLobbySlots({
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

  test('returns an error for unsupported modes', () => {
    const result = arrangeTeamLobbySlots({
      mode: 'ffa',
      strategy: 'randomize',
      slots: ['p1', 'p2', null],
      queueEntries: [entry('p1'), entry('p2')],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('2v2 and 3v3')
    }
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
