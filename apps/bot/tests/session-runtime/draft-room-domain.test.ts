import type { DraftInput, DraftSeat, DraftState } from '@civup/game'
import { allLeaderIds, createDraft, draftFormatMap, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { applyDraftResultCommand, applyLeaderSwapCommand, createRoomRecord, finalizeCompletedDraftCommand, normalizeStoredRoomRecord } from '../../src/session-runtime/draft-room-domain.ts'
import { EMPTY_STORED_MAP_VOTE_STATE } from '../../src/session-runtime/map-vote-room-state.ts'

describe('draft room domain', () => {
  test('tracks double-pick fallback metrics through room transitions', () => {
    const seats: DraftSeat[] = [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ]
    const format = draftFormatMap.get('default-2v2')
    expect(format).toBeDefined()
    if (!format) return

    let state = createDraft('match-double-metrics', format, seats, allLeaderIds.slice(0, 24))
    state = applyDraftInput(state, { type: 'START' }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: allLeaderIds.slice(0, 3) }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: allLeaderIds.slice(3, 6) }, format.blindBans)
    state = applyDraftInput(state, { type: 'PICK', seatIndex: 0, civId: allLeaderIds[6]! }, format.blindBans)
    state = applyDraftInput(state, { type: 'PICK', seatIndex: 1, civId: allLeaderIds[7]! }, format.blindBans)

    const room = createRoomRecord({
      matchId: 'match-double-metrics',
      hostId: 'a1',
      formatId: 'default-2v2',
      seats,
      civPool: allLeaderIds.slice(0, 24),
    }, state, EMPTY_STORED_MAP_VOTE_STATE)

    const timedOut = processDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
    expect(isDraftError(timedOut)).toBe(false)
    if (isDraftError(timedOut)) return

    const fallbackTransition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: timedOut.state,
      events: timedOut.events,
      now: 1_000,
    })

    expect(fallbackTransition.room.doublePickMetrics).toEqual({
      groups: 1,
      fallbackStarted: 1,
      fallbackResolved: 0,
      bothMissedTimeouts: 0,
      fallbackTimeouts: 0,
    })

    const fallbackPick = processDraftInput(timedOut.state, { type: 'PICK', seatIndex: 3, civId: allLeaderIds[8]! }, format.blindBans)
    expect(isDraftError(fallbackPick)).toBe(false)
    if (isDraftError(fallbackPick)) return

    const resolvedTransition = applyDraftResultCommand(fallbackTransition.room, {
      type: 'apply-draft-result',
      nextState: fallbackPick.state,
      events: fallbackPick.events,
      now: 2_000,
    })

    expect(resolvedTransition.room.doublePickMetrics).toEqual({
      groups: 1,
      fallbackStarted: 1,
      fallbackResolved: 1,
      bothMissedTimeouts: 0,
      fallbackTimeouts: 0,
    })
  })

  test('includes double-pick timeout metrics in cancellation lifecycle payloads', () => {
    const seats: DraftSeat[] = [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ]
    const format = draftFormatMap.get('default-2v2')
    expect(format).toBeDefined()
    if (!format) return

    let state = createDraft('match-double-timeout', format, seats, allLeaderIds.slice(0, 24))
    state = applyDraftInput(state, { type: 'START' }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: allLeaderIds.slice(0, 3) }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: allLeaderIds.slice(3, 6) }, format.blindBans)
    state = applyDraftInput(state, { type: 'PICK', seatIndex: 0, civId: allLeaderIds[6]! }, format.blindBans)

    const room = createRoomRecord({
      matchId: 'match-double-timeout',
      hostId: 'a1',
      formatId: 'default-2v2',
      seats,
      civPool: allLeaderIds.slice(0, 24),
    }, state, EMPTY_STORED_MAP_VOTE_STATE)
    const timedOut = processDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
    expect(isDraftError(timedOut)).toBe(false)
    if (isDraftError(timedOut)) return

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: timedOut.state,
      events: timedOut.events,
      now: 1_000,
    })

    expect(transition.room.doublePickMetrics).toEqual({
      groups: 1,
      fallbackStarted: 0,
      fallbackResolved: 0,
      bothMissedTimeouts: 1,
      fallbackTimeouts: 0,
    })
    expect(transition.effects.find(effect => effect.type === 'sync-draft-lifecycle')).toMatchObject({
      type: 'sync-draft-lifecycle',
      payload: {
        doublePickMetrics: transition.room.doublePickMetrics,
      },
    })
  })

  test('preserves double-pick metrics in repeat draft snapshots', () => {
    const seats: DraftSeat[] = [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ]
    const format = draftFormatMap.get('default-2v2')
    expect(format).toBeDefined()
    if (!format) return

    let state = createDraft('match-double-repeat', format, seats, allLeaderIds.slice(0, 24))
    state = applyDraftInput(state, { type: 'START' }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: allLeaderIds.slice(0, 3) }, format.blindBans)
    state = applyDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: allLeaderIds.slice(3, 6) }, format.blindBans)
    state = applyDraftInput(state, { type: 'PICK', seatIndex: 0, civId: allLeaderIds[6]! }, format.blindBans)
    state = applyDraftInput(state, { type: 'PICK', seatIndex: 1, civId: allLeaderIds[7]! }, format.blindBans)

    const room = createRoomRecord({
      matchId: 'match-double-repeat',
      hostId: 'a1',
      formatId: 'default-2v2',
      seats,
      civPool: allLeaderIds.slice(0, 24),
    }, state, EMPTY_STORED_MAP_VOTE_STATE)

    const fallback = processDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
    expect(isDraftError(fallback)).toBe(false)
    if (isDraftError(fallback)) return

    const fallbackTransition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: fallback.state,
      events: fallback.events,
      now: 1_000,
    })

    const fallbackTimeout = processDraftInput(fallbackTransition.room.state, { type: 'TIMEOUT' }, format.blindBans)
    expect(isDraftError(fallbackTimeout)).toBe(false)
    if (isDraftError(fallbackTimeout)) return

    const cancelledTransition = applyDraftResultCommand(fallbackTransition.room, {
      type: 'apply-draft-result',
      nextState: fallbackTimeout.state,
      events: fallbackTimeout.events,
      now: 2_000,
    })
    const expectedMetrics = {
      groups: 1,
      fallbackStarted: 1,
      fallbackResolved: 0,
      bothMissedTimeouts: 0,
      fallbackTimeouts: 1,
    }

    expect(cancelledTransition.room.doublePickMetrics).toEqual(expectedMetrics)
    expect(cancelledTransition.room.repeatDraft?.doublePickMetrics).toEqual(expectedMetrics)
    expect(normalizeStoredRoomRecord(cancelledTransition.room)?.repeatDraft?.doublePickMetrics).toEqual(expectedMetrics)

    const legacyRoom = {
      ...cancelledTransition.room,
      repeatDraft: cancelledTransition.room.repeatDraft
        ? { ...cancelledTransition.room.repeatDraft, doublePickMetrics: undefined }
        : null,
    }
    expect(normalizeStoredRoomRecord(legacyRoom)?.repeatDraft?.doublePickMetrics).toEqual(expectedMetrics)
  })

  test('applying a leader swap broadcasts the updated room without syncing lifecycle projection', () => {
    const seats: DraftSeat[] = [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ]
    const format = draftFormatMap.get('default-2v2')
    expect(format).toBeDefined()
    if (!format) return

    const state = {
      ...createDraft('match-swap', format, seats, allLeaderIds.slice(0, 12)),
      status: 'complete' as const,
      currentStepIndex: format.getSteps(seats.length).length,
      picks: seats.map((_, seatIndex) => ({
        civId: allLeaderIds[seatIndex] ?? allLeaderIds[0]!,
        seatIndex,
        stepIndex: seatIndex,
      })),
    }
    const swappedPicks = state.picks.map((pick) => {
      if (pick.seatIndex === 0) return { ...pick, civId: state.picks[2]!.civId }
      if (pick.seatIndex === 2) return { ...pick, civId: state.picks[0]!.civId }
      return pick
    })
    const room = createRoomRecord({
      matchId: 'match-swap',
      hostId: 'a1',
      formatId: 'default-2v2',
      seats,
      civPool: allLeaderIds.slice(0, 12),
    }, state, EMPTY_STORED_MAP_VOTE_STATE, {
      completedAt: 100,
      swapWindowOpen: true,
      swapState: { completedSwaps: [] },
      swapSafetyEndsAt: 1_000,
    })

    const transition = applyLeaderSwapCommand(room, {
      type: 'apply-leader-swap',
      nextState: { ...state, picks: swappedPicks },
      swapState: { completedSwaps: [{ fromSeat: 0, toSeat: 2 }] },
    })

    expect(transition.room.state.picks).toEqual(swappedPicks)
    expect(transition.room.swapState).toEqual({ completedSwaps: [{ fromSeat: 0, toSeat: 2 }] })
    expect(transition.effects.map(effect => effect.type)).toEqual([
      'schedule-swap-alarm',
      'broadcast-update',
    ])
  })

  test('persists draft completion before broadcasting an open swap window', () => {
    const seats: DraftSeat[] = [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ]
    const format = draftFormatMap.get('default-2v2')
    expect(format).toBeDefined()
    if (!format) return

    const started = applyDraftInput(createDraft('match-complete-swap', format, seats, allLeaderIds.slice(0, 12)), { type: 'START' }, format.blindBans)
    const completeState: DraftState = {
      ...started,
      status: 'complete',
      currentStepIndex: started.steps.length,
      picks: seats.map((_, seatIndex) => ({
        civId: allLeaderIds[seatIndex]!,
        seatIndex,
        stepIndex: seatIndex,
      })),
    }
    const room = createRoomRecord({
      matchId: 'match-complete-swap',
      hostId: 'a1',
      formatId: 'default-2v2',
      seats,
      civPool: allLeaderIds.slice(0, 12),
    }, started, EMPTY_STORED_MAP_VOTE_STATE)

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: completeState,
      events: [],
      now: 1_000,
    })
    const effectTypes = transition.effects.map(effect => effect.type)

    expect(transition.room.swapWindowOpen).toBe(true)
    expect(effectTypes.indexOf('sync-draft-lifecycle')).toBeLessThan(effectTypes.indexOf('broadcast-update'))
  })

  test('finalizing a completed swap window syncs lifecycle and broadcasts cleared swap state before closing selected-session sockets', () => {
    const seats: DraftSeat[] = [
      { playerId: 'p1', displayName: 'Player One' },
      { playerId: 'p2', displayName: 'Player Two' },
    ]
    const format = draftFormatMap.get('default-1v1')
    expect(format).toBeDefined()
    if (!format) return

    const state = {
      ...createDraft('match-1', format, seats, allLeaderIds.slice(0, 8)),
      status: 'complete' as const,
      picks: seats.map((_, seatIndex) => ({
        civId: allLeaderIds[seatIndex] ?? allLeaderIds[0]!,
        seatIndex,
        stepIndex: seatIndex,
      })),
    }
    const room = createRoomRecord({
      matchId: 'match-1',
      hostId: 'p1',
      formatId: 'default-1v1',
      leaderDataVersion: 'beta',
      seats,
      civPool: allLeaderIds.slice(0, 8),
    }, state, EMPTY_STORED_MAP_VOTE_STATE, {
      completedAt: 100,
      swapWindowOpen: true,
      swapState: { completedSwaps: [] },
      swapSafetyEndsAt: 1_000,
      timerEndsAt: 1_000,
      alarmStepIndex: 2,
    })

    const transition = finalizeCompletedDraftCommand(room, {
      type: 'finalize-completed-draft',
      now: 200,
    })

    expect(transition.response).toBe(true)
    expect(transition.room.swapWindowOpen).toBe(false)
    expect(transition.room.swapState).toBeNull()
    expect(transition.room.swapSafetyEndsAt).toBeNull()
    expect(transition.room.timerEndsAt).toBeNull()
    expect(transition.room.alarmStepIndex).toBe(-1)
    expect(transition.effects.map(effect => effect.type)).toEqual([
      'delete-alarm',
      'sync-draft-lifecycle',
      'broadcast-update',
      'close-connections',
    ])
    expect(transition.effects[1]).toMatchObject({
      type: 'sync-draft-lifecycle',
      delivery: 'await',
      payload: expect.objectContaining({
        eventKind: 'DraftFinalized',
        finalized: true,
      }),
    })
  })

  test('completing a draft without swaps releases live membership before closing sockets', () => {
    const seats: DraftSeat[] = [
      { playerId: 'p1', displayName: 'Player One' },
      { playerId: 'p2', displayName: 'Player Two' },
    ]
    const format = draftFormatMap.get('default-1v1')
    expect(format).toBeDefined()
    if (!format) return

    const started = processDraftInput(createDraft('match-1', format, seats, allLeaderIds.slice(0, 8)), { type: 'START' })
    expect(isDraftError(started)).toBe(false)
    if (isDraftError(started)) return

    const completeState = {
      ...started.state,
      status: 'complete' as const,
      currentStepIndex: started.state.steps.length,
      picks: seats.map((_, seatIndex) => ({
        civId: allLeaderIds[seatIndex] ?? allLeaderIds[0]!,
        seatIndex,
        stepIndex: seatIndex,
      })),
    }
    const room = createRoomRecord({
      matchId: 'match-1',
      hostId: 'p1',
      formatId: 'default-1v1',
      leaderDataVersion: 'beta',
      seats,
      civPool: allLeaderIds.slice(0, 8),
    }, started.state, {
      enabled: true,
      phase: 'voting',
      endsAt: 1_000,
      selections: {},
      confirmations: {},
      revealedVotes: null,
      result: null,
    }, {
      timerEndsAt: 1_000,
      alarmStepIndex: 0,
    })

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: completeState,
      events: [],
      now: 200,
    })

    expect(transition.effects.map(effect => effect.type)).toEqual([
      'delete-alarm',
      'sync-draft-lifecycle',
      'broadcast-update',
      'close-connections',
    ])
    expect(transition.effects[1]).toMatchObject({
      type: 'sync-draft-lifecycle',
      delivery: 'await',
      payload: expect.objectContaining({
        eventKind: 'DraftCompleted',
        leaderDataVersion: 'beta',
      }),
    })
  })

  test('revert cancellation syncs the reopened lobby before closing selected-session sockets', () => {
    const seats: DraftSeat[] = [
      { playerId: 'p1', displayName: 'Player One' },
      { playerId: 'p2', displayName: 'Player Two' },
    ]
    const format = draftFormatMap.get('default-1v1')
    expect(format).toBeDefined()
    if (!format) return

    const started = processDraftInput(createDraft('match-1', format, seats, allLeaderIds.slice(0, 8)), { type: 'START' })
    expect(isDraftError(started)).toBe(false)
    if (isDraftError(started)) return

    const cancelled = processDraftInput(started.state, { type: 'CANCEL', reason: 'revert' })
    expect(isDraftError(cancelled)).toBe(false)
    if (isDraftError(cancelled)) return

    const room = createRoomRecord({
      matchId: 'match-1',
      hostId: 'p1',
      formatId: 'default-1v1',
      seats,
      civPool: allLeaderIds.slice(0, 8),
    }, started.state, EMPTY_STORED_MAP_VOTE_STATE, {
      timerEndsAt: 1_000,
      alarmStepIndex: 0,
    })

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: cancelled.state,
      events: cancelled.events,
      now: 200,
    })

    expect(transition.effects.map(effect => effect.type)).toEqual([
      'delete-alarm',
      'sync-draft-lifecycle',
      'broadcast-update',
      'close-connections',
    ])
    expect(transition.effects[1]).toMatchObject({
      type: 'sync-draft-lifecycle',
      delivery: 'await',
      payload: expect.objectContaining({
        eventKind: 'DraftCancelled',
        reason: 'revert',
      }),
    })
    expect(transition.room.mapVote).toEqual(EMPTY_STORED_MAP_VOTE_STATE)
  })
})

function applyDraftInput(state: DraftState, input: DraftInput, blindBans: boolean): DraftState {
  const result = processDraftInput(state, input, blindBans)
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}
