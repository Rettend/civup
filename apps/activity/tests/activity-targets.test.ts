import type { ActivityTargetOption } from '../src/client/stores'
import { describe, expect, test } from 'bun:test'
import { activityTargetOptionKey, activityTargetsMatch, didClearResolvedActivityTarget, filterClearedActivityTargetOptions, resolveAutoSelectedActivityTarget, shouldApplyResolvedActivitySelection, shouldHoldAuthenticatedDraftStateForSelection } from '../src/client/lib/activity-targets'

const joinedMatch: ActivityTargetOption = {
  kind: 'match',
  id: 'match-1',
  lobbyId: 'lobby-1',
  matchId: 'match-1',
  channelId: 'channel-1',
  mode: '2v2',
  status: 'drafting',
  participantCount: 4,
  targetSize: 4,
  redDeath: false,
  isMember: true,
  isHost: false,
  updatedAt: 20,
}

const staleLobby: ActivityTargetOption = {
  kind: 'lobby',
  id: 'lobby-2',
  lobbyId: 'lobby-2',
  matchId: null,
  channelId: 'channel-1',
  mode: '2v2',
  status: 'open',
  participantCount: 1,
  targetSize: 4,
  redDeath: false,
  isMember: false,
  isHost: false,
  updatedAt: 10,
}

describe('activity target helpers', () => {
  test('does not treat the initial missing target replay as a cleared selection', () => {
    expect(didClearResolvedActivityTarget(undefined, null)).toBe(false)
  })

  test('keeps the initial default-target auto-selection behavior', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [staleLobby, joinedMatch],
      target: null,
      overviewPinned: false,
      suppressAutoSelection: false,
    })

    expect(selected).toEqual(joinedMatch)
  })

  test('suppresses auto-selection after an existing target is cleared', () => {
    const suppressAutoSelection = didClearResolvedActivityTarget({ kind: 'lobby', id: 'lobby-1' }, null)

    const selected = resolveAutoSelectedActivityTarget({
      options: [staleLobby],
      target: null,
      overviewPinned: false,
      suppressAutoSelection,
    })

    expect(suppressAutoSelection).toBe(true)
    expect(selected).toBeNull()
  })

  test('matches activity targets by kind and id', () => {
    expect(activityTargetsMatch(joinedMatch, { kind: 'match', id: 'match-1' })).toBe(true)
    expect(activityTargetsMatch(joinedMatch, { kind: 'lobby', id: 'match-1' })).toBe(false)
  })

  test('builds stable option keys from kind and id', () => {
    expect(activityTargetOptionKey(joinedMatch)).toBe('match:match-1')
  })

  test('filters a cleared target out of the available options', () => {
    expect(filterClearedActivityTargetOptions([staleLobby, joinedMatch], joinedMatch)).toEqual([staleLobby])
  })

  test('does not auto-select while the overview is pinned open', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [joinedMatch],
      target: null,
      overviewPinned: true,
      suppressAutoSelection: false,
    })

    expect(selected).toBeNull()
  })

  test('does not auto-select spectator lobbies by default', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [staleLobby],
      target: null,
      overviewPinned: false,
      suppressAutoSelection: false,
    })

    expect(selected).toBeNull()
  })

  test('keeps pinned overview from applying background selections', () => {
    expect(shouldApplyResolvedActivitySelection({
      isOverviewVisible: true,
      allowSelectionWhileOverview: false,
    })).toBe(false)
  })

  test('allows user-requested selections while overview is pinned', () => {
    expect(shouldApplyResolvedActivitySelection({
      isOverviewVisible: true,
      allowSelectionWhileOverview: true,
    })).toBe(true)
  })

  test('releases a timed-out draft when the target switches back to the lobby', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: 'lobby',
      hasInFlightConnection: false,
      draftState: {
        status: 'cancelled',
        cancelReason: 'timeout',
      },
    })).toBe(false)
  })

  test('releases a reverted draft when the target switches back to the lobby', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: 'lobby',
      hasInFlightConnection: false,
      draftState: {
        status: 'cancelled',
        cancelReason: 'revert',
      },
    })).toBe(false)
  })

  test('releases a completed draft when the target is cleared', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: null,
      hasInFlightConnection: false,
      draftState: {
        status: 'complete',
        cancelReason: null,
      },
    })).toBe(false)
  })

  test('keeps manual scrubs on the draft result screen', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: 'lobby',
      hasInFlightConnection: false,
      draftState: {
        status: 'cancelled',
        cancelReason: 'scrub',
      },
    })).toBe(true)
  })

  test('keeps scrubbed drafts on screen when the target is cleared', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: null,
      hasInFlightConnection: false,
      draftState: {
        status: 'cancelled',
        cancelReason: 'scrub',
      },
    })).toBe(true)
  })
})
