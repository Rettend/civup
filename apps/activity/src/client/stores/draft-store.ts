import type { DraftEvent, DraftPreviewState, DraftSelection, DraftState, DraftStep, LeaderDataVersion, LeaderSwapState, MapVoteSnapshot } from '@civup/game'
import { EMPTY_MAP_VOTE_SNAPSHOT, getPickSeatForPlayer, inferGameMode, isCivBlitzFormatId, isRedDeathFormatId } from '@civup/game'
import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'

const EMPTY_DRAFT_PREVIEWS: DraftPreviewState = {
  bans: {},
  picks: {},
}

const SWAP_FLASH_DURATION_MS = 600
export const BLIND_PICK_SUBMISSION_PLACEHOLDER = '__blind__'

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
  /** Steam lobby deep link projected by the session aggregate. */
  steamLobbyLink: string | null
  /** Whether completed FFA result reporting should group adjacent placements as allies. */
  permanentAlly: boolean
  /** Server-authoritative pre-draft map vote state. */
  mapVote: MapVoteSnapshot
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
  steamLobbyLink: null,
  permanentAlly: false,
  mapVote: EMPTY_MAP_VOTE_SNAPSHOT,
  swapFlashSeatIndices: [],
  initVersion: 0,
})

const [serverTimeOffsetMs, setServerTimeOffsetMs] = createSignal(0)

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
  mapVote: MapVoteSnapshot = EMPTY_MAP_VOTE_SNAPSHOT,
  steamLobbyLink: string | null = null,
  permanentAlly = false,
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
    steamLobbyLink,
    permanentAlly,
    mapVote,
    swapFlashSeatIndices: [],
    initVersion: nextInitVersion,
  })
}

export function resetDraft() {
  clearSwapFlash()
  setServerTimeOffsetMs(0)
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
    steamLobbyLink: null,
    permanentAlly: false,
    mapVote: EMPTY_MAP_VOTE_SNAPSHOT,
    swapFlashSeatIndices: [],
    initVersion: 0,
  })
}

export function syncDraftServerTime(serverNow: number | null | undefined, receivedAt: number = Date.now()): void {
  if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return
  setServerTimeOffsetMs(serverNow - receivedAt)
}

export function draftNow(localNow: number = Date.now()): number {
  return localNow + serverTimeOffsetMs()
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
  mapVote: MapVoteSnapshot = EMPTY_MAP_VOTE_SNAPSHOT,
  steamLobbyLink: string | null = null,
  permanentAlly = false,
) {
  const flashSeats = swapState ? findChangedPickSeats(draftStore.state?.picks ?? [], state.picks) : []

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
    s.steamLobbyLink = steamLobbyLink
    s.permanentAlly = permanentAlly
    s.mapVote = mapVote
    if (flashSeats.length > 0) s.swapFlashSeatIndices = flashSeats
  }))

  if (flashSeats.length === 0) return

  clearSwapFlashTimeout()
  swapFlashTimeout = setTimeout(() => {
    setDraftStore('swapFlashSeatIndices', [])
    swapFlashTimeout = null
  }, SWAP_FLASH_DURATION_MS)
}

export function updateDraftSteamLobbyLink(steamLobbyLink: string | null) {
  setDraftStore('steamLobbyLink', steamLobbyLink)
}

export function updateDraftPreviews(previews: DraftPreviewState) {
  setDraftStore('previews', previews)
}

/** Optimistically show a pick for this client's seat until server update arrives. */
export function setOptimisticSeatPick(civId: string): void {
  const s = draftStore.state
  const seat = currentPickTargetSeatIndex()
  if (!s || s.status !== 'active' || seat == null) return

  const step = s.steps[s.currentStepIndex]
  if (!step || step.action !== 'pick') return
  if ((s.submissions[seat]?.length ?? 0) >= step.count) return

  setDraftStore('optimisticSeatPicks', seat, step.blind ? BLIND_PICK_SUBMISSION_PLACEHOLDER : civId)
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

/** Get the seat this client would currently submit a pick for. */
export function currentPickTargetSeatIndex(): number | null {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || seat == null) return null
  return getPickSeatForPlayer(s, seat)
}

