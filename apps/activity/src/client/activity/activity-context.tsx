import type { Accessor, JSX } from 'solid-js'
import type { PlayerDataExportState } from '../lib/player-data-export'
import type { ActivityLaunchSelection, ActivityTargetOption, LobbyJoinEligibilitySnapshot, LobbySnapshot } from '../stores'
import { createContext, useContext } from 'solid-js'

export type ActivityState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'overview' }
    | { status: 'lobby-waiting', lobby: LobbySnapshot, joinPending: boolean, joinEligibility: LobbyJoinEligibilitySnapshot }
    | {
      status: 'authenticated'
      matchId: string
      autoStart: boolean
      steamLobbyLink: string | null
      sessionAccessToken: string | null
      lobbyId: string | null
      lobbyMode: string | null
      reported: boolean
    }

export interface ActivityControllerContextValue {
  canSwitchTargets: boolean
  canResumeSelection: () => boolean
  state: Accessor<ActivityState>
  availableTargets: Accessor<ActivityTargetOption[]>
  pickerBusy: Accessor<boolean>
  pickerError: Accessor<string | null>
  lastResolvedSelection: Accessor<ActivityLaunchSelection | null>
  currentTargetKey: () => string | null
  openOverview: (options?: { replace?: boolean }) => void
  openPractice: () => void
<<<<<<< New base: chore: update leader desc
  openAutosaveUpload: () => void
  openAutosaveFolderUpload: () => void
  openAutosaveCatalog: () => void
  canViewAutosaveCatalog: () => boolean
  canExportPlayerData: () => boolean
  exportPlayerData: () => Promise<void>
  playerDataExportState: Accessor<PlayerDataExportState>
||||||| Common ancestor
=======
  openAutosaveUpload: () => void
  openAutosaveCatalog: () => void
  canViewAutosaveCatalog: () => boolean
>>>>>>> Current commit: feat: catalog
  handleTargetSelection: (option: ActivityTargetOption) => Promise<void>
  restoreLastSelection: () => Promise<void>
  transitionToDraft: (
    matchId: string,
    autoStart: boolean,
    steamLobbyLink: string | null,
    sessionAccessToken: string | null,
  ) => void
}

export const ActivityControllerContext = createContext<ActivityControllerContextValue>()

export function useActivityController(): ActivityControllerContextValue {
  const context = useContext(ActivityControllerContext)
  if (!context) throw new Error('Activity controller context is missing')
  return context
}

export function ActivityLoadingPage(): JSX.Element {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
        <div class="text-sm text-fg-muted">Connecting to CivUp...</div>
      </div>
    </main>
  )
}

export function ActivityErrorPage(props: { message: string }): JSX.Element {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
        <div class="text-lg text-danger font-bold mb-2">Connection Failed</div>
        <div class="text-sm text-fg-muted">{props.message}</div>
      </div>
    </main>
  )
}

export function ActivityRedirectingPage(): JSX.Element {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
        <div class="text-sm text-fg-muted">Opening activity...</div>
      </div>
    </main>
  )
}
