import { describe, expect, test } from 'bun:test'
import { createCellGridLayout, createSeatGridLayout, findSeatGridPosition, getSeatAtGridPosition } from '../src/client/lib/seat-grid'

describe('seat-grid helpers', () => {
  test('builds a two-column mobile-friendly grid for larger FFAs', () => {
    const layout = createSeatGridLayout(7, 2)

    expect(layout).toEqual({
      columns: 2,
      rows: 4,
      cells: [0, 1, 2, 3, 4, 5, 6, null],
    })
  })

  test('caps columns at the seat count', () => {
    const layout = createSeatGridLayout(2, 5)

    expect(layout).toEqual({
      columns: 2,
      rows: 1,
      cells: [0, 1],
    })
  })

  test('locates seats and resolves neighbor lookups', () => {
    const layout = createSeatGridLayout(6, 2)

    expect(findSeatGridPosition(layout, 4)).toEqual({ row: 2, col: 0 })
    expect(getSeatAtGridPosition(layout, 2, 1)).toBe(5)
    expect(getSeatAtGridPosition(layout, 3, 1)).toBeNull()
  })

  test('builds a 2x2 team block layout for 4v4', () => {
    const layout = createCellGridLayout([0, 2, 4, 6], 2)

    expect(layout).toEqual({
      columns: 2,
      rows: 2,
      cells: [0, 2, 4, 6],
    })
  })
})
