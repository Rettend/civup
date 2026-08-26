import type { JSX } from 'solid-js'
import type { PlayerDataExportFile, PlayerDataExportState } from '../lib/player-data-export'
import type { ActivityTargetDescriptor } from '../lib/activity-targets'
import type {
  ActivityLaunchSelection,
  ActivityLaunchSnapshot,
  ActivityOverviewSnapshot,
  ActivityStateChange,
  ActivityTargetOption,
  LobbyJoinEligibilitySnapshot,
  LobbySnapshot,
  LobbyStateWatch,
  SelectedSessionStateChange,
  SessionSocketTarget,
} from '../stores'
import type { ActivityState } from './activity-context'
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { useLocation, useNavigate } from '@solidjs/router'
import { batch, createEffect, createSignal, onCleanup, onMount, Show, startTransition, untrack } from 'solid-js'
import { activityTargetOptionKey, activityTargetsMatch, filterClearedActivityTargetOptions, getBrokenMatchRefreshKey, resolveAutoSelectedActivityTarget, resolveMissingLiveTarget, shouldApplyActivityLaunchSnapshotRefresh, shouldApplyResolvedActivitySelection, shouldHoldAuthenticatedDraftStateForSelection, shouldReconnectVisibleActivityTarget, shouldRequestActivityTargetSelection } from '../lib/activity-targets'
import { fetchActivityAdminCapabilities, NO_ACTIVITY_ADMIN_CAPABILITIES } from '../lib/admin-capabilities'
import { buildActivitySessionHeaders } from '../lib/activity-session'
import { getAutosaveUploadErrorMessage, uploadAutosaveMultipart } from '../lib/autosave-upload'
import { relayDevLog } from '../lib/dev-log'
import { bootstrapBrowserChannel, bootstrapBrowserSession } from '../platform/browser-platform'
import { bootstrapDiscordPlatform } from '../platform/discord-platform'
import { openExternalLink } from '../platform/external-links'
import {
  connectionStatus,
  connectionCloseReason,
  connectToSession,
  disconnect,
  draftStore,
  fetchActivityLaunchSnapshot,
  resetDraft,
  selectActivityTarget,
  setAuthenticatedUser,
  guildId as currentGuildId,
  setIsMiniView,
  setIsMobileLayout,
  watchLobbyState,
} from '../stores'
import { ActivityControllerContext } from './activity-context'
import { browserChannelPath, browserPracticePath, browserSessionPath, parseBrowserLaunchRoute, parseBrowserReturnPath, shouldWatchChannelFeed } from './route-policy'

const SESSION_SOCKET_TARGET = resolveSessionSocketTarget()
const MINI_VIEW_MAX_WIDTH = 430
const MINI_VIEW_MAX_HEIGHT = 260
const MINI_VIEW_MIN_ASPECT_RATIO = 1.5
const MOBILE_LAYOUT_BREAKPOINT = 640
const AUTOSAVE_UPLOAD_ACCEPT = '.zip,application/zip,application/x-zip-compressed'
const MAX_AUTOSAVE_UPLOAD_BYTES = 512 * 1024 * 1024

type AutosaveUploadState
  = | { status: 'idle' }
    | { status: 'uploading', fileName: string }
    | { status: 'success', fileName: string }
    | { status: 'error', message: string }

interface AutosaveUploadInitResponse {
  id?: string
  partSizeBytes?: number
  error?: string
}

interface AutosaveFolderFile {
  file: File
  relativePath: string
}

interface WebkitDataTransferItem {
  webkitGetAsEntry?: () => WebkitFileSystemEntry | null
}

interface WebkitFileSystemEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
}

interface WebkitFileSystemFileEntry extends WebkitFileSystemEntry {
  isFile: true
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void
}

interface WebkitFileSystemDirectoryEntry extends WebkitFileSystemEntry {
  isDirectory: true
  createReader: () => WebkitFileSystemDirectoryReader
}

interface WebkitFileSystemDirectoryReader {
  readEntries: (success: (entries: WebkitFileSystemEntry[]) => void, error?: (error: DOMException) => void) => void
}

let cachedOverviewTargets: ActivityTargetOption[] = []

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
    sessionAccessToken: string | null
    steamLobbyLink: string | null
    lobbyId: string | null
    mode: string | null
    status: ActivityTargetOption['status']
  }

type LiveRoute
  = | { kind: 'root' }
    | { kind: 'overview' }
    | { kind: 'uploads' }
    | { kind: 'lobby', id: string }
    | { kind: 'draft', id: string }

