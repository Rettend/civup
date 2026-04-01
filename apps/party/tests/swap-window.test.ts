import type { LeaderSwapState } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  canOpenSwapWindowForState,
  countConnectedDraftParticipants,
  getNextSwapLifecycleAlarmAt,
  getSwapDisconnectFinalizeAtAfterDisconnect,
  getSwapWindowAlarmAction,
} from '../src/swap-window.ts'

describe('swap window lifecycle helpers', () => {
  test('starts a short finalize grace when the last participant disconnects', () => {
    const now = 1_700_000_000_000
    const participantIds = ['p1', 'p2', 'p3', 'p4']
    const participantConnection = { id: 'participant-1' }

    const remainingParticipants = countConnectedDraftParticipants(participantIds, [
      { connection: participantConnection, playerId: 'p1' },
      { connection: { id: 'spectator-1' }, playerId: 'spec-1' },
    ], participantConnection)

    expect(remainingParticipants).toBe(0)
    expect(getSwapDisconnectFinalizeAtAfterDisconnect({
      connectedParticipantCount: remainingParticipants,
      existingDisconnectFinalizeAt: null,
      now,
      graceMs: 5_000,
    })).toBe(now + 5_000)
  })

  test('opens the swap window for completed team red death drafts', () => {
    expect(canOpenSwapWindowForState({
      matchId: 'match-rd-swap',
      formatId: 'red-death-2v2',
      seats: [
        { playerId: 'a1', displayName: 'A1', team: 0 },
        { playerId: 'b1', displayName: 'B1', team: 1 },
        { playerId: 'a2', displayName: 'A2', team: 0 },
        { playerId: 'b2', displayName: 'B2', team: 1 },
      ],
      steps: [],
      currentStepIndex: 4,
      submissions: {},
      bans: [],
      picks: [
        { civId: 'rd-faction-1', seatIndex: 0, stepIndex: 0 },
        { civId: 'rd-faction-2', seatIndex: 1, stepIndex: 1 },
        { civId: 'rd-faction-3', seatIndex: 2, stepIndex: 2 },
        { civId: 'rd-faction-4', seatIndex: 3, stepIndex: 3 },
      ],
      availableCivIds: [],
      dealtCivIds: null,
      dealOptionsSize: 2,
      status: 'complete',
      cancelReason: null,
      pendingBlindBans: [],
    })).toBe(true)
  })

  test('keeps the window open and clears the disconnect grace when a participant is still connected', () => {
    expect(getSwapWindowAlarmAction({
      now: 1_700_000_000_000,
      connectedParticipantCount: 1,
      disconnectFinalizeAt: 1_700_000_000_000,
      safetyEndsAt: 1_700_000_060_000,
    })).toBe('clear-disconnect-grace')
  })

  test('finalizes the window once the disconnect grace expires with no participants left', () => {
    expect(getSwapWindowAlarmAction({
      now: 1_700_000_005_000,
      connectedParticipantCount: 0,
      disconnectFinalizeAt: 1_700_000_005_000,
      safetyEndsAt: 1_700_000_060_000,
    })).toBe('finalize')
  })

  test('schedules the earliest pending swap, disconnect grace, or safety alarm', () => {
    const swapState: LeaderSwapState = {
      pendingSwaps: [
        { fromSeat: 0, toSeat: 2, expiresAt: 1_700_000_010_000 },
      ],
      completedSwaps: [],
    }

    expect(getNextSwapLifecycleAlarmAt({
      swapState,
      disconnectFinalizeAt: 1_700_000_020_000,
      safetyEndsAt: 1_700_000_030_000,
    })).toBe(1_700_000_010_000)
  })
})
