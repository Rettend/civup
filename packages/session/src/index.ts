import type {
  DraftAction,
  CivBlitzPartialKit,
  DraftEvent,
  DraftPreviewState,
  DraftSeat,
  DraftState,
  DraftTimerConfig,
  LeaderDataVersion,
  LeaderSwapState,
  MapVoteSelection,
  MapVoteSnapshot,
  AppliedCivLobbySettings,
  TeamFormationPlayerStats,
  TeamFormationSnapshot,
} from '@civup/game'

/** Configuration used by SessionDO to initialize its draft subruntime. */
export interface DraftRuntimeConfig {
  matchId: string
  hostId: string
  formatId: string
  seats: DraftSeat[]
  civPool: string[]
  bansPerTeam?: number
  dealOptionsSize?: number
  civBlitz?: boolean
  civBlitzOptionCount?: number
  civBlitzExcludeBbgExpanded?: boolean
  blindPicks?: boolean
  randomDraft?: boolean
  hiddenDraft?: boolean
  permanentAlly?: boolean
  duplicateFactions?: boolean
  mapVoteEnabled?: boolean
  teamFormationEnabled?: boolean
  teamFormationPartySeatIndices?: number[][]
  teamFormationStatsBySeat?: Record<number, TeamFormationPlayerStats>
  leaderDataVersion?: LeaderDataVersion
  timerConfig?: DraftTimerConfig
  steamLobbyLink?: string | null
  gameSettings?: AppliedCivLobbySettings
}

export type SessionClientMessage
  = | { type: 'start' }
    | { type: 'map-vote-selection', selection: MapVoteSelection }
    | { type: 'map-vote-confirm' }
    | { type: 'team-formation-pick', groupId: string, revision: number }
    | { type: 'ban', civIds: string[] }
    | { type: 'pick', civId: string }
    | { type: 'civ-blitz-submit', kit: CivBlitzPartialKit }
    | { type: 'preview', action: DraftAction, civIds: string[] }
    | { type: 'cancel', reason: 'cancel' | 'scrub' | 'revert' }
    | { type: 'leader-swap', toSeat: number }
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
    teamFormation: TeamFormationSnapshot
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    seatIndex: number | null
    serverNow?: number
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
    steamLobbyLink?: string | null
    permanentAlly?: boolean
    hiddenDraft?: boolean
  }
  | {
    type: 'update'
    state: DraftState
    mapVote: MapVoteSnapshot
    teamFormation: TeamFormationSnapshot
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    events: DraftEvent[]
    serverNow?: number
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
    steamLobbyLink?: string | null
    permanentAlly?: boolean
    hiddenDraft?: boolean
  }
  | { type: 'preview', previews: DraftPreviewState }
  | { type: 'projection-update', steamLobbyLink: string | null }
  | { type: 'error', message: string }
