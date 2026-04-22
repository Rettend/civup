import type { DraftPreviewState } from '@civup/game'
import type { StoredMapVoteState } from '../src/map-vote-room-state.ts'
import { createDraft, default2v2 } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { assertDraftRoomInvariants, getDraftRoomInvariantViolations } from '../src/draft-room-invariants.ts'

function createPreviewState(): DraftPreviewState {
  return {
    bans: {},
    picks: {},
  }
}

function createMapVoteState(): StoredMapVoteState {
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

describe('draft room invariants', () => {
  test('accepts a complete room snapshot with an open swap window', () => {
    const waiting = createDraft('match-room-ok', default2v2, [
      { playerId: 'p1', displayName: 'P1', team: 0 },
      { playerId: 'p2', displayName: 'P2', team: 1 },
      { playerId: 'p3', displayName: 'P3', team: 0 },
      { playerId: 'p4', displayName: 'P4', team: 1 },
    ], ['a', 'b', 'c', 'd'])
    const state = {
      ...waiting,
      currentStepIndex: waiting.steps.length,
      picks: [
        { civId: 'a', seatIndex: 0, stepIndex: 0 },
        { civId: 'b', seatIndex: 1, stepIndex: 1 },
        { civId: 'c', seatIndex: 2, stepIndex: 2 },
        { civId: 'd', seatIndex: 3, stepIndex: 3 },
      ],
      availableCivIds: [],
      status: 'complete' as const,
    }

    expect(getDraftRoomInvariantViolations({
      alarmStepIndex: -1,
      cancelledAt: null,
      completedAt: 1234,
      config: {
        matchId: state.matchId,
        hostId: 'p1',
        formatId: state.formatId,
        seats: state.seats,
        civPool: ['a', 'b', 'c', 'd'],
      },
      mapVote: createMapVoteState(),
      matchId: state.matchId,
      previews: createPreviewState(),
      state,
      swapDisconnectFinalizeAt: null,
      swapSafetyEndsAt: 4321,
      swapState: { pendingSwaps: [], completedSwaps: [] },
      swapWindowOpen: true,
      timerEndsAt: null,
    })).toHaveLength(0)
  })

  test('throws on impossible complete-state lifecycle data in strict mode', () => {
    const state = {
      ...createDraft('match-room-bad', default2v2, [
        { playerId: 'p1', displayName: 'P1', team: 0 },
        { playerId: 'p2', displayName: 'P2', team: 1 },
        { playerId: 'p3', displayName: 'P3', team: 0 },
        { playerId: 'p4', displayName: 'P4', team: 1 },
      ], ['a', 'b', 'c', 'd']),
      currentStepIndex: 2,
      status: 'complete' as const,
    }

    expect(() => assertDraftRoomInvariants({
      alarmStepIndex: 2,
      cancelledAt: null,
      completedAt: null,
      config: null,
      mapVote: createMapVoteState(),
      matchId: state.matchId,
      previews: createPreviewState(),
      state,
      swapDisconnectFinalizeAt: 1000,
      swapSafetyEndsAt: null,
      swapState: null,
      swapWindowOpen: true,
      timerEndsAt: 500,
    }, {
      strict: true,
    })).toThrow()
  })
})
