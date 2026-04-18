import type { MapScriptId, MapTypeId, RevealedMapVoteSeatBallot } from '@civup/game'
import { createMemo } from 'solid-js'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  isMapVoteSelectionConfirmable,
  MAX_MAP_VOTE_MAP_SCRIPT_PICKS,
  MAP_VOTE_REVEAL_DURATION_SECONDS,
  MAP_VOTE_VOTING_DURATION_SECONDS,
  normalizeMapVoteSelection,
} from '@civup/game'
import { sendMapVoteConfirm, sendMapVoteSelection } from './connection-store'
import { draftStore } from './draft-store'

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

export { MAP_VOTE_REVEAL_DURATION_SECONDS, MAP_VOTE_VOTING_DURATION_SECONDS }

export const mapVoteEnabled = () => draftStore.mapVote.enabled
export const mapVotePhase = () => draftStore.mapVote.phase
export const mapVoteSelectedType = () => draftStore.mapVote.selection?.mapType ?? null
export const mapVoteSelectedScripts = () => draftStore.mapVote.selection?.mapScripts ?? []
export const mapVoteSelectedScriptCount = () => mapVoteSelectedScripts().length
export const mapVoteHasConfirmed = () => draftStore.mapVote.hasConfirmed
export const mapVoteSeatVotes = () => draftStore.mapVote.revealedVotes ?? []
export const mapVoteWinningType = () => draftStore.mapVote.result?.mapType ?? null
export const mapVoteWinningScript = () => draftStore.mapVote.result?.mapScript ?? null
export const mapVoteVotingEndsAt = () => mapVotePhase() === 'voting' ? draftStore.mapVote.endsAt : null
export const mapVoteRevealEndsAt = () => mapVotePhase() === 'reveal' ? draftStore.mapVote.endsAt : null

export const isMapVotePhase = createMemo(() => mapVotePhase() === 'voting' || mapVotePhase() === 'reveal')

interface MapVoteSelectionUpdate {
  selection: { mapType: MapTypeId, mapScripts: MapScriptId[] }
  changed: boolean
  readyToConfirm: boolean
}

interface MapVoteSelectionResult {
  changed: boolean
  readyToConfirm: boolean
}

function buildMapVoteSelectionUpdate(partial: { mapType?: MapTypeId | null, mapScripts?: MapScriptId[] | null }): MapVoteSelectionUpdate | null {
  if (draftStore.mapVote.phase !== 'voting' || draftStore.mapVote.hasConfirmed || draftStore.seatIndex == null) return null

  const currentSelection = normalizeMapVoteSelection(draftStore.mapVote.selection ?? DEFAULT_MAP_VOTE_SELECTION)
  const nextSelection = normalizeMapVoteSelection({
    mapType: partial.mapType ?? currentSelection.mapType,
    mapScripts: partial.mapScripts ?? currentSelection.mapScripts,
  })

  return {
    selection: nextSelection,
    changed: currentSelection.mapType !== nextSelection.mapType || currentSelection.mapScripts.join('|') !== nextSelection.mapScripts.join('|'),
    readyToConfirm: isMapVoteSelectionConfirmable(nextSelection),
  }
}

export const mapVoteReadyToConfirm = createMemo(() => {
  return mapVotePhase() === 'voting'
    && isMapVoteSelectionConfirmable(draftStore.mapVote.selection)
    && !mapVoteHasConfirmed()
})

export function getSeatMapVote(seatIndex: number): RevealedMapVoteSeatBallot | null {
  return mapVoteSeatVotes().find(vote => vote.seatIndex === seatIndex) ?? null
}

export function getNextMapVoteSelection(partial: { mapType?: MapTypeId | null, mapScripts?: MapScriptId[] | null }): MapVoteSelectionUpdate | null {
  return buildMapVoteSelectionUpdate(partial)
}

export function setMapVoteSelectedType(id: MapTypeId | null): MapVoteSelectionResult {
  if (id == null) return { changed: false, readyToConfirm: false }
  const next = getNextMapVoteSelection({ mapType: id })
  if (!next) return { changed: false, readyToConfirm: false }
  if (!next.changed) return { changed: false, readyToConfirm: next.readyToConfirm }
  sendMapVoteSelection(next.selection)
  return { changed: true, readyToConfirm: next.readyToConfirm }
}

export function toggleMapVoteSelectedScript(id: MapScriptId | null): MapVoteSelectionResult {
  if (id == null) return { changed: false, readyToConfirm: false }
  const currentSelection = normalizeMapVoteSelection(draftStore.mapVote.selection ?? DEFAULT_MAP_VOTE_SELECTION)
  const nextScripts: MapScriptId[] = currentSelection.mapScripts.includes(id)
    ? currentSelection.mapScripts.filter(mapScript => mapScript !== id)
    : id === 'random'
      ? ['random']
      : currentSelection.mapScripts.includes('random')
        ? [id]
        : currentSelection.mapScripts.length >= MAX_MAP_VOTE_MAP_SCRIPT_PICKS
          ? currentSelection.mapScripts
          : [...currentSelection.mapScripts, id]
  const next = getNextMapVoteSelection({ mapScripts: nextScripts })
  if (!next) return { changed: false, readyToConfirm: false }
  if (!next.changed) return { changed: false, readyToConfirm: next.readyToConfirm }
  sendMapVoteSelection(next.selection)
  return { changed: true, readyToConfirm: next.readyToConfirm }
}

export function confirmMapVote() {
  if (!mapVoteReadyToConfirm()) return false
  return sendMapVoteConfirm()
}
