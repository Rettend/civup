import type { LobbySnapshot } from '../src/client/stores'
import { describe, expect, test } from 'bun:test'
import { resolvePendingJoinGhostSlot } from '../src/client/lib/config-screen/helpers'

const baseLobby: LobbySnapshot = {
  id: 'lobby-1',
  revision: 1,
  mode: '2v2',
  hostId: 'host-1',
  status: 'open',
  minRole: null,
  entries: [
    { playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: [] },
    null,
    null,
    null,
  ],
  minPlayers: 2,
  targetSize: 4,
  draftConfig: {
    banTimerSeconds: null,
    pickTimerSeconds: null,
  },
  serverDefaults: {
    banTimerSeconds: null,
    pickTimerSeconds: null,
  },
}

describe('resolvePendingJoinGhostSlot', () => {
  test('returns the predicted slot when a pending join is eligible', () => {
    expect(resolvePendingJoinGhostSlot(baseLobby, 'player-2', true, {
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })).toBe(1)
  })

  test('returns null when the pending join is blocked', () => {
    expect(resolvePendingJoinGhostSlot(baseLobby, 'player-2', true, {
      canJoin: false,
      blockedReason: 'This lobby requires at least Legion.',
      pendingSlot: null,
    })).toBeNull()
  })

  test('uses the clicked empty slot for local spectator joins', () => {
    expect(resolvePendingJoinGhostSlot(baseLobby, 'player-2', true, {
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    }, 2)).toBe(2)
  })

  test('returns null once the viewer is already in the lobby snapshot', () => {
    const joinedLobby = {
      ...baseLobby,
      entries: [
        { playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: [] },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, partyIds: [] },
        null,
        null,
      ],
    }

    expect(resolvePendingJoinGhostSlot(joinedLobby, 'player-2', true, {
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })).toBeNull()
  })
})
