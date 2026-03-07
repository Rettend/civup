import type { ActivityLaunchSelection, ActivityTargetOption, LobbySnapshot, LobbyStateWatch } from './stores'
import { createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { ActivityTargetPicker, activityTargetOptionKey, ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import { relayDevLog } from './lib/dev-log'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  disconnect,
  draftStore,
  fetchActivityLaunchSnapshot,
  resetDraft,
  selectActivityTarget,
  setAuthenticatedUser,
  userId,
  watchLobbyState,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'overview' }
    | { status: 'lobby-waiting', lobby: LobbySnapshot }
    | { status: 'authenticated', matchId: string, autoStart: boolean }

const ACTIVITY_HOST = (import.meta.env.VITE_ACTIVITY_HOST as string | undefined)
  || (typeof window !== 'undefined' ? window.location.host : 'localhost:5173')
const ACTIVITY_SAFETY_POLL_MS = 90_000

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

  onCleanup(() => {
    stopActivityWatch()
    stopActivitySafetyPoll()
    clearDraftConnection()
  })

  const currentTargetKey = () => {
    const current = state()
    if (current.status === 'lobby-waiting') return activityTargetOptionKey({ kind: 'lobby', id: current.lobby.id })
    if (current.status === 'authenticated') return activityTargetOptionKey({ kind: 'match', id: current.matchId })
    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return null
    return activityTargetOptionKey(lastSelection.option)
  }

  const canSwitchTargets = () => availableTargets().length > 1

  const openOverview = () => {
    const current = state()
    if (current.status === 'authenticated') {
      clearDraftConnection()
    }
    resetDraft()
    setPickerError(null)
    setState({ status: 'overview' })
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
    const previousSelectionKey = currentTargetKey()
    const nextSelectionKey = snapshot.selection ? activityTargetOptionKey(snapshot.selection.option) : null
    setAvailableTargets(snapshot.options)
    setLastResolvedSelection(snapshot.selection)

    if (!snapshot.selection) {
      setPickerError(null)

      if (state().status === 'authenticated') {
        clearDraftConnection()
      }

      setState({ status: 'overview' })
      return
    }

    if (state().status === 'overview' && !allowSelectionWhileOverview && previousSelectionKey === nextSelectionKey) return

    if (snapshot.selection.kind === 'lobby') {
      const nextLobby = snapshot.selection.lobby
      setPickerError(null)

      if (state().status === 'authenticated') {
        clearDraftConnection()
      }

      setState((prev) => {
        if (prev.status !== 'lobby-waiting') return { status: 'lobby-waiting', lobby: nextLobby }
        if (nextLobby.revision < prev.lobby.revision) return prev
        if (isSameLobbySnapshot(prev.lobby, nextLobby)) return prev
        return { status: 'lobby-waiting', lobby: nextLobby }
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

  const restoreLastSelection = async () => {
    const lastSelection = lastResolvedSelection()
    if (!lastSelection) return
    await handleTargetSelection(lastSelection.option)
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
        return
      }
      applyLaunchSnapshot(channelId, currentUserId, result.snapshot, false, true)
    }
    finally {
      setPickerBusy(false)
    }
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
          <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
            <div class="text-center">
              <div class="text-2xl text-accent-gold font-bold mb-2">CivUp</div>
              <div class="text-sm text-text-secondary">Connecting to Discord...</div>
            </div>
          </main>
        </Match>

        <Match when={state().status === 'error'}>
          <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
            <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
              <div class="text-lg text-accent-red font-bold mb-2">Connection Failed</div>
              <div class="text-sm text-text-secondary">
                {(state() as Extract<AppState, { status: 'error' }>).message}
              </div>
            </div>
          </main>
        </Match>

        <Match when={state().status === 'overview'}>
          <main class="text-text-primary font-sans bg-bg-primary min-h-screen overflow-y-auto">
            <div class="mx-auto px-4 py-8 max-w-6xl md:px-6">
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
        </Match>

        <Match when={state().status === 'lobby-waiting'}>
            <ConfigScreen
              lobby={(state() as Extract<AppState, { status: 'lobby-waiting' }>).lobby}
              canSwitchTarget={canSwitchTargets()}
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
            canSwitchTarget={canSwitchTargets()}
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
  canSwitchTarget?: boolean
}) {
  const hasTerminalState = () => {
    const status = draftStore.state?.status
    return status === 'complete' || status === 'cancelled'
  }

  return (
    <Switch>
      <Match when={connectionStatus() === 'connecting'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent-gold font-bold mb-2">CivUp</div>
            <div class="text-sm text-text-secondary">Joining draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={hasTerminalState() && (connectionStatus() === 'error' || connectionStatus() === 'disconnected')}>
        <DraftView
          matchId={props.matchId}
          autoStart={props.autoStart}
          onSwitchTarget={props.onSwitchTarget}
          canSwitchTarget={props.canSwitchTarget}
        />
      </Match>

      <Match when={connectionStatus() === 'error'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
            <div class="text-lg text-accent-red font-bold mb-2">Connection Error</div>
            <div class="text-sm text-text-secondary">
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
          canSwitchTarget={props.canSwitchTarget}
        />
      </Match>

      <Match when={connectionStatus() === 'disconnected'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
            <div class="text-lg text-text-muted font-bold mb-2">Disconnected</div>
            <div class="text-sm text-text-secondary">Lost connection to the draft room.</div>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function TargetPickerPanel(props: {
  options: ActivityTargetOption[]
  busy: boolean
  selectedKey: string | null
  error: string | null
  onSelect: (option: ActivityTargetOption) => void
  onResume?: () => void
}) {
  return (
    <div class="flex flex-col gap-4">
      <ActivityTargetPicker
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
        onClose={props.onResume}
        closeLabel="Return"
        title="Channel Overview"
        subtitle="Discord reuses one activity instance per channel, so switch which lobby or live draft this shared activity should show."
      />

      <Show when={props.error}>
        <div class="rounded-xl border border-accent-red/25 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
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
