import type { DraftState, MapVotePhase, MapVoteSelection, ResolvedMapVoteResult, RevealedMapVoteSeatBallot, RoomConfig } from '@civup/game'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  isMapScriptId,
  isMapTypeId,
  normalizeMapVoteEnabled,
} from '@civup/game'

export interface StoredMapVoteState {
  enabled: boolean
  phase: MapVotePhase
  endsAt: number | null
  selections: Record<number, MapVoteSelection>
  confirmations: Record<number, boolean>
  revealedVotes: RevealedMapVoteSeatBallot[] | null
  result: ResolvedMapVoteResult | null
}

export type MapVoteSelectionUpdateResult = StoredMapVoteState | 'inactive' | 'locked'

export const EMPTY_STORED_MAP_VOTE_STATE: StoredMapVoteState = {
  enabled: false,
  phase: 'idle',
  endsAt: null,
  selections: {},
  confirmations: {},
  revealedVotes: null,
  result: null,
}

export function isValidMapVoteSelectionInput(selection: { mapType?: unknown, mapScript?: unknown } | null | undefined): selection is MapVoteSelection {
  return isMapTypeId(typeof selection?.mapType === 'string' ? selection.mapType : null)
    && isMapScriptId(typeof selection?.mapScript === 'string' ? selection.mapScript : null)
}

export function applyMapVoteSelectionUpdate(
  mapVoteState: StoredMapVoteState,
  seatIndex: number,
  selection: MapVoteSelection,
): MapVoteSelectionUpdateResult {
  if (!mapVoteState.enabled || mapVoteState.phase !== 'voting') return 'inactive'
  if (mapVoteState.confirmations[seatIndex] === true) return 'locked'

  return {
    ...mapVoteState,
    selections: {
      ...mapVoteState.selections,
      [seatIndex]: {
        mapType: selection.mapType,
        mapScript: selection.mapScript,
      },
    },
  }
}

export function createInitialMapVoteState(state: DraftState, config: RoomConfig, redDeath: boolean): StoredMapVoteState {
  const enabled = normalizeMapVoteEnabled(draftFormatMap.get(config.formatId)?.gameMode ?? 'ffa', config.mapVoteEnabled === true, { redDeath })
  if (!enabled) return { ...EMPTY_STORED_MAP_VOTE_STATE }

  const selections: Record<number, MapVoteSelection> = {}
  const confirmations: Record<number, boolean> = {}
  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    selections[seatIndex] = { ...DEFAULT_MAP_VOTE_SELECTION }
    confirmations[seatIndex] = false
  }

  return {
    enabled,
    phase: 'idle',
    endsAt: null,
    selections,
    confirmations,
    revealedVotes: null,
    result: null,
  }
}
