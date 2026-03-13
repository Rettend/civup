import type { DraftAction, DraftError, DraftEvent, DraftPreviewState, DraftResult, DraftState, DraftStep } from '@civup/game'
import { getCurrentStep, isDraftError, processDraftInput } from '@civup/game'

export function createEmptyDraftPreviews(): DraftPreviewState {
  return {
    bans: {},
    picks: {},
  }
}

export function draftPreviewsEqual(a: DraftPreviewState, b: DraftPreviewState): boolean {
  return previewMapEqual(a.bans, b.bans) && previewMapEqual(a.picks, b.picks)
}

export function sanitizeDraftPreviews(state: DraftState, previews: DraftPreviewState): DraftPreviewState {
  if (state.status !== 'active') return createEmptyDraftPreviews()

  const step = getCurrentStep(state)
  if (!step) return createEmptyDraftPreviews()

  const available = new Set(state.availableCivIds)
  const sanitizedBans = step.action === 'ban'
    ? sanitizeBanPreviewMap(state, step, previews.bans, available)
    : {}
  const sanitizedPicks = step.action === 'pick'
    ? sanitizePickPreviewMap(state, previews.picks, available)
    : {}

  return {
    bans: sanitizedBans,
    picks: sanitizedPicks,
  }
}

export function applyDraftPreview(
  state: DraftState,
  previews: DraftPreviewState,
  seatIndex: number,
  action: DraftAction,
  civIds: string[],
): DraftPreviewState | DraftError {
  if (state.status !== 'active') return { error: 'Draft is not active' }
  if (seatIndex < 0 || seatIndex >= state.seats.length) return { error: 'Not a participant' }
  if (!Array.isArray(civIds)) return { error: 'civIds must be an array' }

  const step = getCurrentStep(state)
  if (!step) return { error: 'No current step' }

  if (action === 'ban') {
    if (step.action !== 'ban') return { error: 'Current step is not a ban phase' }
    if (!isSeatInStep(step, seatIndex, state.seats.length)) return { error: `Seat ${seatIndex} is not active in this step` }
    if (state.submissions[seatIndex]) return { error: `Seat ${seatIndex} has already submitted for this step` }

    const normalized = normalizePreviewSelections(civIds, new Set(state.availableCivIds), step.count)
    return sanitizeDraftPreviews(state, {
      bans: setPreviewSelections(previews.bans, seatIndex, normalized),
      picks: previews.picks,
    })
  }

  if (step.action !== 'pick') return { error: 'Current step is not a pick phase' }

  const normalized = normalizePreviewSelections(civIds, new Set(state.availableCivIds))
  return sanitizeDraftPreviews(state, {
    bans: previews.bans,
    picks: setPreviewSelections(previews.picks, seatIndex, normalized),
  })
}

export function resolveTimeoutWithPreviews(
  state: DraftState,
  blindBans: boolean,
  previews: DraftPreviewState,
): DraftResult | DraftError {
  const step = getCurrentStep(state)
  if (!step) return processDraftInput(state, { type: 'TIMEOUT' }, blindBans)

  return step.action === 'ban'
    ? resolveBanTimeoutWithPreviews(state, step, blindBans, previews.bans)
    : resolvePickTimeoutWithPreviews(state, step, blindBans, previews.picks)
}

export function censorDraftPreviews(
  state: DraftState,
  previews: DraftPreviewState,
  seatIndex: number,
): DraftPreviewState {
  const sanitized = sanitizeDraftPreviews(state, previews)
  if (state.status !== 'active' || seatIndex < 0) return createEmptyDraftPreviews()

  const step = getCurrentStep(state)
  if (!step) return createEmptyDraftPreviews()

  const ownTeam = state.seats[seatIndex]?.team ?? null
  const visiblePicks: DraftPreviewState['picks'] = {}
  if (step.action === 'pick') {
    for (const [rawSeatIndex, civIds] of Object.entries(sanitized.picks)) {
      const previewSeatIndex = Number(rawSeatIndex)
      const previewSeat = state.seats[previewSeatIndex]
      if (!previewSeat) continue
      if (previewSeatIndex === seatIndex) {
        visiblePicks[previewSeatIndex] = [...civIds]
        continue
      }
      if (ownTeam == null || previewSeat.team == null || previewSeat.team !== ownTeam) continue
      visiblePicks[previewSeatIndex] = [...civIds]
    }
  }

  const ownBans = sanitized.bans[seatIndex]
  return {
    bans: ownBans ? { [seatIndex]: [...ownBans] } : {},
    picks: visiblePicks,
  }
}

