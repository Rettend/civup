import type { ActivityTargetOption } from '../src/client/stores'
import { describe, expect, test } from 'bun:test'
import { activityTargetOptionKey, activityTargetsMatch, didClearResolvedActivityTarget, filterClearedActivityTargetOptions, getBrokenMatchRefreshKey, resolveAutoSelectedActivityTarget, resolveMissingLiveTarget, shouldApplyActivityLaunchSnapshotRefresh, shouldApplyResolvedActivitySelection, shouldHoldAuthenticatedDraftStateForSelection, shouldReconnectVisibleActivityTarget, shouldRequestActivityTargetSelection } from '../src/client/lib/activity-targets'

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

const joinedActiveMatch: ActivityTargetOption = {
  ...joinedMatch,
  id: 'match-active',
  lobbyId: 'lobby-active',
  matchId: 'match-active',
  status: 'active',
  updatedAt: 30,
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

const joinedLobby: ActivityTargetOption = {
  ...staleLobby,
  id: 'lobby-joined',
  lobbyId: 'lobby-joined',
  isMember: true,
  updatedAt: 40,
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

  test('prefers open lobby membership over old active matches', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [joinedActiveMatch, joinedLobby],
      target: null,
      overviewPinned: false,
      suppressAutoSelection: false,
    })

    expect(selected).toEqual(joinedLobby)
  })

  test('does not auto-select active matches without a live draft room', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [joinedActiveMatch],
      target: null,
      overviewPinned: false,
      suppressAutoSelection: false,
    })

    expect(selected).toBeNull()
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

  test('promotes a selected lobby to its started draft before holding the lobby view', () => {
    const resolution = resolveMissingLiveTarget({
      options: [joinedMatch],
      target: { kind: 'lobby', id: 'lobby-1' },
      currentLobbyId: 'lobby-1',
      hasCurrentLobbySnapshot: true,
      failedAutoSelectionKeys: new Set(),
    })

    expect(resolution).toEqual({ kind: 'promote', option: joinedMatch })
  })

  test('holds a visible selected lobby when it is briefly missing without a promoted match', () => {
    const resolution = resolveMissingLiveTarget({
      options: [],
      target: { kind: 'lobby', id: 'lobby-joined' },
      currentLobbyId: 'lobby-joined',
      hasCurrentLobbySnapshot: true,
      failedAutoSelectionKeys: new Set(),
    })

    expect(resolution).toEqual({ kind: 'hold' })
  })

  test('clears a visible selected lobby after its live snapshot is removed', () => {
    const resolution = resolveMissingLiveTarget({
      options: [],
      target: { kind: 'lobby', id: 'lobby-joined' },
      currentLobbyId: 'lobby-joined',
      hasCurrentLobbySnapshot: false,
      failedAutoSelectionKeys: new Set(),
    })

    expect(resolution).toEqual({ kind: 'clear' })
  })

  test('re-confirms an already selected lobby so the full lobby snapshot can hydrate', () => {
    expect(shouldRequestActivityTargetSelection({
      option: staleLobby,
      currentTargetKey: activityTargetOptionKey(staleLobby),
    })).toBe(true)
  })

  test('re-confirms an already selected joined lobby', () => {
    expect(shouldRequestActivityTargetSelection({
      option: joinedLobby,
      currentTargetKey: activityTargetOptionKey(joinedLobby),
    })).toBe(true)
  })

  test('does not re-request the same selected match', () => {
    expect(shouldRequestActivityTargetSelection({
      option: joinedMatch,
      currentTargetKey: activityTargetOptionKey(joinedMatch),
    })).toBe(false)
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

  test('reconnects a visible selected draft after the hidden tab disconnects it', () => {
    expect(shouldReconnectVisibleActivityTarget({
      appStatus: 'authenticated',
      connectionStatus: 'disconnected',
      draftStatus: 'active',
    })).toBe(true)
  })

  test('does not duplicate an already in-flight visible reconnect', () => {
    expect(shouldReconnectVisibleActivityTarget({
      appStatus: 'authenticated',
      connectionStatus: 'reconnecting',
      draftStatus: 'active',
    })).toBe(false)
  })

  test('does not reconnect completed selected drafts after the swap window closes', () => {
    expect(shouldReconnectVisibleActivityTarget({
      appStatus: 'authenticated',
      connectionStatus: 'disconnected',
      draftStatus: 'complete',
      hasOpenSwapWindow: false,
    })).toBe(false)
  })

  test('reconnects completed selected drafts while the swap window is still open', () => {
    expect(shouldReconnectVisibleActivityTarget({
      appStatus: 'authenticated',
      connectionStatus: 'disconnected',
      draftStatus: 'complete',
      hasOpenSwapWindow: true,
    })).toBe(true)
  })

  test('reconnects visible lobby targets after the hidden tab disconnects them', () => {
    expect(shouldReconnectVisibleActivityTarget({
      appStatus: 'lobby-waiting',
      connectionStatus: 'disconnected',
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

  test('releases a reverted draft when the target is cleared', () => {
    expect(shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind: null,
      hasInFlightConnection: false,
      draftState: {
        status: 'cancelled',
        cancelReason: 'revert',
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

  test('applies a refreshed launch snapshot while the live state stays unchanged', () => {
    expect(shouldApplyActivityLaunchSnapshotRefresh({
      requestVersion: 2,
      latestRequestVersion: 2,
      requestedChannelId: 'channel-1',
      requestedUserId: 'user-1',
      activeChannelId: 'channel-1',
      activeUserId: 'user-1',
      hydratedLiveState: true,
      liveStateRevisionAtStart: 4,
      liveStateRevision: 4,
    })).toBe(true)
  })

  test('rejects an outdated launch snapshot refresh result', () => {
    expect(shouldApplyActivityLaunchSnapshotRefresh({
      requestVersion: 2,
      latestRequestVersion: 3,
      requestedChannelId: 'channel-1',
      requestedUserId: 'user-1',
      activeChannelId: 'channel-1',
      activeUserId: 'user-1',
      hydratedLiveState: false,
      liveStateRevisionAtStart: 1,
      liveStateRevision: 1,
    })).toBe(false)
  })

  test('rejects a launch snapshot refresh for a different active session', () => {
    expect(shouldApplyActivityLaunchSnapshotRefresh({
      requestVersion: 2,
      latestRequestVersion: 2,
      requestedChannelId: 'channel-1',
      requestedUserId: 'user-1',
      activeChannelId: 'channel-2',
      activeUserId: 'user-1',
      hydratedLiveState: false,
      liveStateRevisionAtStart: 1,
      liveStateRevision: 1,
    })).toBe(false)
  })

  test('rejects a refreshed launch snapshot after newer live watch state arrives', () => {
    expect(shouldApplyActivityLaunchSnapshotRefresh({
      requestVersion: 2,
      latestRequestVersion: 2,
      requestedChannelId: 'channel-1',
      requestedUserId: 'user-1',
      activeChannelId: 'channel-1',
      activeUserId: 'user-1',
      hydratedLiveState: true,
      liveStateRevisionAtStart: 4,
      liveStateRevision: 5,
    })).toBe(false)
  })

  test('requests a repair refresh for timed out drafts that should reopen the lobby', () => {
    expect(getBrokenMatchRefreshKey({
      appStatus: 'authenticated',
      currentMatchId: 'match-1',
      connectionStatus: 'connected',
      draftState: {
        matchId: 'match-1',
        status: 'cancelled',
        cancelReason: 'timeout',
      },
    })).toBe('match-1:cancelled:timeout')
  })

  test('requests a repair refresh when a selected live match fails before state loads', () => {
    expect(getBrokenMatchRefreshKey({
      appStatus: 'authenticated',
      currentMatchId: 'match-1',
      connectionStatus: 'error',
      draftState: null,
    })).toBe('match-1:connection-error')
  })

  test('does not request a repair refresh for healthy or manually scrubbed drafts', () => {
    expect(getBrokenMatchRefreshKey({
      appStatus: 'authenticated',
      currentMatchId: 'match-1',
      connectionStatus: 'connected',
      draftState: {
        matchId: 'match-1',
        status: 'cancelled',
        cancelReason: 'scrub',
      },
    })).toBeNull()

    expect(getBrokenMatchRefreshKey({
      appStatus: 'authenticated',
      currentMatchId: 'match-1',
      connectionStatus: 'connected',
      draftState: {
        matchId: 'match-1',
        status: 'active',
        cancelReason: null,
      },
    })).toBeNull()
  })
})
