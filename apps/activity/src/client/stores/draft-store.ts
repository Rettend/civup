import type { DraftEvent, DraftPreviewState, DraftSelection, DraftState, DraftStep, LeaderDataVersion, LeaderSwapState, PendingLeaderSwapRequest } from '@civup/game'
import { inferGameMode, isRedDeathFormatId } from '@civup/game'
import { createStore, produce } from 'solid-js/store'

const EMPTY_DRAFT_PREVIEWS: DraftPreviewState = {
  bans: {},
  picks: {},
}

const SWAP_FLASH_DURATION_MS = 600

// ── Types ──────────────────────────────────────────────────

export interface DraftStore {
  /** Full draft state from the server */
  state: DraftState | null
  /** Which leader text set the draft uses */
  leaderDataVersion: LeaderDataVersion
  /** Host Discord user ID */
  hostId: string | null
  /** This client's seat index (null = spectator) */
  seatIndex: number | null
  /** Server-provided timer end timestamp (ms) */
  timerEndsAt: number | null
  /** When draft completed (ms timestamp) */
  completedAt: number | null
  /** Recent events for animation triggers */
  lastEvents: DraftEvent[]
  /** Local optimistic picks keyed by seat index */
  optimisticSeatPicks: Record<number, string>
  /** Server-authoritative tentative selections visible to this client */
  previews: DraftPreviewState
  /** Post-draft teammate swap state, when the swap window is open. */
  swapState: LeaderSwapState | null
  /** Recently swapped seats for transient portrait flash effects. */
  swapFlashSeatIndices: number[]
  /** Increments whenever the socket receives a fresh init payload. */
  initVersion: number
}

// ── Store ──────────────────────────────────────────────────

const [draftStore, setDraftStore] = createStore<DraftStore>({
  state: null,
  leaderDataVersion: 'live',
  hostId: null,
  seatIndex: null,
  timerEndsAt: null,
  completedAt: null,
  lastEvents: [],
  optimisticSeatPicks: {},
  previews: EMPTY_DRAFT_PREVIEWS,
  swapState: null,
  swapFlashSeatIndices: [],
  initVersion: 0,
})

export { draftStore }

let swapFlashTimeout: ReturnType<typeof setTimeout> | null = null

// ── Actions ────────────────────────────────────────────────

export function initDraft(
  state: DraftState,
  leaderDataVersion: LeaderDataVersion,
  hostId: string,
  seatIndex: number | null,
  timerEndsAt: number | null,
  completedAt: number | null,
  previews: DraftPreviewState,
  swapState: LeaderSwapState | null,
) {
  clearSwapFlash()
  const nextInitVersion = draftStore.initVersion + 1
  setDraftStore({
    state,
    leaderDataVersion,
    hostId,
    seatIndex,
    timerEndsAt,
    completedAt,
    lastEvents: [],
    optimisticSeatPicks: {},
    previews,
    swapState,
    swapFlashSeatIndices: [],
    initVersion: nextInitVersion,
  })
}

export function resetDraft() {
  clearSwapFlash()
  setDraftStore({
    state: null,
    leaderDataVersion: 'live',
    hostId: null,
    seatIndex: null,
    timerEndsAt: null,
    completedAt: null,
    lastEvents: [],
    optimisticSeatPicks: {},
    previews: EMPTY_DRAFT_PREVIEWS,
    swapState: null,
    swapFlashSeatIndices: [],
    initVersion: 0,
  })
}

export function updateDraft(
  state: DraftState,
  leaderDataVersion: LeaderDataVersion,
  hostId: string,
  events: DraftEvent[],
  timerEndsAt: number | null,
  completedAt: number | null,
  previews: DraftPreviewState,
  swapState: LeaderSwapState | null,
) {
  setDraftStore(produce((s) => {
    s.state = state
    s.leaderDataVersion = leaderDataVersion
    s.hostId = hostId
    s.timerEndsAt = timerEndsAt
    s.completedAt = completedAt
    s.lastEvents = events
    s.optimisticSeatPicks = {}
    s.previews = previews
    s.swapState = swapState
  }))
}

