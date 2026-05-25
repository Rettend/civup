import type { DraftState } from '@civup/game'
import { allLeaderIds } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { censorDraftPreviews } from '../../src/session-runtime/draft-previews.ts'

describe('draft previews', () => {
  test('shows captain ban previews to teammates but not opponents', () => {
    const state = createTeamBanState()
    const teamABans = allLeaderIds.slice(0, 3)
    const teamBBans = allLeaderIds.slice(3, 6)
    const previews = {
      bans: {
        0: teamABans,
        1: teamBBans,
      },
      picks: {},
    }

    expect(censorDraftPreviews(state, previews, 0).bans).toEqual({ 0: teamABans })
    expect(censorDraftPreviews(state, previews, 2).bans).toEqual({ 0: teamABans })
    expect(censorDraftPreviews(state, previews, 1).bans).toEqual({ 1: teamBBans })
    expect(censorDraftPreviews(state, previews, 3).bans).toEqual({ 1: teamBBans })
  })
})

function createTeamBanState(): DraftState {
  return {
    matchId: 'match-ban-preview',
    formatId: 'default-2v2',
    currentStepIndex: 0,
    steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
    seats: [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ],
    submissions: {},
    bans: [],
    picks: [],
    availableCivIds: allLeaderIds.slice(0, 24),
    status: 'active',
    cancelReason: null,
    pendingBlindBans: [],
  }
}
