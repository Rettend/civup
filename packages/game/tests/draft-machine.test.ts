import type { DraftSeat, DraftState } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import { ppl2v2, pplDuel, pplFfa } from '../src/draft-formats.ts'
import {
  createDraft,
  getBansForSeat,
  getCurrentStep,
  getPendingSeats,
  getPicksForSeat,
  isDraftError,
  isPlayerTurn,
  processDraftInput,
} from '../src/draft-machine.ts'

// ── Test Setup Helpers ──────────────────────────────────────

function createTestCivPool(count = 50): string[] {
  return Array.from({ length: count }, (_, i) => `civ-${i + 1}`)
}

function create2v2Seats(): DraftSeat[] {
  return [
    { playerId: 'teamA', displayName: 'Team A', team: 0 },
    { playerId: 'teamB', displayName: 'Team B', team: 1 },
  ]
}

function createDuelSeats(): DraftSeat[] {
  return [
    { playerId: 'player1', displayName: 'Player 1' },
    { playerId: 'player2', displayName: 'Player 2' },
  ]
}

function createFfaSeats(count = 8): DraftSeat[] {
  return Array.from({ length: count }, (_, i) => ({
    playerId: `player${i + 1}`,
    displayName: `Player ${i + 1}`,
  }))
}

// Helper to start a draft and return the started state
function startDraft(state: DraftState): DraftState {
  const result = processDraftInput(state, { type: 'START' })
  if (isDraftError(result))
    throw new Error(result.error)
  return result.state
}

// ── createDraft ─────────────────────────────────────────────

describe('createDraft', () => {
  test('creates a draft in waiting state', () => {
    const seats = create2v2Seats()
    const civPool = createTestCivPool()
    const draft = createDraft('match-123', ppl2v2, seats, civPool)

    expect(draft.matchId).toBe('match-123')
    expect(draft.formatId).toBe('ppl-2v2')
    expect(draft.status).toBe('waiting')
    expect(draft.currentStepIndex).toBe(-1)
    expect(draft.seats).toEqual(seats)
    expect(draft.availableCivIds).toEqual(civPool)
    expect(draft.bans).toEqual([])
    expect(draft.picks).toEqual([])
    expect(draft.submissions).toEqual({})
    expect(draft.pendingBlindBans).toEqual([])
  })

  test('generates steps from format', () => {
    const seats = create2v2Seats()
    const draft = createDraft('match-123', ppl2v2, seats, createTestCivPool())

    // ppl2v2 has: ban(all), pick([0]), pick([1]), pick([0])
    expect(draft.steps.length).toBeGreaterThan(0)
    expect(draft.steps[0]!.action).toBe('ban')
    expect(draft.steps[0]!.seats).toBe('all')
  })

  test('creates draft with FFA format and correct number of steps', () => {
    const seats = createFfaSeats(8)
    const draft = createDraft('match-ffa', pplFfa, seats, createTestCivPool())

    // pplFfa: 1 ban step + 8 pick steps (one per player)
    expect(draft.steps.length).toBe(9)
    expect(draft.steps[0]!.action).toBe('ban')
    expect(draft.steps[0]!.seats).toBe('all')

    for (let i = 1; i <= 8; i++) {
      expect(draft.steps[i]!.action).toBe('pick')
      expect(draft.steps[i]!.seats).toEqual([i - 1])
    }
  })
})

// ── START ───────────────────────────────────────────────────

describe('processDraftInput — START', () => {
  test('starts draft and moves to first step', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    const result = processDraftInput(draft, { type: 'START' })

    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    expect(result.state.status).toBe('active')
    expect(result.state.currentStepIndex).toBe(0)
    expect(result.events).toContainEqual({ type: 'DRAFT_STARTED' })
    expect(result.events).toContainEqual({ type: 'STEP_ADVANCED', stepIndex: 0 })
  })

  test('fails if draft already started', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    const started = startDraft(draft)

    const result = processDraftInput(started, { type: 'START' })

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Draft already started')
  })
})

// ── BAN Flow (Blind Bans, Simultaneous) ─────────────────────

