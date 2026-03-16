import type { ActivityLaunchSelection, ActivityTargetOption, LobbyJoinEligibilitySnapshot, LobbySnapshot, LobbyStateWatch, PartySocketTarget } from './stores'
import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { activityTargetOptionKey, ActivityTargetPicker, ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import { cn } from './lib/css'
import { relayDevLog } from './lib/dev-log'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  disconnect,
  draftStore,
  fetchActivityLaunchSnapshot,
  isMiniView,
  isMobileLayout,
  resetDraft,
  selectActivityTarget,
  setAuthenticatedUser,
  setIsMiniView,
  setIsMobileLayout,
  watchLobbyState,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'overview' }
    | { status: 'lobby-waiting', lobby: LobbySnapshot, joinPending: boolean, joinEligibility: LobbyJoinEligibilitySnapshot }
    | {
      status: 'authenticated'
      matchId: string
      autoStart: boolean
      steamLobbyLink: string | null
      roomAccessToken: string | null
      lobbyId: string | null
      lobbyMode: string | null
    }

const ACTIVITY_HOST = (import.meta.env.VITE_ACTIVITY_HOST as string | undefined)
  || (typeof window !== 'undefined' ? window.location.host : 'localhost:5173')
const PARTY_SOCKET_TARGET = resolvePartySocketTarget()
const ACTIVITY_SAFETY_POLL_MS = 90_000
const LOBBY_MODE_STATE_PREFIX = 'lobby:mode:'
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
  let subscribedLobbySnapshotKey: string | null = null
  let overviewPrefixSubscribed = false

  const stopActivityWatch = () => {
    if (!activityWatch) return
    activityWatch.close()
    activityWatch = null
    subscribedLobbySnapshotKey = null
    overviewPrefixSubscribed = false
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
    if (isDraftConnectionInFlight()) return true
    return draftStore.state != null
  }

  const isDraftConnectionInFlight = () => {
    const status = connectionStatus()
    return status === 'connecting' || status === 'reconnecting' || status === 'connected'
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

  const syncActivityWatchSubscriptions = () => {
    if (!activityWatch || !activeChannelId || !activeUserId) return

    const current = state()
    activityWatch.subscribeKey(activityTargetStateKey(activeUserId, activeChannelId))

    const shouldSubscribeOverviewPrefix = current.status === 'overview'
      || current.status === 'loading'
      || current.status === 'error'

    if (shouldSubscribeOverviewPrefix && !overviewPrefixSubscribed) {
      activityWatch.subscribePrefix(LOBBY_MODE_STATE_PREFIX)
      overviewPrefixSubscribed = true
    }
    else if (!shouldSubscribeOverviewPrefix && overviewPrefixSubscribed) {
      activityWatch.unsubscribePrefix(LOBBY_MODE_STATE_PREFIX)
      overviewPrefixSubscribed = false
    }

    const nextLobbySnapshotKey = current.status === 'lobby-waiting'
      ? lobbySnapshotStateKey(current.lobby.id)
      : null

    if (subscribedLobbySnapshotKey && subscribedLobbySnapshotKey !== nextLobbySnapshotKey) {
      activityWatch.unsubscribeKey(subscribedLobbySnapshotKey)
    }

    if (nextLobbySnapshotKey && subscribedLobbySnapshotKey !== nextLobbySnapshotKey) {
      activityWatch.subscribeKey(nextLobbySnapshotKey)
    }

    subscribedLobbySnapshotKey = nextLobbySnapshotKey
  }

  const applyLiveLobbySnapshot = (lobby: LobbySnapshot) => {
    setState((previous) => {
      if (previous.status !== 'lobby-waiting') return previous
      if (previous.lobby.id !== lobby.id) return previous
      if (lobby.revision < previous.lobby.revision) return previous

      const currentUserId = activeUserId
      const isCurrentUserInLobby = currentUserId != null
        && lobby.entries.some(entry => entry?.playerId === currentUserId)
      const nextJoinEligibility = resolveLiveJoinEligibility(previous.joinEligibility, lobby, currentUserId)
      const nextJoinPending = isCurrentUserInLobby ? false : previous.joinPending

      if (
        isSameLobbySnapshot(previous.lobby, lobby)
        && previous.joinPending === nextJoinPending
        && previous.joinEligibility.canJoin === nextJoinEligibility.canJoin
        && previous.joinEligibility.blockedReason === nextJoinEligibility.blockedReason
        && previous.joinEligibility.pendingSlot === nextJoinEligibility.pendingSlot
      ) {
        return previous
      }

      return {
        status: 'lobby-waiting',
        lobby,
        joinPending: nextJoinPending,
        joinEligibility: nextJoinEligibility,
      }
    })
  }

  const handleActivityStateChange = (channelId: string, currentUserId: string, key: string, value?: string) => {
    const targetKey = activityTargetStateKey(currentUserId, channelId)
    if (key === targetKey) {
      const selection = parseActivityTargetState(value)
      const current = state()

      if (selection) {
        if (current.status === 'lobby-waiting' && selection.kind === 'lobby' && selection.id === current.lobby.id) {
          if (current.joinPending !== selection.pendingJoin) {
            setState({
              status: 'lobby-waiting',
              lobby: current.lobby,
              joinPending: selection.pendingJoin,
              joinEligibility: current.joinEligibility,
            })
          }
          return
        }

        if (current.status === 'authenticated' && selection.kind === 'match' && selection.id === current.matchId) {
          return
        }

        const nextSelectionKey = activityTargetOptionKey({ kind: selection.kind, id: selection.id })
        if (currentTargetKey() === nextSelectionKey) {
          return
        }
      }

      void refreshActivityState(channelId, currentUserId)
      return
    }

    const current = state()
    if (current.status === 'lobby-waiting' && key === lobbySnapshotStateKey(current.lobby.id)) {
      const snapshot = parseLobbySnapshotValue(value)
      if (!snapshot) {
        void refreshActivityState(channelId, currentUserId)
        return
      }

      applyLiveLobbySnapshot(snapshot)
      return
    }

    if (key.startsWith(LOBBY_MODE_STATE_PREFIX)) {
      void refreshActivityState(channelId, currentUserId)
    }
  }

  createEffect(() => {
    state()
    syncActivityWatchSubscriptions()
  })

  const transitionToDraft = (
    matchId: string,
    autoStart: boolean,
    steamLobbyLink: string | null,
    roomAccessToken: string | null,
    lobbyContext?: {
      lobbyId: string | null
      lobbyMode: string | null
    },
  ) => {
    setPickerError(null)

    const current = state()
    const nextAutoStart = current.status === 'authenticated' && current.matchId === matchId
      ? current.autoStart || autoStart
      : autoStart
    const isSameMatch = current.status === 'authenticated' && current.matchId === matchId
    const hasTerminalDraft = draftStore.state?.status === 'complete' || draftStore.state?.status === 'cancelled'
    const nextLobbyId = lobbyContext?.lobbyId
      ?? (current.status === 'lobby-waiting'
        ? current.lobby.id
        : current.status === 'authenticated'
          ? current.lobbyId
          : null)
    const nextLobbyMode = lobbyContext?.lobbyMode
      ?? (current.status === 'lobby-waiting'
        ? current.lobby.mode
        : current.status === 'authenticated'
          ? current.lobbyMode
          : null)

    setState({ status: 'authenticated', matchId, autoStart: nextAutoStart, steamLobbyLink, roomAccessToken, lobbyId: nextLobbyId, lobbyMode: nextLobbyMode })
    if (isSameMatch && (isDraftConnectionInFlight() || hasTerminalDraft)) return

    resetDraft()
    connectToRoom(PARTY_SOCKET_TARGET, matchId, roomAccessToken)
  }

  const applyLaunchSnapshot = (
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

    transitionToDraft(snapshot.selection.matchId, autoStart, snapshot.selection.steamLobbyLink, snapshot.selection.roomAccessToken, {
      lobbyId: snapshot.selection.option.lobbyId,
      lobbyMode: snapshot.selection.option.mode,
    })
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
      applyLaunchSnapshot(snapshot)
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

    activityWatch = watchLobbyState(PARTY_SOCKET_TARGET, {
      channelId,
      userId: currentUserId,
      onConnected: () => {
        stopActivitySafetyPoll()
        syncActivityWatchSubscriptions()
      },
      onStateChanged: ({ key, op, value }) => {
        if (op !== 'put' && op !== 'delete') return
        handleActivityStateChange(channelId, currentUserId, key, value)
      },
      onDisconnected: () => {
        startActivitySafetyPoll(channelId, currentUserId)
      },
      onError: () => {
        startActivitySafetyPoll(channelId, currentUserId)
      },
    })

    syncActivityWatchSubscriptions()
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
      applyLaunchSnapshot(result.snapshot, false, true)
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
              <main class="text-text-primary bg-bg-primary font-sans min-h-screen relative overflow-y-auto">
                <Show when={lastResolvedSelection()}>
                  <button
                    type="button"
                    class={cn(
                      'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
                      isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6',
                    )}
                    title="Return"
                    aria-label="Return"
                    onClick={() => void restoreLastSelection()}
                  >
                    <span class="i-ph-arrow-right-bold text-base" />
                  </button>
                </Show>
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
            onLobbyStarted={(matchId, steamLobbyLink, roomAccessToken) => {
              transitionToDraft(matchId, true, steamLobbyLink, roomAccessToken)
            }}
          />
        </Match>

        <Match when={state().status === 'authenticated'}>
          <DraftWithConnection
            matchId={(state() as Extract<AppState, { status: 'authenticated' }>).matchId}
            autoStart={(state() as Extract<AppState, { status: 'authenticated' }>).autoStart}
            steamLobbyLink={(state() as Extract<AppState, { status: 'authenticated' }>).steamLobbyLink}
            lobbyId={(state() as Extract<AppState, { status: 'authenticated' }>).lobbyId}
            lobbyMode={(state() as Extract<AppState, { status: 'authenticated' }>).lobbyMode}
            onSwitchTarget={openOverview}
          />
        </Match>
      </Switch>
    </>
  )
}

