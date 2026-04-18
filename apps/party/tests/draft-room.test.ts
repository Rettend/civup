import type { LeaderSwapState } from '@civup/game'
import { createDraft, default2v2, redDeath2v2 } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveAcceptedSwapState } from '../src/leader-swaps.ts'
import { buildRandomDraftResult } from '../src/random-draft.ts'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
})

function createRdSeats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
  ]
}

describe('buildRandomDraftResult', () => {
  test('assigns distinct leaders for base game drafts', () => {
    Math.random = () => 0

    const state = createDraft('match-base-random', default2v2, createRdSeats(), ['leader-a', 'leader-b', 'leader-c', 'leader-d'])

    const result = buildRandomDraftResult(state)

    expect(result.state.picks).toHaveLength(4)
    expect(result.state.picks.map(pick => pick.civId)).toEqual(['leader-a', 'leader-b', 'leader-c', 'leader-d'])
    expect(result.state.availableCivIds).toEqual([])
  })

  test('uses duplicate leaders when enabled for base game drafts', () => {
    Math.random = () => 0

    const state = createDraft('match-base-random-dup', default2v2, createRdSeats(), ['leader-a', 'leader-b', 'leader-c', 'leader-d'], {
      duplicateFactions: true,
    })

    const result = buildRandomDraftResult(state)

    expect(result.state.picks).toHaveLength(4)
    expect(result.state.picks.map(pick => pick.civId)).toEqual(['leader-a', 'leader-a', 'leader-a', 'leader-a'])
    expect(result.state.availableCivIds).toEqual(['leader-a', 'leader-b', 'leader-c', 'leader-d'])
  })

  test('uses duplicate factions when enabled', () => {
    Math.random = () => 0

    const state = createDraft('match-rd-random', redDeath2v2, createRdSeats(), ['rd-a', 'rd-b', 'rd-c', 'rd-d'], {
      dealOptionsSize: 2,
      duplicateFactions: true,
    })

    const result = buildRandomDraftResult(state)

    expect(result.state.picks).toHaveLength(4)
    expect(result.state.picks.map(pick => pick.civId)).toEqual(['rd-a', 'rd-a', 'rd-a', 'rd-a'])
    expect(result.state.availableCivIds).toEqual(['rd-a', 'rd-b', 'rd-c', 'rd-d'])
  })
})

describe('resolveAcceptedSwapState', () => {
  test('clears stale pending swaps for both accepted seats', () => {
    const swapState: LeaderSwapState = {
      pendingSwaps: [
        { fromSeat: 0, toSeat: 1, expiresAt: 1000 },
        { fromSeat: 1, toSeat: 3, expiresAt: 1001 },
        { fromSeat: 2, toSeat: 0, expiresAt: 1002 },
        { fromSeat: 3, toSeat: 2, expiresAt: 1003 },
      ],
      completedSwaps: [],
    }

    const nextSwapState = resolveAcceptedSwapState(swapState, swapState.pendingSwaps[1]!)

    expect(nextSwapState.pendingSwaps).toEqual([
      { fromSeat: 2, toSeat: 0, expiresAt: 1002 },
    ])
    expect(nextSwapState.completedSwaps).toEqual([
      { fromSeat: 1, toSeat: 3, expiresAt: 1001 },
    ])
  })

  test('keeps independent pending swaps available', () => {
    const swapState: LeaderSwapState = {
      pendingSwaps: [
        { fromSeat: 1, toSeat: 3, expiresAt: 1001 },
        { fromSeat: 0, toSeat: 2, expiresAt: 1002 },
      ],
      completedSwaps: [{ fromSeat: 4, toSeat: 5 }],
    }

    const nextSwapState = resolveAcceptedSwapState(swapState, swapState.pendingSwaps[0]!)

    expect(nextSwapState.pendingSwaps).toEqual([
      { fromSeat: 0, toSeat: 2, expiresAt: 1002 },
    ])
    expect(nextSwapState.completedSwaps).toEqual([
      { fromSeat: 4, toSeat: 5 },
      { fromSeat: 1, toSeat: 3, expiresAt: 1001 },
    ])
  })
})
