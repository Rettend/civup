import type { PlayerDataExportState } from '../lib/player-data-export'
import type {
  ActivityLaunchSelection,
  ActivityTargetOption,
  LobbyJoinEligibilitySnapshot,
  LobbySnapshot,
} from '../stores'
import type { JSX } from '@solidjs/web'
import type { Accessor } from 'solid-js'
import { createContext, Show, useContext } from 'solid-js'
import { Button } from '../components/ui/Button'

export type ActivityState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'overview' }
  | {
      status: 'lobby-waiting'
      lobby: LobbySnapshot
      joinPending: boolean
      joinEligibility: LobbyJoinEligibilitySnapshot
    }
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
  openAutosaveUpload: () => void
  openAutosaveFolderUpload: () => void
  openAutosaveCatalog: () => void
  canViewAutosaveCatalog: () => boolean
  canExportPlayerData: () => boolean
  exportPlayerData: () => Promise<void>
  playerDataExportState: Accessor<PlayerDataExportState>
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
  return useContext(ActivityControllerContext)
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

export function ActivityErrorPage(props: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
        <div class="text-lg text-danger font-bold mb-2">Connection Failed</div>
        <div class="text-sm text-fg-muted">{props.message}</div>
        <Show when={props.onRetry}>
          <Button type="button" class="mt-4" onClick={() => props.onRetry?.()}>
            Retry
          </Button>
        </Show>
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
