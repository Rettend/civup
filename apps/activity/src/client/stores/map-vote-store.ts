import type { MapScriptId, MapTypeId, RevealedMapVoteSeatBallot } from '@civup/game'
import { createMemo } from 'solid-js'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  MAP_VOTE_REVEAL_DURATION_SECONDS,
  MAP_VOTE_VOTING_DURATION_SECONDS,
} from '@civup/game'
import { sendMapVoteConfirm, sendMapVoteSelection } from './connection-store'
import { draftStore } from './draft-store'

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

export { MAP_VOTE_REVEAL_DURATION_SECONDS, MAP_VOTE_VOTING_DURATION_SECONDS }

export const mapVoteEnabled = () => draftStore.mapVote.enabled
export const mapVotePhase = () => draftStore.mapVote.phase
export const mapVoteSelectedType = () => draftStore.mapVote.selection?.mapType ?? null
export const mapVoteSelectedScript = () => draftStore.mapVote.selection?.mapScript ?? null
export const mapVoteHasConfirmed = () => draftStore.mapVote.hasConfirmed
export const mapVoteSeatVotes = () => draftStore.mapVote.revealedVotes ?? []
export const mapVoteWinningType = () => draftStore.mapVote.result?.mapType ?? null
export const mapVoteWinningScript = () => draftStore.mapVote.result?.mapScript ?? null
export const mapVoteVotingEndsAt = () => mapVotePhase() === 'voting' ? draftStore.mapVote.endsAt : null
export const mapVoteRevealEndsAt = () => mapVotePhase() === 'reveal' ? draftStore.mapVote.endsAt : null

export const isMapVotePhase = createMemo(() => mapVotePhase() === 'voting' || mapVotePhase() === 'reveal')

export const mapVoteReadyToConfirm = createMemo(() => {
  return mapVotePhase() === 'voting'
    && mapVoteSelectedType() != null
    && mapVoteSelectedScript() != null
    && !mapVoteHasConfirmed()
})

export function getSeatMapVote(seatIndex: number): RevealedMapVoteSeatBallot | null {
  return mapVoteSeatVotes().find(vote => vote.seatIndex === seatIndex) ?? null
}

export function setMapVoteSelectedType(id: MapTypeId | null) {
  if (draftStore.mapVote.phase !== 'voting' || draftStore.mapVote.hasConfirmed || draftStore.seatIndex == null || id == null) return
  sendMapVoteSelection({
    mapType: id,
    mapScript: draftStore.mapVote.selection?.mapScript ?? DEFAULT_MAP_VOTE_SELECTION.mapScript,
  })
}

export function setMapVoteSelectedScript(id: MapScriptId | null) {
  if (draftStore.mapVote.phase !== 'voting' || draftStore.mapVote.hasConfirmed || draftStore.seatIndex == null || id == null) return
  sendMapVoteSelection({
    mapType: draftStore.mapVote.selection?.mapType ?? DEFAULT_MAP_VOTE_SELECTION.mapType,
    mapScript: id,
  })
}

export function confirmMapVote() {
  if (!mapVoteReadyToConfirm()) return
  sendMapVoteConfirm()
}
