import type { DraftSeat } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import { default1v1, default2v2, default3v3, defaultFfa, formatDraftStepLabel } from '../src/draft-formats.ts'

const duelSeats: DraftSeat[] = [
  { playerId: 'p1', displayName: 'Player 1', team: 0 },
  { playerId: 'p2', displayName: 'Player 2', team: 1 },
]

const teamerSeats: DraftSeat[] = [
  { playerId: 'a1', displayName: 'A1', team: 0 },
  { playerId: 'b1', displayName: 'B1', team: 1 },
  { playerId: 'a2', displayName: 'A2', team: 0 },
  { playerId: 'b2', displayName: 'B2', team: 1 },
  { playerId: 'a3', displayName: 'A3', team: 0 },
  { playerId: 'b3', displayName: 'B3', team: 1 },
]

const ffaSeats: DraftSeat[] = [
  { playerId: 'p1', displayName: 'Player 1' },
  { playerId: 'p2', displayName: 'Player 2' },
  { playerId: 'p3', displayName: 'Player 3' },
]

describe('draft formats', () => {
  test('2v2 full roster order stays A1, B1, B2, A2', () => {
    expect(default2v2.getSteps(4).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2]])
  })

  test('3v3 full roster order stays A1, B1, B2, A2, B3, A3', () => {
    expect(default3v3.getSteps(6).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4]])
  })
})

describe('formatDraftStepLabel', () => {
  test('labels duel picks by team side', () => {
    const steps = default1v1.getSteps(2)
    expect(formatDraftStepLabel(steps[1]!, duelSeats)).toBe('PICK T1')
    expect(formatDraftStepLabel(steps[2]!, duelSeats)).toBe('PICK T2')
  })

  test('labels teamer picks by team instead of seat index', () => {
    const steps = default3v3.getSteps(6)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, teamerSeats))).toEqual([
      'PICK T1',
      'PICK T2',
      'PICK T2',
      'PICK T1',
      'PICK T2',
      'PICK T1',
    ])
  })

  test('keeps FFA picks labeled by player order', () => {
    const steps = defaultFfa.getSteps(3)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, ffaSeats))).toEqual([
      'PICK P1',
      'PICK P2',
      'PICK P3',
    ])
  })
})
