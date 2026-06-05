import type { MapVoteMapId, RevealedMapVoteSeatBallot } from '@civup/game'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  isMapVoteSelectionConfirmable,
  MAP_VOTE_REVEAL_DURATION_SECONDS,
  MAP_VOTE_VOTING_DURATION_SECONDS,
  MAX_MAP_VOTE_MAP_PICKS,
  normalizeMapVoteSelection,
} from '@civup/game'
import { createMemo } from 'solid-js'
import { sendMapVoteConfirm, sendMapVoteSelection } from './connection-store'
import { draftStore } from './draft-store'

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

export { MAP_VOTE_REVEAL_DURATION_SECONDS, MAP_VOTE_VOTING_DURATION_SECONDS }

export const mapVoteEnabled = () => draftStore.mapVote.enabled
export const mapVotePhase = () => draftStore.mapVote.phase
export const mapVoteSelectedMaps = () => draftStore.mapVote.selection?.maps ?? []
export const mapVoteSelectedMapCount = () => mapVoteSelectedMaps().length
export const mapVoteHasConfirmed = () => draftStore.mapVote.hasConfirmed
export const mapVoteConfirmedSeatIndices = () => draftStore.mapVote.confirmedSeatIndices ?? []
export const mapVoteSeatVotes = () => draftStore.mapVote.revealedVotes ?? []
export const mapVoteWinningType = () => draftStore.mapVote.result?.mapType ?? null
export const mapVoteWinningScript = () => draftStore.mapVote.result?.mapScript ?? null
export const mapVoteWinningTypeCandidate = () => draftStore.mapVote.result?.mapTypeWinner ?? null
export const mapVoteWinningScriptCandidate = () => draftStore.mapVote.result?.mapScriptWinner ?? null
export const mapVoteVotingEndsAt = () => mapVotePhase() === 'voting' ? draftStore.mapVote.endsAt : null
export const mapVoteRevealEndsAt = () => mapVotePhase() === 'reveal' ? draftStore.mapVote.endsAt : null

export const isMapVotePhase = createMemo(() => mapVotePhase() === 'voting' || mapVotePhase() === 'reveal')

interface MapVoteSelectionUpdate {
  selection: { maps: MapVoteMapId[] }
  changed: boolean
  readyToConfirm: boolean
}

interface MapVoteSelectionResult {
  changed: boolean
  readyToConfirm: boolean
}

function buildMapVoteSelectionUpdate(partial: { maps?: MapVoteMapId[] | null }): MapVoteSelectionUpdate | null {
  if (draftStore.mapVote.phase !== 'voting' || draftStore.mapVote.hasConfirmed || draftStore.seatIndex == null) return null

  const currentSelection = normalizeMapVoteSelection(draftStore.mapVote.selection ?? DEFAULT_MAP_VOTE_SELECTION)
  const nextSelection = normalizeMapVoteSelection({
    maps: partial.maps ?? currentSelection.maps,
  })

  return {
    selection: nextSelection,
    changed: currentSelection.maps.join('|') !== nextSelection.maps.join('|'),
    readyToConfirm: isMapVoteSelectionConfirmable(nextSelection),
  }
}

function toggleRankedChoice<T extends string>(current: readonly T[], id: T, max: number): T[] {
  const existingIndex = current.indexOf(id)
  if (existingIndex >= 0) return current.filter(value => value !== id)
  if (current.length >= max) return [...current]
  return [...current, id]
}

export const mapVoteReadyToConfirm = createMemo(() => {
  return mapVotePhase() === 'voting'
    && isMapVoteSelectionConfirmable(draftStore.mapVote.selection)
    && !mapVoteHasConfirmed()
})

export function getSeatMapVote(seatIndex: number): RevealedMapVoteSeatBallot | null {
  return mapVoteSeatVotes().find(vote => vote.seatIndex === seatIndex) ?? null
}

export function isSeatMapVoteConfirmed(seatIndex: number): boolean {
  return mapVoteConfirmedSeatIndices().includes(seatIndex)
}

export function getNextMapVoteSelection(partial: { maps?: MapVoteMapId[] | null }): MapVoteSelectionUpdate | null {
  return buildMapVoteSelectionUpdate(partial)
}

export function toggleMapVoteSelectedMap(id: MapVoteMapId | null): MapVoteSelectionResult {
  if (id == null) return { changed: false, readyToConfirm: false }
  const currentSelection = normalizeMapVoteSelection(draftStore.mapVote.selection ?? DEFAULT_MAP_VOTE_SELECTION)
  const next = getNextMapVoteSelection({ maps: toggleRankedChoice(currentSelection.maps, id, MAX_MAP_VOTE_MAP_PICKS) })
  if (!next) return { changed: false, readyToConfirm: false }
  if (!next.changed) return { changed: false, readyToConfirm: next.readyToConfirm }
  sendMapVoteSelection(next.selection)
  return { changed: true, readyToConfirm: next.readyToConfirm }
}

export function confirmMapVote() {
  if (!mapVoteReadyToConfirm()) return false
  return sendMapVoteConfirm()
}
