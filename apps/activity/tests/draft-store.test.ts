import type { DraftState } from '@civup/game'
import { allFactionIds, createDraft, default2v2, default2v2BlindPick, default4v4, getDraftFormat, isDraftError, processDraftInput } from '@civup/game'
import { createEffect, createRoot, flush, snapshot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  canSendPickPreview,
  canSwapLeadersWith,
  currentStep,
  currentStepDuration,
  draftNow,
  draftStore,
  getOptimisticSeatPick,
  getPreviewPickForSeat,
  hasSubmitted,
  initDraft,
  isMyTurn,
  isSwapWindowOpen,
  phaseLabel,
  resetDraft,
  seatJustSwapped,
  setOptimisticSeatPick,
  syncDraftServerTime,
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

function createActiveBlindPickState(submissions: DraftState['submissions'] = {}): DraftState {
  const civPool = Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`)
  const waiting = createDraft('draft-store-blind-pick-test', default2v2BlindPick, create2v2Seats(), civPool)
  return {
    ...waiting,
    status: 'active',
    currentStepIndex: 1,
    submissions,
  }
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
  beforeEach(() => {
    resetDraft()
    flush()
  })

  afterEach(() => {
    resetDraft()
    flush()
  })

  test('tracks server time offset for draft countdowns', () => {
    try {
      syncDraftServerTime(112_000, 100_000)
      flush()
      expect(draftNow(130_000)).toBe(142_000)
    }
    finally {
      resetDraft()
    }
  })

  test('phaseLabel returns WAITING before draft starts', () => {
    initDraft(createWaitingState(), 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(phaseLabel()).toBe('WAITING')
    expect(currentStep()).toBeNull()
  })

  test('tracks active step label, duration, and turn ownership', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)

    flush()
    expect(phaseLabel()).toBe('BAN PHASE')
    expect(isMyTurn()).toBe(true)
    expect(currentStepDuration()).toBe(active.steps[0]!.timer ?? 0)

    initDraft(active, 'live', 'a1', null, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(isMyTurn()).toBe(false)
  })

  test('hasSubmitted flips true once seat reaches required submission count', () => {
    const active = createActiveBanState()
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)

    flush()
    expect(hasSubmitted()).toBe(false)

    const withSubmission: DraftState = {
      ...active,
      submissions: {
        ...active.submissions,
        0: ['civ-1', 'civ-2', 'civ-3'],
      },
    }

    updateDraft(withSubmission, 'live', 'a1', [], null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(hasSubmitted()).toBe(true)
  })

  test('phaseLabel uses cancelled wording for waiting cancel flow', () => {
    const waiting = createWaitingState()
    const cancelled = resolveDraftState(processDraftInput(waiting, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(cancelled, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(phaseLabel()).toBe('DRAFT CANCELLED')
  })

  test('phaseLabel uses scrub wording when active draft is cancelled', () => {
    const active = createActiveBanState()
    const scrubbed = resolveDraftState(processDraftInput(active, { type: 'CANCEL', reason: 'cancel' }))

    initDraft(scrubbed, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(phaseLabel()).toBe('MATCH SCRUBBED')
  })

  test('stores preview picks alongside the draft state', () => {
    const active = resolveDraftState(processDraftInput(createActiveBanState(), { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true))
    initDraft(active, 'live', 'a1', 0, null, null, { bans: {}, picks: { 2: ['civ-9', 'civ-10'] } }, null)

    flush()
    expect(getPreviewPickForSeat(2)).toBe('civ-9')
  })

  test('team drafts still allow teammates to send pick previews', () => {
    const active = createActiveBanState()
    const pickState: DraftState = {
      ...active,
      currentStepIndex: 1,
    }

    initDraft(pickState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(canSendPickPreview()).toBe(true)
  })

  test('blind pick allows previews until the seat submits', () => {
    initDraft(createActiveBlindPickState(), 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(canSendPickPreview()).toBe(true)

    initDraft(createActiveBlindPickState({ 0: ['civ-1'] }), 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(canSendPickPreview()).toBe(false)
  })

  test('red death only allows the active picker to send pick previews', () => {
    const active = createActiveRedDeathState()
    const dealtState: DraftState = {
      ...active,
      dealtCivIds: allFactionIds.slice(0, 2),
    }

    initDraft(dealtState, 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(canSendPickPreview()).toBe(true)

    initDraft(dealtState, 'live', 'a1', 2, null, null, { bans: {}, picks: {} }, null)
    flush()
    expect(canSendPickPreview()).toBe(false)
  })

  test('opens the swap window only for completed team drafts with swap state', () => {
    const complete = createCompleteTeamState()
    initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
      completedSwaps: [],
    })

    flush()
    expect(isSwapWindowOpen()).toBe(true)
    expect(canSwapLeadersWith(2)).toBe(true)
    expect(canSwapLeadersWith(1)).toBe(false)
  })

  test('opens the swap window for completed red death team drafts with swap state', () => {
    const complete = createCompleteRedDeathTeamState()
    initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
      completedSwaps: [],
    })

    flush()
    expect(isSwapWindowOpen()).toBe(true)
    expect(canSwapLeadersWith(2)).toBe(true)
    expect(canSwapLeadersWith(1)).toBe(false)
  })

  test('does not allow swapping with yourself or across teams', () => {
    const complete = createCompleteTeamState()
    initDraft(complete, 'live', 'a1', 2, null, Date.now(), { bans: {}, picks: {} }, {
      completedSwaps: [],
    })

    flush()
    expect(canSwapLeadersWith(2)).toBe(false)
    expect(canSwapLeadersWith(1)).toBe(false)
    expect(canSwapLeadersWith(0)).toBe(true)
  })

  test('allows teammate leader swaps after previous swaps completed', () => {
    const complete = createComplete4v4State()
    const now = Date.now()

    initDraft(complete, 'live', 'a2', 2, null, now, { bans: {}, picks: {} }, {
      completedSwaps: [{ fromSeat: 0, toSeat: 2 }],
    })

    flush()
    expect(canSwapLeadersWith(4)).toBe(true)
    expect(canSwapLeadersWith(6)).toBe(true)
  })

  test('full draft updates during the swap window update picks and flash changed seats', () => {
    const complete = createCompleteTeamState()
    const swapped: DraftState = {
      ...complete,
      picks: complete.picks.map((pick) => {
        if (pick.seatIndex === 0) return { ...pick, civId: complete.picks.find(current => current.seatIndex === 2)!.civId }
        if (pick.seatIndex === 2) return { ...pick, civId: complete.picks.find(current => current.seatIndex === 0)!.civId }
        return pick
      }),
    }

    try {
      initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
        completedSwaps: [],
      })

      updateDraft(swapped, 'live', 'a1', [], null, Date.now(), { bans: {}, picks: {} }, {
        completedSwaps: [{ fromSeat: 0, toSeat: 2 }],
      })

      flush()
      expect(seatJustSwapped(0)).toBe(true)
      expect(seatJustSwapped(2)).toBe(true)
      expect(canSwapLeadersWith(2)).toBe(true)
    }
    finally {
      resetDraft()
    }
  })

  test('full draft updates after swap window finalization hide swap actions', () => {
    const complete = createCompleteTeamState()

    try {
      initDraft(complete, 'live', 'a1', 0, null, Date.now(), { bans: {}, picks: {} }, {
        completedSwaps: [],
      })
      flush()
      expect(isSwapWindowOpen()).toBe(true)
      expect(canSwapLeadersWith(2)).toBe(true)

      updateDraft(complete, 'live', 'a1', [], null, Date.now(), { bans: {}, picks: {} }, null)

      flush()
      expect(isSwapWindowOpen()).toBe(false)
      expect(canSwapLeadersWith(2)).toBe(false)
      expect(seatJustSwapped(0)).toBe(false)
      expect(seatJustSwapped(2)).toBe(false)
    }
    finally {
      resetDraft()
    }
  })

  test('applies each server snapshot atomically and replaces optimistic picks', () => {
    const seen: { status: string | undefined, host: string | null, timer: number | null, previews: string[], optimistic: string | null }[] = []
    const dispose = createRoot(stop => {
      createEffect(
        () => ({
          status: draftStore.state?.status,
          host: draftStore.hostId,
          timer: draftStore.timerEndsAt,
          previews: [...(draftStore.previews.picks[0] ?? [])],
          optimistic: getOptimisticSeatPick(0),
        }),
        value => { seen.push(value) },
      )
      return stop
    })
    try {
      flush()
      const active = createActiveBlindPickState()
      initDraft(active, 'live', 'a1', 0, 1_000, null, { bans: {}, picks: {} }, null)
      setOptimisticSeatPick('civ-2')
      flush()
      expect(getOptimisticSeatPick(0)).toBe('__blind__')
      seen.length = 0

      updateDraft({ ...active, status: 'complete', picks: [{ seatIndex: 0, civId: 'civ-3', stepIndex: 1 }] }, 'beta', 'a2', [], null, 2_000, { bans: {}, picks: { 0: ['civ-3'] } }, null)
      flush()
      expect(seen).toEqual([{ status: 'complete', host: 'a2', timer: null, previews: ['civ-3'], optimistic: null }])
      expect(draftStore.leaderDataVersion).toBe('beta')
      expect(snapshot(draftStore.state)?.picks).toEqual([{ seatIndex: 0, civId: 'civ-3', stepIndex: 1 }])
    }
    finally { dispose() }
  })

  test('counts multiple init payloads before a flush and resets every session field', () => {
    initDraft(createWaitingState(), 'live', 'a1', 0, null, null, { bans: {}, picks: {} }, null)
    initDraft(createCompleteTeamState(), 'beta', 'a2', 2, 1_000, 500, { bans: { 0: ['civ-1'] }, picks: {} }, { completedSwaps: [] }, undefined, 'steam://example', true, true)
    flush()
    expect(draftStore.initVersion).toBe(2)
    resetDraft()
    flush()
    expect(draftStore.initVersion).toBe(0)
    expect(draftStore.state).toBeNull()
    expect(draftStore.hostId).toBeNull()
    expect(draftStore.seatIndex).toBeNull()
    expect(draftStore.timerEndsAt).toBeNull()
    expect(draftStore.completedAt).toBeNull()
    expect(draftStore.steamLobbyLink).toBeNull()
    expect(draftStore.permanentAlly).toBe(false)
    expect(draftStore.hiddenDraft).toBe(false)
    expect(snapshot(draftStore.previews)).toEqual({ bans: {}, picks: {} })
  })

  test('reset cancels a pending swap flash timer', () => {
    vi.useFakeTimers()
    const complete = createCompleteTeamState()
    initDraft(complete, 'live', 'a1', 0, null, 1_000, { bans: {}, picks: {} }, { completedSwaps: [] })
    updateDraft({ ...complete, picks: complete.picks.map(pick => Object.assign({}, pick, { civId: `${pick.civId}-swapped` })) }, 'live', 'a1', [], null, 1_000, { bans: {}, picks: {} }, { completedSwaps: [] })
    flush()
    expect(seatJustSwapped(0)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    resetDraft()
    flush()
    expect(vi.getTimerCount()).toBe(0)
    expect(seatJustSwapped(0)).toBe(false)
  })
})
