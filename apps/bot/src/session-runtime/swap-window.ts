import type { DraftState } from '@civup/game'

export function canOpenSwapWindowForState(state: DraftState): boolean {
  if (state.status !== 'complete') return false
  if (!state.seats.some(seat => seat.team != null)) return false
  if (state.civBlitz) {
    return state.seats.every((_, seatIndex) => {
      const kit = state.civBlitz?.lockedKits[seatIndex]
      return !!kit
        && typeof kit.civilizationAbility === 'string'
        && typeof kit.leaderAbility === 'string'
        && typeof kit.infrastructure === 'string'
        && typeof kit.unit === 'string'
    })
  }
  const pickedSeats = new Set(state.picks.map(pick => pick.seatIndex))
  return state.seats.every((_, seatIndex) => pickedSeats.has(seatIndex))
}

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
  disconnectFinalizeAt: number | null
  safetyEndsAt: number | null
}): number | null {
  return [input.disconnectFinalizeAt, input.safetyEndsAt]
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
