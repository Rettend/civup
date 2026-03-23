import type {
  ActivityLaunchSelection,
  ActivityLaunchSnapshot,
  ActivityOverviewOptionSnapshot,
  ActivityOverviewSnapshot,
  ActivityTargetOption,
  LobbyJoinEligibilitySnapshot,
  LobbySnapshot,
  LobbyStateWatch,
  PartySocketTarget,
} from './stores'
import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch, untrack } from 'solid-js'
import { activityTargetOptionKey, ActivityTargetPicker, ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import { didClearResolvedActivityTarget, resolveAutoSelectedActivityTarget, shouldApplyResolvedActivitySelection, shouldHoldAuthenticatedDraftStateForSelection } from './lib/activity-targets'
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
const MINI_VIEW_MAX_WIDTH = 430
const MINI_VIEW_MAX_HEIGHT = 260
const MINI_VIEW_MIN_ASPECT_RATIO = 1.5
const MOBILE_LAYOUT_BREAKPOINT = 640

type LiveActivityTargetState
  = | {
    kind: 'lobby'
    id: string
    pendingJoin: boolean
  }
    | {
      kind: 'match'
      id: string
      pendingJoin: boolean
      roomAccessToken: string | null
      steamLobbyLink: string | null
      lobbyId: string | null
      mode: string | null
    }

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })
  const [availableTargets, setAvailableTargets] = createSignal<ActivityTargetOption[]>([])
  const [pickerBusy, setPickerBusy] = createSignal(false)
  const [pickerError, setPickerError] = createSignal<string | null>(null)
  const [lastResolvedSelection, setLastResolvedSelection] = createSignal<ActivityLaunchSelection | null>(null)
  const [fallbackOptions, setFallbackOptions] = createSignal<ActivityTargetOption[]>([])
  const [overviewPinned, setOverviewPinned] = createSignal(false)
  const [liveOverviewSnapshot, setLiveOverviewSnapshot] = createSignal<ActivityOverviewSnapshot | null | undefined>(undefined)
  const [liveTargetState, setLiveTargetState] = createSignal<LiveActivityTargetState | null | undefined>(undefined)
  const [liveLobbySnapshotVersion, setLiveLobbySnapshotVersion] = createSignal(0)
  let activityWatch: LobbyStateWatch | null = null
  let activeChannelId: string | null = null
  let activeUserId: string | null = null
  let pendingTargetSelectionKey: string | null = null
  const subscribedLobbySnapshotKeys = new Set<string>()
  let selectionRequestVersion = 0
  let suppressAutoSelection = false
  let refreshInFlight = false
  const liveLobbySnapshots = new Map<string, LobbySnapshot>()

  const stopActivityWatch = () => {
    if (!activityWatch) return
    activityWatch.close()
    activityWatch = null
    subscribedLobbySnapshotKeys.clear()
  }

  const clearDraftConnection = () => {
    disconnect()
    resetDraft()
  }

  const shouldHoldAuthenticatedDraftState = (nextSelectionKind: 'lobby' | 'match' | null = null) => {
    if (state().status !== 'authenticated') return false
    return shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind,
      hasInFlightConnection: isDraftConnectionInFlight(),
      draftState: draftStore.state,
    })
  }

  const isDraftConnectionInFlight = () => {
    const status = connectionStatus()
    return status === 'connecting' || status === 'reconnecting' || status === 'connected'
  }

  onCleanup(() => {
    stopActivityWatch()
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
    setOverviewPinned(true)
    setState({ status: 'overview' })
    applyLiveActivityState()
    void requestActivityLaunchSnapshotRefresh()
  }

  const syncActivityWatchSubscriptions = () => {
    if (!activityWatch || !activeChannelId || !activeUserId) return

    const target = liveTargetState()
    activityWatch.subscribeKey(activityOverviewStateKey(activeChannelId))
    activityWatch.subscribeKey(activityTargetStateKey(activeUserId, activeChannelId))

    const nextLobbySnapshotKeys = new Set(
      availableTargets()
        .filter((option): option is ActivityTargetOption & { kind: 'lobby' } => option.kind === 'lobby')
        .map(option => lobbySnapshotStateKey(option.id)),
    )
    if (target?.kind === 'lobby') {
      nextLobbySnapshotKeys.add(lobbySnapshotStateKey(target.id))
    }

    for (const key of subscribedLobbySnapshotKeys) {
      if (nextLobbySnapshotKeys.has(key)) continue
      activityWatch.unsubscribeKey(key)
      subscribedLobbySnapshotKeys.delete(key)
    }

    for (const key of nextLobbySnapshotKeys) {
      if (subscribedLobbySnapshotKeys.has(key)) continue
      activityWatch.subscribeKey(key)
      subscribedLobbySnapshotKeys.add(key)
    }
  }

  const requestTargetSelection = async (option: ActivityTargetOption, auto = false) => {
    const channelId = activeChannelId
    const currentUserId = activeUserId
    if (!channelId || !currentUserId) return

    const optionKey = activityTargetOptionKey(option)
    if (pendingTargetSelectionKey === optionKey) return

    pendingTargetSelectionKey = optionKey
    const requestVersion = ++selectionRequestVersion
    setPickerBusy(true)
    setPickerError(null)

    const result = await selectActivityTarget(channelId, currentUserId, option)
    if (requestVersion !== selectionRequestVersion) return
    if (result.ok) return

    if (pendingTargetSelectionKey === optionKey) {
      pendingTargetSelectionKey = null
    }
    setPickerBusy(false)
    setPickerError(result.error)
    void requestActivityLaunchSnapshotRefresh()
    if (auto && state().status === 'loading') {
      setState({ status: 'error', message: result.error })
    }
  }

  const applyLiveActivityState = () => {
    const currentUserId = activeUserId
    const overviewSnapshot = liveOverviewSnapshot()
    const targetState = liveTargetState()
    if (!currentUserId || overviewSnapshot === undefined || targetState === undefined) return

    const options = overviewSnapshot
      ? materializeOverviewOptions(overviewSnapshot, currentUserId)
      : fallbackOptions()
    const resolvedSnapshot = buildLiveActivityLaunchSnapshot(options, targetState, liveLobbySnapshots, currentUserId)
    const targetOption = targetState
      ? options.find(option => activityTargetOptionKey(option) === activityTargetOptionKey(targetState)) ?? null
      : null
    const waitingOnLobbySnapshot = targetState?.kind === 'lobby' && targetOption != null && !liveLobbySnapshots.has(targetState.id)
    const pendingSelectionKey = pendingTargetSelectionKey
    const autoSelectedOption = resolveAutoSelectedActivityTarget({
      options,
      target: targetState,
      overviewPinned: overviewPinned(),
      suppressAutoSelection,
    })

    setAvailableTargets(options)

    if (targetState && !targetOption) {
      void requestActivityLaunchSnapshotRefresh()
      return
    }

    if (resolvedSnapshot?.selection) {
      const resolvedKey = activityTargetOptionKey(resolvedSnapshot.selection.option)
      const allowSelectionWhileOverview = !overviewPinned() || (pendingSelectionKey != null && pendingSelectionKey === resolvedKey)
      if (!shouldApplyResolvedActivitySelection({
        isOverviewVisible: state().status === 'overview',
        allowSelectionWhileOverview,
      })) {
        return
      }

      if (pendingSelectionKey === resolvedKey) {
        pendingTargetSelectionKey = null
        setPickerBusy(false)
      }
      applyLaunchSnapshot(resolvedSnapshot, false, allowSelectionWhileOverview)
      return
    }

    if (waitingOnLobbySnapshot) return

    if (!targetOption) {
      if (autoSelectedOption) {
        void requestTargetSelection(autoSelectedOption, true)
        if (state().status === 'loading') return
      }
    }

    if (pendingTargetSelectionKey == null) {
      setPickerBusy(false)
    }
    applyLaunchSnapshot({ selection: null, options }, false, !overviewPinned())
  }

  const handleActivityStateChange = (channelId: string, currentUserId: string, key: string, op: 'put' | 'delete', value?: string) => {
    if (key === activityOverviewStateKey(channelId)) {
      setLiveOverviewSnapshot(op === 'put' ? parseActivityOverviewValue(value) : null)
      applyLiveActivityState()
      return
    }

    if (key === activityTargetStateKey(currentUserId, channelId)) {
      const previousTargetState = liveTargetState()
      const nextTargetState = op === 'put' ? parseActivityTargetState(value) : null

      if (didClearResolvedActivityTarget(previousTargetState, nextTargetState)) {
        suppressAutoSelection = true
        pendingTargetSelectionKey = null
        selectionRequestVersion += 1
        setPickerBusy(false)
        setPickerError(null)
      }
      else if (nextTargetState) {
        suppressAutoSelection = false
      }

      setLiveTargetState(nextTargetState)
      syncActivityWatchSubscriptions()
      applyLiveActivityState()
      return
    }

    if (key.startsWith('lobby:snapshot:')) {
      if (op === 'put') {
        const snapshot = parseLobbySnapshotValue(value)
        if (!snapshot) return
        const current = liveLobbySnapshots.get(snapshot.id)
        if (current && snapshot.revision < current.revision) {
          return
        }
        liveLobbySnapshots.set(snapshot.id, snapshot)
      }
      else {
        const lobbyId = key.slice('lobby:snapshot:'.length)
        liveLobbySnapshots.delete(lobbyId)
        if (liveOverviewSnapshot() === null) {
          void requestActivityLaunchSnapshotRefresh()
        }
      }
      setLiveLobbySnapshotVersion(version => version + 1)
      applyLiveActivityState()
      return
    }
  }

  createEffect(() => {
    liveTargetState()
    availableTargets()
    syncActivityWatchSubscriptions()
  })

  createEffect(() => {
    liveOverviewSnapshot()
    liveTargetState()
    liveLobbySnapshotVersion()
    fallbackOptions()
    overviewPinned()
    untrack(applyLiveActivityState)
  })

  const hydrateActivityLaunchSnapshot = (snapshot: ActivityLaunchSnapshot) => {
    setFallbackOptions(snapshot.options)
    if (snapshot.selection?.kind === 'lobby') {
      liveLobbySnapshots.set(snapshot.selection.lobby.id, snapshot.selection.lobby)
      setLiveLobbySnapshotVersion(version => version + 1)
    }
    applyLaunchSnapshot(snapshot)
  }

  const refreshActivityLaunchSnapshot = async (channelId: string, userId: string) => {
    const snapshot = await fetchActivityLaunchSnapshot(channelId, userId)
    if (!snapshot) return
    hydrateActivityLaunchSnapshot(snapshot)
  }

  const resolveMatchSelectionOption = (matchId: string, lobbyId: string | null, lobbyMode: string | null): ActivityTargetOption => {
    const resolved = availableTargets().find(option => option.kind === 'match' && option.id === matchId)
      ?? fallbackOptions().find(option => option.kind === 'match' && option.id === matchId)
    if (resolved) return resolved

    const lastSelection = lastResolvedSelection()
    if (lastSelection?.kind === 'match' && lastSelection.matchId === matchId) {
      return lastSelection.option
    }

    return {
      kind: 'match',
      id: matchId,
      lobbyId: lobbyId ?? '',
      matchId,
      channelId: activeChannelId ?? '',
      mode: lobbyMode ?? '1v1',
      status: 'drafting',
      participantCount: 0,
      targetSize: 0,
      isMember: true,
      isHost: false,
      updatedAt: Date.now(),
    }
  }

  const requestActivityLaunchSnapshotRefresh = async () => {
    const channelId = activeChannelId
    const userId = activeUserId
    if (!channelId || !userId || refreshInFlight) return

    refreshInFlight = true
    try {
      await refreshActivityLaunchSnapshot(channelId, userId)
    }
    finally {
      refreshInFlight = false
    }
  }

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

    const previousSelection = lastResolvedSelection()
    if (previousSelection?.kind !== 'match' || previousSelection.matchId !== matchId) {
      setLastResolvedSelection({
        kind: 'match',
        option: resolveMatchSelectionOption(matchId, nextLobbyId, nextLobbyMode),
        matchId,
        steamLobbyLink,
        roomAccessToken,
        lobbyId: nextLobbyId,
        mode: nextLobbyMode,
      })
    }

    setState({ status: 'authenticated', matchId, autoStart: nextAutoStart, steamLobbyLink, roomAccessToken, lobbyId: nextLobbyId, lobbyMode: nextLobbyMode })
    if (isSameMatch && (isDraftConnectionInFlight() || hasTerminalDraft)) return

    resetDraft()
    connectToRoom(PARTY_SOCKET_TARGET, matchId, roomAccessToken)
  }

  const applyLaunchSnapshot = (
    snapshot: ActivityLaunchSnapshot,
    autoStart = false,
    allowSelectionWhileOverview = false,
  ) => {
    const current = state()
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

    if (current.status === 'authenticated' && snapshot.selection.kind === 'lobby' && shouldHoldAuthenticatedDraftState('lobby')) return

    setLastResolvedSelection(snapshot.selection)

    if (!shouldApplyResolvedActivitySelection({
      isOverviewVisible: current.status === 'overview',
      allowSelectionWhileOverview,
    })) return

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
      lobbyId: snapshot.selection.lobbyId ?? snapshot.selection.option.lobbyId,
      lobbyMode: snapshot.selection.mode ?? snapshot.selection.option.mode,
    })
  }

  const startActivityWatch = (channelId: string, currentUserId: string) => {
    stopActivityWatch()
    pendingTargetSelectionKey = null
    selectionRequestVersion += 1
    suppressAutoSelection = false
    setPickerBusy(false)
    setFallbackOptions([])
    setLiveOverviewSnapshot(undefined)
    setLiveTargetState(undefined)
    liveLobbySnapshots.clear()
    setLiveLobbySnapshotVersion(version => version + 1)

    activityWatch = watchLobbyState(PARTY_SOCKET_TARGET, {
      channelId,
      userId: currentUserId,
      onConnected: () => {
        syncActivityWatchSubscriptions()
      },
      onStateChanged: ({ key, op, value }) => {
        handleActivityStateChange(channelId, currentUserId, key, op, value)
      },
      onError: (message) => {
        if (liveOverviewSnapshot() === undefined || liveTargetState() === undefined) {
          setState({ status: 'error', message })
        }
      },
    })

    syncActivityWatchSubscriptions()
    void refreshActivityLaunchSnapshot(channelId, currentUserId)
  }

  const handleTargetSelection = async (option: ActivityTargetOption) => {
    suppressAutoSelection = false
    const optionKey = activityTargetOptionKey(option)
    if (currentTargetKey() === optionKey) {
      pendingTargetSelectionKey = optionKey
      applyLiveActivityState()
      return
    }
    await requestTargetSelection(option)
  }

  const restoreLastSelection = async () => {
    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return
    suppressAutoSelection = false
    const optionKey = activityTargetOptionKey(lastSelection.option)
    if (currentTargetKey() === optionKey) {
      pendingTargetSelectionKey = optionKey
      applyLiveActivityState()
      return
    }
    await requestTargetSelection(lastSelection.option)
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

function activityOverviewStateKey(channelId: string): string {
  return `activity:overview:${channelId}`
}

function lobbySnapshotStateKey(lobbyId: string): string {
  return `lobby:snapshot:${lobbyId}`
}

function parseActivityTargetState(value: string | undefined): LiveActivityTargetState | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as {
      kind?: unknown
      id?: unknown
      pendingJoin?: unknown
      roomAccessToken?: unknown
      steamLobbyLink?: unknown
      lobbyId?: unknown
      mode?: unknown
    }

    if ((parsed.kind !== 'lobby' && parsed.kind !== 'match') || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      return null
    }

    if (parsed.kind === 'match') {
      return {
        kind: 'match',
        id: parsed.id,
        pendingJoin: false,
        roomAccessToken: typeof parsed.roomAccessToken === 'string' && parsed.roomAccessToken.length > 0 ? parsed.roomAccessToken : null,
        steamLobbyLink: typeof parsed.steamLobbyLink === 'string' && parsed.steamLobbyLink.length > 0 ? parsed.steamLobbyLink : null,
        lobbyId: typeof parsed.lobbyId === 'string' && parsed.lobbyId.length > 0 ? parsed.lobbyId : null,
        mode: typeof parsed.mode === 'string' && parsed.mode.length > 0 ? parsed.mode : null,
      }
    }

    return {
      kind: 'lobby',
      id: parsed.id,
      pendingJoin: parsed.pendingJoin === true,
    }
  }
  catch {
    return null
  }
}

