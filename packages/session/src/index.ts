import type {
  DraftAction,
  DraftEvent,
  DraftPreviewState,
  DraftSeat,
  DraftSelection,
  DraftState,
  DraftTimerConfig,
  LeaderDataVersion,
  LeaderSwapState,
  MapVoteSelection,
  MapVoteSnapshot,
} from '@civup/game'

/** Configuration used by SessionDO to initialize its draft subruntime. */
export interface DraftRuntimeConfig {
  matchId: string
  hostId: string
  formatId: string
  seats: DraftSeat[]
  civPool: string[]
  dealOptionsSize?: number
  randomDraft?: boolean
  duplicateFactions?: boolean
  mapVoteEnabled?: boolean
  leaderDataVersion?: LeaderDataVersion
  timerConfig?: DraftTimerConfig
  steamLobbyLink?: string | null
}

export type SessionClientMessage
  = | { type: 'start' }
    | { type: 'map-vote-selection', selection: MapVoteSelection }
    | { type: 'map-vote-confirm' }
    | { type: 'ban', civIds: string[] }
    | { type: 'pick', civId: string }
    | { type: 'preview', action: DraftAction, civIds: string[] }
    | { type: 'cancel', reason: 'cancel' | 'scrub' | 'revert' }
    | { type: 'swap-request', toSeat: number }
    | { type: 'swap-accept' }
    | { type: 'swap-cancel' }
    | {
      type: 'config'
      banTimerSeconds: number | null
      pickTimerSeconds: number | null
    }

export type SessionServerMessage
  = | {
    type: 'lobby'
    lobbyId: string
    snapshot: unknown
  }
  | {
    type: 'session-started'
    lobbyId: string
    matchId: string
    steamLobbyLink: string | null
    sessionAccessToken: string | null
    mode: string | null
  }
  | {
    type: 'init'
    state: DraftState
    mapVote: MapVoteSnapshot
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    seatIndex: number | null
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
    steamLobbyLink?: string | null
  }
  | {
    type: 'update'
    state: DraftState
    mapVote: MapVoteSnapshot
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    events: DraftEvent[]
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
    steamLobbyLink?: string | null
  }
  | { type: 'preview', previews: DraftPreviewState }
  | { type: 'swap-update', swapState: LeaderSwapState, picks?: DraftSelection[] }
  | { type: 'projection-update', steamLobbyLink: string | null }
  | { type: 'error', message: string }
