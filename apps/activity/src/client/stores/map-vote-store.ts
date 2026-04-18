import type { MapTypeId, MapScriptId, SeatMapVote } from '~/client/lib/map-vote'
import { makePersisted } from '@solid-primitives/storage'
import { createMemo } from 'solid-js'
import { createStore, unwrap } from 'solid-js/store'
import {
  pickWinningMapScript,
  pickWinningMapType,
  resolveRandomMapScript,
  resolveRandomMapType,
} from '~/client/lib/map-vote'
import { draftStore } from './draft-store'

const VOTING_DURATION_MS = 300000
const REVEAL_DURATION_MS = 5000

export const MAP_VOTE_VOTING_DURATION_SECONDS = VOTING_DURATION_MS / 1000
export const MAP_VOTE_REVEAL_DURATION_SECONDS = REVEAL_DURATION_MS / 1000

/**
 * Map vote store — frontend-only dummy state.
 *
 * The server has no concept of a MAP phase yet. While the UI is being
 * designed, this store simulates the vote locally: it fakes other players'
 * ballots on confirm and runs a reveal timer before handing off to the
 * regular ban/pick draft UI.
 */

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

interface MapVoteMemoryState {
  /** Current phase of the dummy map vote. */
  phase: MapVotePhase
  /** Match ID this vote is for (used to reset when a new draft starts). */
  matchId: string | null
  /** This client's current map type selection. */
  selectedMapType: MapTypeId | null
  /** This client's current map script selection. */
  selectedMapScript: MapScriptId | null
  /** Whether this client already confirmed their ballot. */
  hasConfirmed: boolean
  /** Faked ballots for all seats, including this client's, populated on confirm. */
  seatVotes: SeatMapVote[]
  /** Resolved winning map type (after random tiebreak). */
  winningMapType: MapTypeId | null
  /** Resolved winning map script (after random tiebreak). */
  winningMapScript: MapScriptId | null
  /** Local voting countdown end timestamp. */
  votingEndsAt: number | null
  /** Local reveal countdown end timestamp. */
  revealEndsAt: number | null
}

interface MapVotePersistedState {
  /** Local-only toggle that decides whether the MAP phase appears. */
  mapVoteEnabled: boolean
}

const INITIAL_MEMORY: MapVoteMemoryState = {
  phase: 'idle',
  matchId: null,
  selectedMapType: null,
  selectedMapScript: null,
  hasConfirmed: false,
  seatVotes: [],
  winningMapType: null,
  winningMapScript: null,
  votingEndsAt: null,
  revealEndsAt: null,
}

const [memoryState, setMemoryState] = createStore<MapVoteMemoryState>({ ...INITIAL_MEMORY })

const [persistedStateBase, setPersistedStateBase] = createStore<MapVotePersistedState>({
  mapVoteEnabled: true,
})

const [persistedState, setPersistedState] = makePersisted([persistedStateBase, setPersistedStateBase], {
  name: 'civup:activity:map-vote',
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  serialize: value => JSON.stringify(unwrap(value)),
  deserialize: (value) => {
    try {
      const parsed = JSON.parse(value)
      return {
        mapVoteEnabled: typeof parsed?.mapVoteEnabled === 'boolean' ? parsed.mapVoteEnabled : true,
      }
    }
    catch {
      return { mapVoteEnabled: true }
    }
  },
})

// ── Public readers ─────────────────────────────────────────

export const mapVotePhase = () => memoryState.phase
export const mapVoteSelectedType = () => memoryState.selectedMapType
export const mapVoteSelectedScript = () => memoryState.selectedMapScript
export const mapVoteHasConfirmed = () => memoryState.hasConfirmed
export const mapVoteSeatVotes = () => memoryState.seatVotes
export const mapVoteWinningType = () => memoryState.winningMapType
export const mapVoteWinningScript = () => memoryState.winningMapScript
export const mapVoteVotingEndsAt = () => memoryState.votingEndsAt
export const mapVoteRevealEndsAt = () => memoryState.revealEndsAt
export const mapVoteEnabled = () => persistedState.mapVoteEnabled