function parseActivityOverviewValue(value: string | undefined): ActivityOverviewSnapshot | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as Partial<ActivityOverviewSnapshot>
    if (typeof parsed.channelId !== 'string' || !Array.isArray(parsed.options)) {
      return null
    }
    return parsed as ActivityOverviewSnapshot
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

function materializeOverviewOptions(
  snapshot: ActivityOverviewSnapshot | null,
  currentUserId: string,
): ActivityTargetOption[] {
  if (!snapshot) return []

  return snapshot.options
    .map((option) => ({
      kind: option.kind,
      id: option.id,
      lobbyId: option.lobbyId,
      matchId: option.matchId,
      channelId: option.channelId,
      mode: option.mode,
      status: option.status,
      participantCount: option.participantCount,
      targetSize: option.targetSize,
      isMember: option.memberPlayerIds.includes(currentUserId),
      isHost: option.hostId === currentUserId,
      updatedAt: option.updatedAt,
    }))
    .sort(compareActivityTargetOptions)
}

function compareActivityTargetOptions(left: ActivityTargetOption, right: ActivityTargetOption): number {
  const leftPriority = activityTargetPriority(left)
  const rightPriority = activityTargetPriority(right)
  if (leftPriority !== rightPriority) return leftPriority - rightPriority

  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.mode !== right.mode) return left.mode.localeCompare(right.mode)
  return left.id.localeCompare(right.id)
}

