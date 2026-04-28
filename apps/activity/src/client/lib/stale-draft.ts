import type { DraftState, MapVoteSnapshot } from '@civup/game'

export const STALE_DRAFT_RECONNECT_GRACE_MS = 5_000

export function shouldForceReconnectForStaleDraft(params: {
  connectionStatus: 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'
  state: DraftState | null
  timerEndsAt: number | null
  mapVote?: Pick<MapVoteSnapshot, 'phase' | 'endsAt'> | null
  lastSocketActivityAt: number
  lastForcedReconnectTimerEndsAt?: number | null
  nowMs?: number
  graceMs?: number
}): boolean {
  if (params.connectionStatus !== 'connected') return false

  const timerEndsAt = getReconnectWatchdogTimerEndsAt(params)
  if (timerEndsAt == null) return false

  const nowMs = params.nowMs ?? Date.now()
  const graceMs = params.graceMs ?? STALE_DRAFT_RECONNECT_GRACE_MS
  if (nowMs <= timerEndsAt + graceMs) return false
  if (params.lastForcedReconnectTimerEndsAt === timerEndsAt) return false

  return params.lastSocketActivityAt <= timerEndsAt
}

function getReconnectWatchdogTimerEndsAt(params: {
  state: DraftState | null
  timerEndsAt: number | null
  mapVote?: Pick<MapVoteSnapshot, 'phase' | 'endsAt'> | null
}): number | null {
  if ((params.mapVote?.phase === 'voting' || params.mapVote?.phase === 'reveal') && params.mapVote.endsAt != null) {
    return params.mapVote.endsAt
  }

  const state = params.state
  if (!state || state.status !== 'active' || params.timerEndsAt == null) return null

  const step = state.steps[state.currentStepIndex]
  if (!step || step.timer <= 0) return null

  return params.timerEndsAt
}
