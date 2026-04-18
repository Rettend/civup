import type { LeaderSwapState, PendingLeaderSwapRequest } from '@civup/game'

export function resolveAcceptedSwapState(
  swapState: LeaderSwapState,
  acceptedSwap: PendingLeaderSwapRequest,
): LeaderSwapState {
  return {
    pendingSwaps: swapState.pendingSwaps.filter(swap => !isPendingSwapInvalidAfterAcceptance(swap, acceptedSwap)),
    completedSwaps: [...swapState.completedSwaps, acceptedSwap],
  }
}

function isPendingSwapInvalidAfterAcceptance(
  pendingSwap: PendingLeaderSwapRequest,
  acceptedSwap: Pick<PendingLeaderSwapRequest, 'fromSeat' | 'toSeat'>,
): boolean {
  return isSamePendingSwap(pendingSwap, acceptedSwap)
    || pendingSwap.fromSeat === acceptedSwap.fromSeat
    || pendingSwap.fromSeat === acceptedSwap.toSeat
    || pendingSwap.toSeat === acceptedSwap.fromSeat
    || pendingSwap.toSeat === acceptedSwap.toSeat
}

function isSamePendingSwap(
  left: Pick<PendingLeaderSwapRequest, 'fromSeat' | 'toSeat'>,
  right: Pick<PendingLeaderSwapRequest, 'fromSeat' | 'toSeat'>,
): boolean {
  return left.fromSeat === right.fromSeat && left.toSeat === right.toSeat
}
