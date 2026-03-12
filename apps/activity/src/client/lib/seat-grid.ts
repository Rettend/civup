export interface GridLayout<T> {
  columns: number
  rows: number
  cells: Array<T | null>
}

export type SeatGridLayout = GridLayout<number>

export function createCellGridLayout<T>(cells: T[], maxColumns: number): GridLayout<T> {
  if (cells.length === 0 || maxColumns <= 0) return { columns: 0, rows: 0, cells: [] }

  const columns = Math.min(cells.length, maxColumns)
  const rows = Math.ceil(cells.length / columns)
  const paddedCells: Array<T | null> = [...cells]

  while (paddedCells.length < rows * columns) paddedCells.push(null)

  return {
    columns,
    rows,
    cells: paddedCells,
  }
}

export function createSeatGridLayout(seatCount: number, maxColumns: number): SeatGridLayout {
  if (seatCount <= 0 || maxColumns <= 0) return { columns: 0, rows: 0, cells: [] }

  return createCellGridLayout(Array.from({ length: seatCount }, (_, index) => index), maxColumns)
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
