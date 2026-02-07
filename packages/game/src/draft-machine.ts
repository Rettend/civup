import type {
  DraftError,
  DraftEvent,
  DraftFormat,
  DraftInput,
  DraftResult,
  DraftSeat,
  DraftSelection,
  DraftState,
  DraftStep,
} from './types.ts'

// ── Create ──────────────────────────────────────────────────

/**
 * Create a new draft state.
 *
 * For team modes: seats represent teams (seat 0 = Team A, seat 1 = Team B).
 * For FFA: seats represent individual players.
 */
export function createDraft(
  matchId: string,
  format: DraftFormat,
  seats: DraftSeat[],
  civPool: string[],
): DraftState {
  const seatCount = seats.length
  const steps = format.getSteps(seatCount)

  return {
    matchId,
    formatId: format.id,
    seats,
    steps,
    currentStepIndex: -1,
    submissions: {},
    bans: [],
    picks: [],
    availableCivIds: [...civPool],
    status: 'waiting',
    pendingBlindBans: [],
  }
}

// ── Process Input ───────────────────────────────────────────

/**
 * Process a draft input and return the new state + events, or an error.
 *
 * This is a pure function — given a state and input, produces a new state.
 * No side effects. The caller (PartyKit server) handles broadcasting events.
 */
export function processDraftInput(
  state: DraftState,
  input: DraftInput,
  blindBans: boolean = false,
): DraftResult | DraftError {
  switch (input.type) {
    case 'START':
      return processStart(state)
    case 'BAN':
      return processBan(state, input.seatIndex, input.civIds, blindBans)
    case 'PICK':
      return processPick(state, input.seatIndex, input.civId)
    case 'TIMEOUT':
      return processTimeout(state, blindBans)
  }
}

/** Type guard for DraftError */
export function isDraftError(result: DraftResult | DraftError): result is DraftError {
  return 'error' in result
}

// ── Start ───────────────────────────────────────────────────

function processStart(state: DraftState): DraftResult | DraftError {
  if (state.status !== 'waiting') {
    return { error: 'Draft already started' }
  }

  if (state.steps.length === 0) {
    return { error: 'No steps in draft format' }
  }

  const newState: DraftState = {
    ...state,
    status: 'active',
    currentStepIndex: 0,
    submissions: {},
  }

  return {
    state: newState,
    events: [
      { type: 'DRAFT_STARTED' },
      { type: 'STEP_ADVANCED', stepIndex: 0 },
    ],
  }
}

// ── Ban ─────────────────────────────────────────────────────

function processBan(
  state: DraftState,
  seatIndex: number,
  civIds: string[],
  blindBans: boolean,
): DraftResult | DraftError {
  if (state.status !== 'active') {
    return { error: 'Draft is not active' }
  }

  const step = state.steps[state.currentStepIndex]
  if (!step)
    return { error: 'No current step' }

  if (step.action !== 'ban') {
    return { error: 'Current step is not a ban phase' }
  }

  // Validate seat is allowed to act
  if (!isSeatActive(step, seatIndex, state.seats.length)) {
    return { error: `Seat ${seatIndex} is not active in this step` }
  }

  // Check seat hasn't already submitted
  if (state.submissions[seatIndex]) {
    return { error: `Seat ${seatIndex} has already submitted for this step` }
  }

  // Validate count
  if (civIds.length !== step.count) {
    return { error: `Expected ${step.count} bans, got ${civIds.length}` }
  }

  // Validate civs are available (for blind bans, also check pending blind bans aren't duplicated by same seat)
  for (const civId of civIds) {
    if (!state.availableCivIds.includes(civId)) {
      return { error: `Civ ${civId} is not available` }
    }
    // For non-blind, check not already in another seat's submission this step
    if (!blindBans) {
      const alreadySubmitted = Object.values(state.submissions).flat()
      if (alreadySubmitted.includes(civId)) {
        return { error: `Civ ${civId} was already banned in this step` }
      }
    }
  }

  // Check for duplicates within submission
  if (new Set(civIds).size !== civIds.length) {
    return { error: 'Duplicate civs in ban submission' }
  }

  // Record submission
  const newSubmissions = { ...state.submissions, [seatIndex]: civIds }
  const events: DraftEvent[] = []

  // For blind bans, add to pending but don't broadcast the civ IDs
  const isBlind = blindBans && step.seats === 'all'
  events.push({ type: 'BAN_SUBMITTED', seatIndex, civIds, blind: isBlind })

  // Check if step is complete
  const activeSeatCount = getActiveSeatCount(step, state.seats.length)
  const submittedCount = Object.keys(newSubmissions).length

  if (submittedCount >= activeSeatCount) {
    // Step complete — apply all bans
    return completeStep(state, newSubmissions, events, blindBans)
  }

  // Step not yet complete, update submissions
  const newState: DraftState = {
    ...state,
    submissions: newSubmissions,
    // For blind bans, accumulate without removing from available
    pendingBlindBans: isBlind
      ? [
          ...state.pendingBlindBans,
          ...civIds.map(civId => ({ civId, seatIndex, stepIndex: state.currentStepIndex })),
        ]
      : state.pendingBlindBans,
  }

  return { state: newState, events }
}