describe('processDraftInput — BAN (blind bans)', () => {
  test('accepts ban from active seat', () => {
    const draft = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)

    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    expect(result.state.submissions[0]).toEqual(['civ-1', 'civ-2', 'civ-3'])
    expect(result.events).toContainEqual({
      type: 'BAN_SUBMITTED',
      seatIndex: 0,
      civIds: ['civ-1', 'civ-2', 'civ-3'],
      blind: true,
    })
  })

  test('civ pool is not modified until all seats submit', () => {
    const draft = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)

    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Civs should still be available (blind bans are pending)
    expect(result.state.availableCivIds).toContain('civ-1')
    expect(result.state.availableCivIds).toContain('civ-2')
    expect(result.state.availableCivIds).toContain('civ-3')
  })

  test('completes ban step when all seats submit', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Seat 0 bans
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return
    state = result.state

    // Seat 1 bans
    result = processDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Step should advance
    expect(result.state.currentStepIndex).toBe(1)
    // Bans recorded
    expect(result.state.bans).toHaveLength(6)
    // Civs removed from pool
    expect(result.state.availableCivIds).not.toContain('civ-1')
    expect(result.state.availableCivIds).not.toContain('civ-4')
    // Submissions cleared
    expect(result.state.submissions).toEqual({})
    // Blind bans revealed
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'BLIND_BANS_REVEALED' }))
    expect(result.events).toContainEqual({ type: 'STEP_ADVANCED', stepIndex: 1 })
  })

  test('rejects duplicate bans within same submission', () => {
    const draft = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-1', 'civ-3'] }, true)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Duplicate civs in ban submission')
  })

  test('rejects if seat already submitted', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result1 = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result1))
      throw new Error(result1.error)
    state = result1.state

    const result2 = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)

    expect(isDraftError(result2)).toBe(true)
    if (!isDraftError(result2))
      return
    expect(result2.error).toBe('Seat 0 has already submitted for this step')
  })

  test('rejects if civ not in available pool', () => {
    const draft = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['invalid-civ', 'civ-1', 'civ-2'] }, true)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Civ invalid-civ is not available')
  })

  test('rejects wrong ban count', () => {
    const draft = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2'] }, true)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Expected 3 bans, got 2')
  })
})

// ── PICK Flow (Sequential) ──────────────────────────────────

describe('processDraftInput — PICK (sequential)', () => {
  // Helper to complete ban phase for 2v2
  function completeBanPhase(state: DraftState): DraftState {
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    return result.state
  }

  test('accepts pick from active seat', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    state = completeBanPhase(state)

    // Now at pick step [0] (Team A picks 1)
    expect(state.steps[state.currentStepIndex]!.action).toBe('pick')
    expect(state.steps[state.currentStepIndex]!.seats).toEqual([0])

    const result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' })

    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Pick recorded
    expect(result.state.picks).toContainEqual({ civId: 'civ-10', seatIndex: 0, stepIndex: 1 })
    // Civ removed from pool
    expect(result.state.availableCivIds).not.toContain('civ-10')
    // Step should advance (Team A only picks 1)
    expect(result.state.currentStepIndex).toBe(2)
    expect(result.events).toContainEqual({ type: 'PICK_SUBMITTED', seatIndex: 0, civId: 'civ-10' })
  })

  test('handles multi-pick step correctly', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    state = completeBanPhase(state)

    // Team A picks 1
    let result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Now at pick step [1] count=2 (Team B picks 2)
    expect(state.steps[state.currentStepIndex]!.seats).toEqual([1])
    expect(state.steps[state.currentStepIndex]!.count).toBe(2)

    // First pick by Team B
    result = processDraftInput(state, { type: 'PICK', seatIndex: 1, civId: 'civ-20' })
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Step should NOT advance yet (need 2 picks)
    expect(result.state.currentStepIndex).toBe(2)
    expect(result.state.submissions[1]).toEqual(['civ-20'])

    // Second pick by Team B
    result = processDraftInput(result.state, { type: 'PICK', seatIndex: 1, civId: 'civ-21' })
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Now step should advance
    expect(result.state.currentStepIndex).toBe(3)
    expect(result.state.picks).toContainEqual({ civId: 'civ-20', seatIndex: 1, stepIndex: 2 })
    expect(result.state.picks).toContainEqual({ civId: 'civ-21', seatIndex: 1, stepIndex: 2 })
  })

  test('rejects pick from wrong seat', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    state = completeBanPhase(state)

    // Current step is for seat 0, try seat 1
    const result = processDraftInput(state, { type: 'PICK', seatIndex: 1, civId: 'civ-10' })

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Seat 1 is not active in this step')
  })

  test('rejects pick of unavailable civ', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    state = completeBanPhase(state)

    // civ-1 was banned
    const result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-1' })

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Civ civ-1 is not available')
  })

  test('rejects picking during ban phase', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    const result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-1' })

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Current step is not a pick phase')
  })
})

