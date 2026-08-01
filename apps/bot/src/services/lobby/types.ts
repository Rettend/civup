import type { AppliedCivLobbySettings, CompetitiveTier, GameMode, LeaderDataVersion } from '@civup/game'

export type LobbyStatus = 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'
export type LobbyArrangeStrategy = 'randomize' | 'balance' | 'shuffle-teams'

export interface LobbyArrangeMarker {
  strategy: LobbyArrangeStrategy
  at: number
}

export interface LobbyDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
  leaderPoolSize: number | null
  leaderDataVersion: LeaderDataVersion
  mapVoteEnabled: boolean
  blindBans: boolean
  simultaneousPick: boolean
  permanentAlly: boolean
  redDeath: boolean
  dealOptionsSize: number | null
  civBlitz: boolean
  civBlitzOptionCount: number | null
  civBlitzExcludeBbgExpanded: boolean
  blindPicks: boolean
  randomDraft: boolean
  hiddenDraft: boolean
  duplicateFactions: boolean
  closed?: boolean
}

export interface LobbyState {
  id: string
  mode: GameMode
  status: LobbyStatus
  guildId: string | null
  hostId: string
  channelId: string
  messageId: string
  matchId: string | null
  steamLobbyLink: string | null
  minRole: CompetitiveTier | null
  maxRole: CompetitiveTier | null
  lastArrange?: LobbyArrangeMarker | null
  lastActivityAt: number
  /** Player IDs currently attached to this lobby (slotted or spectator). */
  memberPlayerIds: string[]
  /** Slot player IDs for open lobby ordering (null = empty slot) */
  slots: (string | null)[]
  draftConfig: LobbyDraftConfig
  /** Frozen lobby checklist profile and preset attribution copied into this lobby. */
  gameSettings?: AppliedCivLobbySettings
  createdAt: number
  updatedAt: number
  revision: number
}

export interface StoredLobbyState extends Omit<LobbyState, 'draftConfig' | 'gameSettings' | 'slots' | 'revision' | 'memberPlayerIds' | 'steamLobbyLink' | 'lastActivityAt' | 'lastArrange'> {
  steamLobbyLink?: unknown
  draftConfig?: Partial<LobbyDraftConfig> | null
  gameSettings?: unknown
  slots?: unknown
  revision?: unknown
  lastArrange?: unknown
  lastActivityAt?: unknown
  memberPlayerIds?: unknown
}
