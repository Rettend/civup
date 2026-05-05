import type { DraftSeat } from '@civup/game'
import { allLeaderIds, createDraft, draftFormatMap, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { applyDraftResultCommand, applyLeaderSwapCommand, createRoomRecord, finalizeCompletedDraftCommand } from '../../src/session-runtime/draft-room-domain.ts'
import { EMPTY_STORED_MAP_VOTE_STATE } from '../../src/session-runtime/map-vote-room-state.ts'

describe('draft room domain', () => {
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