// ── Full 2v2 Draft Flow ─────────────────────────────────────

describe('full 2v2 draft flow', () => {
  test('completes entire draft successfully', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Step 0: Blind bans (3 each)
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Step 1: Team A picks 1
    result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Step 2: Team B picks 2
    result = processDraftInput(state, { type: 'PICK', seatIndex: 1, civId: 'civ-20' })
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'PICK', seatIndex: 1, civId: 'civ-21' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Step 3: Team A picks 1
    result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-11' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Draft should be complete
    expect(state.status).toBe('complete')
    expect(state.bans).toHaveLength(6)
    expect(state.picks).toHaveLength(4)
    expect(result.events).toContainEqual({ type: 'DRAFT_COMPLETE' })
  })
})

// ── Full FFA Draft Flow ─────────────────────────────────────

describe('full FFA draft flow', () => {
  test('completes 4-player FFA draft', () => {
    let state = startDraft(createDraft('match-ffa', pplFfa, createFfaSeats(4), createTestCivPool()))

    // Step 0: Everyone bans 2 (simultaneous/blind)
    for (let i = 0; i < 4; i++) {
      const result = processDraftInput(state, {
        type: 'BAN',
        seatIndex: i,
        civIds: [`civ-${i * 2 + 1}`, `civ-${i * 2 + 2}`],
      }, true)
      if (isDraftError(result))
        throw new Error(result.error)
      state = result.state
    }

    // Should have 8 bans total
    expect(state.bans).toHaveLength(8)
    expect(state.currentStepIndex).toBe(1)

    // Steps 1-4: Each player picks 1
    for (let i = 0; i < 4; i++) {
      const result = processDraftInput(state, {
        type: 'PICK',
        seatIndex: i,
        civId: `civ-${20 + i}`,
      })
      if (isDraftError(result))
        throw new Error(result.error)
      state = result.state
    }

    // Draft complete
    expect(state.status).toBe('complete')
    expect(state.picks).toHaveLength(4)
  })
})

// ── TIMEOUT with Random Selection ───────────────────────────

describe('processDraftInput — TIMEOUT', () => {
  test('auto-selects random civs for missing submissions', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Only seat 0 submits
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Trigger timeout
    result = processDraftInput(state, { type: 'TIMEOUT' }, true)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    // Should have applied timeout for seat 1
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'TIMEOUT_APPLIED',
      seatIndex: 1,
    }))

    // Bans should be complete (6 total: 3 from seat 0, 3 random for seat 1)
    expect(result.state.bans).toHaveLength(6)
    expect(result.state.currentStepIndex).toBe(1) // Advanced to next step
  })

  test('timeout on pick phase auto-picks random civ', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Now at pick phase for seat 0, trigger timeout without pick
    result = processDraftInput(state, { type: 'TIMEOUT' }, false)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result))
      return

    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'TIMEOUT_APPLIED',
      seatIndex: 0,
    }))
    expect(result.state.picks.length).toBe(1)
  })

  test('timeout completes draft when all remaining steps are filled', () => {
    // Create a duel, start it, complete bans, then timeout on picks
    let state = startDraft(createDraft('match-duel', pplDuel, createDuelSeats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Timeout seat 0's pick
    result = processDraftInput(state, { type: 'TIMEOUT' }, false)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Timeout seat 1's pick
    result = processDraftInput(state, { type: 'TIMEOUT' }, false)
    if (isDraftError(result))
      throw new Error(result.error)

    expect(result.state.status).toBe('complete')
    expect(result.state.picks).toHaveLength(2)
  })
})

