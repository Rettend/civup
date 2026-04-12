import type { DraftState, QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { reopenLobbyAfterCancelledDraft, reopenLobbyAfterTimedOutDraft } from '../../src/services/lobby/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const draftRoster: QueueEntry[] = [
  {
    playerId: 'host',
    displayName: 'Host',
    joinedAt: 1,
  },
  {
    playerId: 'p2',
    displayName: 'Player 2',
    joinedAt: 2,
  },
]

describe('lobby recovery', () => {
  test('reopens a reverted draft with every player still in the lobby', async () => {
    const { kv } = createTrackedKv()
    const lobby = createLobbyState()
    const state = createCancelledState('revert')

    const recovered = await reopenLobbyAfterCancelledDraft(kv, lobby, state, {
      draftRoster,
      now: 10_000,
    })

    expect(recovered).not.toBeNull()
    expect(recovered?.removedPlayerIds).toEqual([])
    expect(recovered?.lobby.status).toBe('open')
    expect(recovered?.lobby.matchId).toBeNull()
    expect(recovered?.lobby.memberPlayerIds).toEqual(['host', 'p2'])
    expect(recovered?.lobby.slots).toEqual(['host', 'p2'])
    expect(recovered?.queueEntries.map(entry => entry.playerId)).toEqual(['host', 'p2'])
  })

  test('reopens a timed-out draft without the timed out player', async () => {
    const { kv } = createTrackedKv()
    const lobby = createLobbyState()
    const state = createCancelledState('timeout')

    const recovered = await reopenLobbyAfterTimedOutDraft(kv, lobby, state, {
      draftRoster,
      now: 20_000,
    })

    expect(recovered).not.toBeNull()
    expect(recovered?.timedOutPlayerIds).toEqual(['host'])
    expect(recovered?.lobby.hostId).toBe('p2')
    expect(recovered?.lobby.memberPlayerIds).toEqual(['p2'])
    expect(recovered?.lobby.slots).toEqual([null, 'p2'])
    expect(recovered?.queueEntries.map(entry => entry.playerId)).toEqual(['p2'])
  })
})

function createLobbyState() {
  return {
    id: 'lobby-1',
    mode: '1v1' as const,
    status: 'active' as const,
    guildId: 'guild-1',
    hostId: 'host',
    channelId: 'channel-1',
    messageId: 'message-1',
    matchId: 'match-1',
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    lastActivityAt: 1,
    memberPlayerIds: ['host', 'p2'],
    slots: ['host', 'p2'],
    draftConfig: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live' as const,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
  }
}

function createCancelledState(cancelReason: DraftState['cancelReason']): DraftState {
  return {
    matchId: 'match-1',
    formatId: 'default-1v1',
    seats: [
      { playerId: 'host', displayName: 'Host' },
      { playerId: 'p2', displayName: 'Player 2' },
    ],
    steps: [{ action: 'pick', seats: [0], count: 1, timer: 60 }],
    currentStepIndex: 0,
    submissions: {},
    bans: [],
    picks: [],
    availableCivIds: ['rome'],
    status: 'cancelled',
    cancelReason,
    pendingBlindBans: [],
  }
}