function resolvePartySocketTarget(): PartySocketTarget {
  return {
    host: typeof window !== 'undefined' ? window.location.host : ACTIVITY_HOST,
    prefix: 'api/parties',
    label: 'activity-origin',
  }
}

function activityTargetStateKey(userId: string, channelId: string): string {
  return `activity-target-user:${userId}:${channelId}`
}

function lobbySnapshotStateKey(lobbyId: string): string {
  return `lobby:snapshot:${lobbyId}`
}

function parseActivityTargetState(value: string | undefined): {
  kind: 'lobby' | 'match'
  id: string
  pendingJoin: boolean
} | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as {
      kind?: unknown
      id?: unknown
      pendingJoin?: unknown
    }

    if ((parsed.kind !== 'lobby' && parsed.kind !== 'match') || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      return null
    }

    return {
      kind: parsed.kind,
      id: parsed.id,
      pendingJoin: parsed.pendingJoin === true,
    }
  }
  catch {
    return null
  }
}

function parseLobbySnapshotValue(value: string | undefined): LobbySnapshot | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as Partial<LobbySnapshot>
    if (typeof parsed.id !== 'string' || typeof parsed.revision !== 'number' || !Array.isArray(parsed.entries)) {
      return null
    }
    return parsed as LobbySnapshot
  }
  catch {
    return null
  }
}

