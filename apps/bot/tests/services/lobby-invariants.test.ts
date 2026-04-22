import type { LobbyState } from '../../src/services/lobby/types.ts'
import { describe, expect, test } from 'bun:test'
import { getLobbyInvariantViolations } from '../../src/services/lobby/invariants.ts'

function createLobbyState(): LobbyState {
  return {
    id: 'lobby-1',
    mode: '2v2',
    status: 'open',
    guildId: null,
    hostId: 'p1',
    channelId: 'channel-1',
    messageId: 'message-1',
    matchId: null,
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    lastArrange: null,
    lastActivityAt: 10,
    memberPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    slots: ['p1', 'p2', 'p3', 'p4'],
    draftConfig: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      mapVoteEnabled: false,
      blindBans: true,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    createdAt: 1,
    updatedAt: 10,
    revision: 2,
  }
}

describe('lobby invariants', () => {
  test('accept a queue-backed open lobby with aligned projections', () => {
    const lobby = createLobbyState()

    expect(getLobbyInvariantViolations(lobby, {
      checkOpenRoster: true,
      checkSlotNormalization: true,
      projection: {
        channelIndexed: true,
        hostLobbyId: lobby.id,
        matchLobbyId: null,
        modeIndexed: true,
      },
      queueEntries: lobby.memberPlayerIds.map((playerId, index) => ({
        playerId,
        displayName: playerId,
        joinedAt: index + 1,
      })),
    })).toHaveLength(0)
  })

  test('reports member and projection drift for an open lobby', () => {
    const lobby = {
      ...createLobbyState(),
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p3', null, null],
    }

    const violations = getLobbyInvariantViolations(lobby, {
      checkOpenRoster: true,
      checkSlotNormalization: true,
      projection: {
        channelIndexed: false,
        hostLobbyId: null,
        matchLobbyId: 'other-lobby',
        modeIndexed: true,
      },
      queueEntries: [
        { playerId: 'p1', displayName: 'p1', joinedAt: 1 },
        { playerId: 'p2', displayName: 'p2', joinedAt: 2 },
        { playerId: 'p3', displayName: 'p3', joinedAt: 3 },
      ],
    })

    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some(violation => violation.message.includes('queue-backed roster'))).toBe(true)
    expect(violations.some(violation => violation.message.includes('channel index'))).toBe(true)
  })
})
