import type { ActivityLaunchSelection, ActivityTargetOption, LobbyJoinEligibilitySnapshot, LobbySnapshot, LobbyStateWatch } from './stores'
import { createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { activityTargetOptionKey, ActivityTargetPicker, ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import { relayDevLog } from './lib/dev-log'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  disconnect,
  draftStore,
  fetchActivityLaunchSnapshot,
  isMiniView,
  resetDraft,
  selectActivityTarget,
  setAuthenticatedUser,
  setIsMobileLayout,
  setIsMiniView,
  userId,
  watchLobbyState,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'overview' }
    | { status: 'lobby-waiting', lobby: LobbySnapshot, joinPending: boolean, joinEligibility: LobbyJoinEligibilitySnapshot }
    | { status: 'authenticated', matchId: string, autoStart: boolean }

const ACTIVITY_HOST = (import.meta.env.VITE_ACTIVITY_HOST as string | undefined)
  || (typeof window !== 'undefined' ? window.location.host : 'localhost:5173')
const ACTIVITY_SAFETY_POLL_MS = 90_000
const MINI_VIEW_MAX_WIDTH = 430
const MINI_VIEW_MAX_HEIGHT = 260
const MINI_VIEW_MIN_ASPECT_RATIO = 1.5
const MOBILE_LAYOUT_BREAKPOINT = 640

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })
  const [availableTargets, setAvailableTargets] = createSignal<ActivityTargetOption[]>([])
  const [pickerBusy, setPickerBusy] = createSignal(false)
  const [pickerError, setPickerError] = createSignal<string | null>(null)
  const [lastResolvedSelection, setLastResolvedSelection] = createSignal<ActivityLaunchSelection | null>(null)
  let activityWatch: LobbyStateWatch | null = null
  let activitySafetyPoll: ReturnType<typeof setInterval> | null = null
  let activityRefreshInFlight = false
  let activityRefreshPending = false
  let activeChannelId: string | null = null
  let activeUserId: string | null = null

  const stopActivityWatch = () => {
    if (!activityWatch) return
    activityWatch.close()
    activityWatch = null
  }

  const stopActivitySafetyPoll = () => {
    if (!activitySafetyPoll) return
    clearInterval(activitySafetyPoll)
    activitySafetyPoll = null
  }

  const clearDraftConnection = () => {
    disconnect()
    resetDraft()
  }

  const shouldHoldAuthenticatedDraftState = () => {
    if (state().status !== 'authenticated') return false
    if (connectionStatus() === 'connecting' || connectionStatus() === 'connected') return true
    return draftStore.state != null
  }

  onCleanup(() => {
    stopActivityWatch()
    stopActivitySafetyPoll()
    clearDraftConnection()
  })

  onMount(() => {
    const viewport = window.visualViewport
    const syncMiniView = () => {
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const isLandscape = width > height
      const aspectRatio = height > 0 ? width / height : 0

      setIsMobileLayout(width < MOBILE_LAYOUT_BREAKPOINT)
      setIsMiniView(
        isLandscape
        && width <= MINI_VIEW_MAX_WIDTH
        && height <= MINI_VIEW_MAX_HEIGHT
        && aspectRatio >= MINI_VIEW_MIN_ASPECT_RATIO,
      )
    }

    syncMiniView()
    window.addEventListener('resize', syncMiniView)
    viewport?.addEventListener('resize', syncMiniView)

    onCleanup(() => {
      window.removeEventListener('resize', syncMiniView)
      viewport?.removeEventListener('resize', syncMiniView)
    })
  })

  const currentTargetKey = () => {
    const current = state()
    if (current.status === 'lobby-waiting') return activityTargetOptionKey({ kind: 'lobby', id: current.lobby.id })
    if (current.status === 'authenticated') return activityTargetOptionKey({ kind: 'match', id: current.matchId })
    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return null
    return activityTargetOptionKey(lastSelection.option)
  }

  const openOverview = () => {
    const current = state()
    const hadTerminalDraft = draftStore.state?.status === 'complete' || draftStore.state?.status === 'cancelled'
    if (current.status === 'authenticated') {
      if (hadTerminalDraft) setAvailableTargets([])
      clearDraftConnection()
    }
    resetDraft()
    setPickerError(null)
    setState({ status: 'overview' })

    const channelId = activeChannelId
    const currentUserId = activeUserId
    if (!channelId || !currentUserId) return
    void refreshActivityState(channelId, currentUserId)
  }

  const transitionToDraft = (matchId: string, currentUserId: string, autoStart: boolean) => {
    setPickerError(null)

    const current = state()
    const nextAutoStart = current.status === 'authenticated' && current.matchId === matchId
      ? current.autoStart || autoStart
      : autoStart
    const isSameMatch = current.status === 'authenticated' && current.matchId === matchId
    const hasTerminalDraft = draftStore.state?.status === 'complete' || draftStore.state?.status === 'cancelled'

    setState({ status: 'authenticated', matchId, autoStart: nextAutoStart })
    if (isSameMatch && (connectionStatus() === 'connected' || hasTerminalDraft)) return

    resetDraft()
    connectToRoom(ACTIVITY_HOST, matchId, currentUserId)
  }

  const applyLaunchSnapshot = (
    channelId: string,
    currentUserId: string,
    snapshot: NonNullable<Awaited<ReturnType<typeof fetchActivityLaunchSnapshot>>>,
    autoStart = false,
    allowSelectionWhileOverview = false,
  ) => {
    const current = state()
    const previousSelectionKey = currentTargetKey()
    const nextSelectionKey = snapshot.selection ? activityTargetOptionKey(snapshot.selection.option) : null
    setAvailableTargets(snapshot.options)

    if (!snapshot.selection) {
      setPickerError(null)

      if (shouldHoldAuthenticatedDraftState()) return

      setLastResolvedSelection(null)
      if (current.status === 'authenticated') {
        clearDraftConnection()
      }

      setState({ status: 'overview' })
      return
    }

    if (current.status === 'authenticated' && snapshot.selection.kind === 'lobby' && shouldHoldAuthenticatedDraftState()) return

    setLastResolvedSelection(snapshot.selection)

    if (current.status === 'overview' && !allowSelectionWhileOverview && previousSelectionKey === nextSelectionKey) return

    if (snapshot.selection.kind === 'lobby') {
      const nextLobby = snapshot.selection.lobby
      const joinPending = snapshot.selection.pendingJoin
      const joinEligibility = snapshot.selection.joinEligibility
      setPickerError(null)

      if (current.status === 'authenticated') {
        clearDraftConnection()
      }

      setState((prev) => {
        if (prev.status !== 'lobby-waiting') return { status: 'lobby-waiting', lobby: nextLobby, joinPending, joinEligibility }
        const resolvedLobby = nextLobby.revision < prev.lobby.revision ? prev.lobby : nextLobby
        if (
          isSameLobbySnapshot(prev.lobby, resolvedLobby)
          && prev.joinPending === joinPending
          && prev.joinEligibility.canJoin === joinEligibility.canJoin
          && prev.joinEligibility.blockedReason === joinEligibility.blockedReason
          && prev.joinEligibility.pendingSlot === joinEligibility.pendingSlot
        ) {
          return prev
        }
        return { status: 'lobby-waiting', lobby: resolvedLobby, joinPending, joinEligibility }
      })
      return
    }

    transitionToDraft(snapshot.selection.matchId, currentUserId, autoStart)
  }

  const refreshActivityState = async (channelId: string, currentUserId: string) => {
    if (activityRefreshInFlight) {
      activityRefreshPending = true
      return
    }

    activityRefreshInFlight = true
    try {
      const snapshot = await fetchActivityLaunchSnapshot(channelId, currentUserId)
      if (!snapshot) {
        if (state().status === 'loading') {
          setState({ status: 'error', message: 'Failed to load the activity state. Reopen the activity and try again.' })
        }
        return
      }
      applyLaunchSnapshot(channelId, currentUserId, snapshot)
    }
    finally {
      activityRefreshInFlight = false
      if (activityRefreshPending) {
        activityRefreshPending = false
        void refreshActivityState(channelId, currentUserId)
      }
    }
  }

  const startActivitySafetyPoll = (channelId: string, currentUserId: string) => {
    if (activitySafetyPoll) return
    activitySafetyPoll = setInterval(() => {
      void refreshActivityState(channelId, currentUserId)
    }, ACTIVITY_SAFETY_POLL_MS)
  }

  const startActivityWatch = (channelId: string, currentUserId: string) => {
    stopActivityWatch()
    stopActivitySafetyPoll()

    activityWatch = watchLobbyState(ACTIVITY_HOST, {
      channelId,
      userId: currentUserId,
      onConnected: () => {
        stopActivitySafetyPoll()
      },
      onInvalidation: () => {
        void refreshActivityState(channelId, currentUserId)
      },
      onDisconnected: () => {
        startActivitySafetyPoll(channelId, currentUserId)
      },
      onError: () => {
        startActivitySafetyPoll(channelId, currentUserId)
      },
    })
  }

  const handleTargetSelection = async (option: ActivityTargetOption) => {
    const channelId = activeChannelId
    const currentUserId = activeUserId
    if (!channelId || !currentUserId) return

    setPickerBusy(true)
    setPickerError(null)
    try {
      const result = await selectActivityTarget(channelId, currentUserId, option)
      if (!result.ok) {
        setPickerError(result.error)
        void refreshActivityState(channelId, currentUserId)
        return
      }
      applyLaunchSnapshot(channelId, currentUserId, result.snapshot, false, true)
    }
    finally {
      setPickerBusy(false)
    }
  }

  const restoreLastSelection = async () => {
    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return
    await handleTargetSelection(lastSelection.option)
  }

  onMount(async () => {
    try {
      const auth = await setupDiscordSdk()
      setAuthenticatedUser(auth)
      const channelId = discordSdk.channelId

      if (!channelId) {
        setState({ status: 'error', message: 'No channel ID found - start from Discord' })
        return
      }

      activeChannelId = channelId
      activeUserId = auth.user.id
      startActivityWatch(channelId, auth.user.id)
      await refreshActivityState(channelId, auth.user.id)
    }
    catch (err) {
      console.error('Discord SDK setup failed:', err)
      relayDevLog('error', 'Activity app setup failed', err)
      setState({
        status: 'error',
        message: err instanceof Error && err.message.trim().length > 0
          ? err.message
          : typeof err === 'string' && err.trim().length > 0
            ? err
            : 'Unknown error',
      })
    }
  })

  return (
    <>
      <Switch>
        <Match when={state().status === 'loading'}>
          <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
            <div class="text-center">
              <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
              <div class="text-sm text-fg-muted">Connecting to Discord...</div>
            </div>
          </main>
        </Match>

        <Match when={state().status === 'error'}>
          <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
            <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
              <div class="text-lg text-danger font-bold mb-2">Connection Failed</div>
              <div class="text-sm text-fg-muted">
                {(state() as Extract<AppState, { status: 'error' }>).message}
              </div>
            </div>
          </main>
        </Match>

        <Match when={state().status === 'overview'}>
          <Show
            when={isMiniView()}
            fallback={(
              <main class="text-text-primary bg-bg-primary font-sans min-h-screen overflow-y-auto">
                <div class="mx-auto px-6 py-4 max-w-5xl">
                  <TargetPickerPanel
                    options={availableTargets()}
                    busy={pickerBusy()}
                    selectedKey={currentTargetKey()}
                    error={pickerError()}
                    onSelect={handleTargetSelection}
                    onResume={lastResolvedSelection() ? restoreLastSelection : undefined}
                  />
                </div>
              </main>
            )}
          >
            <TargetPickerPanel
              mini
              options={availableTargets()}
              busy={pickerBusy()}
              selectedKey={currentTargetKey()}
              error={pickerError()}
              onSelect={handleTargetSelection}
              onResume={lastResolvedSelection() ? restoreLastSelection : undefined}
            />
          </Show>
        </Match>

        <Match when={state().status === 'lobby-waiting'}>
          <ConfigScreen
            lobby={(state() as Extract<AppState, { status: 'lobby-waiting' }>).lobby}
            showJoinPending={(state() as Extract<AppState, { status: 'lobby-waiting' }>).joinPending}
            joinEligibility={(state() as Extract<AppState, { status: 'lobby-waiting' }>).joinEligibility}
            onSwitchTarget={openOverview}
            onLobbyStarted={(matchId) => {
              const currentUserId = userId()
              if (!currentUserId) {
                setState({ status: 'error', message: 'Could not identify your Discord user. Reopen the activity.' })
                return
              }
              transitionToDraft(matchId, currentUserId, true)
            }}
          />
        </Match>

        <Match when={state().status === 'authenticated'}>
          <DraftWithConnection
            matchId={(state() as Extract<AppState, { status: 'authenticated' }>).matchId}
            autoStart={(state() as Extract<AppState, { status: 'authenticated' }>).autoStart}
            onSwitchTarget={openOverview}
          />
        </Match>
      </Switch>
    </>
  )
}

