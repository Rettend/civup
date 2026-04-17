import type { CompetitiveTier, GameMode, LeaderDataVersion } from '@civup/game'

export type LobbyStatus = 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'

export interface LobbyDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
  leaderPoolSize: number | null
  leaderDataVersion: LeaderDataVersion
  blindBans: boolean
  simultaneousPick: boolean
  redDeath: boolean
  dealOptionsSize: number | null
  randomDraft: boolean
  duplicateFactions: boolean
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
  lastActivityAt: number
  /** Player IDs currently attached to this lobby (slotted or spectator). */
  memberPlayerIds: string[]
  /** Slot player IDs for open lobby ordering (null = empty slot) */
  slots: (string | null)[]
  draftConfig: LobbyDraftConfig
  createdAt: number
  updatedAt: number
  revision: number
}

export interface StoredLobbyState extends Omit<LobbyState, 'draftConfig' | 'slots' | 'revision' | 'memberPlayerIds' | 'steamLobbyLink' | 'lastActivityAt'> {
  steamLobbyLink?: unknown
  draftConfig?: Partial<LobbyDraftConfig> | null
  slots?: unknown
  revision?: unknown
  lastActivityAt?: unknown
  lastJoinedAt?: unknown
  memberPlayerIds?: unknown
}
