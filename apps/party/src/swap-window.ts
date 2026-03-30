import type { LeaderSwapState } from '@civup/game'

export function countConnectedDraftParticipants<TConnection>(
  participantIds: readonly string[],
  connections: readonly { connection: TConnection, playerId: string | null | undefined }[],
  excludedConnection?: TConnection,
): number {
  const connectedParticipantIds = new Set(participantIds)
  let count = 0

  for (const entry of connections) {
    if (entry.connection === excludedConnection) continue
    if (!entry.playerId || !connectedParticipantIds.has(entry.playerId)) continue
    count += 1
  }

  return count
}

export function getSwapDisconnectFinalizeAtAfterDisconnect(input: {
  connectedParticipantCount: number
  existingDisconnectFinalizeAt: number | null
  now: number
  graceMs: number
}): number | null {
  if (input.connectedParticipantCount > 0) return input.existingDisconnectFinalizeAt
  if (input.existingDisconnectFinalizeAt != null) return input.existingDisconnectFinalizeAt
  return input.now + input.graceMs
}

export function getNextSwapLifecycleAlarmAt(input: {
  swapState: LeaderSwapState
  disconnectFinalizeAt: number | null
  safetyEndsAt: number | null
}): number | null {
  return [getNextSwapPendingExpiry(input.swapState), input.disconnectFinalizeAt, input.safetyEndsAt]
    .filter((timestamp): timestamp is number => typeof timestamp === 'number' && Number.isFinite(timestamp))
    .sort((left, right) => left - right)[0] ?? null
}

export function getSwapWindowAlarmAction(input: {
  now: number
  connectedParticipantCount: number
  disconnectFinalizeAt: number | null
  safetyEndsAt: number | null
}): 'keep-open' | 'clear-disconnect-grace' | 'finalize' {
  if (input.disconnectFinalizeAt != null) {
    if (input.connectedParticipantCount > 0) return 'clear-disconnect-grace'
    if (input.disconnectFinalizeAt <= input.now) return 'finalize'
  }

  if (input.safetyEndsAt != null && input.safetyEndsAt <= input.now) return 'finalize'
  return 'keep-open'
}

function getNextSwapPendingExpiry(swapState: LeaderSwapState): number | null {
  return swapState.pendingSwaps
    .map(swap => swap.expiresAt)
    .filter(timestamp => Number.isFinite(timestamp))
    .sort((left, right) => left - right)[0] ?? null
}
