import { createDraft, default2v2, redDeath2v2 } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
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