// ── Pick ────────────────────────────────────────────────────

function processPick(
  state: DraftState,
  seatIndex: number,
  civId: string,
): DraftResult | DraftError {
  if (state.status !== 'active') {
    return { error: 'Draft is not active' }
  }

  const step = state.steps[state.currentStepIndex]
  if (!step)
    return { error: 'No current step' }

  if (step.action !== 'pick') {
    return { error: 'Current step is not a pick phase' }
  }

  if (!isSeatActive(step, seatIndex, state.seats.length)) {
    return { error: `Seat ${seatIndex} is not active in this step` }
  }

  // For sequential picks (count > 1), check how many this seat has already submitted
  const existingPicks = state.submissions[seatIndex] || []
  if (existingPicks.length >= step.count) {
    return { error: `Seat ${seatIndex} has already made all picks for this step` }
  }

  if (!state.availableCivIds.includes(civId)) {
    return { error: `Civ ${civId} is not available` }
  }

  // Also check not already picked in current submissions by another seat
  const allCurrentSubmissions = Object.values(state.submissions).flat()
  if (allCurrentSubmissions.includes(civId)) {
    return { error: `Civ ${civId} was already picked in this step` }
  }

  const newSeatPicks = [...existingPicks, civId]
  const newSubmissions = { ...state.submissions, [seatIndex]: newSeatPicks }
  const events: DraftEvent[] = [
    { type: 'PICK_SUBMITTED', seatIndex, civId },
  ]

  // Remove from available immediately (picks are never blind)
  const newAvailable = state.availableCivIds.filter(id => id !== civId)

  // Check if step is complete (all active seats have made all their picks)
  const activeSeatCount = getActiveSeatCount(step, state.seats.length)
  const fullySubmittedSeats = Object.entries(newSubmissions)
    .filter(([_, picks]) => picks.length >= step.count)
    .length
  const stepComplete = fullySubmittedSeats >= activeSeatCount

  if (stepComplete) {
    // Record picks
    const newPicks = [...state.picks]
    for (const [seat, picks] of Object.entries(newSubmissions)) {
      for (const pick of picks) {
        newPicks.push({ civId: pick, seatIndex: Number(seat), stepIndex: state.currentStepIndex })
      }
    }

    const stateAfterPicks: DraftState = {
      ...state,
      submissions: {},
      picks: newPicks,
      availableCivIds: newAvailable,
    }

    return advanceStep(stateAfterPicks, events)
  }

  // Step not complete, update state
  return {
    state: {
      ...state,
      submissions: newSubmissions,
      availableCivIds: newAvailable,
    },
    events,
  }
}

// ── Timeout ─────────────────────────────────────────────────

function processTimeout(
  state: DraftState,
  blindBans: boolean,
): DraftResult | DraftError {
  if (state.status !== 'active') {
    return { error: 'Draft is not active' }
  }

  const step = state.steps[state.currentStepIndex]
  if (!step)
    return { error: 'No current step' }

  const events: DraftEvent[] = []
  const newSubmissions = { ...state.submissions }
  let available = [...state.availableCivIds]

  // For each seat that hasn't submitted, auto-select random civs
  const activeSeats = getActiveSeats(step, state.seats.length)
  for (const seat of activeSeats) {
    const existing = newSubmissions[seat]
    const needed = step.count - (existing?.length ?? 0)
    if (needed <= 0)
      continue

    // Pick random civs from available pool
    const randomPicks: string[] = []
    for (let i = 0; i < needed; i++) {
      if (available.length === 0)
        break
      const idx = Math.floor(Math.random() * available.length)
      randomPicks.push(available[idx]!)
      if (step.action === 'pick') {
        // Remove immediately for picks
        available = available.filter((_, j) => j !== idx)
      }
    }

    newSubmissions[seat] = [...(existing ?? []), ...randomPicks]
    events.push({ type: 'TIMEOUT_APPLIED', seatIndex: seat, selections: randomPicks })
  }

  // Complete the step with all submissions
  return completeStep(
    { ...state, availableCivIds: available },
    newSubmissions,
    events,
    blindBans,
  )
}

// ── Internal Helpers ────────────────────────────────────────

