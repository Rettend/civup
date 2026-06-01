import type { RandomSource } from './random.ts'
import type {
  CivBlitzCategoryOptions,
  CivBlitzComponentCategory,
  CivBlitzComponentPools,
  CivBlitzPartialKit,
  CivBlitzReveal,
  CivBlitzSeatSubmission,
  CivBlitzSelection,
  CivBlitzState,
  DraftCancelReason,
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
import { CIV_BLITZ_CATEGORIES } from './types.ts'

export interface DraftProcessOptions {
  blindBans?: boolean
  random?: RandomSource
}

const BLIND_PICK_MAX_REDRAFTS = 2
const BLIND_PICK_REVEAL_SECONDS = 5
const DEFAULT_PICK_TIMER_SECONDS = 60
const CIV_BLITZ_MAX_REDRAFTS = 2

interface CivBlitzCreateOptions {
  componentPools: CivBlitzComponentPools
  optionCount: number
  excludeBbgExpanded?: boolean
  random?: RandomSource
}

// ── Create ──────────────────────────────────────────────────

/**
 * Create a new draft state.
 *
 * Seats always represent player slots.
 */
export function createDraft(
  matchId: string,
  format: DraftFormat,
  seats: DraftSeat[],
  civPool: string[],
  options: {
    dealOptionsSize?: number
    duplicateFactions?: boolean
    civBlitz?: CivBlitzCreateOptions
  } = {},
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
    dealtCivIds: null,
    dealtCivIdsBySeat: null,
    dealOptionsSize: options.dealOptionsSize,
    duplicateFactions: options.duplicateFactions === true,
    blindPickReveal: null,
    blindPickBans: [],
    civBlitz: options.civBlitz ? createCivBlitzState(seatCount, options.civBlitz) : null,
    status: 'waiting',
    cancelReason: null,
    pendingBlindBans: [],
  }
}

// ── Process Input ───────────────────────────────────────────

/**
 * Process a draft input and return the new state + events, or an error.
 *
 * This is a pure function — given a state and input, produces a new state.
 * No side effects. The caller handles broadcasting events.
 */
export function processDraftInput(
  state: DraftState,
  input: DraftInput,
  options: boolean | DraftProcessOptions = false,
): DraftResult | DraftError {
  const { blindBans, random } = normalizeDraftProcessOptions(options)
  switch (input.type) {
    case 'START':
      return processStart(state)
    case 'CANCEL':
      return processCancel(state, input.reason)
    case 'BAN':
      return processBan(state, input.seatIndex, input.civIds, blindBans)
    case 'PICK':
      return processPick(state, input.seatIndex, input.civId)
    case 'CIV_BLITZ_SUBMIT':
      return processCivBlitzSubmit(state, input.seatIndex, input.kit, random ?? Math.random)
    case 'TIMEOUT':
      return processTimeout(state, blindBans, random)
  }
}

/** Type guard for DraftError */
export function isDraftError(result: DraftResult | DraftError): result is DraftError {
  return 'error' in result
}

/** Swap the picked civs between two teammate seats after draft completion. */
export function swapSeatPicks(
  state: DraftState,
  seatA: number,
  seatB: number,
): DraftSelection[] | DraftError {
  if (seatA === seatB) return { error: 'Cannot swap a seat with itself' }
  if (state.status !== 'complete') return { error: 'Draft is not complete' }

  const leftSeat = state.seats[seatA]
  const rightSeat = state.seats[seatB]
  if (!leftSeat || !rightSeat) return { error: 'Invalid seat index' }
  if (leftSeat.team == null || rightSeat.team == null) return { error: 'Only team seats can swap picks' }
  if (leftSeat.team !== rightSeat.team) return { error: 'Only teammates can swap picks' }

  const leftPick = state.picks.find(pick => pick.seatIndex === seatA)
  const rightPick = state.picks.find(pick => pick.seatIndex === seatB)
  if (!leftPick || !rightPick) return { error: 'Both seats need a locked pick before swapping' }

  return state.picks.map((pick) => {
    if (pick.seatIndex === seatA) return { ...pick, civId: rightPick.civId }
    if (pick.seatIndex === seatB) return { ...pick, civId: leftPick.civId }
    return pick
  })
}

/** Swap the completed draft choices between two teammate seats. */
export function swapSeatDraftChoices(
  state: DraftState,
  seatA: number,
  seatB: number,
): DraftState | DraftError {
  if (state.civBlitz) {
    const validation = validateSeatSwap(state, seatA, seatB)
    if (validation) return validation
    const leftKit = state.civBlitz.lockedKits[seatA]
    const rightKit = state.civBlitz.lockedKits[seatB]
    if (!isCompleteCivBlitzKit(leftKit) || !isCompleteCivBlitzKit(rightKit)) {
      return { error: 'Both seats need a locked CivBlitz kit before swapping' }
    }
    return {
      ...state,
      civBlitz: {
        ...state.civBlitz,
        lockedKits: {
          ...state.civBlitz.lockedKits,
          [seatA]: { ...rightKit },
          [seatB]: { ...leftKit },
        },
      },
    }
  }

  const picks = swapSeatPicks(state, seatA, seatB)
  if ('error' in picks) return picks
  return { ...state, picks }
}

function validateSeatSwap(state: DraftState, seatA: number, seatB: number): DraftError | null {
  if (seatA === seatB) return { error: 'Cannot swap a seat with itself' }
  if (state.status !== 'complete') return { error: 'Draft is not complete' }

  const leftSeat = state.seats[seatA]
  const rightSeat = state.seats[seatB]
  if (!leftSeat || !rightSeat) return { error: 'Invalid seat index' }
  if (leftSeat.team == null || rightSeat.team == null) return { error: 'Only team seats can swap picks' }
  if (leftSeat.team !== rightSeat.team) return { error: 'Only teammates can swap picks' }
  return null
}

// ── Start ───────────────────────────────────────────────────

