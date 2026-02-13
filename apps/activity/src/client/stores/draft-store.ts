import type { DraftEvent, DraftState, DraftStep } from '@civup/game'
import { createStore, produce } from 'solid-js/store'

// ── Types ──────────────────────────────────────────────────

export interface DraftStore {
  /** Full draft state from the server */
  state: DraftState | null
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
}

// ── Store ──────────────────────────────────────────────────

const [draftStore, setDraftStore] = createStore<DraftStore>({
  state: null,
  hostId: null,
  seatIndex: null,
  timerEndsAt: null,
  completedAt: null,
  lastEvents: [],
})

export { draftStore }

// ── Actions ────────────────────────────────────────────────

export function initDraft(
  state: DraftState,
  hostId: string,
  seatIndex: number | null,
  timerEndsAt: number | null,
  completedAt: number | null,
) {
  setDraftStore({
    state,
    hostId,
    seatIndex,
    timerEndsAt,
    completedAt,
    lastEvents: [],
  })
}

export function updateDraft(
  state: DraftState,
  hostId: string,
  events: DraftEvent[],
  timerEndsAt: number | null,
  completedAt: number | null,
) {
  setDraftStore(produce((s) => {
    s.state = state
    s.hostId = hostId
    s.timerEndsAt = timerEndsAt
    s.completedAt = completedAt
    s.lastEvents = events
  }))
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
    return 'MATCH SCRUBBED'
  }

  const step = s.steps[s.currentStepIndex]
  if (!step) return ''

  const action = step.action.toUpperCase()
  const stepNum = s.currentStepIndex + 1
  return `${action} PHASE ${stepNum}`
}

/** Get the timer duration for the current step (in seconds) */
export function currentStepDuration(): number {
  const step = currentStep()
  return step?.timer ?? 0
}
