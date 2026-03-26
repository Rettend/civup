import { describe, expect, test } from 'bun:test'

function isParticipant(userId: string | null, seats: Array<{ playerId: string }>): boolean {
  if (!userId) return false
  return seats.some(seat => seat.playerId === userId)
}

function canShowResultActions(
  status: 'waiting' | 'active' | 'complete' | 'cancelled',
  userId: string | null,
  seats: Array<{ playerId: string }>,
): boolean {
  return status === 'complete' && isParticipant(userId, seats)
}

describe('draft reporting permissions', () => {
  test('lets non-host participants see result actions after draft completion', () => {
    const seats = [{ playerId: 'host' }, { playerId: 'player-2' }]

    expect(canShowResultActions('complete', 'player-2', seats)).toBe(true)
  })

  test('keeps spectators from seeing result actions after draft completion', () => {
    const seats = [{ playerId: 'host' }, { playerId: 'player-2' }]

    expect(canShowResultActions('complete', 'spectator', seats)).toBe(false)
  })
})
