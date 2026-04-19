import type { DraftState, MapVotePhase, MapVoteSelection, ResolvedMapVoteResult, RevealedMapVoteSeatBallot, RoomConfig } from '@civup/game'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  isMapVoteSelectionConfirmable,
  isMapScriptId,
  isMapTypeId,
  MAX_MAP_VOTE_MAP_SCRIPT_PICKS,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
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

export function isMapVoteVoting(mapVoteState: StoredMapVoteState): boolean {
  return mapVoteState.enabled && mapVoteState.phase === 'voting'
}

export function isMapVoteInProgress(mapVoteState: StoredMapVoteState): boolean {
  return mapVoteState.enabled && (mapVoteState.phase === 'voting' || mapVoteState.phase === 'reveal')
}

export function isValidMapVoteSelectionInput(selection: { mapType?: unknown, mapScripts?: unknown } | null | undefined): selection is MapVoteSelection {
  return isMapTypeId(typeof selection?.mapType === 'string' ? selection.mapType : null)
    && Array.isArray(selection?.mapScripts)
    && selection.mapScripts.length <= MAX_MAP_VOTE_MAP_SCRIPT_PICKS
    && selection.mapScripts.every(mapScript => typeof mapScript === 'string' && isMapScriptId(mapScript))
    && new Set(selection.mapScripts).size === selection.mapScripts.length
}

export function applyMapVoteSelectionUpdate(
  mapVoteState: StoredMapVoteState,
  seatIndex: number,
  selection: MapVoteSelection,
): MapVoteSelectionUpdateResult {
  if (!mapVoteState.enabled || mapVoteState.phase !== 'voting') return 'inactive'
  if (mapVoteState.confirmations[seatIndex] === true) return 'locked'
  const normalizedSelection = normalizeMapVoteSelection(selection)

  return {
    ...mapVoteState,
    selections: {
      ...mapVoteState.selections,
      [seatIndex]: {
        mapType: normalizedSelection.mapType,
        mapScripts: [...normalizedSelection.mapScripts],
      },
    },
  }
}

export { isMapVoteSelectionConfirmable }

export function createInitialMapVoteState(state: DraftState, config: RoomConfig, redDeath: boolean): StoredMapVoteState {
  const enabled = normalizeMapVoteEnabled(draftFormatMap.get(config.formatId)?.gameMode ?? 'ffa', config.mapVoteEnabled === true, { redDeath })
  if (!enabled) return { ...EMPTY_STORED_MAP_VOTE_STATE }

  const selections: Record<number, MapVoteSelection> = {}
  const confirmations: Record<number, boolean> = {}
  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    selections[seatIndex] = {
      mapType: DEFAULT_MAP_VOTE_SELECTION.mapType,
      mapScripts: [...DEFAULT_MAP_VOTE_SELECTION.mapScripts],
    }
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
