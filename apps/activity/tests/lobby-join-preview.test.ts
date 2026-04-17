import type { LobbySnapshot } from '../src/client/stores'
import { describe, expect, test } from 'bun:test'
import { resolveOptimisticLobbyPlacementAction, resolvePendingJoinGhostSlot } from '../src/client/pages/draft-setup/helpers'

const baseLobby: LobbySnapshot = {
  id: 'lobby-1',
  revision: 1,
  mode: '2v2',
  hostId: 'host-1',
  status: 'open',
  steamLobbyLink: null,
  minRole: null,
  maxRole: null,
  entries: [
    { playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: [] },
    null,
    null,
    null,
  ],
  minPlayers: 4,
  targetSize: 4,
  draftConfig: {
    banTimerSeconds: null,
    pickTimerSeconds: null,
    leaderPoolSize: null,
    leaderDataVersion: 'live',
    blindBans: true,
    simultaneousPick: false,
    redDeath: false,
    dealOptionsSize: 2,
    randomDraft: false,
    duplicateFactions: false,
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

describe('resolveOptimisticLobbyPlacementAction', () => {
  test('returns place-self for click-to-move when the viewer is already slotted', () => {
    expect(resolveOptimisticLobbyPlacementAction(baseLobby, 'host-1', 'host-1', 1, true)).toEqual({
      kind: 'place-self',
      targetSlot: 1,
    })
  })

  test('returns null for a fresh self-join with no current slot', () => {
    expect(resolveOptimisticLobbyPlacementAction(baseLobby, 'player-2', 'player-2', 1, false)).toBeNull()
  })

  test('returns null for linked self-moves in team lobbies', () => {
    const linkedLobby: LobbySnapshot = {
      ...baseLobby,
      entries: [
        { playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: ['player-2'] },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, partyIds: ['host-1'] },
        null,
        null,
      ],
    }

    expect(resolveOptimisticLobbyPlacementAction(linkedLobby, 'host-1', 'host-1', 2, true)).toBeNull()
  })
})