export default function ActivityShell(props: { children?: JSX.Element }) {
  const navigate = useNavigate()
  const location = useLocation()
  const surface = location.pathname.startsWith('/web/') ? 'web' as const : 'discord-embedded' as const
  const browserRoute = () => surface === 'web' ? parseBrowserLaunchRoute(location.pathname) : null
  const directBrowserSessionId = () => {
    const route = browserRoute()
    return route?.kind === 'session' ? route.sessionId : null
  }
  const browserReturnPath = () => browserRoute()?.kind === 'channel' ? parseBrowserReturnPath(location.search, 'session') : null
  const browserReturnRoute = () => {
    const path = browserReturnPath()
    return path ? parseBrowserLaunchRoute(path) : null
  }
  const browserRouteKey = () => `${location.pathname}${location.search}`
  const [state, setState] = createSignal<ActivityState>({ status: 'loading' })
  const [availableTargets, setAvailableTargets] = createSignal<ActivityTargetOption[]>(cachedOverviewTargets)
  const [pickerBusy, setPickerBusy] = createSignal(false)
  const [pickerError, setPickerError] = createSignal<string | null>(null)
  const [lastResolvedSelection, setLastResolvedSelection] = createSignal<ActivityLaunchSelection | null>(null)
  const [fallbackOptions, setFallbackOptions] = createSignal<ActivityTargetOption[]>([])
  const [clearedTarget, setClearedTarget] = createSignal<ActivityTargetDescriptor>(null)
  const [overviewPinned, setOverviewPinned] = createSignal(false)
  const [liveOverviewSnapshot, setLiveOverviewSnapshot] = createSignal<ActivityOverviewSnapshot | null | undefined>(undefined)
  const [liveTargetState, setLiveTargetState] = createSignal<LiveActivityTargetState | null>(null)
  const [liveLobbySnapshotVersion, setLiveLobbySnapshotVersion] = createSignal(0)
  const [autosaveDragActive, setAutosaveDragActive] = createSignal(false)
  const [autosaveUploadState, setAutosaveUploadState] = createSignal<AutosaveUploadState>({ status: 'idle' })
  const [adminCapabilities, setAdminCapabilities] = createSignal(NO_ACTIVITY_ADMIN_CAPABILITIES)
  const [playerDataExportState, setPlayerDataExportState] = createSignal<PlayerDataExportState>({ status: 'idle' })
  const [loadedBrowserRouteKey, setLoadedBrowserRouteKey] = createSignal<string | null>(null)
  let activityWatch: LobbyStateWatch | null = null
  let launchSnapshotFallbackTimeout: ReturnType<typeof setTimeout> | null = null
  let autosaveUploadResetTimeout: ReturnType<typeof setTimeout> | null = null
  let autosaveFileInput: HTMLInputElement | undefined
  let autosaveFolderInput: HTMLInputElement | undefined
  let autosaveDragDepth = 0
  let activeChannelId: string | null = null
  let activeUserId: string | null = null
  let pendingTargetSelectionKey: string | null = null
  let brokenMatchRefreshKey: string | null = null
  let selectionRequestVersion = 0
  let liveStateRevision = 0
  let launchSnapshotRequestVersion = 0
  let browserRouteRequestVersion = 0
  let adminCapabilitiesRequestVersion = 0
  let playerDataExportRequestVersion = 0
  let pendingPlayerDataExport: PlayerDataExportFile | null = null
  let overviewPushSourcePath: string | null = null
  let pendingLiveRoutePath: string | null = null
  let suppressAutoSelection = false
  let refreshInFlight = false
  const liveLobbySnapshots = new Map<string, LobbySnapshot>()
  const failedAutoSelectionKeys = new Set<string>()

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

  const clearAutosaveUploadReset = () => {
    if (!autosaveUploadResetTimeout) return
    clearTimeout(autosaveUploadResetTimeout)
    autosaveUploadResetTimeout = null
  }

  const hasHydratedLiveActivityState = () => liveOverviewSnapshot() !== undefined

  const updateAvailableTargets = (options: ActivityTargetOption[]) => {
    cachedOverviewTargets = options
    setAvailableTargets(options)
  }

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
    clearAutosaveUploadReset()
    browserRouteRequestVersion += 1
    adminCapabilitiesRequestVersion += 1
    playerDataExportRequestVersion += 1
    pendingPlayerDataExport = null
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

  onMount(() => {
    if (surface === 'web') return
    const handleDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      autosaveDragDepth += 1
      setAutosaveDragActive(true)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setAutosaveDragActive(true)
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      autosaveDragDepth = Math.max(0, autosaveDragDepth - 1)
      if (autosaveDragDepth === 0) setAutosaveDragActive(false)
    }

    const handleDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      autosaveDragDepth = 0
      setAutosaveDragActive(false)

      void handleAutosaveDrop(event.dataTransfer)
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)

    onCleanup(() => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
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
      sessionAccessToken: selection.sessionAccessToken,
      steamLobbyLink: selection.steamLobbyLink,
      lobbyId: selection.lobbyId ?? selection.option.lobbyId,
      mode: selection.mode ?? selection.option.mode,
      status: selection.option.status,
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
      originGuildId: currentGuildId() ?? '',
      mode: lobbyMode ?? '1v1',
      status: 'drafting',
      participantCount: 0,
      targetSize: 0,
      redDeath: false,
      civBlitz: false,
      isMember: true,
      isHost: false,
      updatedAt: Date.now(),
    }
  }

  const transitionToDraft = (
    matchId: string,
    autoStart: boolean,
    steamLobbyLink: string | null,
    sessionAccessToken: string | null,
    lobbyContext?: {
      lobbyId: string | null
      lobbyMode: string | null
      reported?: boolean
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
    const nextReported = lobbyContext?.reported === true

    const previousSelection = lastResolvedSelection()
    if (previousSelection?.kind !== 'match' || previousSelection.matchId !== matchId) {
      setLastResolvedSelection({
        kind: 'match',
        option: resolveMatchSelectionOption(matchId, nextLobbyId, nextLobbyMode),
        matchId,
        steamLobbyLink,
        sessionAccessToken,
        lobbyId: nextLobbyId,
        mode: nextLobbyMode,
      })
    }

    setState({ status: 'authenticated', matchId, autoStart: nextAutoStart, steamLobbyLink, sessionAccessToken, lobbyId: nextLobbyId, lobbyMode: nextLobbyMode, reported: nextReported })
    if (nextReported) {
      const shouldKeepTerminalDraft = isSameMatch && hasTerminalDraft
      disconnect()
      if (!shouldKeepTerminalDraft) resetDraft()
      return
    }
    if (isSameMatch && (isDraftConnectionInFlight() || hasTerminalDraft)) return

    resetDraft()
    connectToSession(SESSION_SOCKET_TARGET, nextLobbyId ?? matchId, sessionAccessToken, { onStateChanged: handleSelectedSessionStateChange })
  }

  const handleSelectedSessionStateChange = (change: SelectedSessionStateChange) => {
    liveStateRevision += 1

    if (change.type === 'session-started') {
      transitionToDraft(change.matchId, true, change.steamLobbyLink, change.sessionAccessToken, {
        lobbyId: change.lobbyId,
        lobbyMode: change.mode,
      })
      return
    }

    if (change.snapshot) {
      const snapshot = change.snapshot
      const current = liveLobbySnapshots.get(snapshot.id)
      if (current && snapshot.revision < current.revision) return
      liveLobbySnapshots.set(snapshot.id, snapshot)
      setLiveLobbySnapshotVersion(version => version + 1)

      const currentState = state()
      if (currentState.status === 'authenticated' && (currentState.matchId === snapshot.id || currentState.lobbyId === snapshot.id)) {
        const currentUserId = activeUserId ?? ''
        const existingOption = availableTargets().find(option => option.kind === 'lobby' && option.id === snapshot.id) ?? null
        const option = existingOption ?? buildLobbyTargetOptionFromSnapshot(snapshot, currentUserId, activeChannelId)
        const options = existingOption ? availableTargets() : [...availableTargets(), option]
        const joinEligibility = resolveLiveJoinEligibility(options, option, snapshot, currentUserId)

        resetDraft()
        setLastResolvedSelection({
          kind: 'lobby',
          option,
          pendingJoin: false,
          joinEligibility,
          lobby: snapshot,
        })
        setLiveTargetState({ kind: 'lobby', id: snapshot.id, pendingJoin: false })
        setState({ status: 'lobby-waiting', lobby: snapshot, joinPending: false, joinEligibility })
        disconnect()
        return
      }

      setState((prev) => {
        if (prev.status !== 'lobby-waiting' || prev.lobby.id !== snapshot.id) return prev
        const option = availableTargets().find(target => target.kind === 'lobby' && target.id === snapshot.id)
          ?? lastResolvedSelection()?.option
        const joinEligibility = option
          ? resolveLiveJoinEligibility(availableTargets(), option, snapshot, activeUserId ?? '')
          : prev.joinEligibility
        return { status: 'lobby-waiting', lobby: snapshot, joinPending: prev.joinPending, joinEligibility }
      })
      return
    }

    liveLobbySnapshots.delete(change.lobbyId)
    setLiveLobbySnapshotVersion(version => version + 1)
    const current = state()
    if (current.status === 'lobby-waiting' && current.lobby.id === change.lobbyId) {
      setLiveTargetState(null)
      setClearedTarget({ kind: 'lobby', id: change.lobbyId })
      setState({ status: 'overview' })
      void requestActivityLaunchSnapshotRefresh()
    }
  }

  const reconnectVisibleSelection = () => {
    const current = state()
    if (!shouldReconnectVisibleActivityTarget({
      appStatus: current.status,
      connectionStatus: connectionStatus(),
      draftStatus: draftStore.state?.status ?? null,
      hasOpenSwapWindow: draftStore.swapState != null,
    })) { return }

    if (current.status === 'authenticated') {
      connectToSession(SESSION_SOCKET_TARGET, current.lobbyId ?? current.matchId, current.sessionAccessToken, { onStateChanged: handleSelectedSessionStateChange })
      return
    }

    const directSessionId = directBrowserSessionId()
    if (current.status === 'lobby-waiting' && directSessionId) {
      connectToSession(SESSION_SOCKET_TARGET, directSessionId, null, { onStateChanged: handleSelectedSessionStateChange })
      return
    }
    if (current.status === 'lobby-waiting' && activeChannelId && activeUserId && !activityWatch) startActivityWatch(activeChannelId, activeUserId)
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
    updateAvailableTargets(filteredSnapshot.options)

    if (!filteredSnapshot.selection) {
      setPickerError(null)

      if (shouldHoldAuthenticatedDraftState()) return

      setLastResolvedSelection(null)
      if (current.status === 'authenticated') {
        clearDraftConnection()
      }
      else if (current.status === 'lobby-waiting') {
        disconnect()
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
      disconnect()
      const directSessionId = directBrowserSessionId()
      if (directSessionId) {
        connectToSession(SESSION_SOCKET_TARGET, directSessionId, null, { onStateChanged: handleSelectedSessionStateChange })
      }
      return
    }

    if (filteredSnapshot.selection.option.reported === true) {
      const current = state()
      if (current.status === 'authenticated' && current.matchId === filteredSnapshot.selection.matchId && draftStore.state?.status === 'complete') {
        if (!current.reported) setState({ ...current, reported: true })
        return
      }
      transitionToDraft(filteredSnapshot.selection.matchId, autoStart, filteredSnapshot.selection.steamLobbyLink, filteredSnapshot.selection.sessionAccessToken, {
        lobbyId: filteredSnapshot.selection.lobbyId ?? filteredSnapshot.selection.option.lobbyId,
        lobbyMode: filteredSnapshot.selection.mode ?? filteredSnapshot.selection.option.mode,
        reported: true,
      })
      return
    }

    transitionToDraft(filteredSnapshot.selection.matchId, autoStart, filteredSnapshot.selection.steamLobbyLink, filteredSnapshot.selection.sessionAccessToken, {
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
    const route = browserRoute()
    if (surface === 'web' && route?.kind === 'channel') {
      const bootstrap = await bootstrapBrowserChannel(route.channelId)
      if (activeChannelId !== channelId || activeUserId !== userId) return
      hydrateActivityLaunchSnapshot(bootstrap.context.snapshot)
      return
    }
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
    })) { return }

    hydrateActivityLaunchSnapshot(snapshot)
  }

  const requestActivityLaunchSnapshotRefresh = async () => {
    const directSessionId = directBrowserSessionId()
    if (directSessionId) {
      if (refreshInFlight) return
      refreshInFlight = true
      try {
        const bootstrap = await bootstrapBrowserSession(directSessionId)
        if (bootstrap.context.status === 'ended') {
          setState({ status: 'error', message: 'This session has ended.' })
          clearDraftConnection()
          return
        }
        hydrateActivityLaunchSnapshot({
          selection: bootstrap.context.selection,
          options: [bootstrap.context.selection.option],
        }, true)
      }
      finally {
        refreshInFlight = false
      }
      return
    }
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

  const navigateToSelectionFromOverview = (selection: ActivityLaunchSelection, options: { auto?: boolean } = {}) => {
    if (surface === 'web') {
      const sessionId = selection.kind === 'lobby' ? selection.lobby.id : selection.lobbyId ?? selection.option.lobbyId
      void startTransition(() => navigate(browserSessionPath(sessionId), { scroll: false }))
      return
    }
    if (options.auto || state().status !== 'overview') return
    if (parseLiveRoute(location.pathname)?.kind !== 'overview') return

    const selectedPath = getCanonicalSelectionPath(selection)
    pendingLiveRoutePath = selectedPath
    void startTransition(() => {
      navigate(selectedPath, { scroll: false })
    })
  }

  const openOverview = (options: { replace?: boolean } = {}) => {
    if (surface === 'web') {
      const channelId = activeChannelId
      if (!channelId) return
      void startTransition(() => navigate(browserChannelPath(channelId, directBrowserSessionId() ?? undefined), { scroll: false }))
      return
    }

    const current = state()
    const replace = options.replace ?? false
    pendingTargetSelectionKey = null
    pendingLiveRoutePath = '/overview'
    selectionRequestVersion += 1
    setPickerBusy(false)
    setPickerError(null)
    if (!replace && location.pathname !== '/overview') overviewPushSourcePath = location.pathname
    batch(() => {
      setOverviewPinned(true)
      setState({ status: 'overview' })
    })
    void startTransition(() => {
      navigate('/overview', { replace, scroll: false })
    })
    if (current.status === 'authenticated') {
      clearDraftConnection()
    }
    else if (current.status === 'lobby-waiting') {
      disconnect()
      resetDraft()
    }
    else {
      resetDraft()
    }
    void requestActivityLaunchSnapshotRefresh()
  }

  const openPractice = () => {
    if (surface === 'web') {
      const channelId = activeChannelId
      if (!channelId) return
      const returnRoute = browserReturnRoute()
      void startTransition(() => navigate(browserPracticePath(channelId, returnRoute?.kind === 'session' ? returnRoute.sessionId : undefined), { scroll: false }))
      return
    }

    pendingTargetSelectionKey = null
    pendingLiveRoutePath = null
    selectionRequestVersion += 1
    setPickerBusy(false)
    setPickerError(null)
    stopActivityWatch()
    clearLaunchSnapshotFallback()
    clearDraftConnection()
    void startTransition(() => {
      navigate('/practice/great-people', { scroll: false })
    })
  }

  const openAutosaveUpload = () => {
    if (autosaveUploadState().status === 'uploading') return
    autosaveFileInput?.click()
  }

  const openAutosaveFolderUpload = () => {
    if (autosaveUploadState().status === 'uploading') return
    autosaveFolderInput?.click()
  }

  const openAutosaveCatalog = () => {
    void startTransition(() => {
      navigate('/uploads', { scroll: false })
    })
  }

  const canViewAutosaveCatalog = () => {
    return surface === 'discord-embedded' && adminCapabilities().autosaveCatalog
  }

  const canExportPlayerData = () => adminCapabilities().playerDataExport

  const refreshAdminCapabilities = async () => {
    const requestVersion = ++adminCapabilitiesRequestVersion
    setAdminCapabilities(NO_ACTIVITY_ADMIN_CAPABILITIES)
    const capabilities = await fetchActivityAdminCapabilities()
    if (requestVersion === adminCapabilitiesRequestVersion) setAdminCapabilities(capabilities)
  }

  const exportPlayerData = async () => {
    if (!canExportPlayerData()) return
    const currentState = playerDataExportState()
    if (currentState.status === 'loading' || currentState.status === 'estimating') return
    if (currentState.status === 'ready') {
      await openPlayerDataExportDownload(currentState.url)
      return
    }

    const shouldEstimate = currentState.status === 'idle'
      || (currentState.status === 'error' && currentState.retry === 'estimate')
    if (shouldEstimate) {
      const requestVersion = ++playerDataExportRequestVersion
      setPlayerDataExportState({ status: 'estimating' })
      try {
        const { fetchPlayerDataExportEstimate } = await import('../lib/player-data-export')
        const estimate = await fetchPlayerDataExportEstimate()
        if (requestVersion === playerDataExportRequestVersion) setPlayerDataExportState({ status: 'estimate', estimate })
      }
      catch (error) {
        if (requestVersion !== playerDataExportRequestVersion) return
        setPlayerDataExportState({
          status: 'error',
          retry: 'estimate',
          message: error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Player data export estimate failed.',
        })
      }
      return
    }

    if (currentState.status !== 'estimate' && !(currentState.status === 'error' && currentState.retry === 'export')) return

    const requestVersion = ++playerDataExportRequestVersion
    const existingExport = pendingPlayerDataExport
    setPlayerDataExportState(existingExport
      ? {
          status: 'loading',
          phase: 'workbook',
          players: existingExport.source.players.length,
          ratings: existingExport.source.ratings.length,
          matches: existingExport.source.matches.length,
          participants: existingExport.source.participants.length,
          bans: existingExport.source.bans.length,
        }
      : {
          status: 'loading',
          phase: 'players',
          players: 0,
          ratings: 0,
          matches: 0,
          participants: 0,
          bans: 0,
        })

    try {
      const { createPlayerDataExport, publishPlayerDataExport } = await import('../lib/player-data-export')
      const result = existingExport ?? await createPlayerDataExport({
        onProgress(progress) {
          if (requestVersion === playerDataExportRequestVersion) setPlayerDataExportState({ status: 'loading', ...progress })
        },
      })
      if (requestVersion !== playerDataExportRequestVersion) return
      pendingPlayerDataExport = result
      const published = await publishPlayerDataExport(result)
      if (requestVersion !== playerDataExportRequestVersion) return
      pendingPlayerDataExport = null
      setPlayerDataExportState({
        status: 'ready',
        filename: published.filename,
        url: published.url,
        players: result.source.players.length,
        matches: result.source.matches.length,
      })
      await openPlayerDataExportDownload(published.url)
    }
    catch (error) {
      if (requestVersion !== playerDataExportRequestVersion) return
      setPlayerDataExportState({
        status: 'error',
        retry: 'export',
        message: error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Player data export failed.',
      })
    }
  }

  const openPlayerDataExportDownload = async (url: string) => {
    try {
      const opened = await openExternalLink(url)
      if (!opened) window.open(url, '_blank', 'noopener')
    }
    catch (error) {
      console.error('Player data download failed:', error)
      window.open(url, '_blank', 'noopener')
    }
  }

  const setAutosaveUploadMessage = (nextState: AutosaveUploadState, resetDelayMs = 4500) => {
    clearAutosaveUploadReset()
    setAutosaveUploadState(nextState)
    if (nextState.status === 'uploading') return

    autosaveUploadResetTimeout = setTimeout(() => {
      autosaveUploadResetTimeout = null
      setAutosaveUploadState({ status: 'idle' })
    }, resetDelayMs)
  }

  const uploadAutosaveFile = async (file: File | null) => {
    if (!file) return
    const validationError = validateAutosaveUploadFile(file)
    if (validationError) {
      setAutosaveUploadMessage({ status: 'error', message: validationError })
      return
    }

    clearAutosaveUploadReset()
    setAutosaveUploadState({ status: 'uploading', fileName: file.name })

    try {
      await uploadAutosaveFileMultipart(file)
      setAutosaveUploadMessage({ status: 'success', fileName: file.name })
    }
    catch (error) {
      setAutosaveUploadMessage({
        status: 'error',
        message: error instanceof Error && error.message.trim().length > 0 ? error.message : 'Upload failed',
      }, 6500)
    }
  }

  const uploadAutosaveFileMultipart = async (file: File) => {
    const current = state()
    const initResponse = await fetch('/api/uploads/autosaves/init', {
      method: 'POST',
      headers: buildActivitySessionHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        fileName: file.name,
        fileSizeBytes: file.size,
        contentType: file.type || 'application/zip',
        channelId: activeChannelId,
        matchId: current.status === 'authenticated' ? current.matchId : null,
      }),
    })
    const initPayload = await initResponse.json().catch(() => null) as AutosaveUploadInitResponse | null
    if (!initResponse.ok) {
      throw new Error(getAutosaveUploadErrorMessage(initResponse.status, initPayload?.error))
    }
    if (!initPayload?.id) throw new Error('Upload init returned an invalid response')

    const partSizeBytes = normalizeAutosaveMultipartPartSize(initPayload.partSizeBytes)
    if (partSizeBytes == null) {
      await fetch(`/api/uploads/autosaves/${encodeURIComponent(initPayload.id)}/abort`, {
        method: 'POST',
        headers: buildActivitySessionHeaders(),
      }).catch(() => null)
      throw new Error('Upload init returned an invalid multipart response')
    }
    relayDevLog('warn', '[autosave-upload] multipart init ok', {
      id: initPayload.id,
      fileName: file.name,
      fileSizeBytes: file.size,
      partSizeBytes,
    })
    await uploadAutosaveMultipart({ file, uploadId: initPayload.id, partSizeBytes })
  }

  const uploadAutosaveFolder = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []).map(file => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }))

    await uploadAutosaveFolderFiles(files)
  }

  const uploadAutosaveFolderFiles = async (files: readonly AutosaveFolderFile[]) => {
    if (files.length === 0) return

    const folderName = resolveFolderUploadName(files)
    const zipName = `${folderName}.zip`
    clearAutosaveUploadReset()
    setAutosaveUploadState({ status: 'uploading', fileName: zipName })

    try {
      const zipFile = await zipAutosaveFolder(files, zipName)
      await uploadAutosaveFile(zipFile)
    }
    catch (error) {
      setAutosaveUploadMessage({
        status: 'error',
        message: error instanceof Error && error.message.trim().length > 0 ? error.message : 'Failed to zip folder',
      }, 6500)
    }
  }

  const handleAutosaveDrop = async (dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return

    try {
      const folderFiles = await readDroppedFolderFiles(dataTransfer)
      if (folderFiles) {
        await uploadAutosaveFolderFiles(folderFiles)
        return
      }

      const files = dataTransfer.files
      if (!files || files.length === 0) return
      if (files.length > 1) {
        setAutosaveUploadMessage({ status: 'error', message: 'Drop one autosave zip or folder at a time' })
        return
      }
      await uploadAutosaveFile(files.item(0))
    }
    catch (error) {
      setAutosaveUploadMessage({
        status: 'error',
        message: error instanceof Error && error.message.trim().length > 0 ? error.message : 'Drop failed',
      }, 6500)
    }
  }

  const requestTargetSelection = async (option: ActivityTargetOption, auto = false) => {
    if (surface === 'web') {
      void startTransition(() => navigate(browserSessionPath(option.lobbyId), { scroll: false }))
      return
    }
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
      if (result.snapshot.selection) navigateToSelectionFromOverview(result.snapshot.selection, { auto })
      pendingTargetSelectionKey = null
      failedAutoSelectionKeys.delete(optionKey)
      setPickerBusy(false)
      setPickerError(null)
      hydrateActivityLaunchSnapshot(result.snapshot, true)
      return
    }

    if (pendingTargetSelectionKey === optionKey) {
      pendingTargetSelectionKey = null
    }
    if (auto && result.status === 409) failedAutoSelectionKeys.add(optionKey)
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
    const current = state()
    if (!currentUserId || overviewSnapshot === undefined) return

    clearLaunchSnapshotFallback()

    const rawOptions = overviewSnapshot === undefined
      ? fallbackOptions()
      : overviewSnapshot
        ? materializeOverviewOptions(overviewSnapshot, currentUserId)
        : []
    const options = applyLiveLobbyMembership(visibleTargetOptions(rawOptions), liveLobbySnapshots, currentUserId)
    const resolvedSnapshot = buildLiveActivityLaunchSnapshot(options, targetState, liveLobbySnapshots, currentUserId)
    const targetOption = targetState
      ? options.find(option => activityTargetOptionKey(option) === activityTargetOptionKey(targetState)) ?? null
      : null
    const waitingOnLobbySnapshot = targetState?.kind === 'lobby' && targetOption != null && !liveLobbySnapshots.has(targetState.id)
    const pendingSelectionKey = pendingTargetSelectionKey
    const resolvedAutoSelectedOption = resolveAutoSelectedActivityTarget({
      options,
      target: targetState,
      overviewPinned: overviewPinned(),
      suppressAutoSelection,
    })
    const autoSelectedOption = resolvedAutoSelectedOption && !failedAutoSelectionKeys.has(activityTargetOptionKey(resolvedAutoSelectedOption))
      ? resolvedAutoSelectedOption
      : null

    updateAvailableTargets(options)

    if (targetState && !targetOption) {
      const missingTarget = resolveMissingLiveTarget({
        options,
        target: targetState,
        currentLobbyId: current.status === 'lobby-waiting' ? current.lobby.id : null,
        hasCurrentLobbySnapshot: targetState.kind === 'lobby' && liveLobbySnapshots.has(targetState.id),
        failedAutoSelectionKeys,
      })
      if (missingTarget.kind === 'promote') {
        void requestTargetSelection(missingTarget.option, true)
        return
      }
      if (missingTarget.kind === 'hold') return

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
        isOverviewVisible: current.status === 'overview',
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
      connectionCloseReason: connectionCloseReason(),
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
    failedAutoSelectionKeys.clear()
    setPickerBusy(false)
    setFallbackOptions([])
    setLiveOverviewSnapshot(undefined)
    liveLobbySnapshots.clear()
    setLiveLobbySnapshotVersion(version => version + 1)

    activityWatch = watchLobbyState(SESSION_SOCKET_TARGET, {
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

  createEffect(() => {
    const current = state()
    const channelId = activeChannelId
    const userId = activeUserId
    if (surface === 'web' && loadedBrowserRouteKey() !== browserRouteKey()) {
      stopActivityWatch()
      return
    }
    if (!shouldWatchChannelFeed({ directSessionId: directBrowserSessionId(), status: current.status }) || !channelId || !userId) {
      stopActivityWatch()
      return
    }
    if (!activityWatch) startActivityWatch(channelId, userId)
  })

  const handleTargetSelection = async (option: ActivityTargetOption) => {
    suppressAutoSelection = false
    const optionKey = activityTargetOptionKey(option)
    failedAutoSelectionKeys.delete(optionKey)
    if (!shouldRequestActivityTargetSelection({ option, currentTargetKey: currentTargetKey() })) {
      pendingTargetSelectionKey = optionKey
      const lastSelection = lastResolvedSelection()
      if (lastSelection && activityTargetOptionKey(lastSelection.option) === optionKey) {
        navigateToSelectionFromOverview(lastSelection)
      }
      applyLiveActivityState()
      return
    }
    await requestTargetSelection(option)
  }

  const restoreLastSelection = async () => {
    if (surface === 'web') {
      const returnPath = browserReturnPath()
      if (returnPath) void startTransition(() => navigate(returnPath, { scroll: false }))
      return
    }

    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return
    suppressAutoSelection = false
    const optionKey = activityTargetOptionKey(lastSelection.option)
    failedAutoSelectionKeys.delete(optionKey)
    if (!shouldRequestActivityTargetSelection({ option: lastSelection.option, currentTargetKey: currentTargetKey() })) {
      pendingTargetSelectionKey = optionKey
      navigateToSelectionFromOverview(lastSelection)
      applyLiveActivityState()
      return
    }
    await requestTargetSelection(lastSelection.option)
  }

  const canResumeSelection = () => browserReturnPath() != null || lastResolvedSelection() != null

  createEffect(() => {
    if (surface !== 'web') return
    const route = browserRoute()
    const routeKey = browserRouteKey()
    const requestVersion = ++browserRouteRequestVersion

    stopActivityWatch()
    clearLaunchSnapshotFallback()
    clearDraftConnection()
    setPickerBusy(false)
    setPickerError(null)
    setState({ status: 'loading' })

    void untrack(async () => {
      try {
        if (!route) throw new Error('Invalid browser URL')
        if (route.kind === 'session') {
          const bootstrap = await bootstrapBrowserSession(route.sessionId)
          if (requestVersion !== browserRouteRequestVersion) return
          setAuthenticatedUser(bootstrap.identity)
          activeUserId = bootstrap.identity.userId
          void refreshAdminCapabilities()
          if (bootstrap.context.status === 'ended') {
            setLoadedBrowserRouteKey(routeKey)
            setState({ status: 'error', message: 'This session has ended.' })
            return
          }
          activeChannelId = bootstrap.context.selection.option.channelId
          setLoadedBrowserRouteKey(routeKey)
          hydrateActivityLaunchSnapshot({
            selection: bootstrap.context.selection,
            options: [bootstrap.context.selection.option],
          }, true)
          return
        }

        const bootstrap = await bootstrapBrowserChannel(route.channelId)
        if (requestVersion !== browserRouteRequestVersion) return
        setAuthenticatedUser(bootstrap.identity)
        activeChannelId = bootstrap.context.channelId
        activeUserId = bootstrap.identity.userId
        void refreshAdminCapabilities()
        setOverviewPinned(true)
        setLoadedBrowserRouteKey(routeKey)
        hydrateActivityLaunchSnapshot(bootstrap.context.snapshot, true)
      }
      catch (err) {
        if (requestVersion !== browserRouteRequestVersion) return
        console.error('Browser app setup failed:', err)
        relayDevLog('error', 'Browser app setup failed', err)
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
  })

  onMount(async () => {
    if (surface === 'web') return
    try {
      const bootstrap = await bootstrapDiscordPlatform()
      setAuthenticatedUser(bootstrap.identity)
      const channelId = bootstrap.channelId

      if (!channelId) {
        setState({ status: 'error', message: 'No channel ID found - start from Discord' })
        return
      }

      activeChannelId = channelId
      activeUserId = bootstrap.identity.userId
      void refreshAdminCapabilities()
      const initialRoute = parseLiveRoute(location.pathname)
      if (initialRoute?.kind === 'overview') {
        setOverviewPinned(true)
        if (availableTargets().length > 0) setState({ status: 'overview' })
      }
      void requestActivityLaunchSnapshotRefresh()
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
      if (directBrowserSessionId()) {
        reconnectVisibleSelection()
        return
      }
      if (state().status === 'overview' || state().status === 'lobby-waiting') {
        if (!activityWatch) startActivityWatch(activeChannelId, activeUserId)
        void requestActivityLaunchSnapshotRefresh()
        return
      }
      reconnectVisibleSelection()
      void requestActivityLaunchSnapshotRefresh()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    })
  })

  let routeRestoreAttemptKey: string | null = null

  createEffect(() => {
    if (surface === 'web') return
    const route = parseLiveRoute(location.pathname)
    const current = state()
    if (current.status === 'loading' || current.status === 'error') return

    if (!route || route.kind === 'root') {
      routeRestoreAttemptKey = null
      return
    }

    if (route.kind === 'overview') {
      routeRestoreAttemptKey = null
      const currentPath = getCanonicalLivePath(current)
      if (current.status !== 'overview' && currentPath !== pendingLiveRoutePath) untrack(() => openOverview({ replace: true }))
      return
    }

    if (current.status !== 'overview') {
      routeRestoreAttemptKey = null
      return
    }

    if (overviewPushSourcePath === location.pathname) return

    if (!liveRouteMatchesSelection(route, lastResolvedSelection())) return

    const routeKey = liveRouteKey(route)
    if (routeRestoreAttemptKey === routeKey || pickerBusy()) return
    routeRestoreAttemptKey = routeKey
    void untrack(restoreLastSelection)
  })

  createEffect(() => {
    if (surface === 'web') return
    const current = state()
    const canonicalPath = getCanonicalLivePath(current)
    if (!canonicalPath) return
    if (pendingLiveRoutePath && location.pathname === pendingLiveRoutePath) pendingLiveRoutePath = null
    if (location.pathname === canonicalPath) {
      if (canonicalPath === '/overview') overviewPushSourcePath = null
      return
    }

    const route = parseLiveRoute(location.pathname)
    if (route?.kind === 'uploads') return
    if (canonicalPath === '/overview' && overviewPushSourcePath === location.pathname) return
    if (canonicalPath === pendingLiveRoutePath) return
    if (
      current.status === 'overview'
      && route
      && route.kind !== 'overview'
      && route.kind !== 'root'
      && pickerBusy()
      && liveRouteMatchesSelection(route, lastResolvedSelection())
    ) {
      return
    }

    void startTransition(() => {
      navigate(canonicalPath, { replace: true, scroll: false })
    })
  })

  return (
    <ActivityControllerContext.Provider
      value={{
        canSwitchTargets: true,
        canResumeSelection,
        state,
        availableTargets,
        supportedServers: () => liveOverviewSnapshot()?.supportedServers ?? [],
        pickerBusy,
        pickerError,
        lastResolvedSelection,
        currentTargetKey,
        openOverview,
        openPractice,
        openAutosaveUpload,
        openAutosaveFolderUpload,
        openAutosaveCatalog,
        canViewAutosaveCatalog,
        canExportPlayerData,
        exportPlayerData,
        playerDataExportState,
        handleTargetSelection,
        restoreLastSelection,
        transitionToDraft,
      }}
    >
      {props.children}
      <input
        ref={(element) => { autosaveFileInput = element }}
        type="file"
        class="hidden"
        accept={AUTOSAVE_UPLOAD_ACCEPT}
        onChange={(event) => {
          const file = event.currentTarget.files?.item(0) ?? null
          event.currentTarget.value = ''
          void uploadAutosaveFile(file)
        }}
      />
      <input
        ref={(element) => {
          autosaveFolderInput = element
          element.setAttribute('webkitdirectory', '')
          element.setAttribute('directory', '')
        }}
        type="file"
        class="hidden"
        multiple
        onChange={(event) => {
          const files = event.currentTarget.files
          event.currentTarget.value = ''
          void uploadAutosaveFolder(files)
        }}
      />
      <AutosaveDropOverlay visible={autosaveDragActive()} />
      <AutosaveUploadToast
        state={autosaveUploadState()}
        onDismiss={() => {
          clearAutosaveUploadReset()
          setAutosaveUploadState({ status: 'idle' })
        }}
      />
    </ActivityControllerContext.Provider>
  )
}

function AutosaveDropOverlay(props: { visible: boolean }) {
  return (
    <Show when={props.visible}>
      <div class="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 backdrop-blur-[2px] pointer-events-none">
        <div class="mx-6 max-w-md rounded-3xl border border-border-subtle bg-bg-subtle/92 px-8 py-7 text-center shadow-2xl">
          <div class="i-ph-upload-simple-bold mx-auto mb-4 text-5xl text-fg-muted" />
          <div class="text-xl font-bold text-fg">Upload autosaves</div>
          <div class="mt-2 text-sm text-fg-muted">Upload the <code class="rounded bg-bg px-1 py-0.5 text-fg">auto</code> folder to share the game with others</div>
        </div>
      </div>
    </Show>
  )
}

function AutosaveUploadToast(props: { state: AutosaveUploadState, onDismiss: () => void }) {
  const iconClass = () => {
    const status = props.state.status
    if (status === 'success') return 'i-ph-check-circle-bold text-emerald-300'
    if (status === 'error') return 'i-ph-warning-circle-bold text-danger'
    return 'i-gg:spinner animate-spin text-fg-muted'
  }

  const messageClass = () => {
    const status = props.state.status
    if (status === 'error') return 'text-danger'
    if (status === 'success') return 'text-emerald-100'
    return 'text-fg'
  }

  const message = () => {
    const state = props.state
    if (state.status === 'uploading') return `Uploading ${state.fileName}...`
    if (state.status === 'success') return `Uploaded ${state.fileName}`
    if (state.status === 'error') return state.message
    return ''
  }

  return (
    <Show when={props.state.status !== 'idle'}>
      <div class="fixed bottom-5 right-5 z-[90] max-w-[min(24rem,calc(100vw-2.5rem))]">
        <div class="flex items-start gap-3 rounded-2xl border border-border-subtle bg-bg-subtle/95 px-4 py-3 text-fg shadow-2xl backdrop-blur">
          <span class={`${iconClass()} mt-0.5 shrink-0 text-xl`} />
          <div class={`min-w-0 flex-1 text-sm font-semibold break-words ${messageClass()}`}>{message()}</div>
          <Show when={props.state.status !== 'uploading'}>
            <button
              type="button"
              class="text-fg-muted transition hover:text-fg"
              aria-label="Dismiss upload status"
              onClick={props.onDismiss}
            >
              <span class="i-ph-x-bold text-base" />
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

async function zipAutosaveFolder(files: readonly AutosaveFolderFile[], fileName: string): Promise<File> {
  const zipWriter = new ZipWriter(new BlobWriter('application/zip'))
  const usedEntryNames = new Set<string>()

  for (const entry of files) {
    const entryName = dedupeZipEntryName(normalizeFolderUploadEntryPath(entry), usedEntryNames)
    await zipWriter.add(entryName, new BlobReader(entry.file), {
      lastModDate: Number.isFinite(entry.file.lastModified) ? new Date(entry.file.lastModified) : undefined,
    })
  }

  const blob = await zipWriter.close()
  return new File([blob], fileName, { type: 'application/zip', lastModified: Date.now() })
}

function resolveFolderUploadName(files: readonly AutosaveFolderFile[]): string {
  const relativePath = files.find(entry => entry.relativePath)?.relativePath ?? ''
  const root = relativePath.split(/[\\/]+/).find(segment => segment.trim().length > 0) ?? ''
  return sanitizeFolderUploadBaseName(root || 'autosaves')
}

function sanitizeFolderUploadBaseName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120)

  return normalized.length > 0 ? normalized : 'autosaves'
}

function normalizeFolderUploadEntryPath(entry: AutosaveFolderFile): string {
  const path = entry.relativePath || entry.file.name
  const segments = path
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')

  return segments.length > 0 ? segments.join('/') : 'autosave-file'
}

function dedupeZipEntryName(entryName: string, usedEntryNames: Set<string>): string {
  if (!usedEntryNames.has(entryName)) {
    usedEntryNames.add(entryName)
    return entryName
  }

  const extensionIndex = entryName.lastIndexOf('.')
  const base = extensionIndex > 0 ? entryName.slice(0, extensionIndex) : entryName
  const extension = extensionIndex > 0 ? entryName.slice(extensionIndex) : ''
  let index = 2
  let candidate = `${base}_${index}${extension}`
  while (usedEntryNames.has(candidate)) {
    index += 1
    candidate = `${base}_${index}${extension}`
  }
  usedEntryNames.add(candidate)
  return candidate
}

async function readDroppedFolderFiles(dataTransfer: DataTransfer): Promise<AutosaveFolderFile[] | null> {
  const entries = Array.from(dataTransfer.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => (item as unknown as WebkitDataTransferItem).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is WebkitFileSystemEntry => entry != null)

  const directories = entries.filter(isWebkitDirectoryEntry)
  if (directories.length === 0) return null
  if (entries.length !== 1 || directories.length !== 1) throw new Error('Drop one autosave folder at a time')
  const directory = directories[0]
  if (!directory) throw new Error('Drop one autosave folder at a time')

  return readDroppedDirectoryEntries(directory, directory.name)
}

async function readDroppedDirectoryEntries(directory: WebkitFileSystemDirectoryEntry, relativePath: string): Promise<AutosaveFolderFile[]> {
  const entries = await readAllDirectoryEntries(directory)
  const files = await Promise.all(entries.map(async (entry) => {
    const childPath = `${relativePath}/${entry.name}`
    if (isWebkitFileEntry(entry)) {
      return [{ file: await readDroppedFileEntry(entry), relativePath: childPath }]
    }
    if (isWebkitDirectoryEntry(entry)) return readDroppedDirectoryEntries(entry, childPath)
    return []
  }))

  return files.flat()
}

async function readAllDirectoryEntries(directory: WebkitFileSystemDirectoryEntry): Promise<WebkitFileSystemEntry[]> {
  const reader = directory.createReader()
  const entries: WebkitFileSystemEntry[] = []

  while (true) {
    const batch = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) return entries
    entries.push(...batch)
  }
}

async function readDroppedFileEntry(entry: WebkitFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function isWebkitFileEntry(entry: WebkitFileSystemEntry): entry is WebkitFileSystemFileEntry {
  return entry.isFile
}

function isWebkitDirectoryEntry(entry: WebkitFileSystemEntry): entry is WebkitFileSystemDirectoryEntry {
  return entry.isDirectory
}

function validateAutosaveUploadFile(file: File): string | null {
  if (!file.name.trim().toLowerCase().endsWith('.zip')) return 'Please upload one .zip file'
  if (file.size <= 0) return 'Selected zip is empty'
  if (file.size > MAX_AUTOSAVE_UPLOAD_BYTES) return 'This upload path supports autosave zips up to 512 MB'
  return null
}

function normalizeAutosaveMultipartPartSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function parseLiveRoute(pathname: string): LiveRoute | null {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  if (normalized === '/') return { kind: 'root' }
  if (normalized === '/overview') return { kind: 'overview' }
  if (normalized === '/uploads') return { kind: 'uploads' }

  const match = normalized.match(/^\/(lobby|draft)\/([^/]+)$/)
  if (!match?.[1] || !match[2]) return null

  const id = decodeURIComponent(match[2])
  if (match[1] === 'lobby') return { kind: 'lobby', id }
  return { kind: 'draft', id }
}

function liveRouteKey(route: LiveRoute): string {
  if (route.kind === 'root' || route.kind === 'overview' || route.kind === 'uploads') return route.kind
  return `${route.kind}:${route.id}`
}

function liveRouteMatchesSelection(route: LiveRoute, selection: ActivityLaunchSelection | null): boolean {
  if (!selection) return false
  if (route.kind === 'lobby') return selection.kind === 'lobby' && selection.lobby.id === route.id
  if (route.kind === 'draft') return selection.kind === 'match' && selection.matchId === route.id
  return false
}

function getCanonicalSelectionPath(selection: ActivityLaunchSelection): string {
  if (selection.kind === 'lobby') return `/lobby/${encodeURIComponent(selection.lobby.id)}`
  return `/draft/${encodeURIComponent(selection.matchId)}`
}

function getCanonicalLivePath(state: ActivityState): string | null {
  if (state.status === 'loading' || state.status === 'error') return null
  if (state.status === 'overview') return '/overview'
  if (state.status === 'lobby-waiting') return `/lobby/${encodeURIComponent(state.lobby.id)}`
  if (state.status === 'authenticated') return `/draft/${encodeURIComponent(state.matchId)}`
  return null
}

function resolveSessionSocketTarget(): SessionSocketTarget {
  return {
    host: typeof window !== 'undefined' ? window.location.host : 'localhost:5173',
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
      originGuildId: option.originGuildId,
      mode: option.mode,
      status: option.status,
      reported: option.reported,
      starting: option.starting,
      participantCount: option.participantCount,
      targetSize: option.targetSize,
      redDeath: option.redDeath,
      civBlitz: option.civBlitz,
      isMember: option.memberPlayerIds.includes(currentUserId),
      isHost: option.hostId === currentUserId,
      players: option.players ?? [],
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
      sessionAccessToken: targetState.sessionAccessToken,
      lobbyId: targetState.lobbyId,
      mode: targetState.mode,
    },
    options,
  }
}

function buildLobbyTargetOptionFromSnapshot(
  snapshot: LobbySnapshot,
  currentUserId: string,
  channelId: string | null,
): ActivityTargetOption {
  return {
    kind: 'lobby',
    id: snapshot.id,
    lobbyId: snapshot.id,
    matchId: null,
    channelId: channelId ?? '',
    originGuildId: snapshot.originGuildId ?? currentGuildId() ?? '',
    mode: snapshot.mode as ActivityTargetOption['mode'],
    status: snapshot.draftConfig.closed === true ? 'closed' : 'open',
    participantCount: snapshot.entries.filter(entry => entry != null).length,
    targetSize: snapshot.targetSize,
    redDeath: snapshot.draftConfig.redDeath,
    civBlitz: snapshot.draftConfig.civBlitz,
    isMember: isLobbySnapshotMember(snapshot, currentUserId),
    isHost: snapshot.hostId === currentUserId,
    updatedAt: Date.now(),
  }
}

function resolveLiveJoinEligibility(
  options: ActivityTargetOption[],
  selectedOption: ActivityTargetOption,
  lobby: LobbySnapshot,
  currentUserId: string,
): LobbyJoinEligibilitySnapshot {
  if (selectedOption.isMember || isLobbySnapshotMember(lobby, currentUserId)) {
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

  if (lobby.draftConfig.closed === true) {
    return {
      canJoin: false,
      blockedReason: 'This lobby is closed.',
      pendingSlot: null,
    }
  }

  if (options.some(option => option.kind === 'match' && option.status === 'drafting' && option.id !== selectedOption.id && (option.isHost || option.isMember))) {
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

function applyLiveLobbyMembership(
  options: ActivityTargetOption[],
  liveLobbySnapshots: ReadonlyMap<string, LobbySnapshot>,
  currentUserId: string,
): ActivityTargetOption[] {
  return options.map((option) => {
    if (option.kind !== 'lobby') return option
    const snapshot = liveLobbySnapshots.get(option.id)
    if (!snapshot) return option

    const status = snapshot.draftConfig.closed === true ? 'closed' : 'open'
    const participantCount = snapshot.entries.filter(entry => entry != null).length
    const isMember = option.isMember || isLobbySnapshotMember(snapshot, currentUserId)
    const isHost = snapshot.hostId === currentUserId
    if (
      option.status === status
      && option.participantCount === participantCount
      && option.targetSize === snapshot.targetSize
      && option.mode === snapshot.mode
      && option.redDeath === snapshot.draftConfig.redDeath
      && option.isMember === isMember
      && option.isHost === isHost
    ) return option

    return {
      ...option,
      mode: snapshot.mode,
      status,
      participantCount,
      targetSize: snapshot.targetSize,
      redDeath: snapshot.draftConfig.redDeath,
      isMember,
      isHost,
    }
  })
}

function isLobbySnapshotMember(snapshot: LobbySnapshot, currentUserId: string): boolean {
  if (!currentUserId) return false
  return snapshot.entries.some(entry => entry?.playerId === currentUserId)
    || snapshot.memberPlayerIds?.includes(currentUserId) === true
}

function isSameLobbySnapshot(a: LobbySnapshot, b: LobbySnapshot): boolean {
  if (a.id !== b.id) return false
  if (a.revision !== b.revision) return false
  if (a.mode !== b.mode) return false
  if (a.hostId !== b.hostId) return false
  if (a.status !== b.status) return false
  if (a.minRole !== b.minRole) return false
  if (a.maxRole !== b.maxRole) return false
  if ((a.lobbyRank?.tier ?? null) !== (b.lobbyRank?.tier ?? null)) return false
  if ((a.lobbyRank?.leaderPoolSize ?? null) !== (b.lobbyRank?.leaderPoolSize ?? null)) return false
  if (a.minPlayers !== b.minPlayers) return false
  if (a.targetSize !== b.targetSize) return false
  if (a.draftConfig.banTimerSeconds !== b.draftConfig.banTimerSeconds) return false
  if (a.draftConfig.pickTimerSeconds !== b.draftConfig.pickTimerSeconds) return false
  if (a.draftConfig.leaderPoolSize !== b.draftConfig.leaderPoolSize) return false
  if (a.draftConfig.leaderDataVersion !== b.draftConfig.leaderDataVersion) return false
  if (a.draftConfig.blindBans !== b.draftConfig.blindBans) return false
  if (a.draftConfig.bansPerTeam !== b.draftConfig.bansPerTeam) return false
  if (a.draftConfig.blindPicks !== b.draftConfig.blindPicks) return false
  if (a.draftConfig.simultaneousPick !== b.draftConfig.simultaneousPick) return false
  if (a.draftConfig.redDeath !== b.draftConfig.redDeath) return false
  if (a.draftConfig.dealOptionsSize !== b.draftConfig.dealOptionsSize) return false
  if (a.draftConfig.randomDraft !== b.draftConfig.randomDraft) return false
  if ((a.draftConfig.closed === true) !== (b.draftConfig.closed === true)) return false
  if ((a.tournament?.id ?? null) !== (b.tournament?.id ?? null)) return false
  if ((a.tournament?.rematchWarning ?? null) !== (b.tournament?.rematchWarning ?? null)) return false
  if ((a.repeatDraft?.kind ?? null) !== (b.repeatDraft?.kind ?? null)) return false
  if ((a.repeatDraft?.matchId ?? null) !== (b.repeatDraft?.matchId ?? null)) return false
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
    if ((aEntry.sourceGuild?.id ?? null) !== (bEntry.sourceGuild?.id ?? null)) return false
    if ((aEntry.sourceGuild?.name ?? null) !== (bEntry.sourceGuild?.name ?? null)) return false
    if ((aEntry.sourceGuild?.iconUrl ?? null) !== (bEntry.sourceGuild?.iconUrl ?? null)) return false
  }

  return true
}
