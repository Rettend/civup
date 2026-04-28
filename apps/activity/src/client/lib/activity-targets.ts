import type { ActivityTargetOption } from '~/client/stores'

export type ActivityTargetDescriptor = Pick<ActivityTargetOption, 'kind' | 'id'> | null | undefined

export function activityTargetOptionKey(option: Pick<ActivityTargetOption, 'kind' | 'id'>): string {
  return `${option.kind}:${option.id}`
}

export function activityTargetsMatch(
  left: ActivityTargetDescriptor,
  right: ActivityTargetDescriptor,
): boolean {
  return left?.kind === right?.kind && left?.id === right?.id
}

export function filterClearedActivityTargetOptions(
  options: readonly ActivityTargetOption[],
  clearedTarget: ActivityTargetDescriptor,
): ActivityTargetOption[] {
  if (!clearedTarget) return [...options]
  return options.filter(option => !activityTargetsMatch(option, clearedTarget))
}

/** Returns true when a previously resolved target was explicitly cleared. */
export function didClearResolvedActivityTarget(
  previous: ActivityTargetDescriptor,
  next: ActivityTargetDescriptor,
): boolean {
  return previous != null && next == null
}

export function shouldRequestActivityTargetSelection(input: {
  option: ActivityTargetOption
  currentTargetKey: string | null
}): boolean {
  const optionKey = activityTargetOptionKey(input.option)
  if (input.currentTargetKey !== optionKey) return true

  return input.option.kind === 'lobby'
}

/** Chooses a default target only when it is still safe to auto-select one. */
export function resolveAutoSelectedActivityTarget(input: {
  options: readonly ActivityTargetOption[]
  target: ActivityTargetDescriptor
  overviewPinned: boolean
  suppressAutoSelection: boolean
}): ActivityTargetOption | null {
  const hasResolvedTarget = input.target != null
    && input.options.some(option => option.kind === input.target?.kind && option.id === input.target?.id)

  if (hasResolvedTarget || input.overviewPinned || input.suppressAutoSelection) return null

  return input.options.find(option => (option.isHost || option.isMember) && option.kind === 'match' && option.status === 'drafting')
    ?? input.options.find(option => (option.isHost || option.isMember) && option.kind === 'lobby')
    ?? null
}

export function shouldApplyResolvedActivitySelection(input: {
  isOverviewVisible: boolean
  allowSelectionWhileOverview: boolean
}): boolean {
  return !input.isOverviewVisible || input.allowSelectionWhileOverview
}

export function shouldReconnectVisibleActivityTarget(input: {
  appStatus: 'loading' | 'error' | 'overview' | 'lobby-waiting' | 'authenticated' | 'reported'
  connectionStatus: string
  draftStatus?: string | null
}): boolean {
  if (input.connectionStatus === 'connecting' || input.connectionStatus === 'reconnecting' || input.connectionStatus === 'connected') return false
  if (input.appStatus === 'lobby-waiting') return true
  if (input.appStatus !== 'authenticated') return false
  if (input.draftStatus === 'complete' || input.draftStatus === 'cancelled') return false
  return true
}

export function shouldHoldAuthenticatedDraftStateForSelection(input: {
  nextSelectionKind: 'lobby' | 'match' | null
  hasInFlightConnection: boolean
  draftState: { status?: string, cancelReason?: string | null } | null | undefined
}): boolean {
  if (input.hasInFlightConnection) return true
  if (!input.draftState) return false

  if (input.nextSelectionKind == null && input.draftState.status === 'complete') {
    return false
  }

  if (
    input.nextSelectionKind === 'lobby'
    && input.draftState.status === 'cancelled'
    && (input.draftState.cancelReason === 'timeout' || input.draftState.cancelReason === 'revert')
  ) {
    return false
  }

  return true
}

export function shouldApplyActivityLaunchSnapshotRefresh(input: {
  requestVersion: number
  latestRequestVersion: number
  requestedChannelId: string
  requestedUserId: string
  activeChannelId: string | null
  activeUserId: string | null
  hydratedLiveState: boolean
  liveStateRevisionAtStart: number
  liveStateRevision: number
}): boolean {
  if (input.requestVersion !== input.latestRequestVersion) return false
  if (input.requestedChannelId !== input.activeChannelId || input.requestedUserId !== input.activeUserId) return false
  if (
    input.hydratedLiveState
    && input.liveStateRevision !== input.liveStateRevisionAtStart
  ) {
    return false
  }

  return true
}

export function getBrokenMatchRefreshKey(input: {
  appStatus: 'loading' | 'error' | 'overview' | 'lobby-waiting' | 'authenticated' | 'reported'
  currentMatchId: string | null
  connectionStatus: string
  draftState: { matchId?: string, status?: string, cancelReason?: string | null } | null | undefined
}): string | null {
  if (input.appStatus !== 'authenticated' || !input.currentMatchId) return null

  if (
    input.draftState?.matchId === input.currentMatchId
    && input.draftState.status === 'cancelled'
    && (input.draftState.cancelReason === 'timeout' || input.draftState.cancelReason === 'revert')
  ) {
    return `${input.currentMatchId}:cancelled:${input.draftState.cancelReason}`
  }

  if (input.connectionStatus === 'error' && (!input.draftState || input.draftState.matchId !== input.currentMatchId)) {
    return `${input.currentMatchId}:connection-error`
  }

  return null
}