function processStart(state: DraftState): DraftResult | DraftError {
  if (state.status === 'cancelled') {
    return { error: 'Draft has been cancelled' }
  }

  if (state.status !== 'waiting') {
    return { error: 'Draft already started' }
  }

  if (state.steps.length === 0) {
    return { error: 'No steps in draft format' }
  }

  const newState: DraftState = {
    ...state,
    status: 'active',
    cancelReason: null,
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

// ── Cancel ──────────────────────────────────────────────────

function processCancel(
  state: DraftState,
  reason: DraftCancelReason,
): DraftResult | DraftError {
  if (state.status === 'cancelled') {
    return { error: 'Draft already cancelled' }
  }

  const normalizedReason = normalizeCancelReason(state, reason)

  return {
    state: {
      ...state,
      status: 'cancelled',
      cancelReason: normalizedReason,
      submissions: {},
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: null,
      civBlitz: state.civBlitz ? { ...state.civBlitz, submissions: {}, reveal: null } : state.civBlitz,
      pendingBlindBans: [],
    },
    events: [{ type: 'DRAFT_CANCELLED', reason: normalizedReason }],
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
  if (!step) return { error: 'No current step' }

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
  const isBlind = isBlindBanStep(step, blindBans)
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
  if (!step) return { error: 'No current step' }

  if (step.action !== 'pick') {
    return { error: 'Current step is not a pick phase' }
  }

  if (step.civBlitz) {
    return { error: 'Current step is a CivBlitz pick phase' }
  }

  if (step.reveal) {
    return { error: 'Current step is resolving blind pick conflicts' }
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

  const dealtCivIds = getDealtCivIdsForSeat(state, seatIndex)
  if (dealtCivIds && !dealtCivIds.includes(civId)) {
    return { error: `Civ ${civId} is not in the dealt options` }
  }

  // Also check not already picked in current submissions by another seat
  const allCurrentSubmissions = Object.values(state.submissions).flat()
  if (!step.blind && !state.duplicateFactions && allCurrentSubmissions.includes(civId)) {
    return { error: `Civ ${civId} was already picked in this step` }
  }

  const newSeatPicks = [...existingPicks, civId]
  const newSubmissions = { ...state.submissions, [seatIndex]: newSeatPicks }
  if (step.blind) {
    const events: DraftEvent[] = [
      { type: 'PICK_SUBMITTED', seatIndex, civId, blind: true },
    ]
    const activeSeats = getActiveSeats(step, state.seats.length)
    const fullySubmittedSeats = activeSeats.filter(seat => (newSubmissions[seat]?.length ?? 0) >= step.count).length
    const stepComplete = fullySubmittedSeats >= activeSeats.length

    if (stepComplete) return completeBlindPickStep(state, step, newSubmissions, events)

    return {
      state: {
        ...state,
        submissions: newSubmissions,
      },
      events,
    }
  }

  const newPicks = [...state.picks, { civId, seatIndex, stepIndex: state.currentStepIndex }]
  const events: DraftEvent[] = [
    { type: 'PICK_SUBMITTED', seatIndex, civId },
  ]

  // Remove from available immediately (picks are never blind)
  const newAvailable = state.duplicateFactions
    ? state.availableCivIds
    : state.availableCivIds.filter(id => id !== civId)

  // Check if step is complete (all active seats have made all their picks)
  const activeSeats = getActiveSeats(step, state.seats.length)
  const activeSeatCount = activeSeats.length
  const fullySubmittedSeats = activeSeats.filter(seat => (newSubmissions[seat]?.length ?? 0) >= step.count).length
  const stepComplete = fullySubmittedSeats >= activeSeatCount

  const stateAfterPick: DraftState = {
    ...state,
    submissions: newSubmissions,
    picks: newPicks,
    availableCivIds: newAvailable,
    dealtCivIds: null,
    dealtCivIdsBySeat: null,
  }

  if (stepComplete) {
    return advanceStep({
      ...stateAfterPick,
      submissions: {},
    }, events)
  }

  return { state: stateAfterPick, events }
}

// -- CivBlitz ---------------------------------------------------------------

function processCivBlitzSubmit(
  state: DraftState,
  seatIndex: number,
  kit: CivBlitzPartialKit,
  random: RandomSource,
): DraftResult | DraftError {
  if (state.status !== 'active') {
    return { error: 'Draft is not active' }
  }

  const step = state.steps[state.currentStepIndex]
  if (!step) return { error: 'No current step' }
  if (step.action !== 'pick' || !step.civBlitz) return { error: 'Current step is not a CivBlitz pick phase' }
  if (step.reveal) return { error: 'Current step is resolving CivBlitz conflicts' }
  if (!state.civBlitz) return { error: 'CivBlitz state is missing' }
  if (!isSeatActive(step, seatIndex, state.seats.length)) return { error: `Seat ${seatIndex} is not active in this step` }
  if (state.submissions[seatIndex]) return { error: `Seat ${seatIndex} has already submitted for this step` }

  const categories = getCivBlitzStepCategories(step, seatIndex)
  const normalizedKit = normalizeCivBlitzSubmission(state.civBlitz, seatIndex, categories, kit)
  if ('error' in normalizedKit) return normalizedKit

  const nextCivBlitz: CivBlitzState = {
    ...state.civBlitz,
    submissions: {
      ...state.civBlitz.submissions,
      [seatIndex]: normalizedKit,
    },
  }
  const nextState: DraftState = {
    ...state,
    submissions: {
      ...state.submissions,
      [seatIndex]: ['__civblitz__'],
    },
    civBlitz: nextCivBlitz,
  }
  const events: DraftEvent[] = [{ type: 'CIV_BLITZ_SUBMITTED', seatIndex, categories, blind: true }]

  if (isCivBlitzStepComplete(nextState, step)) {
    return completeCivBlitzStep(nextState, step, events, random)
  }

  return { state: nextState, events }
}

function processCivBlitzTimeout(
  state: DraftState,
  step: DraftStep,
  random: RandomSource,
): DraftResult | DraftError {
  if (!state.civBlitz) return { error: 'CivBlitz state is missing' }

  let nextCivBlitz = state.civBlitz
  const nextSubmissions = { ...state.submissions }
  const events: DraftEvent[] = []

  for (const seatIndex of getActiveSeats(step, state.seats.length)) {
    if (nextSubmissions[seatIndex]) continue

    const categories = getCivBlitzStepCategories(step, seatIndex)
    const autoKit = buildRandomCivBlitzKit(nextCivBlitz, seatIndex, categories, random)
    if ('error' in autoKit) return autoKit

    nextCivBlitz = {
      ...nextCivBlitz,
      submissions: {
        ...nextCivBlitz.submissions,
        [seatIndex]: autoKit,
      },
    }
    nextSubmissions[seatIndex] = ['__civblitz__']
    events.push({ type: 'TIMEOUT_APPLIED', seatIndex, selections: categories.map(category => autoKit[category]).filter(isString) })
  }

  return completeCivBlitzStep({ ...state, submissions: nextSubmissions, civBlitz: nextCivBlitz }, step, events, random)
}

function completeCivBlitzStep(
  state: DraftState,
  step: DraftStep,
  events: DraftEvent[],
  random: RandomSource,
): DraftResult | DraftError {
  const civBlitz = state.civBlitz
  if (!civBlitz) return { error: 'CivBlitz state is missing' }

  const submitted = getActiveSeats(step, state.seats.length).map((seatIndex) => {
    return {
      seatIndex,
      stepIndex: state.currentStepIndex,
      kit: civBlitz.submissions[seatIndex] ?? {},
    } satisfies CivBlitzSeatSubmission
  })
  const lockedKits = cloneCivBlitzKits(civBlitz.lockedKits)
  const conflicts = resolveCivBlitzSubmissionConflicts(submitted)

  for (const submission of submitted) {
    for (const category of CIV_BLITZ_CATEGORIES) {
      const componentId = submission.kit[category]
      if (!componentId) continue
      const conflictIds = conflicts.conflictComponentIdsByCategory[category]
      if (conflictIds?.has(componentId)) continue
      lockedKits[submission.seatIndex] = {
        ...(lockedKits[submission.seatIndex] ?? {}),
        [category]: componentId,
      }
    }
  }

  if (conflicts.conflictComponentIds.length === 0) {
    const nextState: DraftState = {
      ...state,
      submissions: {},
      civBlitz: {
        ...civBlitz,
        submissions: {},
        lockedKits,
        reveal: null,
      },
    }
    return advanceStep(nextState, events)
  }

  const round = step.blindPickRound ?? 0
  const nextStepIndex = state.currentStepIndex + 1
  const reveal: CivBlitzReveal = {
    round,
    submissions: submitted,
    conflictComponentIds: conflicts.conflictComponentIds,
    conflictedSeatIndexes: conflicts.conflictedSeatIndexes,
    categoriesBySeat: conflicts.categoriesBySeat,
    maxRedrafts: civBlitz.maxRedrafts,
  }
  const conflictBans: CivBlitzSelection[] = [
    ...civBlitz.conflictBans,
    ...conflicts.conflictSelections,
  ]
  const revealedEvent: DraftEvent = {
    type: 'CIV_BLITZ_REVEALED',
    submissions: submitted,
    conflictComponentIds: conflicts.conflictComponentIds,
    conflictedSeatIndexes: conflicts.conflictedSeatIndexes,
    categoriesBySeat: conflicts.categoriesBySeat,
    round,
  }
  const nextCivBlitz: CivBlitzState = {
    ...civBlitz,
    submissions: {},
    lockedKits,
    reveal,
    conflictBans,
  }

  if (round >= civBlitz.maxRedrafts) {
    const autoLocked = autoLockCivBlitzConflicts(nextCivBlitz, reveal.categoriesBySeat, random)
    if ('error' in autoLocked) return autoLocked
    return advanceStep({
      ...state,
      submissions: {},
      civBlitz: {
        ...nextCivBlitz,
        lockedKits: autoLocked.lockedKits,
        reveal: null,
      },
    }, [...events, revealedEvent, ...autoLocked.events])
  }

  const optionsBySeat = dealCivBlitzRedraftOptions(nextCivBlitz, reveal.categoriesBySeat, random)
  const redraftStep: DraftStep = {
    action: 'pick',
    seats: conflicts.conflictedSeatIndexes,
    count: 1,
    timer: step.timer || DEFAULT_PICK_TIMER_SECONDS,
    blind: true,
    blindPickRound: round + 1,
    civBlitz: true,
    civBlitzCategoriesBySeat: conflicts.categoriesBySeat,
  }

  return {
    state: {
      ...state,
      steps: [
        ...state.steps.slice(0, nextStepIndex),
        redraftStep,
        ...state.steps.slice(nextStepIndex),
      ],
      currentStepIndex: nextStepIndex,
      submissions: {},
      civBlitz: {
        ...nextCivBlitz,
        optionsBySeat,
      },
    },
    events: [
      ...events,
      revealedEvent,
      { type: 'STEP_ADVANCED', stepIndex: nextStepIndex },
    ],
  }
}

function completeCivBlitzReveal(
  state: DraftState,
  step: DraftStep,
  random: RandomSource,
): DraftResult | DraftError {
  const civBlitz = state.civBlitz
  const reveal = civBlitz?.reveal
  if (!civBlitz || !reveal) return { error: 'No CivBlitz reveal to resolve' }

  const nextStepIndex = state.currentStepIndex + 1
  const redraftTimer = step.redraftTimer ?? DEFAULT_PICK_TIMER_SECONDS
  if (reveal.round >= reveal.maxRedrafts) {
    const autoLocked = autoLockCivBlitzConflicts(civBlitz, reveal.categoriesBySeat, random)
    if ('error' in autoLocked) return autoLocked
    return advanceStep({
      ...state,
      submissions: {},
      civBlitz: {
        ...civBlitz,
        submissions: {},
        lockedKits: autoLocked.lockedKits,
        reveal: null,
      },
    }, autoLocked.events)
  }

  const optionsBySeat = dealCivBlitzRedraftOptions(civBlitz, reveal.categoriesBySeat, random)
  const redraftStep: DraftStep = {
    action: 'pick',
    seats: reveal.conflictedSeatIndexes,
    count: 1,
    timer: redraftTimer,
    blind: true,
    blindPickRound: reveal.round + 1,
    civBlitz: true,
    civBlitzCategoriesBySeat: reveal.categoriesBySeat,
  }

  return {
    state: {
      ...state,
      steps: [
        ...state.steps.slice(0, nextStepIndex),
        redraftStep,
        ...state.steps.slice(nextStepIndex),
      ],
      currentStepIndex: nextStepIndex,
      submissions: {},
      civBlitz: {
        ...civBlitz,
        optionsBySeat,
        submissions: {},
        reveal: null,
      },
    },
    events: [{ type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

// ── Timeout ─────────────────────────────────────────────────

function processTimeout(
  state: DraftState,
  blindBans: boolean,
  random: RandomSource,
): DraftResult | DraftError {
  if (state.status !== 'active') {
    return { error: 'Draft is not active' }
  }

  const step = state.steps[state.currentStepIndex]
  if (!step) return { error: 'No current step' }

  const activeSeats = getActiveSeats(step, state.seats.length)

  if (step.action === 'pick') {
    if (step.civBlitz) {
      if (step.reveal) return completeCivBlitzReveal(state, step, random)
      return processCivBlitzTimeout(state, step, random)
    }
    if (step.reveal) return completeBlindPickReveal(state, step)
    if (step.blind) return processBlindPickTimeout(state, step, random)

    if (state.dealtCivIds && state.dealtCivIds.length > 0) {
      const timedOutSeat = activeSeats.find((seat) => {
        const existing = state.submissions[seat]
        const needed = step.count - (existing?.length ?? 0)
        return needed > 0
      })

      if (timedOutSeat == null) {
        return { error: 'No pending picks to timeout' }
      }

      const timedOutPool = getTimeoutPickPool(state, timedOutSeat)
      if (timedOutPool.length === 0) {
        return { error: 'No dealt factions available for timeout pick' }
      }

      const randomPick = timedOutPool[Math.floor(random() * timedOutPool.length)]
      if (!randomPick) return { error: 'Failed to resolve timeout pick' }

      const timeoutEvents: DraftEvent[] = [{
        type: 'TIMEOUT_APPLIED',
        seatIndex: timedOutSeat,
        selections: [randomPick],
      }]

      const nextState: DraftState = {
        ...state,
        submissions: { ...state.submissions, [timedOutSeat]: [randomPick] },
        picks: [...state.picks, { civId: randomPick, seatIndex: timedOutSeat, stepIndex: state.currentStepIndex }],
        availableCivIds: state.duplicateFactions
          ? state.availableCivIds
          : state.availableCivIds.filter(id => id !== randomPick),
        dealtCivIds: null,
        dealtCivIdsBySeat: null,
      }

      return advanceStep({
        ...nextState,
        submissions: {},
      }, timeoutEvents)
    }

    const timedOutSeats = activeSeats.filter((seat) => {
      const existing = state.submissions[seat]
      const needed = step.count - (existing?.length ?? 0)
      return needed > 0
    })

    if (timedOutSeats.length === 0) {
      return { error: 'No pending picks to timeout' }
    }

    const fallbackResult = processDoublePickFallbackTimeout(state, step, timedOutSeats)
    if (fallbackResult) return fallbackResult

    const cancelResult = processCancel(state, 'timeout')
    if (isDraftError(cancelResult)) return cancelResult

    const timeoutEvents: DraftEvent[] = timedOutSeats.map(seat => ({
      type: 'TIMEOUT_APPLIED',
      seatIndex: seat,
      selections: [],
    }))

    return {
      state: cancelResult.state,
      events: [...timeoutEvents, ...cancelResult.events],
    }
  }

  const events: DraftEvent[] = []
  const newSubmissions = { ...state.submissions }
  const available = [...state.availableCivIds]

  // Ban timeout: for each seat that hasn't submitted, auto-select random civs
  for (const seat of activeSeats) {
    const existing = newSubmissions[seat]
    const needed = step.count - (existing?.length ?? 0)
    if (needed <= 0) continue

    // Pick random civs from available pool
    const randomPicks: string[] = []
    for (let i = 0; i < needed; i++) {
      if (available.length === 0) break
      const idx = Math.floor(random() * available.length)
      const [pickedCivId] = available.splice(idx, 1)
      if (!pickedCivId) break
      randomPicks.push(pickedCivId)
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

function processBlindPickTimeout(
  state: DraftState,
  step: DraftStep,
  random: RandomSource,
): DraftResult | DraftError {
  const submissions = { ...state.submissions }
  const events: DraftEvent[] = []

  for (const seatIndex of getActiveSeats(step, state.seats.length)) {
    const existing = submissions[seatIndex] ?? []
    const needed = step.count - existing.length
    if (needed <= 0) continue

    const picks: string[] = []
    const selected = new Set(existing)
    for (let index = 0; index < needed; index++) {
      const pool = getTimeoutPickPool(state, seatIndex).filter(civId => !selected.has(civId))
      if (pool.length === 0) return { error: 'No leaders available for timeout pick' }
      const civId = pool[Math.floor(random() * pool.length)]
      if (!civId) return { error: 'Failed to resolve timeout pick' }
      picks.push(civId)
      selected.add(civId)
    }

    submissions[seatIndex] = [...existing, ...picks]
    events.push({ type: 'TIMEOUT_APPLIED', seatIndex, selections: picks })
  }

  return completeBlindPickStep(state, step, submissions, events)
}

function completeBlindPickStep(
  state: DraftState,
  step: DraftStep,
  submissions: Record<number, string[]>,
  events: DraftEvent[],
): DraftResult {
  const submittedPicks = getActiveSeats(step, state.seats.length).flatMap((seatIndex) => {
    return (submissions[seatIndex] ?? []).map(civId => ({ civId, seatIndex, stepIndex: state.currentStepIndex }))
  })

  if (state.duplicateFactions) {
    return advanceStep({
      ...state,
      submissions: {},
      picks: [...state.picks, ...submittedPicks],
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: null,
    }, events)
  }

  const picksByCivId = new Map<string, DraftSelection[]>()
  for (const pick of submittedPicks) {
    const existing = picksByCivId.get(pick.civId)
    if (existing) existing.push(pick)
    else picksByCivId.set(pick.civId, [pick])
  }

  const conflictCivIds = [...picksByCivId.entries()]
    .filter(([, picks]) => picks.length > 1)
    .map(([civId]) => civId)
  const conflictCivIdSet = new Set(conflictCivIds)
  const lockedPicks = submittedPicks.filter(pick => !conflictCivIdSet.has(pick.civId))
  const conflictPicks = submittedPicks.filter(pick => conflictCivIdSet.has(pick.civId))
  const removedCivIds = new Set([...lockedPicks, ...conflictPicks].map(pick => pick.civId))
  const availableCivIds = state.availableCivIds.filter(civId => !removedCivIds.has(civId))

  if (conflictCivIds.length === 0) {
    return advanceStep({
      ...state,
      submissions: {},
      picks: [...state.picks, ...lockedPicks],
      availableCivIds,
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: null,
    }, events)
  }

  const conflictedSeatIndexes = Array.from(new Set(conflictPicks.map(pick => pick.seatIndex))).sort((left, right) => left - right)
  const round = step.blindPickRound ?? 0
  const revealStep: DraftStep = {
    action: 'pick',
    seats: conflictedSeatIndexes,
    count: 0,
    timer: BLIND_PICK_REVEAL_SECONDS,
    reveal: true,
    blindPickRound: round,
    fallbackPickOrder: step.fallbackPickOrder,
    redraftTimer: step.timer || DEFAULT_PICK_TIMER_SECONDS,
  }
  const nextStepIndex = state.currentStepIndex + 1
  const revealEvent: DraftEvent = {
    type: 'BLIND_PICKS_REVEALED',
    picks: submittedPicks,
    conflictCivIds,
    conflictedSeatIndexes,
    round,
  }

  return {
    state: {
      ...state,
      steps: [
        ...state.steps.slice(0, nextStepIndex),
        revealStep,
        ...state.steps.slice(nextStepIndex),
      ],
      currentStepIndex: nextStepIndex,
      submissions: {},
      picks: [...state.picks, ...lockedPicks],
      availableCivIds,
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: {
        round,
        picks: submittedPicks,
        conflictCivIds,
        conflictedSeatIndexes,
        maxRedrafts: BLIND_PICK_MAX_REDRAFTS,
      },
      blindPickBans: [...(state.blindPickBans ?? []), ...conflictPicks],
    },
    events: [...events, revealEvent, { type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

function completeBlindPickReveal(state: DraftState, step: DraftStep): DraftResult | DraftError {
  const reveal = state.blindPickReveal
  if (!reveal) return { error: 'No blind pick reveal to resolve' }

  const nextStepIndex = state.currentStepIndex + 1
  const redraftTimer = step.redraftTimer ?? DEFAULT_PICK_TIMER_SECONDS
  const nextSteps = reveal.round < reveal.maxRedrafts
    ? [createBlindPickRedraftStep(reveal.conflictedSeatIndexes, reveal.round + 1, redraftTimer, step.fallbackPickOrder)]
    : createDraftPickFallbackSteps(reveal.conflictedSeatIndexes, redraftTimer, step.fallbackPickOrder)

  if (nextSteps.length === 0) {
    return advanceStep({ ...state, blindPickReveal: null }, [])
  }

  return {
    state: {
      ...state,
      steps: [
        ...state.steps.slice(0, nextStepIndex),
        ...nextSteps,
        ...state.steps.slice(nextStepIndex),
      ],
      currentStepIndex: nextStepIndex,
      submissions: {},
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: null,
    },
    events: [{ type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

function createBlindPickRedraftStep(seats: number[], round: number, timer: number, fallbackPickOrder: number[] | undefined): DraftStep {
  return {
    action: 'pick',
    seats: [...seats],
    count: 1,
    timer,
    blind: true,
    blindPickRound: round,
    fallbackPickOrder,
  }
}

function createDraftPickFallbackSteps(seats: number[], timer: number, fallbackPickOrder: number[] | undefined): DraftStep[] {
  const seatSet = new Set(seats)
  const orderedSeats = (fallbackPickOrder?.length ? fallbackPickOrder : seats).filter(seat => seatSet.has(seat))
  return orderedSeats.map(seat => ({ action: 'pick', seats: [seat], count: 1, timer }))
}

function getTimeoutPickPool(state: DraftState, seatIndex: number): string[] {
  const dealt = getDealtCivIdsForSeat(state, seatIndex)
  const source = dealt ?? state.availableCivIds
  return source.filter(civId => state.availableCivIds.includes(civId))
}

function getDealtCivIdsForSeat(state: DraftState, seatIndex: number): string[] | null {
  const seatOptions = state.dealtCivIdsBySeat?.[seatIndex]
  if (seatOptions && seatOptions.length > 0) return seatOptions
  return state.dealtCivIds && state.dealtCivIds.length > 0 ? state.dealtCivIds : null
}

function createCivBlitzState(seatCount: number, options: CivBlitzCreateOptions): CivBlitzState {
  const optionCount = Math.max(1, Math.round(options.optionCount))
  const random = options.random ?? Math.random
  const optionsBySeat: Record<number, CivBlitzCategoryOptions> = {}
  for (let seatIndex = 0; seatIndex < seatCount; seatIndex++) {
    optionsBySeat[seatIndex] = dealCivBlitzCategoryOptions(options.componentPools, optionCount, random)
  }

  return {
    optionCount,
    excludeBbgExpanded: options.excludeBbgExpanded !== false,
    componentPools: cloneCivBlitzPools(options.componentPools),
    optionsBySeat,
    submissions: {},
    lockedKits: {},
    reveal: null,
    conflictBans: [],
    maxRedrafts: CIV_BLITZ_MAX_REDRAFTS,
  }
}

function getCivBlitzStepCategories(step: DraftStep, seatIndex: number): CivBlitzComponentCategory[] {
  const seatCategories = step.civBlitzCategoriesBySeat?.[seatIndex]
  if (seatCategories && seatCategories.length > 0) return normalizeCivBlitzCategories(seatCategories)
  if (step.civBlitzCategories && step.civBlitzCategories.length > 0) return normalizeCivBlitzCategories(step.civBlitzCategories)
  return [...CIV_BLITZ_CATEGORIES]
}

function normalizeCivBlitzCategories(categories: readonly CivBlitzComponentCategory[]): CivBlitzComponentCategory[] {
  const seen = new Set<CivBlitzComponentCategory>()
  const normalized: CivBlitzComponentCategory[] = []
  for (const category of categories) {
    if (!CIV_BLITZ_CATEGORIES.includes(category)) continue
    if (seen.has(category)) continue
    seen.add(category)
    normalized.push(category)
  }
  return normalized
}

function normalizeCivBlitzSubmission(
  civBlitz: CivBlitzState,
  seatIndex: number,
  categories: readonly CivBlitzComponentCategory[],
  kit: CivBlitzPartialKit,
): CivBlitzPartialKit | DraftError {
  const options = civBlitz.optionsBySeat[seatIndex]
  if (!options) return { error: `No CivBlitz options dealt for seat ${seatIndex}` }

  const normalized: CivBlitzPartialKit = {}
  for (const category of categories) {
    const componentId = kit[category]
    if (typeof componentId !== 'string' || componentId.length === 0) {
      return { error: `Missing CivBlitz ${formatCivBlitzCategory(category)} selection` }
    }
    if (!options[category].includes(componentId)) {
      return { error: `CivBlitz ${formatCivBlitzCategory(category)} ${componentId} is not in the dealt options` }
    }
    if (isCivBlitzComponentConflictBanned(civBlitz, category, componentId)) {
      return { error: `CivBlitz ${formatCivBlitzCategory(category)} ${componentId} is no longer available` }
    }
    if (isCivBlitzComponentLockedByOtherSeat(civBlitz, category, componentId, seatIndex)) {
      return { error: `CivBlitz ${formatCivBlitzCategory(category)} ${componentId} was already locked` }
    }
    normalized[category] = componentId
  }

  return normalized
}

function isCivBlitzStepComplete(state: DraftState, step: DraftStep): boolean {
  const civBlitz = state.civBlitz
  if (!civBlitz) return false
  return getActiveSeats(step, state.seats.length).every((seatIndex) => {
    const submission = civBlitz.submissions[seatIndex]
    if (!submission) return false
    return getCivBlitzStepCategories(step, seatIndex).every(category => typeof submission[category] === 'string')
  })
}

function buildRandomCivBlitzKit(
  civBlitz: CivBlitzState,
  seatIndex: number,
  categories: readonly CivBlitzComponentCategory[],
  random: RandomSource,
): CivBlitzPartialKit | DraftError {
  const options = civBlitz.optionsBySeat[seatIndex]
  if (!options) return { error: `No CivBlitz options dealt for seat ${seatIndex}` }

  const kit: CivBlitzPartialKit = {}
  for (const category of categories) {
    const pool = options[category].filter(componentId => !isCivBlitzComponentConflictBanned(civBlitz, category, componentId))
    if (pool.length === 0) return { error: `No CivBlitz ${formatCivBlitzCategory(category)} options available` }
    const componentId = pool[Math.floor(random() * pool.length)]
    if (!componentId) return { error: `Failed to resolve CivBlitz ${formatCivBlitzCategory(category)} timeout` }
    kit[category] = componentId
  }
  return kit
}

function resolveCivBlitzSubmissionConflicts(submissions: CivBlitzSeatSubmission[]): {
  conflictComponentIds: string[]
  conflictComponentIdsByCategory: Partial<Record<CivBlitzComponentCategory, Set<string>>>
  conflictedSeatIndexes: number[]
  categoriesBySeat: Record<number, CivBlitzComponentCategory[]>
  conflictSelections: CivBlitzSelection[]
} {
  const conflictComponentIds: string[] = []
  const conflictComponentIdsByCategory: Partial<Record<CivBlitzComponentCategory, Set<string>>> = {}
  const conflictedSeatIndexes = new Set<number>()
  const categoriesBySeat: Record<number, CivBlitzComponentCategory[]> = {}
  const conflictSelections: CivBlitzSelection[] = []

  for (const category of CIV_BLITZ_CATEGORIES) {
    const selectionsByComponent = new Map<string, CivBlitzSeatSubmission[]>()
    for (const submission of submissions) {
      const componentId = submission.kit[category]
      if (!componentId) continue
      const existing = selectionsByComponent.get(componentId)
      if (existing) existing.push(submission)
      else selectionsByComponent.set(componentId, [submission])
    }

    for (const [componentId, componentSubmissions] of selectionsByComponent) {
      if (componentSubmissions.length <= 1) continue
      conflictComponentIds.push(componentId)
      ;(conflictComponentIdsByCategory[category] ??= new Set()).add(componentId)
      for (const submission of componentSubmissions) {
        conflictedSeatIndexes.add(submission.seatIndex)
        categoriesBySeat[submission.seatIndex] = addCivBlitzCategory(categoriesBySeat[submission.seatIndex], category)
        conflictSelections.push({
          componentId,
          category,
          seatIndex: submission.seatIndex,
          stepIndex: submission.stepIndex,
        })
      }
    }
  }

  return {
    conflictComponentIds,
    conflictComponentIdsByCategory,
    conflictedSeatIndexes: Array.from(conflictedSeatIndexes).sort((left, right) => left - right),
    categoriesBySeat: sortCivBlitzCategoriesBySeat(categoriesBySeat),
    conflictSelections,
  }
}

function dealCivBlitzRedraftOptions(
  civBlitz: CivBlitzState,
  categoriesBySeat: Record<number, CivBlitzComponentCategory[]>,
  random: RandomSource,
): Record<number, CivBlitzCategoryOptions> {
  const nextOptionsBySeat = cloneCivBlitzOptionsBySeat(civBlitz.optionsBySeat)
  for (const [rawSeatIndex, categories] of Object.entries(categoriesBySeat)) {
    const seatIndex = Number(rawSeatIndex)
    const currentOptions = nextOptionsBySeat[seatIndex]
    if (!currentOptions) continue
    for (const category of categories) {
      currentOptions[category] = pickRandomDistinct(
        getAvailableCivBlitzPool(civBlitz, category),
        Math.min(civBlitz.optionCount, getAvailableCivBlitzPool(civBlitz, category).length),
        random,
      )
    }
  }
  return nextOptionsBySeat
}

function autoLockCivBlitzConflicts(
  civBlitz: CivBlitzState,
  categoriesBySeat: Record<number, CivBlitzComponentCategory[]>,
  random: RandomSource,
): { lockedKits: Record<number, CivBlitzPartialKit>, events: DraftEvent[] } | DraftError {
  const lockedKits = cloneCivBlitzKits(civBlitz.lockedKits)
  const events: DraftEvent[] = []
  const reservedByCategory = buildLockedCivBlitzComponentsByCategory(civBlitz)

  for (const [rawSeatIndex, categories] of Object.entries(categoriesBySeat)) {
    const seatIndex = Number(rawSeatIndex)
    const selections: string[] = []
    for (const category of categories) {
      const reserved = reservedByCategory[category] ?? new Set<string>()
      const pool = getAvailableCivBlitzPool(civBlitz, category).filter(componentId => !reserved.has(componentId))
      if (pool.length === 0) return { error: `No CivBlitz ${formatCivBlitzCategory(category)} options available` }
      const componentId = pool[Math.floor(random() * pool.length)]
      if (!componentId) return { error: `Failed to resolve CivBlitz ${formatCivBlitzCategory(category)} conflict` }
      ;(reservedByCategory[category] ??= new Set()).add(componentId)
      lockedKits[seatIndex] = {
        ...(lockedKits[seatIndex] ?? {}),
        [category]: componentId,
      }
      selections.push(componentId)
    }
    events.push({ type: 'TIMEOUT_APPLIED', seatIndex, selections })
  }

  return { lockedKits, events }
}

function getAvailableCivBlitzPool(civBlitz: CivBlitzState, category: CivBlitzComponentCategory): string[] {
  const conflictBanned = new Set(civBlitz.conflictBans.filter(selection => selection.category === category).map(selection => selection.componentId))
  const locked = buildLockedCivBlitzComponentsByCategory(civBlitz)[category] ?? new Set<string>()
  return civBlitz.componentPools[category].filter(componentId => !conflictBanned.has(componentId) && !locked.has(componentId))
}

function buildLockedCivBlitzComponentsByCategory(civBlitz: CivBlitzState): Record<CivBlitzComponentCategory, Set<string>> {
  const result = {
    civilizationAbility: new Set<string>(),
    leaderAbility: new Set<string>(),
    infrastructure: new Set<string>(),
    unit: new Set<string>(),
  }
  for (const kit of Object.values(civBlitz.lockedKits)) {
    for (const category of CIV_BLITZ_CATEGORIES) {
      const componentId = kit[category]
      if (componentId) result[category].add(componentId)
    }
  }
  return result
}

function isCivBlitzComponentLockedByOtherSeat(civBlitz: CivBlitzState, category: CivBlitzComponentCategory, componentId: string, seatIndex: number): boolean {
  for (const [rawSeatIndex, kit] of Object.entries(civBlitz.lockedKits)) {
    if (Number(rawSeatIndex) === seatIndex) continue
    if (kit[category] === componentId) return true
  }
  return false
}

function isCivBlitzComponentConflictBanned(civBlitz: CivBlitzState, category: CivBlitzComponentCategory, componentId: string): boolean {
  return civBlitz.conflictBans.some(selection => selection.category === category && selection.componentId === componentId)
}

function dealCivBlitzCategoryOptions(
  componentPools: CivBlitzComponentPools,
  optionCount: number,
  random: RandomSource,
): CivBlitzCategoryOptions {
  return {
    civilizationAbility: pickRandomDistinct(componentPools.civilizationAbility, Math.min(optionCount, componentPools.civilizationAbility.length), random),
    leaderAbility: pickRandomDistinct(componentPools.leaderAbility, Math.min(optionCount, componentPools.leaderAbility.length), random),
    infrastructure: pickRandomDistinct(componentPools.infrastructure, Math.min(optionCount, componentPools.infrastructure.length), random),
    unit: pickRandomDistinct(componentPools.unit, Math.min(optionCount, componentPools.unit.length), random),
  }
}

function pickRandomDistinct(values: readonly string[], count: number, random: RandomSource): string[] {
  const pool = [...values]
  const picked: string[] = []
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(random() * pool.length)
    const [value] = pool.splice(index, 1)
    if (value) picked.push(value)
  }
  return picked
}

function cloneCivBlitzPools(pools: CivBlitzComponentPools): CivBlitzComponentPools {
  return {
    civilizationAbility: [...pools.civilizationAbility],
    leaderAbility: [...pools.leaderAbility],
    infrastructure: [...pools.infrastructure],
    unit: [...pools.unit],
  }
}

function cloneCivBlitzOptionsBySeat(optionsBySeat: Record<number, CivBlitzCategoryOptions>): Record<number, CivBlitzCategoryOptions> {
  const cloned: Record<number, CivBlitzCategoryOptions> = {}
  for (const [rawSeatIndex, options] of Object.entries(optionsBySeat)) {
    cloned[Number(rawSeatIndex)] = {
      civilizationAbility: [...options.civilizationAbility],
      leaderAbility: [...options.leaderAbility],
      infrastructure: [...options.infrastructure],
      unit: [...options.unit],
    }
  }
  return cloned
}

function cloneCivBlitzKits(kits: Record<number, CivBlitzPartialKit>): Record<number, CivBlitzPartialKit> {
  const cloned: Record<number, CivBlitzPartialKit> = {}
  for (const [rawSeatIndex, kit] of Object.entries(kits)) {
    cloned[Number(rawSeatIndex)] = { ...kit }
  }
  return cloned
}

function isCompleteCivBlitzKit(kit: CivBlitzPartialKit | undefined): boolean {
  return !!kit && CIV_BLITZ_CATEGORIES.every(category => typeof kit[category] === 'string')
}

function addCivBlitzCategory(existing: CivBlitzComponentCategory[] | undefined, category: CivBlitzComponentCategory): CivBlitzComponentCategory[] {
  if (!existing) return [category]
  return existing.includes(category) ? existing : [...existing, category]
}

function sortCivBlitzCategoriesBySeat(categoriesBySeat: Record<number, CivBlitzComponentCategory[]>): Record<number, CivBlitzComponentCategory[]> {
  const sorted: Record<number, CivBlitzComponentCategory[]> = {}
  for (const [rawSeatIndex, categories] of Object.entries(categoriesBySeat)) {
    sorted[Number(rawSeatIndex)] = CIV_BLITZ_CATEGORIES.filter(category => categories.includes(category))
  }
  return sorted
}

function formatCivBlitzCategory(category: CivBlitzComponentCategory): string {
  switch (category) {
    case 'civilizationAbility':
      return 'civilization ability'
    case 'leaderAbility':
      return 'leader ability'
    case 'infrastructure':
      return 'infrastructure'
    case 'unit':
      return 'unit'
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string'
}

function normalizeDraftProcessOptions(options: boolean | DraftProcessOptions): { blindBans: boolean, random: RandomSource } {
  if (typeof options === 'boolean') {
    return {
      blindBans: options,
      random: Math.random,
    }
  }

  return {
    blindBans: options.blindBans === true,
    random: options.random ?? Math.random,
  }
}

// ── Internal Helpers ────────────────────────────────────────

function isSeatActive(step: DraftStep, seatIndex: number, totalSeats: number): boolean {
  if (step.seats === 'all') return seatIndex >= 0 && seatIndex < totalSeats
  return step.seats.includes(seatIndex)
}

function getActiveSeatCount(step: DraftStep, totalSeats: number): number {
  if (step.seats === 'all') return totalSeats
  return step.seats.length
}

function getActiveSeats(step: DraftStep, totalSeats: number): number[] {
  if (step.seats === 'all') return Array.from({ length: totalSeats }, (_, i) => i)
  return step.seats
}

function isBlindBanStep(step: DraftStep, blindBans: boolean): boolean {
  if (!blindBans || step.action !== 'ban') return false
  if (step.seats === 'all') return true
  return step.seats.length > 1
}

function normalizeCancelReason(
  state: DraftState,
  reason: DraftCancelReason,
): DraftCancelReason {
  if (state.status === 'waiting' && reason === 'scrub') return 'cancel'
  if (state.status !== 'waiting' && reason === 'cancel') return 'scrub'
  return reason
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
  const shouldRevealBlindBans = isBlindBanStep(step, blindBans)

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
    if (shouldRevealBlindBans) {
      const revealedBans = newBans.filter(b => b.stepIndex === state.currentStepIndex)
      events.push({ type: 'BLIND_BANS_REVEALED', bans: revealedBans })
    }

    const stateAfterBans: DraftState = {
      ...state,
      submissions: {},
      bans: newBans,
      availableCivIds: newAvailable,
      pendingBlindBans: [],
      blindPickReveal: null,
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
    dealtCivIds: null,
    dealtCivIdsBySeat: null,
    blindPickReveal: null,
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
        cancelReason: null,
        dealtCivIds: null,
        dealtCivIdsBySeat: null,
        blindPickReveal: null,
        civBlitz: state.civBlitz ? { ...state.civBlitz, submissions: {}, reveal: null } : state.civBlitz,
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
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
      blindPickReveal: null,
      civBlitz: state.civBlitz ? { ...state.civBlitz, submissions: {}, reveal: null } : state.civBlitz,
    },
    events: [...events, { type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

// ── Query Helpers ───────────────────────────────────────────

/** Get the current step, or null if draft is not active */
export function getCurrentStep(state: DraftState): DraftStep | null {
  if (state.status !== 'active') return null
  return state.steps[state.currentStepIndex] ?? null
}

/** Get which seats need to submit in the current step */
export function getPendingSeats(state: DraftState): number[] {
  const step = getCurrentStep(state)
  if (!step) return []
  if (step.reveal || step.count <= 0) return []

  const activeSeats = getActiveSeats(step, state.seats.length)
  return activeSeats.filter((seat) => {
    const submissions = state.submissions[seat]
    if (!submissions) return true
    return submissions.length < step.count
  })
}

export function isBlindPickStep(step: DraftStep | null | undefined): boolean {
  return step?.action === 'pick' && step.blind === true && step.reveal !== true
}

export function isBlindPickRevealStep(step: DraftStep | null | undefined): boolean {
  return step?.action === 'pick' && step.reveal === true
}

/** Get which seat this player may currently submit a pick for. */
export function getPickSeatForPlayer(state: DraftState, seatIndex: number): number | null {
  if (seatIndex < 0 || seatIndex >= state.seats.length) return null

  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick') return null
  if (isSeatPendingForStep(state, step, seatIndex)) return seatIndex
  if (step.blind || step.reveal) return null
  if (step.seats === 'all') return null

  const ownSeat = state.seats[seatIndex]
  if (!ownSeat || ownSeat.team == null) return null
  if (!isSeatTeamCaptain(state.seats, seatIndex)) return null

  const targetSeatIndex = step.seats.find((candidateSeatIndex) => {
    const targetSeat = state.seats[candidateSeatIndex]
    if (!targetSeat || targetSeat.team == null || targetSeat.team !== ownSeat.team) return false
    return isSeatPendingForStep(state, step, candidateSeatIndex)
  })

  return targetSeatIndex ?? null
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

function isSeatPendingForStep(state: DraftState, step: DraftStep, seatIndex: number): boolean {
  if (!isSeatActive(step, seatIndex, state.seats.length)) return false
  return (state.submissions[seatIndex]?.length ?? 0) < step.count
}

function processDoublePickFallbackTimeout(
  state: DraftState,
  step: DraftStep,
  timedOutSeats: number[],
): DraftResult | null {
  if (!isDoublePickStep(state, step)) return null
  if (timedOutSeats.length !== 1) return null

  const [seatIndex] = timedOutSeats
  if (seatIndex == null) return null

  const fallbackStep: DraftStep = {
    action: 'pick',
    seats: [seatIndex],
    count: 1,
    timer: step.fallbackTimer ?? step.timer,
    fallbackForStepIndex: state.currentStepIndex,
  }
  const nextStepIndex = state.currentStepIndex + 1

  return {
    state: {
      ...state,
      steps: [
        ...state.steps.slice(0, nextStepIndex),
        fallbackStep,
        ...state.steps.slice(nextStepIndex),
      ],
      currentStepIndex: nextStepIndex,
      submissions: {},
      dealtCivIds: null,
      dealtCivIdsBySeat: null,
    },
    events: [{ type: 'STEP_ADVANCED', stepIndex: nextStepIndex }],
  }
}

export function isDoublePickStep(state: DraftState, step: DraftStep): boolean {
  if (step.action !== 'pick') return false
  if (step.blind || step.reveal) return false
  if (step.seats === 'all' || step.seats.length !== 2) return false
  if (step.count !== 1 || step.fallbackForStepIndex != null) return false

  const [leftSeatIndex, rightSeatIndex] = step.seats
  if (leftSeatIndex == null || rightSeatIndex == null) return false
  const leftTeam = state.seats[leftSeatIndex]?.team
  const rightTeam = state.seats[rightSeatIndex]?.team
  return leftTeam != null && leftTeam === rightTeam
}

function isSeatTeamCaptain(seats: DraftSeat[], seatIndex: number): boolean {
  const team = seats[seatIndex]?.team
  if (team == null) return false

  for (let currentSeatIndex = 0; currentSeatIndex < seats.length; currentSeatIndex++) {
    if (seats[currentSeatIndex]?.team === team) return currentSeatIndex === seatIndex
  }

  return false
}