function resolveLiveJoinEligibility(
  current: LobbyJoinEligibilitySnapshot,
  lobby: LobbySnapshot,
  currentUserId: string | null,
): LobbyJoinEligibilitySnapshot {
  if (currentUserId && lobby.entries.some(entry => entry?.playerId === currentUserId)) {
    return {
      canJoin: true,
      blockedReason: null,
      pendingSlot: null,
    }
  }

  if (lobby.status !== 'open') {
    return {
      canJoin: false,
      blockedReason: 'This lobby is no longer open.',
      pendingSlot: null,
    }
  }

  const pendingSlot = lobby.entries.findIndex(entry => entry == null)
  if (pendingSlot < 0) {
    return {
      canJoin: false,
      blockedReason: 'This lobby is full.',
      pendingSlot: null,
    }
  }

  if (
    current.canJoin === false
    && current.blockedReason
    && current.blockedReason !== 'This lobby is full.'
    && current.blockedReason !== 'This lobby is no longer open.'
  ) {
    return {
      canJoin: false,
      blockedReason: current.blockedReason,
      pendingSlot: null,
    }
  }

  return {
    canJoin: true,
    blockedReason: null,
    pendingSlot,
  }
}

function DraftWithConnection(props: {
  matchId: string
  autoStart: boolean
  steamLobbyLink: string | null
  lobbyId: string | null
  lobbyMode: string | null
  onSwitchTarget?: () => void
}) {
  const hasDraftState = () => draftStore.state != null
  const hasTerminalState = () => {
    const status = draftStore.state?.status
    return status === 'complete' || status === 'cancelled'
  }
  const shouldRenderDraftView = () => {
    const status = connectionStatus()
    return status === 'connected' || (status === 'reconnecting' && hasDraftState())
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

      <Match when={shouldRenderDraftView()}>
        <>
          <DraftView
            matchId={props.matchId}
            autoStart={props.autoStart}
            steamLobbyLink={props.steamLobbyLink}
            lobbyId={props.lobbyId}
            lobbyMode={props.lobbyMode}
            onSwitchTarget={props.onSwitchTarget}
          />
          <Show when={connectionStatus() === 'reconnecting'}>
            <div class="pointer-events-none bottom-3 left-3 fixed z-50 sm:bottom-4 sm:left-4">
              <div class="text-xs text-fg px-3 py-1.5 border border-border rounded-full bg-bg-subtle/90 shadow-2xl shadow-black/30 backdrop-blur-sm">
                Reconnecting...
              </div>
            </div>
          </Show>
        </>
      </Match>

      <Match when={connectionStatus() === 'reconnecting'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">Reconnecting to draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={hasTerminalState() && (connectionStatus() === 'error' || connectionStatus() === 'disconnected')}>
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          steamLobbyLink={props.steamLobbyLink}
          lobbyId={props.lobbyId}
          lobbyMode={props.lobbyMode}
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
  if (a.maxRole !== b.maxRole) return false
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