function isSeatActive(step: DraftStep, seatIndex: number, totalSeats: number): boolean {
  if (step.seats === 'all')
    return seatIndex >= 0 && seatIndex < totalSeats
  return step.seats.includes(seatIndex)
}

function getActiveSeatCount(step: DraftStep, totalSeats: number): number {
  if (step.seats === 'all')
    return totalSeats
  return step.seats.length
}

function getActiveSeats(step: DraftStep, totalSeats: number): number[] {
  if (step.seats === 'all')
    return Array.from({ length: totalSeats }, (_, i) => i)
  return step.seats
}

/**
 * Complete a ban step: apply all bans, optionally reveal blind bans, advance to next step.
 */
function completeStep(
  state: DraftState,
  submissions: Record<number, string[]>,
  events: DraftEvent[],
  blindBans: boolean,
): DraftResult {
  const step = state.steps[state.currentStepIndex]!
  const isBlindBanStep = blindBans && step.action === 'ban' && step.seats === 'all'

  if (step.action === 'ban') {
    // Collect all bans from submissions
    const newBans = [...state.bans]
    const allBannedCivIds: string[] = []

    for (const [seat, civIds] of Object.entries(submissions)) {
      for (const civId of civIds) {
        newBans.push({ civId, seatIndex: Number(seat), stepIndex: state.currentStepIndex })
        allBannedCivIds.push(civId)
      }
    }

    // Remove banned civs from available pool
    const newAvailable = state.availableCivIds.filter(id => !allBannedCivIds.includes(id))

    // If blind bans, emit reveal event
    if (isBlindBanStep) {
      const revealedBans = newBans.filter(b => b.stepIndex === state.currentStepIndex)
      events.push({ type: 'BLIND_BANS_REVEALED', bans: revealedBans })
    }

    const stateAfterBans: DraftState = {
      ...state,
      submissions: {},
      bans: newBans,
      availableCivIds: newAvailable,
      pendingBlindBans: [],
    }

    return advanceStep(stateAfterBans, events)
  }

  // For pick steps, picks were already recorded in processPick
  // This path is reached via timeout
  const newPicks = [...state.picks]
  for (const [seat, picks] of Object.entries(submissions)) {
    for (const pick of picks) {
      // Avoid duplicating picks already recorded
      const exists = newPicks.some(
        p => p.civId === pick && p.seatIndex === Number(seat) && p.stepIndex === state.currentStepIndex,
      )
      if (!exists) {
        newPicks.push({ civId: pick, seatIndex: Number(seat), stepIndex: state.currentStepIndex })
      }
    }
  }

  const stateAfterPicks: DraftState = {
    ...state,
    submissions: {},
    picks: newPicks,
    availableCivIds: state.availableCivIds,
  }

  return advanceStep(stateAfterPicks, events)
}

/**
 * Advance to the next step, or complete the draft.
 */
function advanceStep(
  state: DraftState,
  events: DraftEvent[],
): DraftResult {
  const nextStepIndex = state.currentStepIndex + 1

  if (nextStepIndex >= state.steps.length) {
    // Draft complete
    return {
      state: {
        ...state,
        currentStepIndex: nextStepIndex,
        status: 'complete',
      },
      events: [...events, { type: 'DRAFT_COMPLETE' }],
    }
  }

  // Move to next step
  return {
    state: {
      ...state,
      currentStepIndex: nextStepIndex,
      submissions: {},
    },
    events: [...events, { type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

// ── Query Helpers ───────────────────────────────────────────

/** Get the current step, or null if draft is not active */
export function getCurrentStep(state: DraftState): DraftStep | null {
  if (state.status !== 'active')
    return null
  return state.steps[state.currentStepIndex] ?? null
}

/** Get which seats need to submit in the current step */
export function getPendingSeats(state: DraftState): number[] {
  const step = getCurrentStep(state)
  if (!step)
    return []

  const activeSeats = getActiveSeats(step, state.seats.length)
  return activeSeats.filter((seat) => {
    const submissions = state.submissions[seat]
    if (!submissions)
      return true
    return submissions.length < step.count
  })
}

/** Get picks for a specific seat */
export function getPicksForSeat(state: DraftState, seatIndex: number): DraftSelection[] {
  return state.picks.filter(p => p.seatIndex === seatIndex)
}

/** Get bans for a specific seat */
export function getBansForSeat(state: DraftState, seatIndex: number): DraftSelection[] {
  return state.bans.filter(b => b.seatIndex === seatIndex)
}

/** Check if the draft is waiting for a specific player */
export function isPlayerTurn(state: DraftState, playerId: string): boolean {
  const pendingSeats = getPendingSeats(state)
  return pendingSeats.some(seat => state.seats[seat]?.playerId === playerId)
}
