import type { DraftPreviewState, DraftState, LeaderSwapState, RoomConfig } from '@civup/game'
import type { RuntimeInvariantViolation } from '@civup/utils'
import type { StoredMapVoteState } from './map-vote-room-state.ts'
import { getCurrentStep } from '@civup/game'
import { enforceRuntimeInvariants } from '@civup/utils'
import { sanitizeDraftPreviews } from './draft-previews.ts'
import { canOpenSwapWindowForState } from './swap-window.ts'

export interface DraftRoomInvariantSnapshot {
  alarmStepIndex: number
  cancelledAt: number | null
  completedAt: number | null
  config: RoomConfig | null
  mapVote: StoredMapVoteState
  matchId: string
  previews: DraftPreviewState
  state: DraftState
  swapDisconnectFinalizeAt: number | null
  swapSafetyEndsAt: number | null
  swapState: LeaderSwapState | null
  swapWindowOpen: boolean
  timerEndsAt: number | null
}

export interface DraftRoomInvariantOptions {
  context?: Record<string, unknown>
  strict?: boolean
}

export function getDraftRoomInvariantViolations(
  snapshot: DraftRoomInvariantSnapshot,
  options: DraftRoomInvariantOptions = {},
): RuntimeInvariantViolation[] {
  const violations: RuntimeInvariantViolation[] = []
  const push = (message: string, context?: Record<string, unknown>) => {
    violations.push({
      scope: 'draft-room-invariant',
      message,
      context: {
        matchId: snapshot.matchId,
        status: snapshot.state.status,
        currentStepIndex: snapshot.state.currentStepIndex,
        mapVotePhase: snapshot.mapVote.phase,
        swapWindowOpen: snapshot.swapWindowOpen,
        ...options.context,
        ...context,
      },
    })
  }

  if (snapshot.config && snapshot.config.matchId !== snapshot.state.matchId) {
    push('Room config matchId must stay aligned with the persisted draft state.', {
      configMatchId: snapshot.config.matchId,
      stateMatchId: snapshot.state.matchId,
    })
  }

  const sanitizedPreviews = sanitizeDraftPreviews(snapshot.state, snapshot.previews)
  if (!samePreviewState(snapshot.previews, sanitizedPreviews)) {
    push('Persisted draft previews must stay sanitized for the current state.', {
      previews: snapshot.previews,
      sanitizedPreviews,
    })
  }

  if (!snapshot.mapVote.enabled) {
    if (snapshot.mapVote.phase !== 'idle' || snapshot.mapVote.endsAt != null || snapshot.mapVote.result != null || snapshot.mapVote.revealedVotes != null) {
      push('Disabled map vote state must stay fully idle.')
    }
  }

  const mapVoteInProgress = snapshot.mapVote.enabled
    && (snapshot.mapVote.phase === 'voting' || snapshot.mapVote.phase === 'reveal')
  if (mapVoteInProgress) {
    if (snapshot.mapVote.endsAt == null) {
      push('Map vote in progress must have an endsAt timestamp.')
    }
    if (snapshot.state.status !== 'waiting') {
      push('Map vote in progress must only happen before the draft starts.')
    }
    if (snapshot.timerEndsAt != null || snapshot.alarmStepIndex !== -1) {
      push('Draft-step timer fields must stay clear while map vote drives the alarm.', {
        timerEndsAt: snapshot.timerEndsAt,
        alarmStepIndex: snapshot.alarmStepIndex,
      })
    }
  }
  else if ((snapshot.mapVote.phase === 'idle' || snapshot.mapVote.phase === 'done') && snapshot.mapVote.endsAt != null) {
    push('Idle or completed map vote state must not keep an active endsAt timestamp.', {
      endsAt: snapshot.mapVote.endsAt,
    })
  }

  switch (snapshot.state.status) {
    case 'waiting':
      if (snapshot.state.currentStepIndex !== -1) {
        push('Waiting drafts must keep currentStepIndex at -1.')
      }
      if (snapshot.timerEndsAt != null || snapshot.alarmStepIndex !== -1) {
        push('Waiting drafts must not keep draft-step timers armed.', {
          timerEndsAt: snapshot.timerEndsAt,
          alarmStepIndex: snapshot.alarmStepIndex,
        })
      }
      if (snapshot.completedAt != null || snapshot.cancelledAt != null) {
        push('Waiting drafts must not keep completedAt or cancelledAt timestamps.', {
          completedAt: snapshot.completedAt,
          cancelledAt: snapshot.cancelledAt,
        })
      }
      if (snapshot.swapWindowOpen || snapshot.swapState != null || snapshot.swapDisconnectFinalizeAt != null || snapshot.swapSafetyEndsAt != null) {
        push('Waiting drafts must not keep swap-window state.')
      }
      break

    case 'active': {
      const currentStep = getCurrentStep(snapshot.state)
      if (!currentStep) {
        push('Active drafts must have a current step.')
      }
      if (snapshot.completedAt != null || snapshot.cancelledAt != null) {
        push('Active drafts must not keep completedAt or cancelledAt timestamps.', {
          completedAt: snapshot.completedAt,
          cancelledAt: snapshot.cancelledAt,
        })
      }
      if (snapshot.swapWindowOpen || snapshot.swapState != null || snapshot.swapDisconnectFinalizeAt != null || snapshot.swapSafetyEndsAt != null) {
        push('Active drafts must not keep swap-window state.')
      }
      if (snapshot.timerEndsAt != null && snapshot.alarmStepIndex !== snapshot.state.currentStepIndex) {
        push('Draft-step timers must stay aligned with the active step index.', {
          timerEndsAt: snapshot.timerEndsAt,
          alarmStepIndex: snapshot.alarmStepIndex,
        })
      }
      if (snapshot.timerEndsAt == null && snapshot.alarmStepIndex !== -1) {
        push('Active drafts without a timer must clear alarmStepIndex.', {
          alarmStepIndex: snapshot.alarmStepIndex,
        })
      }
      break
    }

    case 'complete':
      if (snapshot.completedAt == null) {
        push('Completed drafts must keep completedAt.')
      }
      if (snapshot.cancelledAt != null) {
        push('Completed drafts must not keep cancelledAt.', {
          cancelledAt: snapshot.cancelledAt,
        })
      }
      if (snapshot.timerEndsAt != null || snapshot.alarmStepIndex !== -1) {
        push('Completed drafts must not keep draft-step timers armed.', {
          timerEndsAt: snapshot.timerEndsAt,
          alarmStepIndex: snapshot.alarmStepIndex,
        })
      }
      if (snapshot.swapWindowOpen) {
        if (!canOpenSwapWindowForState(snapshot.state)) {
          push('Swap window must only open for complete team drafts.')
        }
        if (snapshot.swapState == null) {
          push('Open swap windows must keep swapState.')
        }
        if (snapshot.swapSafetyEndsAt == null) {
          push('Open swap windows must keep a safety timeout.')
        }
      }
      else if (snapshot.swapState != null || snapshot.swapDisconnectFinalizeAt != null || snapshot.swapSafetyEndsAt != null) {
        push('Closed completed drafts must clear swap-window state.')
      }
      break

    case 'cancelled':
      if (snapshot.cancelledAt == null) {
        push('Cancelled drafts must keep cancelledAt.')
      }
      if (snapshot.completedAt != null) {
        push('Cancelled drafts must not keep completedAt.', {
          completedAt: snapshot.completedAt,
        })
      }
      if (snapshot.timerEndsAt != null || snapshot.alarmStepIndex !== -1) {
        push('Cancelled drafts must not keep draft-step timers armed.', {
          timerEndsAt: snapshot.timerEndsAt,
          alarmStepIndex: snapshot.alarmStepIndex,
        })
      }
      if (snapshot.swapWindowOpen || snapshot.swapState != null || snapshot.swapDisconnectFinalizeAt != null || snapshot.swapSafetyEndsAt != null) {
        push('Cancelled drafts must clear swap-window state.')
      }
      break
  }

  return violations
}

export function assertDraftRoomInvariants(
  snapshot: DraftRoomInvariantSnapshot,
  options: DraftRoomInvariantOptions = {},
): void {
  enforceRuntimeInvariants(getDraftRoomInvariantViolations(snapshot, options), {
    strict: options.strict,
  })
}

function samePreviewState(left: DraftPreviewState, right: DraftPreviewState): boolean {
  return samePreviewMap(left.bans, right.bans) && samePreviewMap(left.picks, right.picks)
}

function samePreviewMap(left: Record<number, string[]>, right: Record<number, string[]>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index]
    if (!key || key !== rightKeys[index]) return false
    const leftValues = left[Number(key)] ?? []
    const rightValues = right[Number(key)] ?? []
    if (leftValues.length !== rightValues.length) return false
    for (let valueIndex = 0; valueIndex < leftValues.length; valueIndex++) {
      if (leftValues[valueIndex] !== rightValues[valueIndex]) return false
    }
  }
  return true
}
