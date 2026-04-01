import type { DraftState } from '@civup/game'
import { createDraft, default2v2, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { shouldForceReconnectForStaleDraft } from '../src/client/lib/stale-draft'

function create2v2Seats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
  ]
}

function createActiveState(): DraftState {
  const waiting = createDraft('connection-store-test', default2v2, create2v2Seats(), Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`))
  const result = processDraftInput(waiting, { type: 'START' })
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

describe('stale draft reconnect watchdog', () => {
  test('reconnects when a timed active step stays expired without newer socket activity', () => {
    const state = createActiveState()
    const timerEndsAt = 10_000

    expect(shouldForceReconnectForStaleDraft({
      connectionStatus: 'connected',
      state,
      timerEndsAt,
      lastSocketActivityAt: timerEndsAt - 1,
      nowMs: timerEndsAt + 5_001,
    })).toBe(true)
  })

  test('does not reconnect when the socket showed activity after the timer expired', () => {
    const state = createActiveState()
    const timerEndsAt = 10_000

    expect(shouldForceReconnectForStaleDraft({
      connectionStatus: 'connected',
      state,
      timerEndsAt,
      lastSocketActivityAt: timerEndsAt + 1,
      nowMs: timerEndsAt + 5_001,
    })).toBe(false)
  })

  test('does not reconnect outside an active timed draft step', () => {
    const active = createActiveState()
    const waiting = createDraft('connection-store-waiting-test', default2v2, create2v2Seats(), Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`))

    expect(shouldForceReconnectForStaleDraft({
      connectionStatus: 'reconnecting',
      state: active,
      timerEndsAt: 10_000,
      lastSocketActivityAt: 0,
      nowMs: 20_000,
    })).toBe(false)

    expect(shouldForceReconnectForStaleDraft({
      connectionStatus: 'connected',
      state: waiting,
      timerEndsAt: 10_000,
      lastSocketActivityAt: 0,
      nowMs: 20_000,
    })).toBe(false)

    expect(shouldForceReconnectForStaleDraft({
      connectionStatus: 'connected',
      state: active,
      timerEndsAt: null,
      lastSocketActivityAt: 0,
      nowMs: 20_000,
    })).toBe(false)
  })
})