function sanitizeBanPreviewMap(
  state: DraftState,
  step: DraftStep,
  previews: DraftPreviewState['bans'],
  available: Set<string>,
): DraftPreviewState['bans'] {
  const sanitized: DraftPreviewState['bans'] = {}
  const reserved = new Set(Object.values(state.submissions).flat())
  const restrictedReserved = step.seats !== 'all' && step.seats.length === 1 ? reserved : undefined

  for (const seatIndex of getActiveSeats(step, state.seats.length)) {
    if (state.submissions[seatIndex]) continue

    const civIds = normalizePreviewSelections(
      previews[seatIndex] ?? [],
      available,
      step.count,
      restrictedReserved,
    )
    if (civIds.length === 0) continue
    sanitized[seatIndex] = civIds
  }

  return sanitized
}

function sanitizePickPreviewMap(
  state: DraftState,
  previews: DraftPreviewState['picks'],
  available: Set<string>,
): DraftPreviewState['picks'] {
  const sanitized: DraftPreviewState['picks'] = {}

  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    if (seatHasLockedPick(state, seatIndex)) continue

    const civIds = normalizePreviewSelections(previews[seatIndex] ?? [], available)
    if (civIds.length === 0) continue
    sanitized[seatIndex] = civIds
  }

  return sanitized
}

function resolveBanTimeoutWithPreviews(
  state: DraftState,
  step: DraftStep,
  blindBans: boolean,
  previews: DraftPreviewState['bans'],
): DraftResult | DraftError {
  let nextState = state
  const events: DraftEvent[] = []
  const reserved = blindBans ? null : new Set(Object.values(state.submissions).flat())

  for (const seatIndex of getActiveSeats(step, state.seats.length)) {
    if (nextState.submissions[seatIndex]) continue

    const civIds = buildTimeoutBanSelections(nextState, step.count, previews[seatIndex] ?? [], reserved)
    if (civIds.length !== step.count) return processDraftInput(nextState, { type: 'TIMEOUT' }, blindBans)

    events.push({ type: 'TIMEOUT_APPLIED', seatIndex, selections: civIds })

    const result = processDraftInput(nextState, { type: 'BAN', seatIndex, civIds }, blindBans)
    if (isDraftError(result)) return result

    events.push(...result.events)
    nextState = result.state

    if (reserved) {
      for (const civId of civIds) reserved.add(civId)
    }

    if (nextState.status !== 'active' || nextState.currentStepIndex !== state.currentStepIndex) break
  }

  return { state: nextState, events }
}

function resolvePickTimeoutWithPreviews(
  state: DraftState,
  step: DraftStep,
  blindBans: boolean,
  previews: DraftPreviewState['picks'],
): DraftResult | DraftError {
  let nextState = state
  const events: DraftEvent[] = []
  let appliedPreviewPick = false

  for (const seatIndex of getPendingSeats(step, nextState)) {
    const previewResult = applyPreviewPickTimeout(nextState, blindBans, seatIndex, previews[seatIndex] ?? [])
    if (!previewResult) continue

    appliedPreviewPick = true
    events.push({ type: 'TIMEOUT_APPLIED', seatIndex, selections: [previewResult.civId] }, ...previewResult.result.events)
    nextState = previewResult.result.state

    if (nextState.status !== 'active' || nextState.currentStepIndex !== state.currentStepIndex) break
  }

  if (!appliedPreviewPick) return processDraftInput(state, { type: 'TIMEOUT' }, blindBans)
  if (nextState.status !== 'active' || nextState.currentStepIndex !== state.currentStepIndex) return { state: nextState, events }
  if (getPendingSeats(step, nextState).length === 0) return { state: nextState, events }

  const timeoutResult = processDraftInput(nextState, { type: 'TIMEOUT' }, blindBans)
  if (isDraftError(timeoutResult)) return timeoutResult

  return {
    state: timeoutResult.state,
    events: [...events, ...timeoutResult.events],
  }
}

