import type { DraftState } from '@civup/game'

export function allowsDuplicateDraftPicks(state: DraftState | null | undefined): boolean {
  return state?.duplicateFactions === true
}

export function isDraftCardUnavailable(state: DraftState | null | undefined, civId: string): boolean {
  if (!state) return false
  if (state.bans.some(ban => ban.civId === civId)) return true
  if (allowsDuplicateDraftPicks(state)) return false
  return state.picks.some(pick => pick.civId === civId)
}
