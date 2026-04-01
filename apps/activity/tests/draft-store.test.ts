import type { DraftState } from '@civup/game'
import { allFactionIds, createDraft, default2v2, default4v4, getDraftFormat, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  canRequestSwapWith,
  canSendPickPreview,
  currentStep,
  currentStepDuration,
  getPreviewPickForSeat,
  hasSubmitted,
  initDraft,
  isMyTurn,
  isSwapWindowOpen,
  phaseLabel,
  seatHasIncomingSwap,
  updateDraft,
} from '../src/client/stores/draft-store'

function resolveDraftState(result: ReturnType<typeof processDraftInput>): DraftState {
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

function create2v2Seats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
  ]
}

function createWaitingState() {
  const civPool = Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`)
  return createDraft('draft-store-test', default2v2, create2v2Seats(), civPool)
}

function create4v4Seats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
    { playerId: 'a3', displayName: 'A3', team: 0 },
    { playerId: 'b3', displayName: 'B3', team: 1 },
    { playerId: 'a4', displayName: 'A4', team: 0 },
    { playerId: 'b4', displayName: 'B4', team: 1 },
  ]
}

function create4v4WaitingState() {
  const civPool = Array.from({ length: 50 }, (_, i) => `civ-${i + 1}`)
  return createDraft('draft-store-4v4-test', default4v4, create4v4Seats(), civPool)
}

function createRedDeathWaitingState() {
  return createDraft('draft-store-rd-test', getDraftFormat('2v2', { redDeath: true }), create2v2Seats(), allFactionIds, { dealOptionsSize: 2 })
}

function createActiveBanState() {
  const waiting = createWaitingState()
  return resolveDraftState(processDraftInput(waiting, { type: 'START' }))
}

function createActiveRedDeathState() {
  const waiting = createRedDeathWaitingState()
  return resolveDraftState(processDraftInput(waiting, { type: 'START' }))
}

function createCompleteTeamState(): DraftState {
  const waiting = createWaitingState()
  return {
    ...waiting,
    status: 'complete',
    currentStepIndex: waiting.steps.length,
    picks: [
      { civId: 'civ-10', seatIndex: 0, stepIndex: 1 },
      { civId: 'civ-20', seatIndex: 1, stepIndex: 2 },
      { civId: 'civ-11', seatIndex: 2, stepIndex: 4 },
      { civId: 'civ-21', seatIndex: 3, stepIndex: 3 },
    ],
  }
}

function createCompleteRedDeathTeamState(): DraftState {
  const waiting = createRedDeathWaitingState()
  return {
    ...waiting,
    status: 'complete',
    currentStepIndex: waiting.steps.length,
    dealtCivIds: null,
    picks: [
      { civId: allFactionIds[0] ?? 'rd-faction-1', seatIndex: 0, stepIndex: 0 },
      { civId: allFactionIds[1] ?? 'rd-faction-2', seatIndex: 1, stepIndex: 1 },
      { civId: allFactionIds[2] ?? 'rd-faction-3', seatIndex: 2, stepIndex: 2 },
      { civId: allFactionIds[3] ?? 'rd-faction-4', seatIndex: 3, stepIndex: 3 },
    ],
  }
}

function createComplete4v4State(): DraftState {
  const waiting = create4v4WaitingState()
  return {
    ...waiting,
    status: 'complete',
    currentStepIndex: waiting.steps.length,
    picks: [
      { civId: 'civ-10', seatIndex: 0, stepIndex: 1 },
      { civId: 'civ-20', seatIndex: 1, stepIndex: 2 },
      { civId: 'civ-11', seatIndex: 2, stepIndex: 4 },
      { civId: 'civ-21', seatIndex: 3, stepIndex: 3 },
      { civId: 'civ-12', seatIndex: 4, stepIndex: 5 },
      { civId: 'civ-22', seatIndex: 5, stepIndex: 6 },
      { civId: 'civ-13', seatIndex: 6, stepIndex: 8 },
      { civId: 'civ-23', seatIndex: 7, stepIndex: 7 },
    ],
  }
}

describe('draft-store helpers', () => {
  test('phaseLabel returns WAITING before draft starts', () => {
    initDraft(createWaitingState(), 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    expect(phaseLabel()).toBe('WAITING')
    expect(currentStep()).toBeNull()
  })

  test('tracks active step label, duration, and turn ownership', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)

    expect(phaseLabel()).toBe('BAN PHASE')
    expect(isMyTurn()).toBe(true)
    expect(currentStepDuration()).toBe(active.steps[0]!.timer ?? 0)

    initDraft(active, 'live', 'a1', null, null, null, { bans: {}, picks: {} }, null)
    expect(isMyTurn()).toBe(false)
  })

  test('hasSubmitted flips true once seat reaches required submission count', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)

    expect(hasSubmitted()).toBe(false)

    const withSubmission: DraftState = {
      ...active,
      submissions: {
        ...active.submissions,
        0: ['civ-1', 'civ-2', 'civ-3'],
      },
    }

    updateDraft(withSubmission, 'live', 'a1', [], null, null, { bans: {}, picks: {} }, null)
    expect(hasSubmitted()).toBe(true)
  })

  test('phaseLabel uses cancelled wording for waiting cancel flow', () => {
    const waiting = createWaitingState()
    const cancelled = resolveDraftState(processDraftInput(waiting, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(cancelled, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    expect(phaseLabel()).toBe('DRAFT CANCELLED')
  })

  test('phaseLabel uses scrub wording when active draft is cancelled', () => {
    const active = createActiveBanState()
    const scrubbed = resolveDraftState(processDraftInput(active, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(scrubbed, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    expect(phaseLabel()).toBe('MATCH SCRUBBED')
  })

  test('stores preview picks alongside the draft state', () => {
    const active = resolveDraftState(processDraftInput(createActiveBanState(), { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true))
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: { 2: ['civ-9', 'civ-10'] } }, null)

    expect(getPreviewPickForSeat(2)).toBe('civ-9')
  })

  test('team drafts still allow teammates to send pick previews', () => {
    const active = createActiveBanState()
    const pickState: DraftState = {
      ...active,
      currentStepIndex: 1,
    }

    initDraft(pickState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} }, null)
    expect(canSendPickPreview()).toBe(true)
  })

  test('red death only allows the active picker to send pick previews', () => {
    const active = createActiveRedDeathState()
    const dealtState: DraftState = {
      ...active,
      dealtCivIds: allFactionIds.slice(0, 2),
    }

    initDraft(dealtState, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    expect(canSendPickPreview()).toBe(true)

    initDraft(dealtState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} }, null)
    expect(canSendPickPreview()).toBe(false)
  })

  test('opens the swap window only for completed team drafts with swap state', () => {
    const complete = createCompleteTeamState()
    initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
      pendingSwaps: [],
      completedSwaps: [],
    })

    expect(isSwapWindowOpen()).toBe(true)
    expect(canRequestSwapWith(2)).toBe(true)
    expect(canRequestSwapWith(1)).toBe(false)
  })

  test('opens the swap window for completed red death team drafts with swap state', () => {
    const complete = createCompleteRedDeathTeamState()
    initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
      pendingSwaps: [],
      completedSwaps: [],
    })

    expect(isSwapWindowOpen()).toBe(true)
    expect(canRequestSwapWith(2)).toBe(true)
    expect(canRequestSwapWith(1)).toBe(false)
  })

  test('tracks incoming swap requests on the requested seat', () => {
    const complete = createCompleteTeamState()
    initDraft(complete, 'live', 'a1', 2, null, Date.now(), { bans: {}, picks: {} }, {
      pendingSwaps: [{ fromSeat: 0, toSeat: 2, expiresAt: Date.now() + 30_000 }],
      completedSwaps: [],
    })

    expect(seatHasIncomingSwap(2)).toBe(true)
    expect(canRequestSwapWith(0)).toBe(false)
  })

  test('allows independent swaps while limiting one incoming and one outgoing per seat', () => {
    const complete = createComplete4v4State()
    const now = Date.now()

    initDraft(complete, 'live', 'a2', 2, null, now, { bans: {}, picks: {} }, {
      pendingSwaps: [
        { fromSeat: 0, toSeat: 2, expiresAt: now + 30_000 },
        { fromSeat: 1, toSeat: 3, expiresAt: now + 30_000 },
      ],
      completedSwaps: [],
    })

    expect(seatHasIncomingSwap(2)).toBe(true)
    expect(canRequestSwapWith(4)).toBe(true)
    expect(canRequestSwapWith(0)).toBe(false)

    initDraft(complete, 'live', 'a1', 0, null, now, { bans: {}, picks: {} }, {
      pendingSwaps: [
        { fromSeat: 0, toSeat: 2, expiresAt: now + 30_000 },
        { fromSeat: 1, toSeat: 3, expiresAt: now + 30_000 },
      ],
      completedSwaps: [],
    })

    expect(canRequestSwapWith(4)).toBe(false)

    initDraft(complete, 'live', 'a3', 4, null, now, { bans: {}, picks: {} }, {
      pendingSwaps: [
        { fromSeat: 0, toSeat: 2, expiresAt: now + 30_000 },
        { fromSeat: 1, toSeat: 3, expiresAt: now + 30_000 },
      ],
      completedSwaps: [],
    })

    expect(canRequestSwapWith(6)).toBe(true)
  })
})
