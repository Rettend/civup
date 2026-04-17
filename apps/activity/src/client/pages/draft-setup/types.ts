import type { RankedRoleOptionSnapshot } from '~/client/stores'

export interface DraftSetupPageProps {
  lobby?: import('~/client/stores').LobbySnapshot
  steamLobbyLink?: string | null
  showJoinPending?: boolean
  joinEligibility?: import('~/client/stores').LobbyJoinEligibilitySnapshot
  prefetchedRankedRoleOptions?: RankedRoleOptionSnapshot[]
  prefetchedFillTestPlayersAvailable?: boolean
  onLobbyStarted?: (matchId: string, steamLobbyLink: string | null, roomAccessToken: string | null) => void
  onSwitchTarget?: () => void
}

export interface LobbyEditableDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
  leaderPoolSize: number | null
  leaderDataVersion: 'live' | 'beta'
  blindBans: boolean
  simultaneousPick: boolean
  redDeath: boolean
  dealOptionsSize: number | null
  randomDraft: boolean
  duplicateFactions: boolean
}

export type EditableConfigField = 'ban' | 'pick' | 'leaderPool'
