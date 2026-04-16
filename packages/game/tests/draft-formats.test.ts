import type { DraftSeat } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import { default1v1, default2v2, default3v3, default4v4, default5v5, default6v6, defaultFfa, defaultFfaSimultaneous, formatDraftStepLabel, getDraftFormat, redDeath2v2, redDeath4v4, redDeath5v5, redDeath6v6 } from '../src/draft-formats.ts'

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

const teamer5v5Seats: DraftSeat[] = [
  { playerId: 'a1', displayName: 'A1', team: 0 },
  { playerId: 'b1', displayName: 'B1', team: 1 },
  { playerId: 'a2', displayName: 'A2', team: 0 },
  { playerId: 'b2', displayName: 'B2', team: 1 },
  { playerId: 'a3', displayName: 'A3', team: 0 },
  { playerId: 'b3', displayName: 'B3', team: 1 },
  { playerId: 'a4', displayName: 'A4', team: 0 },
  { playerId: 'b4', displayName: 'B4', team: 1 },
  { playerId: 'a5', displayName: 'A5', team: 0 },
  { playerId: 'b5', displayName: 'B5', team: 1 },
]

const ffaSeats: DraftSeat[] = [
  { playerId: 'p1', displayName: 'Player 1' },
  { playerId: 'p2', displayName: 'Player 2' },
  { playerId: 'p3', displayName: 'Player 3' },
]

const visibleTeamBanSteps = [
  { action: 'ban', seats: [0], count: 1, timer: 45 },
  { action: 'ban', seats: [1], count: 2, timer: 45 },
  { action: 'ban', seats: [0], count: 2, timer: 45 },
  { action: 'ban', seats: [1], count: 1, timer: 45 },
] as const

