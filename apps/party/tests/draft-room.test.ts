import type { LeaderSwapState } from '@civup/game'
import { createDraft, default2v2, DEFAULT_MAP_VOTE_SELECTION, pickRandomMapScript, pickRandomMapType, redDeath2v2 } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { applyMapVoteSelectionUpdate, isMapVoteInProgress, isMapVoteSelectionConfirmable, isValidMapVoteSelectionInput, type StoredMapVoteState } from '../src/map-vote-room-state.ts'
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

describe('map vote room helpers', () => {
  function createMapVoteState(): StoredMapVoteState {
    return {
      enabled: true,
      phase: 'voting',
      endsAt: 1,
      selections: {
        0: { ...DEFAULT_MAP_VOTE_SELECTION },
      },
      confirmations: {
        0: false,
      },
      revealedVotes: null,
      result: null,
    }
  }

  test('does not allow changing a confirmed ballot', () => {
    const state = createMapVoteState()
    state.confirmations[0] = true

    const result = applyMapVoteSelectionUpdate(state, 0, {
      mapType: 'east-vs-west',
      mapScripts: ['lakes'],
    })

    expect(result).toBe('locked')
  })

  test('rejects invalid map-vote ids', () => {
    expect(isValidMapVoteSelectionInput({ mapType: 'standard', mapScripts: ['lakes'] })).toBe(true)
    expect(isValidMapVoteSelectionInput({ mapType: 'standard', mapScripts: ['random'] })).toBe(true)
    expect(isValidMapVoteSelectionInput({ mapType: 'bogus', mapScripts: ['lakes'] })).toBe(false)
    expect(isValidMapVoteSelectionInput({ mapType: 'standard', mapScripts: ['bogus'] })).toBe(false)
    expect(isValidMapVoteSelectionInput({ mapType: 'standard', mapScripts: ['lakes', 'lakes'] })).toBe(false)
  })

  test('normalizes random script submissions as an exclusive special case', () => {
    const state = createMapVoteState()

    const result = applyMapVoteSelectionUpdate(state, 0, {
      mapType: 'east-vs-west',
      mapScripts: ['lakes', 'random', 'seven-seas'],
    })

    expect(result).not.toBe('inactive')
    expect(result).not.toBe('locked')
    expect((result as StoredMapVoteState).selections[0]).toEqual({
      mapType: 'east-vs-west',
      mapScripts: ['random'],
    })
  })

  test('allows saving an unconfirmed empty approval list but not confirming it', () => {
    const state = createMapVoteState()

    const result = applyMapVoteSelectionUpdate(state, 0, {
      mapType: 'east-vs-west',
      mapScripts: [],
    })

    expect(result).not.toBe('inactive')
    expect(result).not.toBe('locked')
    expect(typeof result).toBe('object')
    expect(isMapVoteSelectionConfirmable((result as StoredMapVoteState).selections[0])).toBe(false)
  })

  test('debug bot votes resolve away from random placeholders before confirmation', () => {
    const rng = () => 0

    expect(pickRandomMapType(rng)).toBe('standard')
    expect(pickRandomMapScript(rng)).toBe('pangaea-ultima')
  })

  test('treats reveal as an in-progress map vote for host reverts', () => {
    const state = createMapVoteState()
    state.phase = 'reveal'

    expect(isMapVoteInProgress(state)).toBe(true)
  })
})