// ── Error Cases ─────────────────────────────────────────────

describe('error cases', () => {
  test('ban when draft not active', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    const result = processDraftInput(draft, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Draft is not active')
  })

  test('pick when draft not active', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    const result = processDraftInput(draft, { type: 'PICK', seatIndex: 0, civId: 'civ-1' })

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Draft is not active')
  })

  test('timeout when draft not active', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    const result = processDraftInput(draft, { type: 'TIMEOUT' }, false)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Draft is not active')
  })

  test('invalid seat index for ban', () => {
    const state = startDraft(createDraft('match-123', pplDuel, createDuelSeats(), createTestCivPool()))
    const result = processDraftInput(state, { type: 'BAN', seatIndex: 99, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)

    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Seat 99 is not active in this step')
  })

  test('picking same civ twice in multi-pick step fails', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Team A picks 1
    result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Team B picks first civ
    result = processDraftInput(state, { type: 'PICK', seatIndex: 1, civId: 'civ-20' })
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Team B tries to pick same civ again
    result = processDraftInput(state, { type: 'PICK', seatIndex: 1, civId: 'civ-20' })
    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Civ civ-20 is not available')
  })

  test('picking civ that was banned fails', () => {
    let state = startDraft(createDraft('match-123', pplDuel, createDuelSeats(), createTestCivPool()))

    // Complete ban phase (civ-1 gets banned)
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Try to pick banned civ
    result = processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-1' })
    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Civ civ-1 is not available')
  })

  test('banning during pick phase fails', () => {
    let state = startDraft(createDraft('match-123', pplDuel, createDuelSeats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    // Try to ban during pick phase
    result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-10', 'civ-11', 'civ-12'] }, true)
    expect(isDraftError(result)).toBe(true)
    if (!isDraftError(result))
      return
    expect(result.error).toBe('Current step is not a ban phase')
  })
})

// ── Query Helpers ───────────────────────────────────────────

describe('query helpers', () => {
  test('getCurrentStep returns null for waiting draft', () => {
    const draft = createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool())
    expect(getCurrentStep(draft)).toBeNull()
  })

  test('getCurrentStep returns current step for active draft', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const step = getCurrentStep(state)
    expect(step).not.toBeNull()
    expect(step!.action).toBe('ban')
  })

  test('getPendingSeats returns all seats in ban phase', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    expect(getPendingSeats(state)).toEqual([0, 1])
  })

  test('getPendingSeats returns remaining seats after partial submission', () => {
    let state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))
    const result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    state = result.state

    expect(getPendingSeats(state)).toEqual([1])
  })

  test('getPicksForSeat returns picks for specific seat', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)

    // Team A picks
    result = processDraftInput(result.state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' })
    if (isDraftError(result))
      throw new Error(result.error)

    const picks = getPicksForSeat(result.state, 0)
    expect(picks).toHaveLength(1)
    expect(picks[0]!.civId).toBe('civ-10')
  })

  test('getBansForSeat returns bans for specific seat', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // Complete ban phase
    let result = processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)
    result = processDraftInput(result.state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true)
    if (isDraftError(result))
      throw new Error(result.error)

    const bans0 = getBansForSeat(result.state, 0)
    expect(bans0).toHaveLength(3)
    expect(bans0.map(b => b.civId).sort()).toEqual(['civ-1', 'civ-2', 'civ-3'])

    const bans1 = getBansForSeat(result.state, 1)
    expect(bans1).toHaveLength(3)
    expect(bans1.map(b => b.civId).sort()).toEqual(['civ-4', 'civ-5', 'civ-6'])
  })

  test('isPlayerTurn correctly identifies active player', () => {
    const state = startDraft(createDraft('match-123', ppl2v2, create2v2Seats(), createTestCivPool()))

    // In ban phase, both teams are active
    expect(isPlayerTurn(state, 'teamA')).toBe(true)
    expect(isPlayerTurn(state, 'teamB')).toBe(true)
    expect(isPlayerTurn(state, 'unknown')).toBe(false)
  })
})