function applyPreviewPickTimeout(
  state: DraftState,
  blindBans: boolean,
  seatIndex: number,
  civIds: string[],
): { civId: string, result: DraftResult } | null {
  for (const civId of civIds) {
    const result = processDraftInput(state, { type: 'PICK', seatIndex, civId }, blindBans)
    if (!isDraftError(result)) return { civId, result }
  }

  return null
}

function buildTimeoutBanSelections(
  state: DraftState,
  count: number,
  previewSelections: string[],
  reserved: Set<string> | null,
): string[] {
  const available = state.availableCivIds.filter((civId) => {
    if (reserved?.has(civId)) return false
    return true
  })
  const selected: string[] = []
  const selectedSet = new Set<string>()

  for (const civId of previewSelections) {
    if (!state.availableCivIds.includes(civId)) continue
    if (reserved?.has(civId)) continue
    if (selectedSet.has(civId)) continue
    selected.push(civId)
    selectedSet.add(civId)
    if (selected.length >= count) return selected
  }

  const remainingPool = available.filter(civId => !selectedSet.has(civId))
  while (selected.length < count && remainingPool.length > 0) {
    const index = Math.floor(Math.random() * remainingPool.length)
    const [civId] = remainingPool.splice(index, 1)
    if (!civId) continue
    selected.push(civId)
    selectedSet.add(civId)
  }

  return selected
}

function getActiveSeats(step: DraftStep, seatCount: number): number[] {
  if (step.seats === 'all') return Array.from({ length: seatCount }, (_, seatIndex) => seatIndex)
  return step.seats
}

function getPendingSeats(step: DraftStep, state: DraftState): number[] {
  return getActiveSeats(step, state.seats.length).filter((seatIndex) => {
    const submitted = state.submissions[seatIndex]?.length ?? 0
    return submitted < step.count
  })
}

function isSeatInStep(step: DraftStep, seatIndex: number, seatCount: number): boolean {
  if (step.seats === 'all') return seatIndex >= 0 && seatIndex < seatCount
  return step.seats.includes(seatIndex)
}

function seatHasLockedPick(state: DraftState, seatIndex: number): boolean {
  return state.picks.some(pick => pick.seatIndex === seatIndex)
}

function normalizePreviewSelections(
  civIds: string[],
  available: Set<string>,
  maxCount: number = Number.POSITIVE_INFINITY,
  reserved?: Set<string>,
): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const civId of civIds) {
    if (typeof civId !== 'string') continue
    if (seen.has(civId)) continue
    if (!available.has(civId)) continue
    if (reserved?.has(civId)) continue
    normalized.push(civId)
    seen.add(civId)
    if (normalized.length >= maxCount) break
  }

  return normalized
}

function setPreviewSelections(
  previews: Record<number, string[]>,
  seatIndex: number,
  civIds: string[],
): Record<number, string[]> {
  const next = { ...previews }
  if (civIds.length === 0) delete next[seatIndex]
  else next[seatIndex] = civIds
  return next
}

function previewMapEqual(a: Record<number, string[]>, b: Record<number, string[]>): boolean {
  const aEntries = Object.entries(a)
  const bEntries = Object.entries(b)
  if (aEntries.length !== bEntries.length) return false

  for (const [seatIndex, civIds] of aEntries) {
    const other = b[Number(seatIndex)]
    if (!other || other.length !== civIds.length) return false
    for (let index = 0; index < civIds.length; index++) {
      if (other[index] !== civIds[index]) return false
    }
  }

  return true
}
