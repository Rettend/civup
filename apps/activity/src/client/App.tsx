import type { ActivityLaunchSelection, ActivityTargetOption, LobbyJoinEligibilitySnapshot, LobbySnapshot, LobbyStateWatch } from './stores'
import { createEffect, createSignal, flush, onCleanup, onSettled, Show } from 'solid-js'
import { activityTargetOptionKey, ActivityTargetPicker, ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import { postDevTrace, updateDevOverlay } from './lib/debug-trace'
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
const ACTIVITY_BOOTSTRAP_TIMEOUT_MS = 90_000
const MINI_VIEW_MAX_WIDTH = 520
const MINI_VIEW_MAX_HEIGHT = 340

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })
  const [availableTargets, setAvailableTargets] = createSignal<ActivityTargetOption[]>([])
  const [pickerBusy, setPickerBusy] = createSignal(false)
  const [pickerError, setPickerError] = createSignal<string | null>(null)
  const [lastResolvedSelection, setLastResolvedSelection] = createSignal<ActivityLaunchSelection | null>(null)
  const [bootstrapStage, setBootstrapStage] = createSignal('Preparing activity bootstrap')
  let activityWatch: LobbyStateWatch | null = null
  let activitySafetyPoll: ReturnType<typeof setInterval> | null = null
  let activityBootstrapTimeout: ReturnType<typeof setTimeout> | null = null
  let activityRefreshInFlight = false
  let activityRefreshPromise: Promise<void> | null = null
  let activityRefreshPending = false
  let activeChannelId: string | null = null
  let activeUserId: string | null = null
  let bootstrapTimedOut = false

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

  const clearActivityBootstrapTimeout = () => {
    if (!activityBootstrapTimeout) return
    clearTimeout(activityBootstrapTimeout)
    activityBootstrapTimeout = null
  }

  const startActivityBootstrapTimeout = () => {
    clearActivityBootstrapTimeout()
    bootstrapTimedOut = false
    activityBootstrapTimeout = setTimeout(() => {
      bootstrapTimedOut = true
      relayDevLog('error', 'Activity bootstrap timed out', {
        timeoutMs: ACTIVITY_BOOTSTRAP_TIMEOUT_MS,
        stage: bootstrapStage(),
        activityHost: ACTIVITY_HOST,
      })
      if (state().status !== 'loading') return
      setAppState({
        status: 'error',
        message: `Activity startup timed out while ${bootstrapStage().toLowerCase()}. Close and reopen the activity.`,
      }, 'bootstrap-timeout')
    }, ACTIVITY_BOOTSTRAP_TIMEOUT_MS)
  }

  const withPendingWarning = async <T,>(
    promise: Promise<T>,
    message: string,
    meta?: unknown,
    warningAfterMs = 12_000,
  ): Promise<T> => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      relayDevLog('warn', message, {
        stage: bootstrapStage(),
        ...((meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta as Record<string, unknown> : { meta }),
      })
    }, warningAfterMs)

    try {
      return await promise
    }
    finally {
      settled = true
      clearTimeout(timeout)
    }
  }

  const shouldHoldAuthenticatedDraftState = () => {
    if (state().status !== 'authenticated') return false
    if (connectionStatus() === 'connecting' || connectionStatus() === 'connected') return true
    return draftStore.state != null
  }

  const setAppState = (
    next: AppState | ((prev: AppState) => AppState),
    reason: string,
    meta?: Record<string, unknown>,
  ) => {
    setState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      postDevTrace('App setState', {
        reason,
        from: prev.status,
        to: resolved.status,
        ...meta,
      })
      queueMicrotask(() => {
        postDevTrace('App setState applied', {
          reason,
          current: state().status,
          ...meta,
        })
      })
      return resolved
    })
  }

  createEffect(
    () => ({
      appStatus: state().status,
      bootstrapStage: bootstrapStage(),
      connection: connectionStatus(),
      draftStatus: draftStore.state?.status ?? null,
      targetCount: availableTargets().length,
      currentTarget: currentTargetKey(),
    }),
    (next, prev) => {
      updateDevOverlay('Activity state', {
        appStatus: next.appStatus,
        bootstrapStage: next.bootstrapStage,
        connection: next.connection,
        draftStatus: next.draftStatus,
        targetCount: next.targetCount,
        currentTarget: next.currentTarget,
      })
      postDevTrace('Activity state snapshot', {
        next,
        prev: prev ?? null,
      })

      queueMicrotask(() => {
        if (typeof document === 'undefined') return
        const bodyText = document.body.textContent ?? ''
        postDevTrace('Activity DOM snapshot', {
          rootChildren: document.getElementById('root')?.childElementCount ?? 0,
          showsLoading: bodyText.includes('Loading activity state'),
          showsJoining: bodyText.includes('Joining draft room'),
          showsDisconnected: bodyText.includes('Disconnected'),
          showsConnectionFailed: bodyText.includes('Connection Failed'),
          bodyPreview: bodyText.trim().slice(0, 240),
        })
      })
    },
  )

  onCleanup(() => {
    clearActivityBootstrapTimeout()
    stopActivityWatch()
    stopActivitySafetyPoll()
    clearDraftConnection()
  })

  onSettled(() => {
    const syncMiniView = () => setIsMiniView(window.innerWidth <= MINI_VIEW_MAX_WIDTH && window.innerHeight <= MINI_VIEW_MAX_HEIGHT)
    syncMiniView()
    window.addEventListener('resize', syncMiniView)
    return () => window.removeEventListener('resize', syncMiniView)
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
    setAppState({ status: 'overview' }, 'open-overview')

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

    setAppState({ status: 'authenticated', matchId, autoStart: nextAutoStart }, 'transition-to-draft', { matchId, autoStart: nextAutoStart })
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
    postDevTrace('Apply launch snapshot', {
      currentStatus: current.status,
      previousSelectionKey,
      nextSelectionKey,
      optionCount: snapshot.options.length,
      selectionKind: snapshot.selection?.kind ?? null,
      selectionId: snapshot.selection?.option.id ?? null,
    })
    setAvailableTargets(snapshot.options)

    if (!snapshot.selection) {
      setPickerError(null)

      if (shouldHoldAuthenticatedDraftState()) return

      setLastResolvedSelection(null)
      if (current.status === 'authenticated') {
        clearDraftConnection()
      }

      setAppState({ status: 'overview' }, 'launch-snapshot-empty-selection')
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

      setAppState((prev) => {
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
      }, 'launch-snapshot-lobby-selection', { lobbyId: nextLobby.id, lobbyRevision: nextLobby.revision, joinPending })
      return
    }

    transitionToDraft(snapshot.selection.matchId, currentUserId, autoStart)
  }

  const refreshActivityState = async (channelId: string, currentUserId: string) => {
    if (activityRefreshInFlight) {
      activityRefreshPending = true
      postDevTrace('Refresh activity state joined inflight request', { channelId, userId: currentUserId })
      return activityRefreshPromise ?? Promise.resolve()
    }

    activityRefreshInFlight = true
    activityRefreshPromise = (async () => {
      postDevTrace('Refresh activity state start', { channelId, userId: currentUserId })
      const snapshot = await fetchActivityLaunchSnapshot(channelId, currentUserId)
      if (!snapshot) {
        if (state().status === 'loading') {
          setAppState({ status: 'error', message: 'Failed to load the activity state. Reopen the activity and try again.' }, 'initial-refresh-failed')
        }
        return
      }
      applyLaunchSnapshot(channelId, currentUserId, snapshot)
    })()

    try {
      await activityRefreshPromise
    }
    finally {
      activityRefreshInFlight = false
      activityRefreshPromise = null
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

  onSettled(() => {
    void (async () => {
      setBootstrapStage('Initializing Discord SDK')
      startActivityBootstrapTimeout()
      try {
        const auth = await setupDiscordSdk({ onStage: setBootstrapStage })
        if (bootstrapTimedOut) return

        setBootstrapStage('Authenticating activity user')
        setAuthenticatedUser(auth)
        const channelId = discordSdk.channelId

        if (!channelId) {
          setAppState({ status: 'error', message: 'No channel ID found - start from Discord' }, 'missing-channel-id')
          return
        }

        activeChannelId = channelId
        activeUserId = auth.user.id
        setBootstrapStage('Subscribing to lobby state')
        startActivityWatch(channelId, auth.user.id)
        setBootstrapStage('Loading activity state')
        await withPendingWarning(
          refreshActivityState(channelId, auth.user.id),
          'Initial activity state request is still pending',
          { channelId, userId: auth.user.id },
        )
        flush()
        if (state().status === 'loading') {
          relayDevLog('error', 'Initial activity state resolved but app is still loading', {
            channelId,
            userId: auth.user.id,
            availableTargetCount: availableTargets().length,
            lastResolvedSelection: lastResolvedSelection()?.option ?? null,
          })
          setAppState({
            status: 'error',
            message: 'The activity state loaded, but the UI did not transition correctly. Close and reopen the activity.',
          }, 'initial-refresh-still-loading')
        }
      }
      catch (err) {
        console.error('Discord SDK setup failed:', err)
        relayDevLog('error', 'Activity app setup failed', err)
        setAppState({
          status: 'error',
          message: err instanceof Error && err.message.trim().length > 0
            ? err.message
            : typeof err === 'string' && err.trim().length > 0
              ? err
              : 'Unknown error',
        }, 'bootstrap-catch')
      }
      finally {
        clearActivityBootstrapTimeout()
      }
    })()
  })

  const renderAppState = () => {
    const current = state()

    if (current.status === 'loading') {
      return (
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">{bootstrapStage()}</div>
            <div class="text-xs text-fg-subtle mt-2">If this sits here for a while, reopen the activity and check the dev logs.</div>
          </div>
        </main>
      )
    }

    if (current.status === 'error') {
      return (
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-danger font-bold mb-2">Connection Failed</div>
            <div class="text-sm text-fg-muted">{current.message}</div>
          </div>
        </main>
      )
    }

    if (current.status === 'overview') {
      return (
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
      )
    }

    if (current.status === 'lobby-waiting') {
      return (
        <ConfigScreen
          lobby={current.lobby}
          showJoinPending={current.joinPending}
          joinEligibility={current.joinEligibility}
          onSwitchTarget={openOverview}
          onLobbyStarted={(matchId) => {
            const currentUserId = userId()
            if (!currentUserId) {
              setAppState({ status: 'error', message: 'Could not identify your Discord user. Reopen the activity.' }, 'missing-user-id-on-lobby-start')
              return
            }
            transitionToDraft(matchId, currentUserId, true)
          }}
        />
      )
    }

    return (
      <DraftWithConnection
        matchId={current.matchId}
        autoStart={current.autoStart}
        onSwitchTarget={openOverview}
      />
    )
  }

  return <div class="contents">{renderAppState()}</div>
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

  const renderConnectionState = () => {
    const status = connectionStatus()

    if (status === 'connecting') {
      return (
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">Joining draft room...</div>
          </div>
        </main>
      )
    }

    if (hasTerminalState() && (status === 'error' || status === 'disconnected')) {
      return (
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          onSwitchTarget={props.onSwitchTarget}
        />
      )
    }

    if (status === 'error') {
      return (
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-danger font-bold mb-2">Connection Error</div>
            <div class="text-sm text-fg-muted">{connectionError() ?? 'Failed to connect to draft room'}</div>
          </div>
        </main>
      )
    }

    if (status === 'connected') {
      return (
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          onSwitchTarget={props.onSwitchTarget}
        />
      )
    }

    return (
      <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
        <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
          <div class="text-lg text-fg-subtle font-bold mb-2">Disconnected</div>
          <div class="text-sm text-fg-muted">Lost connection to the draft room.</div>
        </div>
      </main>
    )
  }

  return <div class="contents">{renderConnectionState()}</div>
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