function DraftWithConnection(props: {
  matchId: string
  autoStart: boolean
  onSwitchTarget?: () => void
}) {
  const hasTerminalState = () => {
    const status = draftStore.state?.status
    return status === 'complete' || status === 'cancelled'
  }

  return (
    <Switch>
      <Match when={connectionStatus() === 'connecting'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">Joining draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={hasTerminalState() && (connectionStatus() === 'error' || connectionStatus() === 'disconnected')}>
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          onSwitchTarget={props.onSwitchTarget}
        />
      </Match>

      <Match when={connectionStatus() === 'error'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-danger font-bold mb-2">Connection Error</div>
            <div class="text-sm text-fg-muted">
              {connectionError() ?? 'Failed to connect to draft room'}
            </div>
          </div>
        </main>
      </Match>

      <Match when={connectionStatus() === 'connected'}>
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          onSwitchTarget={props.onSwitchTarget}
        />
      </Match>

      <Match when={connectionStatus() === 'disconnected'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-fg-subtle font-bold mb-2">Disconnected</div>
            <div class="text-sm text-fg-muted">Lost connection to the draft room.</div>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function TargetPickerPanel(props: {
  mini?: boolean
  options: ActivityTargetOption[]
  busy: boolean
  selectedKey: string | null
  error: string | null
  onSelect: (option: ActivityTargetOption) => void
  onResume?: () => void
}) {
  if (props.mini) {
    return (
      <ActivityTargetPicker
        mini
        error={props.error}
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
        onClose={props.onResume}
      />
    )
  }

  return (
    <div class="flex flex-col gap-4">
      <ActivityTargetPicker
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
        onClose={props.onResume}
      />

      <Show when={props.error}>
        <div class="text-sm text-danger px-4 py-3 border border-danger/25 rounded-xl bg-danger/10">
          {props.error}
        </div>
      </Show>
    </div>
  )
}

function isSameLobbySnapshot(a: LobbySnapshot, b: LobbySnapshot): boolean {
  if (a.id !== b.id) return false
  if (a.revision !== b.revision) return false
  if (a.mode !== b.mode) return false
  if (a.hostId !== b.hostId) return false
  if (a.status !== b.status) return false
  if (a.minRole !== b.minRole) return false
  if (a.minPlayers !== b.minPlayers) return false
  if (a.targetSize !== b.targetSize) return false
  if (a.draftConfig.banTimerSeconds !== b.draftConfig.banTimerSeconds) return false
  if (a.draftConfig.pickTimerSeconds !== b.draftConfig.pickTimerSeconds) return false
  if (a.draftConfig.leaderPoolSize !== b.draftConfig.leaderPoolSize) return false
  if (a.serverDefaults.banTimerSeconds !== b.serverDefaults.banTimerSeconds) return false
  if (a.serverDefaults.pickTimerSeconds !== b.serverDefaults.pickTimerSeconds) return false
  if (a.entries.length !== b.entries.length) return false

  for (let i = 0; i < a.entries.length; i++) {
    const aEntry = a.entries[i]
    const bEntry = b.entries[i]
    if ((aEntry == null) !== (bEntry == null)) return false
    if (!aEntry || !bEntry) continue
    if (aEntry.playerId !== bEntry.playerId) return false
    if (aEntry.displayName !== bEntry.displayName) return false
    if ((aEntry.avatarUrl ?? null) !== (bEntry.avatarUrl ?? null)) return false
    if ((aEntry.partyIds ?? []).join(',') !== (bEntry.partyIds ?? []).join(',')) return false
  }

  return true
}
