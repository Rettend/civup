export interface SeatGridLayout {
  columns: number
  rows: number
  cells: Array<number | null>
}

export function createSeatGridLayout(seatCount: number, maxColumns: number): SeatGridLayout {
  if (seatCount <= 0 || maxColumns <= 0) return { columns: 0, rows: 0, cells: [] }

  const columns = Math.min(seatCount, maxColumns)
  const rows = Math.ceil(seatCount / columns)

  return {
    columns,
    rows,
    cells: Array.from({ length: rows * columns }, (_, index) => index < seatCount ? index : null),
  }
}

export function findSeatGridPosition(layout: SeatGridLayout, seatIndex: number) {
  if (layout.columns <= 0) return null

  const cellIndex = layout.cells.indexOf(seatIndex)
  if (cellIndex < 0) return null

  return {
    row: Math.floor(cellIndex / layout.columns),
    col: cellIndex % layout.columns,
  }
}

export function getSeatAtGridPosition(layout: SeatGridLayout, row: number, col: number): number | null {
  if (row < 0 || col < 0 || row >= layout.rows || col >= layout.columns) return null
  return layout.cells[row * layout.columns + col] ?? null
}
