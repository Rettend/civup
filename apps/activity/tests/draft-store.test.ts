import type { DraftState } from '@civup/game'
import { createDraft, default2v2, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  currentStep,
  currentStepDuration,
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
    { playerId: 'team-a', displayName: 'Team A', team: 0 },
    { playerId: 'team-b', displayName: 'Team B', team: 1 },
  ]
}

function createWaitingState() {
  const civPool = Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`)
  return createDraft('draft-store-test', default2v2, create2v2Seats(), civPool)
}

function createActiveBanState() {
  const waiting = createWaitingState()
  return resolveDraftState(processDraftInput(waiting, { type: 'START' }))
}

describe('draft-store helpers', () => {
  test('phaseLabel returns WAITING before draft starts', () => {
    initDraft(createWaitingState(), 'team-a', 0, null, null)
    expect(phaseLabel()).toBe('WAITING')
    expect(currentStep()).toBeNull()
  })

  test('tracks active step label, duration, and turn ownership', () => {
    const active = createActiveBanState()
    initDraft(active, 'team-a', 0, null, null)

    expect(phaseLabel()).toBe('BAN PHASE 1')
    expect(isMyTurn()).toBe(true)
    expect(currentStepDuration()).toBe(active.steps[0]!.timer ?? 0)

    initDraft(active, 'team-a', null, null, null)
    expect(isMyTurn()).toBe(false)
  })

  test('hasSubmitted flips true once seat reaches required submission count', () => {
    const active = createActiveBanState()
    initDraft(active, 'team-a', 0, null, null)

    expect(hasSubmitted()).toBe(false)

    const withSubmission: DraftState = {
      ...active,
      submissions: {
        ...active.submissions,
        0: ['civ-1', 'civ-2', 'civ-3'],
      },
    }

    updateDraft(withSubmission, 'team-a', [], null, null)
    expect(hasSubmitted()).toBe(true)
  })

  test('phaseLabel uses cancelled wording for waiting cancel flow', () => {
    const waiting = createWaitingState()
    const cancelled = resolveDraftState(processDraftInput(waiting, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(cancelled, 'team-a', 0, null, null)
    expect(phaseLabel()).toBe('DRAFT CANCELLED')
  })

  test('phaseLabel uses scrub wording when active draft is cancelled', () => {
    const active = createActiveBanState()
    const scrubbed = resolveDraftState(processDraftInput(active, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(scrubbed, 'team-a', 0, null, null)
    expect(phaseLabel()).toBe('MATCH SCRUBBED')
  })
})
