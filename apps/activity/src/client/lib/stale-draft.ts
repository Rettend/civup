import type { DraftState } from '@civup/game'

export const STALE_DRAFT_RECONNECT_GRACE_MS = 5_000

export function shouldForceReconnectForStaleDraft(params: {
  connectionStatus: 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'
  state: DraftState | null
  timerEndsAt: number | null
  lastSocketActivityAt: number
  nowMs?: number
  graceMs?: number
}): boolean {
  if (params.connectionStatus !== 'connected') return false

  const state = params.state
  if (!state || state.status !== 'active' || params.timerEndsAt == null) return false

  const step = state.steps[state.currentStepIndex]
  if (!step || step.timer <= 0) return false

  const nowMs = params.nowMs ?? Date.now()
  const graceMs = params.graceMs ?? STALE_DRAFT_RECONNECT_GRACE_MS
  if (nowMs <= params.timerEndsAt + graceMs) return false

  return params.lastSocketActivityAt <= params.timerEndsAt
}
