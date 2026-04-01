import type { DraftSeat } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import { default1v1, default2v2, default3v3, default4v4, defaultFfa, defaultFfaSimultaneous, formatDraftStepLabel, getDraftFormat, redDeath2v2, redDeath4v4 } from '../src/draft-formats.ts'

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

  test('2v2v2v2 uses four captains for bans and a 12344321 snake', () => {
    expect(default2v2.getSteps(8)[0]).toEqual({ action: 'ban', seats: [0, 1, 2, 3], count: 3, timer: 120 })
    expect(default2v2.getSteps(8).slice(1).map(step => step.seats)).toEqual([[0], [1], [2], [3], [7], [6], [5], [4]])
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

  test('FFA defaults to seat-order picks', () => {
    expect(defaultFfa.getSteps(4).slice(1).map(step => step.seats)).toEqual([[0], [1], [2], [3]])
  })

  test('FFA simultaneous format uses one shared pick step', () => {
    expect(defaultFfaSimultaneous.getSteps(8)[1]).toEqual({ action: 'pick', seats: 'all', count: 1, timer: 60 })
  })

  test('resolves the simultaneous FFA format when requested', () => {
    expect(getDraftFormat('ffa', { simultaneousPick: true })).toBe(defaultFfaSimultaneous)
  })

  test('Red Death 2v2 uses no bans and snakes across two teams for 4 players', () => {
    expect(redDeath2v2.getSteps(4).map(step => step.seats)).toEqual([[0], [1], [3], [2]])
  })

  test('Red Death 2v2 uses four-team snake order for 8 players', () => {
    expect(redDeath2v2.getSteps(8).map(step => step.seats)).toEqual([[0], [1], [2], [3], [7], [6], [5], [4]])
  })

  test('Red Death 4v4 removes bans and keeps the 4v4 snake pick order', () => {
    expect(redDeath4v4.getSteps(8).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7]])
  })

  test('resolves the Red Death 2v2 format when requested', () => {
    expect(getDraftFormat('2v2', { redDeath: true })).toBe(redDeath2v2)
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

  test('labels seat-order FFA picks by player order', () => {
    const steps = defaultFfa.getSteps(3)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, ffaSeats))).toEqual([
      'PICK P1',
      'PICK P2',
      'PICK P3',
    ])
  })

  test('labels the shared simultaneous FFA pick step once', () => {
    const steps = defaultFfaSimultaneous.getSteps(3)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, ffaSeats))).toEqual(['PICK'])
  })
})
