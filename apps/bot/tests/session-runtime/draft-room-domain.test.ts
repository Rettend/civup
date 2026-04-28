import type { DraftSeat } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { allLeaderIds, createDraft, draftFormatMap, isDraftError, processDraftInput } from '@civup/game'
import { applyDraftResultCommand, createRoomRecord, finalizeCompletedDraftCommand } from '../../src/session-runtime/draft-room-domain.ts'
import { EMPTY_STORED_MAP_VOTE_STATE } from '../../src/session-runtime/map-vote-room-state.ts'

describe('draft room domain', () => {
  test('finalizing a completed swap window syncs lifecycle before closing selected-session sockets', () => {
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
      swapState: { pendingSwaps: [], completedSwaps: [] },
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
    }, started.state, EMPTY_STORED_MAP_VOTE_STATE, {
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
  })
})
