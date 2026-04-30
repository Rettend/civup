import { describe, expect, test } from 'bun:test'
import { getVisualSeatOrder } from '../src/client/lib/seat-order'

describe('getVisualSeatOrder', () => {
  test('groups interleaved 2v2 draft seats into natural team slot order', () => {
    expect(getVisualSeatOrder([
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ])).toEqual([0, 2, 1, 3])
  })

  test('keeps FFA seats in seat order', () => {
    expect(getVisualSeatOrder([
      { playerId: 'p1', displayName: 'P1' },
      { playerId: 'p2', displayName: 'P2' },
      { playerId: 'p3', displayName: 'P3' },
    ])).toEqual([0, 1, 2])
  })
})
