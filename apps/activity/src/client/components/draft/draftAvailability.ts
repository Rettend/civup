import type { DraftState, DraftStep } from '@civup/game'
import { draftFormatMap } from '@civup/game'

export function allowsDuplicateDraftPicks(state: DraftState | null | undefined): boolean {
  return state?.duplicateFactions === true
}

export function isDraftCardUnavailable(state: DraftState | null | undefined, civId: string): boolean {
  if (!state) return false
  if (state.bans.some(ban => ban.civId === civId)) return true
  if (state.blindPickBans?.some(ban => ban.civId === civId)) return true
  if (isVisibleCurrentSubmission(state, civId)) return true
  if (allowsDuplicateDraftPicks(state)) return false
  return state.picks.some(pick => pick.civId === civId)
}

function isVisibleCurrentSubmission(state: DraftState, civId: string): boolean {
  const step = state.status === 'active' ? state.steps[state.currentStepIndex] : null
  if (!step) return false
  if (step.action === 'ban') {
    if (isBlindBanStep(state, step)) return false
    return Object.values(state.submissions).some(civIds => civIds.includes(civId))
  }
  if (step.action === 'pick' && !step.reveal && !allowsDuplicateDraftPicks(state)) {
    return Object.values(state.submissions).some(civIds => civIds.includes(civId))
  }
  return false
}

function isBlindBanStep(state: DraftState, step: DraftStep): boolean {
  const format = draftFormatMap.get(state.formatId)
  if (format?.blindBans !== true) return false
  if (step.seats === 'all') return true
  return step.seats.length > 1
}
