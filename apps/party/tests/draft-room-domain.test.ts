import type { DraftState, PendingLeaderSwapRequest, RoomConfig } from '@civup/game'
import type { StoredMapVoteState } from '../src/map-vote-room-state.ts'
import {
  MAP_VOTE_REVEAL_DURATION_MS,
  createDraft,
  default1v1,
  default2v2,
  processDraftInput,
} from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  applyDraftResultCommand,
  confirmMapVoteCommand,
  createRoomRecord,
  finalizeCompletedDraftCommand,
} from '../src/draft-room-domain.ts'
import { buildRandomDraftResult } from '../src/random-draft.ts'

function createDuelSeats() {
  return [
    { playerId: 'a1', displayName: 'A1' },
    { playerId: 'b1', displayName: 'B1' },
  ]
}

function create2v2Seats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
  ]
}

function createConfig(state: DraftState, overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    matchId: state.matchId,
    hostId: state.seats[0]?.playerId ?? 'host',
    formatId: state.formatId,
    seats: state.seats,
    civPool: state.availableCivIds,
    ...overrides,
  }
}

function createCivPool(size = 16) {
  return Array.from({ length: size }, (_, index) => `civ-${index + 1}`)
}

function resolveState(result: ReturnType<typeof processDraftInput>): DraftState {
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result.state
}

describe('draft room domain transitions', () => {
  test('applyDraftResultCommand opens a swap window for completed team drafts', () => {
    const waitingState = createDraft('match-room-complete', default2v2, create2v2Seats(), createCivPool())
    const config = createConfig(waitingState)
    const room = createRoomRecord(config, waitingState, disabledMapVote())
    const result = buildRandomDraftResult(waitingState)

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: result.state,
      events: result.events,
      now: 123_456,
    })

    expect(transition.room.state.status).toBe('complete')
    expect(transition.room.swapWindowOpen).toBe(true)
    expect(transition.room.swapState?.pendingSwaps).toEqual([])
    expect(transition.room.completedAt).toBe(123_456)
    expect(transition.effects).toContainEqual({ type: 'schedule-swap-alarm' })
    expect(transition.effects).toContainEqual({
      type: 'notify-draft-complete',
      completedAt: 123_456,
      delivery: 'await',
    })
  })

  test('applyDraftResultCommand clears swap state when a draft is cancelled', () => {
    const waitingState = createDraft('match-room-cancel', default1v1, createDuelSeats(), createCivPool())
    const startedState = resolveState(processDraftInput(waitingState, { type: 'START' }, default1v1.blindBans))
    const cancelled = processDraftInput(startedState, { type: 'CANCEL', reason: 'cancel' }, default1v1.blindBans)
    if ('error' in cancelled) {
      throw new Error(cancelled.error)
    }

    const room = createRoomRecord(createConfig(startedState), startedState, disabledMapVote(), {
      swapWindowOpen: true,
      swapState: {
        pendingSwaps: [{ fromSeat: 0, toSeat: 1, expiresAt: 50_000 }],
        completedSwaps: [],
      },
      swapDisconnectFinalizeAt: 40_000,
      swapSafetyEndsAt: 60_000,
      timerEndsAt: 35_000,
      alarmStepIndex: 0,
    })

    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: cancelled.state,
      events: cancelled.events,
      now: 222_000,
    })

    expect(transition.room.state.status).toBe('cancelled')
    expect(transition.room.swapWindowOpen).toBe(false)
    expect(transition.room.swapState).toBeNull()
    expect(transition.room.timerEndsAt).toBeNull()
    expect(transition.room.cancelledAt).toBe(222_000)
    expect(transition.effects).toContainEqual({ type: 'delete-alarm' })
    expect(transition.effects).toContainEqual({ type: 'close-connections', reason: 'Draft closed' })
    expect(transition.effects).toContainEqual({ type: 'notify-draft-cancelled', cancelledAt: 222_000 })
  })

  test('confirmMapVoteCommand moves the final confirmation straight into reveal', () => {
    const state = createDraft('match-room-map-vote', default1v1, createDuelSeats(), createCivPool())
    const config = createConfig(state, { mapVoteEnabled: true })
    const mapVote: StoredMapVoteState = {
      enabled: true,
      phase: 'voting',
      endsAt: 10_000,
      selections: {
        0: { mapTypes: ['standard'], mapScripts: ['continents'] },
        1: { mapTypes: ['east-vs-west'], mapScripts: ['lakes'] },
      },
      confirmations: {
        0: true,
        1: false,
      },
      revealedVotes: null,
      result: null,
    }
    const room = createRoomRecord(config, state, mapVote)

    const transition = confirmMapVoteCommand(room, {
      type: 'confirm-map-vote',
      state,
      seatIndex: 1,
      now: 33_000,
    })

    expect(transition.response).toBe('ok')
    expect(transition.room.mapVote.phase).toBe('reveal')
    expect(transition.room.mapVote.endsAt).toBe(33_000 + MAP_VOTE_REVEAL_DURATION_MS)
    expect(transition.room.mapVote.revealedVotes).toHaveLength(2)
    expect(transition.effects).toContainEqual({ type: 'set-alarm', at: 33_000 + MAP_VOTE_REVEAL_DURATION_MS })
    expect(transition.effects).toContainEqual({ type: 'broadcast-update', events: [] })
  })

  test('finalizeCompletedDraftCommand closes the swap window and emits a finalized webhook effect', () => {
    const waitingState = createDraft('match-room-finalize', default2v2, create2v2Seats(), createCivPool())
    const result = buildRandomDraftResult(waitingState)
    const room = createRoomRecord(createConfig(result.state), result.state, disabledMapVote(), {
      completedAt: 11_000,
      swapWindowOpen: true,
      swapState: {
        pendingSwaps: [],
        completedSwaps: [{ fromSeat: 0, toSeat: 1 } satisfies PendingLeaderSwapRequest],
      },
      swapSafetyEndsAt: 22_000,
    })

    const transition = finalizeCompletedDraftCommand(room, {
      type: 'finalize-completed-draft',
      now: 44_000,
    })

    expect(transition.response).toBe(true)
    expect(transition.room.swapWindowOpen).toBe(false)
    expect(transition.room.swapState).toBeNull()
    expect(transition.effects).toContainEqual({ type: 'delete-alarm' })
    expect(transition.effects).toContainEqual({ type: 'close-connections', reason: 'Draft closed' })
    expect(transition.effects).toContainEqual({
      type: 'notify-draft-complete',
      completedAt: 11_000,
      finalized: true,
      delivery: 'background',
    })
  })
})

function disabledMapVote(): StoredMapVoteState {
  return {
    enabled: false,
    phase: 'idle',
    endsAt: null,
    selections: {},
    confirmations: {},
    revealedVotes: null,
    result: null,
  }
}