/** Whether the current pick turn belongs to this client's own seat. */
export function isMyOwnPickTurn(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || s.status !== 'active' || seat == null) return false

  const step = s.steps[s.currentStepIndex]
  if (!step || step.action !== 'pick') return false
  return currentPickTargetSeatIndex() === seat
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
  if (step.reveal || step.civBlitz) return false
  if (step.blind) {
    const submittedCount = Math.max(s.submissions[seat]?.length ?? 0, draftStore.optimisticSeatPicks[seat] ? 1 : 0)
    if (submittedCount >= step.count) return false
  }
  if (seatHasLockedPick(seat)) return false
  const targetSeat = currentPickTargetSeatIndex()
  if (targetSeat != null && targetSeat !== seat) return false
  if (!canOpenLeaderGrid()) return false

  return isRedDeathDraft() ? isMyTurn() : true
}

export function isSwapWindowOpen(): boolean {
  return draftStore.state?.status === 'complete' && draftStore.swapState != null
}

export function isHiddenDraftComplete(): boolean {
  const state = draftStore.state
  return state?.status === 'complete' && !state.civBlitz && state.picks.length === 0
}

export function canSwapLeadersWith(seatIndex: number): boolean {
  const state = draftStore.state
  const mySeatIndex = draftStore.seatIndex
  if (!state || !isSwapWindowOpen() || mySeatIndex == null) return false
  if (mySeatIndex === seatIndex) return false

  const mySeat = state.seats[mySeatIndex]
  const targetSeat = state.seats[seatIndex]
  if (!mySeat || !targetSeat) return false
  if (mySeat.team == null || targetSeat.team == null || mySeat.team !== targetSeat.team) return false

  if (state.civBlitz) {
    return hasCompleteCivBlitzKit(mySeatIndex) && hasCompleteCivBlitzKit(seatIndex)
  }

  return state.picks.some(pick => pick.seatIndex === mySeatIndex)
    && state.picks.some(pick => pick.seatIndex === seatIndex)
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

export function isCivBlitzDraft(): boolean {
  return isCivBlitzFormatId(draftStore.state?.formatId)
}

export function dealtCivIds(): string[] | null {
  return draftStore.state?.dealtCivIds ?? null
}

export function canOpenLeaderGrid(): boolean {
  const s = draftStore.state
  if (!s || s.status !== 'active') return false
  const step = currentStep()
  if (step?.reveal) return false
  if (step?.civBlitz) {
    if (!s.civBlitz) return false
    const seat = draftStore.seatIndex
    return seat == null || !!s.civBlitz.optionsBySeat[seat]
  }
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

/** Whether this client can act in the current step. */
export function isMyTurn(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || s.status !== 'active' || seat == null) return false

  const step = s.steps[s.currentStepIndex]
  if (!step) return false
  if (step.action === 'pick') return currentPickTargetSeatIndex() != null

  if (step.seats === 'all') return true
  return step.seats.includes(seat)
}

/** Whether this client has already submitted for the current step */
export function hasSubmitted(): boolean {
  const s = draftStore.state
  const seat = draftStore.seatIndex
  if (!s || seat == null) return false

  const step = s.steps[s.currentStepIndex]
  if (!step) return false

  const targetSeat = step.action === 'pick'
    ? currentPickTargetSeatIndex() ?? seat
    : seat

  const submissionCount = s.submissions[targetSeat]?.length ?? 0
  const optimisticCount = draftStore.optimisticSeatPicks[targetSeat] ? 1 : 0
  return Math.max(submissionCount, optimisticCount) >= step.count
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

  if (s.blindPickReveal || s.civBlitz?.reveal) return 'CONFLICT'
  if (step.action === 'ban') return 'BAN PHASE'
  if (step.civBlitz) return 'PICK PHASE'
  if (step.blind) return 'PICK PHASE'
  return 'PICK PHASE'
}

function hasCompleteCivBlitzKit(seatIndex: number): boolean {
  const kit = draftStore.state?.civBlitz?.lockedKits[seatIndex]
  return !!kit
    && typeof kit.civilizationAbility === 'string'
    && typeof kit.leaderAbility === 'string'
    && typeof kit.infrastructure === 'string'
    && typeof kit.unit === 'string'
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

function findChangedPickSeats(previousPicks: DraftSelection[], nextPicks: DraftSelection[]): number[] {
  const previousBySeat = new Map(previousPicks.map(pick => [pick.seatIndex, pick.civId]))
  const nextBySeat = new Map(nextPicks.map(pick => [pick.seatIndex, pick.civId]))
  const seatIndices = new Set([...previousBySeat.keys(), ...nextBySeat.keys()])

  return [...seatIndices].filter(seatIndex => previousBySeat.get(seatIndex) !== nextBySeat.get(seatIndex))
}
