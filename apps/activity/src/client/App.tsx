import type { ActivityTargetDescriptor } from './lib/activity-targets'
import type {
  ActivityLaunchSelection,
  ActivityLaunchSnapshot,
  ActivityOverviewSnapshot,
  ActivityStateChange,
  ActivityTargetOption,
  LobbyJoinEligibilitySnapshot,
  LobbySnapshot,
  LobbyStateWatch,
  PartySocketTarget,
} from './stores'
import { batch, createEffect, createSignal, Match, onCleanup, onMount, Switch, untrack } from 'solid-js'
import { discordSdk, setupDiscordSdk } from './discord'
import { activityTargetOptionKey, activityTargetsMatch, filterClearedActivityTargetOptions, getBrokenMatchRefreshKey, resolveAutoSelectedActivityTarget, shouldApplyActivityLaunchSnapshotRefresh, shouldApplyResolvedActivitySelection, shouldHoldAuthenticatedDraftStateForSelection } from './lib/activity-targets'
import { relayDevLog } from './lib/dev-log'
import { DraftPage } from './pages/draft'
import { DraftSetupPage } from './pages/draft-setup'
import { LobbyOverviewPage } from './pages/lobby-overview'
import {
  connectionStatus,
  connectToRoom,
  disconnect,
  draftStore,
  fetchActivityLaunchSnapshot,
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
  const [clearedTarget, setClearedTarget] = createSignal<ActivityTargetDescriptor>(null)
  const [overviewPinned, setOverviewPinned] = createSignal(false)
  const [liveOverviewSnapshot, setLiveOverviewSnapshot] = createSignal<ActivityOverviewSnapshot | null | undefined>(undefined)
  const [liveTargetState, setLiveTargetState] = createSignal<LiveActivityTargetState | null>(null)
  const [liveLobbySnapshotVersion, setLiveLobbySnapshotVersion] = createSignal(0)
  let activityWatch: LobbyStateWatch | null = null
  let launchSnapshotFallbackTimeout: ReturnType<typeof setTimeout> | null = null
  let activeChannelId: string | null = null
  let activeUserId: string | null = null
  let pendingTargetSelectionKey: string | null = null
  let brokenMatchRefreshKey: string | null = null
  let selectionRequestVersion = 0
  let liveStateRevision = 0
  let launchSnapshotRequestVersion = 0
  let suppressAutoSelection = false
  let refreshInFlight = false
  const liveLobbySnapshots = new Map<string, LobbySnapshot>()

  const stopActivityWatch = () => {
    if (!activityWatch) return
    activityWatch.close()
    activityWatch = null
  }

  const clearLaunchSnapshotFallback = () => {
    if (!launchSnapshotFallbackTimeout) return
    clearTimeout(launchSnapshotFallbackTimeout)
    launchSnapshotFallbackTimeout = null
  }

  const hasHydratedLiveActivityState = () => liveOverviewSnapshot() !== undefined

  const clearDraftConnection = () => {
    disconnect()
    resetDraft()
  }

  const isDraftConnectionInFlight = () => {
    const status = connectionStatus()
    return status === 'connecting' || status === 'reconnecting' || status === 'connected'
  }

  const shouldHoldAuthenticatedDraftState = (nextSelectionKind: 'lobby' | 'match' | null = null) => {
    if (state().status !== 'authenticated') return false
    return shouldHoldAuthenticatedDraftStateForSelection({
      nextSelectionKind,
      hasInFlightConnection: isDraftConnectionInFlight(),
      draftState: draftStore.state,
    })
  }

  onCleanup(() => {
    clearLaunchSnapshotFallback()
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

  const visibleTargetOptions = (options: readonly ActivityTargetOption[]) => filterClearedActivityTargetOptions(options, clearedTarget())

  const targetStateFromSelection = (selection: ActivityLaunchSelection): LiveActivityTargetState => {
    if (selection.kind === 'lobby') {
      return {
        kind: 'lobby',
        id: selection.option.id,
        pendingJoin: selection.pendingJoin,
      }
    }

    return {
      kind: 'match',
      id: selection.matchId,
      pendingJoin: false,
      roomAccessToken: selection.roomAccessToken,
      steamLobbyLink: selection.steamLobbyLink,
      lobbyId: selection.lobbyId ?? selection.option.lobbyId,
      mode: selection.mode ?? selection.option.mode,
    }
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
      redDeath: false,
      isMember: true,
      isHost: false,
      updatedAt: Date.now(),
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
    const filteredSnapshot: ActivityLaunchSnapshot = {
      selection: snapshot.selection && activityTargetsMatch(snapshot.selection.option, clearedTarget())
        ? null
        : snapshot.selection,
      options: visibleTargetOptions(snapshot.options),
    }
    const current = state()
    setAvailableTargets(filteredSnapshot.options)

    if (!filteredSnapshot.selection) {
      setPickerError(null)

      if (shouldHoldAuthenticatedDraftState()) return

      setLastResolvedSelection(null)
      if (current.status === 'authenticated') {
        clearDraftConnection()
      }

      setState({ status: 'overview' })
      return
    }

    if (current.status === 'authenticated' && filteredSnapshot.selection.kind === 'lobby' && shouldHoldAuthenticatedDraftState('lobby')) return

    setLastResolvedSelection(filteredSnapshot.selection)

    if (!shouldApplyResolvedActivitySelection({
      isOverviewVisible: current.status === 'overview',
      allowSelectionWhileOverview,
    })) { return }

    if (filteredSnapshot.selection.kind === 'lobby') {
      const nextLobby = filteredSnapshot.selection.lobby
      const joinPending = filteredSnapshot.selection.pendingJoin
      const joinEligibility = filteredSnapshot.selection.joinEligibility
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

    transitionToDraft(filteredSnapshot.selection.matchId, autoStart, filteredSnapshot.selection.steamLobbyLink, filteredSnapshot.selection.roomAccessToken, {
      lobbyId: filteredSnapshot.selection.lobbyId ?? filteredSnapshot.selection.option.lobbyId,
      lobbyMode: filteredSnapshot.selection.mode ?? filteredSnapshot.selection.option.mode,
    })
  }

  const hydrateActivityLaunchSnapshot = (snapshot: ActivityLaunchSnapshot, allowSelectionWhileOverview = false) => {
    const filteredSnapshot: ActivityLaunchSnapshot = {
      selection: snapshot.selection && activityTargetsMatch(snapshot.selection.option, clearedTarget())
        ? null
        : snapshot.selection,
      options: visibleTargetOptions(snapshot.options),
    }

    setFallbackOptions(filteredSnapshot.options)
    if (filteredSnapshot.selection) setLiveTargetState(targetStateFromSelection(filteredSnapshot.selection))
    if (filteredSnapshot.selection?.kind === 'lobby') {
      liveLobbySnapshots.set(filteredSnapshot.selection.lobby.id, filteredSnapshot.selection.lobby)
      setLiveLobbySnapshotVersion(version => version + 1)
    }
    applyLaunchSnapshot(filteredSnapshot, false, allowSelectionWhileOverview)
  }

  const refreshActivityLaunchSnapshot = async (channelId: string, userId: string) => {
    const requestVersion = ++launchSnapshotRequestVersion
    const liveStateRevisionAtStart = liveStateRevision
    const snapshot = await fetchActivityLaunchSnapshot(channelId, userId)
    if (!snapshot) return

    if (!shouldApplyActivityLaunchSnapshotRefresh({
      requestVersion,
      latestRequestVersion: launchSnapshotRequestVersion,
      requestedChannelId: channelId,
      requestedUserId: userId,
      activeChannelId,
      activeUserId,
      hydratedLiveState: hasHydratedLiveActivityState(),
      liveStateRevisionAtStart,
      liveStateRevision,
    })) {
      return
    }

    hydrateActivityLaunchSnapshot(snapshot)
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

  const openOverview = () => {
    const current = state()
    const hadTerminalDraft = draftStore.state?.status === 'complete' || draftStore.state?.status === 'cancelled'
    pendingTargetSelectionKey = null
    selectionRequestVersion += 1
    setPickerBusy(false)
    setPickerError(null)
    batch(() => {
      setOverviewPinned(true)
      setState({ status: 'overview' })
    })
    if (current.status === 'authenticated') {
      if (hadTerminalDraft) setAvailableTargets([])
      clearDraftConnection()
    }
    else {
      resetDraft()
    }
    void requestActivityLaunchSnapshotRefresh()
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
    if (result.ok) {
      pendingTargetSelectionKey = null
      setPickerBusy(false)
      setPickerError(null)
      hydrateActivityLaunchSnapshot(result.snapshot, true)
      return
    }

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
    if (!currentUserId || overviewSnapshot === undefined) return

    clearLaunchSnapshotFallback()

    const rawOptions = overviewSnapshot === undefined
      ? fallbackOptions()
      : overviewSnapshot
        ? materializeOverviewOptions(overviewSnapshot, currentUserId)
        : []
    const options = visibleTargetOptions(rawOptions)
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
      if (targetState.kind === 'lobby') {
        const promotedMatch = options.find(option => option.kind === 'match' && option.lobbyId === targetState.id) ?? null
        if (promotedMatch) {
          void requestTargetSelection(promotedMatch, true)
          return
        }
      }
      setLiveTargetState(null)
      setClearedTarget(targetState)
      suppressAutoSelection = true
      void requestActivityLaunchSnapshotRefresh()
      return
    }

    if (resolvedSnapshot?.selection) {
      const resolvedKey = activityTargetOptionKey(resolvedSnapshot.selection.option)
      const allowSelectionWhileOverview = !overviewPinned() || (pendingSelectionKey != null && pendingSelectionKey === resolvedKey)
      if (!shouldApplyResolvedActivitySelection({
        isOverviewVisible: state().status === 'overview',
        allowSelectionWhileOverview,
      })) { return }

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

  const handleActivityStateChange = (_channelId: string, _currentUserId: string, change: ActivityStateChange) => {
    liveStateRevision += 1

    if (change.type === 'overview') {
      setLiveOverviewSnapshot(change.snapshot)
      applyLiveActivityState()
      return
    }

    if (change.type === 'lobby') {
      if (change.snapshot) {
        const snapshot = change.snapshot
        const current = liveLobbySnapshots.get(snapshot.id)
        if (current && snapshot.revision < current.revision) {
          return
        }
        liveLobbySnapshots.set(snapshot.id, snapshot)
      }
      else {
        liveLobbySnapshots.delete(change.lobbyId)
        if (liveOverviewSnapshot() === null) {
          void requestActivityLaunchSnapshotRefresh()
        }
      }
      setLiveLobbySnapshotVersion(version => version + 1)
      applyLiveActivityState()
    }
  }

  createEffect(() => {
    liveOverviewSnapshot()
    liveTargetState()
    liveLobbySnapshotVersion()
    fallbackOptions()
    overviewPinned()
    untrack(applyLiveActivityState)
  })

  createEffect(() => {
    if (state().status !== 'overview') setOverviewPinned(false)
  })

  createEffect(() => {
    const current = state()
    const refreshKey = getBrokenMatchRefreshKey({
      appStatus: current.status,
      currentMatchId: current.status === 'authenticated' ? current.matchId : null,
      connectionStatus: connectionStatus(),
      draftState: draftStore.state,
    })

    if (current.status !== 'authenticated') {
      brokenMatchRefreshKey = null
      return
    }

    if (!refreshKey || brokenMatchRefreshKey === refreshKey) return

    brokenMatchRefreshKey = refreshKey
    void requestActivityLaunchSnapshotRefresh()
  })

  const startActivityWatch = (channelId: string, currentUserId: string) => {
    stopActivityWatch()
    clearLaunchSnapshotFallback()
    pendingTargetSelectionKey = null
    selectionRequestVersion += 1
    liveStateRevision += 1
    launchSnapshotRequestVersion += 1
    suppressAutoSelection = false
    setPickerBusy(false)
    setFallbackOptions([])
    setLiveOverviewSnapshot(undefined)
    liveLobbySnapshots.clear()
    setLiveLobbySnapshotVersion(version => version + 1)

    activityWatch = watchLobbyState(PARTY_SOCKET_TARGET, {
      channelId,
      userId: currentUserId,
      onStateChanged: (change) => {
        handleActivityStateChange(channelId, currentUserId, change)
      },
      onError: (message) => {
        if (liveOverviewSnapshot() === undefined) {
          setState({ status: 'error', message })
        }
      },
    })

    launchSnapshotFallbackTimeout = setTimeout(() => {
      launchSnapshotFallbackTimeout = null
      if (activeChannelId !== channelId || activeUserId !== currentUserId || hasHydratedLiveActivityState()) return
      void refreshActivityLaunchSnapshot(channelId, currentUserId)
    }, 1500)
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

  onMount(() => {
    const handleVisibilityChange = () => {
      if (!activeChannelId || !activeUserId) return
      if (document.visibilityState === 'hidden') {
        // Keep the current draft UI state, but drop background sockets so hidden activities do not keep retrying.
        disconnect()
        stopActivityWatch()
        clearLaunchSnapshotFallback()
        return
      }
      if (activityWatch) return
      startActivityWatch(activeChannelId, activeUserId)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    })
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
          <LobbyOverviewPage
            options={availableTargets()}
            busy={pickerBusy()}
            selectedKey={currentTargetKey()}
            error={pickerError()}
            onSelect={handleTargetSelection}
            onResume={lastResolvedSelection() ? restoreLastSelection : undefined}
          />
        </Match>

        <Match when={state().status === 'lobby-waiting'}>
          <DraftSetupPage
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
          <DraftPage
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

function materializeOverviewOptions(
  snapshot: ActivityOverviewSnapshot | null,
  currentUserId: string,
): ActivityTargetOption[] {
  if (!snapshot) return []

  return snapshot.options
    .map(option => ({
      kind: option.kind,
      id: option.id,
      lobbyId: option.lobbyId,
      matchId: option.matchId,
      channelId: option.channelId,
      mode: option.mode,
      status: option.status,
      participantCount: option.participantCount,
      targetSize: option.targetSize,
      redDeath: option.redDeath,
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
  if (left.redDeath !== right.redDeath) return left.redDeath ? -1 : 1
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
  if (a.draftConfig.blindBans !== b.draftConfig.blindBans) return false
  if (a.draftConfig.simultaneousPick !== b.draftConfig.simultaneousPick) return false
  if (a.draftConfig.redDeath !== b.draftConfig.redDeath) return false
  if (a.draftConfig.dealOptionsSize !== b.draftConfig.dealOptionsSize) return false
  if (a.draftConfig.randomDraft !== b.draftConfig.randomDraft) return false
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
  }

  return true
}