function activityTargetPriority(option: ActivityTargetOption): number {
  if (option.isHost) return 0
  if (option.isMember) return 1
  if (option.kind === 'lobby') return 2
  return option.status === 'drafting' ? 3 : 4
}

function buildLiveActivityLaunchSnapshot(
  options: ActivityTargetOption[],
  targetState: LiveActivityTargetState | null,
  liveLobbySnapshots: ReadonlyMap<string, LobbySnapshot>,
  currentUserId: string,
): ActivityLaunchSnapshot | null {
  if (!targetState) return null

  const option = options.find(candidate => activityTargetOptionKey(candidate) === activityTargetOptionKey(targetState))
  if (!option) return null

  if (targetState.kind === 'lobby') {
    const lobby = liveLobbySnapshots.get(targetState.id)
    if (!lobby) return null

    return {
      selection: {
        kind: 'lobby',
        option,
        pendingJoin: targetState.pendingJoin,
        joinEligibility: resolveLiveJoinEligibility(options, option, lobby, currentUserId),
        lobby,
      },
      options,
    }
  }

  return {
    selection: {
      kind: 'match',
      option,
      matchId: targetState.id,
      steamLobbyLink: targetState.steamLobbyLink,
      roomAccessToken: targetState.roomAccessToken,
      lobbyId: targetState.lobbyId,
      mode: targetState.mode,
    },
    options,
  }
}

function resolveLiveJoinEligibility(
  options: ActivityTargetOption[],
  selectedOption: ActivityTargetOption,
  lobby: LobbySnapshot,
  currentUserId: string,
): LobbyJoinEligibilitySnapshot {
  if (lobby.entries.some(entry => entry?.playerId === currentUserId)) {
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

  if (options.some(option => option.kind === 'match' && option.id !== selectedOption.id && (option.isHost || option.isMember))) {
    return {
      canJoin: false,
      blockedReason: 'You are already in a live match.',
      pendingSlot: null,
    }
  }

  if (options.some(option => option.kind === 'lobby' && option.id !== selectedOption.id && (option.isHost || option.isMember))) {
    return {
      canJoin: false,
      blockedReason: 'You are already in another open lobby.',
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
  if (a.draftConfig.leaderDataVersion !== b.draftConfig.leaderDataVersion) return false
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
