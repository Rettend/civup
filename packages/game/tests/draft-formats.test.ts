import type { DraftSeat } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import { default1v1, default2v2, default3v3, default4v4, defaultFfa, formatDraftStepLabel } from '../src/draft-formats.ts'

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

const teamer4v4Seats: DraftSeat[] = [
  { playerId: 'a1', displayName: 'A1', team: 0 },
  { playerId: 'b1', displayName: 'B1', team: 1 },
  { playerId: 'a2', displayName: 'A2', team: 0 },
  { playerId: 'b2', displayName: 'B2', team: 1 },
  { playerId: 'a3', displayName: 'A3', team: 0 },
  { playerId: 'b3', displayName: 'B3', team: 1 },
  { playerId: 'a4', displayName: 'A4', team: 0 },
  { playerId: 'b4', displayName: 'B4', team: 1 },
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

  test('3v3 full roster order stays A1, B1, B2, A2, A3, B3', () => {
    expect(default3v3.getSteps(6).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [4], [5]])
  })

  test('4v4 full roster order stays A1, B1, B2, A2, B3, A3, A4, B4', () => {
    expect(default4v4.getSteps(8).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7]])
  })

  test('FFA opens with two blind bans each', () => {
    expect(defaultFfa.getSteps(8)[0]).toEqual({ action: 'ban', seats: 'all', count: 2, timer: 120 })
  })

  test('FFA uses one shared simultaneous pick step', () => {
    expect(defaultFfa.getSteps(8)[1]).toEqual({ action: 'pick', seats: 'all', count: 1, timer: 60 })
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
      'PICK T1',
      'PICK T2',
    ])
  })

  test('labels 4v4 teamer picks by team instead of seat index', () => {
    const steps = default4v4.getSteps(8)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, teamer4v4Seats))).toEqual([
      'PICK T1',
      'PICK T2',
      'PICK T2',
      'PICK T1',
      'PICK T2',
      'PICK T1',
      'PICK T1',
      'PICK T2',
    ])
  })

  test('labels the shared FFA pick step once', () => {
    const steps = defaultFfa.getSteps(3)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, ffaSeats))).toEqual(['PICK'])
  })
})
