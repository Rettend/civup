import type { RankedRoleOptionSnapshot } from '~/client/stores'

export interface DraftSetupPageProps {
  lobby?: import('~/client/stores').LobbySnapshot
  steamLobbyLink?: string | null
  showJoinPending?: boolean
  joinEligibility?: import('~/client/stores').LobbyJoinEligibilitySnapshot
  prefetchedRankedRoleOptions?: RankedRoleOptionSnapshot[]
  prefetchedFillTestPlayersAvailable?: boolean
  onLobbyStarted?: (matchId: string, steamLobbyLink: string | null, sessionAccessToken: string | null) => void
  onSwitchTarget?: () => void
}

export interface LobbyEditableDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
  leaderPoolSize: number | null
  leaderDataVersion: 'live' | 'beta'
  mapVoteEnabled: boolean
  teamFormationEnabled: boolean
  blindBans: boolean
  blindPicks: boolean
  simultaneousPick: boolean
  permanentAlly: boolean
  redDeath: boolean
  dealOptionsSize: number | null
  civBlitz: boolean
  civBlitzOptionCount: number | null
  civBlitzExcludeBbgExpanded: boolean
  randomDraft: boolean
  hiddenDraft: boolean
  duplicateFactions: boolean
  closed: boolean
}

export type EditableConfigField = 'ban' | 'pick' | 'leaderPool'