export function updateDraftPreviews(previews: DraftPreviewState) {
  setDraftStore('previews', previews)
}

export function applySwapUpdate(swapState: LeaderSwapState, picks?: DraftSelection[]) {
  const previousPendingSwaps = draftStore.swapState?.pendingSwaps ?? []
  const resolvedSwap = picks ? findResolvedPendingSwap(previousPendingSwaps, swapState.pendingSwaps) : null
  const flashSeats = resolvedSwap ? [resolvedSwap.fromSeat, resolvedSwap.toSeat] : []

  setDraftStore(produce((s) => {
    s.swapState = swapState
    if (picks && s.state) s.state.picks = picks
    if (flashSeats.length > 0) s.swapFlashSeatIndices = flashSeats
  }))

  if (flashSeats.length === 0) return

  clearSwapFlashTimeout()
  swapFlashTimeout = setTimeout(() => {
    setDraftStore('swapFlashSeatIndices', [])
    swapFlashTimeout = null
  }, SWAP_FLASH_DURATION_MS)
}

/** Optimistically show a pick for this client's seat until server update arrives. */
export function setOptimisticSeatPick(civId: string): void {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || s.status !== 'active' || seat == null) return

  const step = s.steps[s.currentStepIndex]
  if (!step || step.action !== 'pick') return

  const seatIsInStep = step.seats === 'all'
    ? seat >= 0 && seat < s.seats.length
    : step.seats.includes(seat)
  if (!seatIsInStep) return

  const submittedCount = s.submissions[seat]?.length ?? 0
  if (submittedCount >= step.count) return

  setDraftStore('optimisticSeatPicks', seat, civId)
}

export function getOptimisticSeatPick(seatIndex: number): string | null {
  return draftStore.optimisticSeatPicks[seatIndex] ?? null
}

export function getPreviewPicksForSeat(seatIndex: number): string[] {
  return draftStore.previews.picks[seatIndex] ?? []
}

export function getPreviewPickForSeat(seatIndex: number): string | null {
  return getPreviewPicksForSeat(seatIndex)[0] ?? null
}

export function seatHasLockedPick(seatIndex: number): boolean {
  return draftStore.state?.picks.some(pick => pick.seatIndex === seatIndex) ?? false
}

export function canSendPickPreview(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || s.status !== 'active' || seat == null) return false

  const step = s.steps[s.currentStepIndex]
  if (!step || step.action !== 'pick') return false
  if (seatHasLockedPick(seat)) return false
  if (!canOpenLeaderGrid()) return false

  return isRedDeathDraft() ? isMyTurn() : true
}

export function isSwapWindowOpen(): boolean {
  return draftStore.state?.status === 'complete' && draftStore.swapState != null
}

export function canRequestSwapWith(seatIndex: number): boolean {
  const state = draftStore.state
  const mySeatIndex = draftStore.seatIndex
  if (!state || !isSwapWindowOpen() || mySeatIndex == null) return false
  if (mySeatIndex === seatIndex) return false

  const mySeat = state.seats[mySeatIndex]
  const targetSeat = state.seats[seatIndex]
  if (!mySeat || !targetSeat) return false
  if (mySeat.team == null || targetSeat.team == null || mySeat.team !== targetSeat.team) return false
  if (getOutgoingSwapForSeat(mySeatIndex)) return false
  if (getIncomingSwapForSeat(seatIndex)) return false
  if (hasPendingSwapBetweenSeats(mySeatIndex, seatIndex)) return false

  return state.picks.some(pick => pick.seatIndex === mySeatIndex)
    && state.picks.some(pick => pick.seatIndex === seatIndex)
}

export function seatHasIncomingSwap(seatIndex: number): boolean {
  return getIncomingSwapForSeat(seatIndex) != null
}

export function seatHasOutgoingSwap(seatIndex: number): boolean {
  return getOutgoingSwapForSeat(seatIndex) != null
}

