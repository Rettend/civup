import type { DraftState } from '@civup/game'

export function getVisualSeatOrder(seats: DraftState['seats'] | undefined | null): number[] {
  if (!seats || seats.length === 0) return []
  if (!seats.some(seat => seat.team != null)) return seats.map((_, index) => index)

  const teamIndices = Array.from(new Set(
    seats.flatMap(seat => seat.team == null ? [] : [seat.team]),
  )).sort((a, b) => a - b)

  return teamIndices.flatMap(team => seats
    .map((seat, index) => ({ seat, index }))
    .filter(entry => entry.seat.team === team)
    .map(entry => entry.index))
}