describe('draft formats', () => {
  test('2v2 full roster order stays A1, B1, B2, A2', () => {
    expect(default2v2.getSteps(4).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2]])
  })

  test('2v2v2v2 uses four captains for bans and a 12344321 snake', () => {
    expect(default2v2.getSteps(8)[0]).toEqual({ action: 'ban', seats: [0, 1, 2, 3], count: 3, timer: 120 })
    expect(default2v2.getSteps(8).slice(1).map(step => step.seats)).toEqual([[0], [1], [2], [3], [7], [6], [5], [4]])
  })

  test('2v2v2 uses three captains for bans and a 123321 snake', () => {
    expect(default2v2.getSteps(6)[0]).toEqual({ action: 'ban', seats: [0, 1, 2], count: 3, timer: 120 })
    expect(default2v2.getSteps(6).slice(1).map(step => step.seats)).toEqual([[0], [1], [2], [5], [4], [3]])
  })

  test('3v3 full roster order stays A1, B1, B2, A2, A3, B3', () => {
    expect(default3v3.getSteps(6).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [4], [5]])
  })

  test('4v4 full roster order stays A1, B1, B2, A2, B3, A3, A4, B4', () => {
    expect(default4v4.getSteps(8).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7]])
  })

  test('5v5 uses the expanded two-team pick order', () => {
    expect(default5v5.getSteps(10).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [8], [9]])
  })

  test('6v6 uses the expanded 12-seat pick order', () => {
    expect(default6v6.getSteps(12).slice(1).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [9], [8], [10], [11]])
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

  test('keeps blind bans enabled by default for team drafts', () => {
    expect(getDraftFormat('3v3').blindBans).toBe(true)
  })

  test('returns the visible-ban team format when blind bans are disabled', () => {
    const format = getDraftFormat('3v3', { blindBans: false, seatCount: 6 })
    expect(format.blindBans).toBe(false)
    expect(format.id).toBe('default-3v3-visible-bans')
  })

  test('returns the visible-ban 1v1 format when blind bans are disabled', () => {
    const format = getDraftFormat('1v1', { blindBans: false, seatCount: 2 })
    expect(format.blindBans).toBe(false)
    expect(format.id).toBe('default-1v1-visible-bans')
  })

  test('2v2 visible bans keep 3 bans each with the 122112 captain sequence', () => {
    const format = getDraftFormat('2v2', { blindBans: false, seatCount: 4 })
    const steps = format.getSteps(4)

    expect(format.blindBans).toBe(false)
    expect(format.id).toBe('default-2v2-visible-bans')
    expect(steps.slice(0, 4)).toEqual(visibleTeamBanSteps)
    expect(steps.slice(4).map(step => step.seats)).toEqual([[0], [1], [3], [2]])
  })

  test('1v1 visible bans alternate one at a time before picks', () => {
    const steps = getDraftFormat('1v1', { blindBans: false, seatCount: 2 }).getSteps(2)
    expect(steps.slice(0, 6)).toEqual([
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
    ])
    expect(steps.slice(6).map(step => step.seats)).toEqual([[0], [1]])
  })

  test('3v3 visible bans follow the 122112 captain sequence before picks', () => {
    const steps = getDraftFormat('3v3', { blindBans: false, seatCount: 6 }).getSteps(6)
    expect(steps.slice(0, 4)).toEqual(visibleTeamBanSteps)
    expect(steps.slice(4).map(step => step.seats)).toEqual([[0], [1], [3], [2], [4], [5]])
  })

  test('4v4 visible bans use the same 122112 captain sequence before picks', () => {
    const steps = getDraftFormat('4v4', { blindBans: false, seatCount: 8 }).getSteps(8)
    expect(steps.slice(0, 4)).toEqual(visibleTeamBanSteps)
    expect(steps.slice(4).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7]])
  })

  test('5v5 visible bans use the same 122112 captain sequence before picks', () => {
    const steps = getDraftFormat('5v5', { blindBans: false, seatCount: 10 }).getSteps(10)
    expect(steps.slice(0, 4)).toEqual(visibleTeamBanSteps)
    expect(steps.slice(4).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [8], [9]])
  })

  test('6v6 visible bans use the same 122112 captain sequence before picks', () => {
    const steps = getDraftFormat('6v6', { blindBans: false, seatCount: 12 }).getSteps(12)
    expect(steps.slice(0, 4)).toEqual(visibleTeamBanSteps)
    expect(steps.slice(4).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [9], [8], [10], [11]])
  })

  test('ignores visible bans for unsupported 2v2 multi-team drafts', () => {
    expect(getDraftFormat('2v2', { blindBans: false, seatCount: 8 })).toBe(default2v2)
  })

  test('Red Death 2v2 uses no bans and snakes across two teams for 4 players', () => {
    expect(redDeath2v2.getSteps(4).map(step => step.seats)).toEqual([[0], [1], [3], [2]])
  })

  test('Red Death 2v2 uses four-team snake order for 8 players', () => {
    expect(redDeath2v2.getSteps(8).map(step => step.seats)).toEqual([[0], [1], [2], [3], [7], [6], [5], [4]])
  })

  test('Red Death 2v2 uses three-team snake order for 6 players', () => {
    expect(redDeath2v2.getSteps(6).map(step => step.seats)).toEqual([[0], [1], [2], [5], [4], [3]])
  })

  test('Red Death 4v4 removes bans and keeps the 4v4 snake pick order', () => {
    expect(redDeath4v4.getSteps(8).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7]])
  })

  test('Red Death 5v5 keeps the 5v5 pick order without bans', () => {
    expect(redDeath5v5.getSteps(10).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [8], [9]])
  })

  test('Red Death 6v6 keeps the 6v6 pick order without bans', () => {
    expect(redDeath6v6.getSteps(12).map(step => step.seats)).toEqual([[0], [1], [3], [2], [5], [4], [6], [7], [9], [8], [10], [11]])
  })

  test('resolves the Red Death 2v2 format when requested', () => {
    expect(getDraftFormat('2v2', { redDeath: true })).toBe(redDeath2v2)
  })

  test('resolves the Red Death 6v6 format when requested', () => {
    expect(getDraftFormat('6v6', { redDeath: true })).toBe(redDeath6v6)
  })
})

describe('formatDraftStepLabel', () => {
  test('labels visible duel bans by team side', () => {
    const steps = getDraftFormat('1v1', { blindBans: false, seatCount: 2 }).getSteps(2)
    expect(steps.slice(0, 6).map(step => formatDraftStepLabel(step, duelSeats))).toEqual([
      'BAN T1',
      'BAN T2',
      'BAN T1',
      'BAN T2',
      'BAN T1',
      'BAN T2',
    ])
  })

  test('labels visible team bans by captain team', () => {
    const steps = getDraftFormat('3v3', { blindBans: false, seatCount: 6 }).getSteps(6)
    expect(steps.slice(0, 4).map(step => formatDraftStepLabel(step, teamerSeats))).toEqual([
      'BAN T1',
      'BAN T2',
      'BAN T1',
      'BAN T2',
    ])
  })

  test('labels simultaneous team blind bans with both teams', () => {
    const steps = default3v3.getSteps(6)
    expect(formatDraftStepLabel(steps[0]!, teamerSeats)).toBe('BAN T1 & T2')
  })

  test('keeps simultaneous FFA bans generic', () => {
    const steps = defaultFfa.getSteps(3)
    expect(formatDraftStepLabel(steps[0]!, ffaSeats)).toBe('BAN')
  })

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

  test('labels 5v5 picks by team instead of seat index', () => {
    const steps = default5v5.getSteps(10)
    expect(steps.slice(1).map(step => formatDraftStepLabel(step, teamer5v5Seats))).toEqual([
      'PICK T1',
      'PICK T2',
      'PICK T2',
      'PICK T1',
      'PICK T2',
      'PICK T1',
      'PICK T1',
      'PICK T2',
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