export function seatJustSwapped(seatIndex: number): boolean {
  return draftStore.swapFlashSeatIndices.includes(seatIndex)
}

export function currentMode() {
  return inferGameMode(draftStore.state?.formatId)
}

export function isRedDeathDraft(): boolean {
  return isRedDeathFormatId(draftStore.state?.formatId)
}

export function dealtCivIds(): string[] | null {
  return draftStore.state?.dealtCivIds ?? null
}

export function canOpenLeaderGrid(): boolean {
  const s = draftStore.state
  if (!s || s.status !== 'active') return false
  if (!isRedDeathDraft()) return true
  return (s.dealtCivIds?.length ?? 0) > 0
}

// ── Derived Helpers ────────────────────────────────────────

/** Current step or null */
export function currentStep(): DraftStep | null {
  const s = draftStore.state
  if (!s || s.status !== 'active') return null
  return s.steps[s.currentStepIndex] ?? null
}

/** Whether this client's seat is active in the current step */
export function isMyTurn(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || s.status !== 'active' || seat == null) return false

  const step = s.steps[s.currentStepIndex]
  if (!step) return false

  if (step.seats === 'all') return true
  return step.seats.includes(seat)
}

/** Whether this client has already submitted for the current step */
export function hasSubmitted(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || seat == null) return false

  const submissions = s.submissions[seat]
  if (!submissions) return false

  const step = s.steps[s.currentStepIndex]
  if (!step) return false

  return submissions.length >= step.count
}

/** Whether the client is a spectator (not a participant) */
export function isSpectator(): boolean {
  return draftStore.seatIndex == null
}

/** Current phase label for display */
export function phaseLabel(): string {
  const s = draftStore.state
  if (!s) return ''
  if (s.status === 'waiting') return 'WAITING'
  if (s.status === 'complete') return 'DRAFT COMPLETE'
  if (s.status === 'cancelled') {
    if (s.cancelReason === 'cancel') return 'DRAFT CANCELLED'
    if (s.cancelReason === 'timeout') return 'AUTO-SCRUBBED'
    if (s.cancelReason === 'revert') return 'DRAFT REVERTED'
    return 'MATCH SCRUBBED'
  }

  const step = s.steps[s.currentStepIndex]
  if (!step) return ''

  return step.action === 'ban' ? 'BAN PHASE' : 'PICK PHASE'
}

/** Get the timer duration for the current step (in seconds) */
export function currentStepDuration(): number {
  const step = currentStep()
  return step?.timer ?? 0
}

function clearSwapFlash() {
  clearSwapFlashTimeout()
  setDraftStore('swapFlashSeatIndices', [])
}

function clearSwapFlashTimeout() {
  if (!swapFlashTimeout) return
  clearTimeout(swapFlashTimeout)
  swapFlashTimeout = null
}

function getIncomingSwapForSeat(seatIndex: number): PendingLeaderSwapRequest | null {
  return draftStore.swapState?.pendingSwaps.find(swap => swap.toSeat === seatIndex) ?? null
}

function getOutgoingSwapForSeat(seatIndex: number): PendingLeaderSwapRequest | null {
  return draftStore.swapState?.pendingSwaps.find(swap => swap.fromSeat === seatIndex) ?? null
}

function hasPendingSwapBetweenSeats(leftSeat: number, rightSeat: number): boolean {
  return draftStore.swapState?.pendingSwaps.some(
    swap => (swap.fromSeat === leftSeat && swap.toSeat === rightSeat)
      || (swap.fromSeat === rightSeat && swap.toSeat === leftSeat),
  ) ?? false
}

function findResolvedPendingSwap(
  previousPendingSwaps: PendingLeaderSwapRequest[],
  nextPendingSwaps: PendingLeaderSwapRequest[],
): PendingLeaderSwapRequest | null {
  return previousPendingSwaps.find(
    previous => !nextPendingSwaps.some(
      next => next.fromSeat === previous.fromSeat && next.toSeat === previous.toSeat,
    ),
  ) ?? null
}
