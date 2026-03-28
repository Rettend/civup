import type { DraftState } from '@civup/game'
import { allFactionIds, createDraft, default2v2, getDraftFormat, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  canSendPickPreview,
  currentStep,
  currentStepDuration,
  getPreviewPickForSeat,
  hasSubmitted,
  initDraft,
  isMyTurn,
  phaseLabel,
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

function createRedDeathWaitingState() {
  return createDraft('draft-store-rd-test', getDraftFormat('rd-2p'), create2v2Seats(), allFactionIds, { dealOptionsSize: 2 })
}

function createActiveBanState() {
  const waiting = createWaitingState()
  return resolveDraftState(processDraftInput(waiting, { type: 'START' }))
}

function createActiveRedDeathState() {
  const waiting = createRedDeathWaitingState()
  return resolveDraftState(processDraftInput(waiting, { type: 'START' }))
}

describe('draft-store helpers', () => {
  test('phaseLabel returns WAITING before draft starts', () => {
    initDraft(createWaitingState(), 'live', 'a1', 0, null, null, { bans: {}, picks: {} })
    expect(phaseLabel()).toBe('WAITING')
    expect(currentStep()).toBeNull()
  })

  test('tracks active step label, duration, and turn ownership', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} })

    expect(phaseLabel()).toBe('BAN PHASE')
    expect(isMyTurn()).toBe(true)
    expect(currentStepDuration()).toBe(active.steps[0]!.timer ?? 0)

    initDraft(active, 'live', 'a1', null, null, null, { bans: {}, picks: {} })
    expect(isMyTurn()).toBe(false)
  })

  test('hasSubmitted flips true once seat reaches required submission count', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} })

    expect(hasSubmitted()).toBe(false)

    const withSubmission: DraftState = {
      ...active,
      submissions: {
        ...active.submissions,
        0: ['civ-1', 'civ-2', 'civ-3'],
      },
    }

    updateDraft(withSubmission, 'live', 'a1', [], null, null, { bans: {}, picks: {} })
    expect(hasSubmitted()).toBe(true)
  })

  test('phaseLabel uses cancelled wording for waiting cancel flow', () => {
    const waiting = createWaitingState()
    const cancelled = resolveDraftState(processDraftInput(waiting, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(cancelled, 'live', 'a1', 0, null, null, { bans: {}, picks: {} })
    expect(phaseLabel()).toBe('DRAFT CANCELLED')
  })

  test('phaseLabel uses scrub wording when active draft is cancelled', () => {
    const active = createActiveBanState()
    const scrubbed = resolveDraftState(processDraftInput(active, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(scrubbed, 'live', 'a1', 0, null, null, { bans: {}, picks: {} })
    expect(phaseLabel()).toBe('MATCH SCRUBBED')
  })

  test('stores preview picks alongside the draft state', () => {
    const active = resolveDraftState(processDraftInput(createActiveBanState(), { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true))
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: { 2: ['civ-9', 'civ-10'] } })

    expect(getPreviewPickForSeat(2)).toBe('civ-9')
  })

  test('team drafts still allow teammates to send pick previews', () => {
    const active = createActiveBanState()
    const pickState: DraftState = {
      ...active,
      currentStepIndex: 1,
    }

    initDraft(pickState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} })
    expect(canSendPickPreview()).toBe(true)
  })

  test('red death only allows the active picker to send pick previews', () => {
    const active = createActiveRedDeathState()
    const dealtState: DraftState = {
      ...active,
      dealtCivIds: allFactionIds.slice(0, 2),
    }

    initDraft(dealtState, 'live', 'a1', 0, null, null, { bans: {}, picks: {} })
    expect(canSendPickPreview()).toBe(true)

    initDraft(dealtState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} })
    expect(canSendPickPreview()).toBe(false)
  })
})