export const isMapVotePhase = createMemo(() => {
  const phase = memoryState.phase
  return phase === 'voting' || phase === 'reveal'
})

export const mapVoteReadyToConfirm = createMemo(() => {
  return memoryState.selectedMapType != null
    && memoryState.selectedMapScript != null
    && !memoryState.hasConfirmed
})

/** Get a specific seat's vote (available once the user confirms). */
export function getSeatMapVote(seatIndex: number): SeatMapVote | null {
  return memoryState.seatVotes.find(vote => vote.seatIndex === seatIndex) ?? null
}

// ── Writers ────────────────────────────────────────────────

export function setMapVoteEnabled(next: boolean | ((prev: boolean) => boolean)) {
  setPersistedState('mapVoteEnabled', next)
}

export function setMapVoteSelectedType(id: MapTypeId | null) {
  if (memoryState.hasConfirmed) return
  setMemoryState('selectedMapType', id)
}

export function setMapVoteSelectedScript(id: MapScriptId | null) {
  if (memoryState.hasConfirmed) return
  setMemoryState('selectedMapScript', id)
}

/**
 * Start a fresh vote for the given match. Safe to call many times — only
 * transitions when the match changes or the store is otherwise idle.
 */
export function startMapVote(matchId: string) {
  if (memoryState.matchId === matchId && memoryState.phase !== 'idle') return
  setMemoryState({
    ...INITIAL_MEMORY,
    matchId,
    phase: 'voting',
    selectedMapType: 'random',
    selectedMapScript: 'random',
    votingEndsAt: Date.now() + VOTING_DURATION_MS,
  })
}

/**
 * Submit this client's ballot. Because this is dummy state, we fabricate
 * ballots for the remaining seats and compute a winner immediately, then
 * switch to the reveal phase.
 */
export function confirmMapVote() {
  if (memoryState.phase !== 'voting') return
  if (memoryState.hasConfirmed) return
  const selectedMapType = memoryState.selectedMapType
  const selectedMapScript = memoryState.selectedMapScript
  const mapType = selectedMapType === 'random' ? resolveRandomMapType() : selectedMapType
  const mapScript = selectedMapScript === 'random' ? resolveRandomMapScript() : selectedMapScript
  if (mapType == null || mapScript == null) return

  const mySeatIndex = draftStore.seatIndex ?? 0
  const seats = draftStore.state?.seats ?? []
  const seatCount = Math.max(seats.length, 1)

  const seatVotes: SeatMapVote[] = []
  for (let seatIndex = 0; seatIndex < seatCount; seatIndex++) {
    if (seatIndex === mySeatIndex) {
      seatVotes.push({ seatIndex, mapType, mapScript })
      continue
    }
    seatVotes.push({
      seatIndex,
      mapType: randomTypeForFakeVote(),
      mapScript: randomScriptForFakeVote(),
    })
  }

  const resolvedType = pickWinningMapType(seatVotes.map(vote => vote.mapType))
  const resolvedScript = pickWinningMapScript(seatVotes.map(vote => vote.mapScript))

  setMemoryState({
    phase: 'reveal',
    hasConfirmed: true,
    seatVotes,
    winningMapType: resolvedType,
    winningMapScript: resolvedScript,
    votingEndsAt: null,
    revealEndsAt: Date.now() + REVEAL_DURATION_MS,
  })
}

/** Called by the reveal timer to complete the map vote. */
export function finishMapVote() {
  if (memoryState.phase !== 'reveal') return
  setMemoryState({
    phase: 'done',
    votingEndsAt: null,
    revealEndsAt: null,
  })
}

/** Reset the whole store (for leaving a draft, cancelling, etc.). */
export function resetMapVote() {
  setMemoryState({ ...INITIAL_MEMORY })
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Slight bias toward non-random picks so the fake vote reveal is readable.
 * Returns a concrete (non-random) map type id.
 */
function randomTypeForFakeVote(): MapTypeId {
  return resolveRandomMapType()
}

function randomScriptForFakeVote(): MapScriptId {
  return resolveRandomMapScript()
}
