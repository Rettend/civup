import type { DraftEvent, DraftState } from '@civup/game'

export function pickRandomDistinct<T>(items: T[], count: number): T[] {
  const pool = [...items]
  const picks: T[] = []
  const target = Math.max(0, Math.min(count, pool.length))
  for (let i = 0; i < target; i++) {
    const index = Math.floor(Math.random() * pool.length)
    const [next] = pool.splice(index, 1)
    if (next != null) picks.push(next)
  }
  return picks
}

function pickRandomWithReplacement<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return []
  return Array.from({ length: count }, () => items[Math.floor(Math.random() * items.length)]!)
}

export function buildRandomDraftResult(state: DraftState): { state: DraftState, events: DraftEvent[] } {
  const assignedIds = state.duplicateFactions === true
    ? pickRandomWithReplacement(state.availableCivIds, state.seats.length)
    : pickRandomDistinct(state.availableCivIds, state.seats.length)
  const picks = state.seats.map((_, seatIndex) => ({
    civId: assignedIds[seatIndex]!,
    seatIndex,
    stepIndex: seatIndex,
  }))

  return {
    state: {
      ...state,
      currentStepIndex: state.steps.length,
      submissions: {},
      picks,
      availableCivIds: state.duplicateFactions === true
        ? state.availableCivIds
        : state.availableCivIds.filter(civId => !picks.some(pick => pick.civId === civId)),
      dealtCivIds: null,
      status: 'complete',
      cancelReason: null,
    },
    events: [
      { type: 'DRAFT_STARTED' },
      { type: 'DRAFT_COMPLETE' },
    ],
  }
}
