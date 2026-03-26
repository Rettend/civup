import type { ActivityTargetOption } from '~/client/stores'

export type ActivityTargetDescriptor = Pick<ActivityTargetOption, 'kind' | 'id'> | null | undefined

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

  return input.options.find(option => (option.isHost || option.isMember) && option.kind === 'match')
    ?? input.options.find(option => option.isHost || option.isMember)
    ?? input.options.find(option => option.kind === 'match')
    ?? null
}

export function shouldApplyResolvedActivitySelection(input: {
  isOverviewVisible: boolean
  allowSelectionWhileOverview: boolean
}): boolean {
  return !input.isOverviewVisible || input.allowSelectionWhileOverview
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
