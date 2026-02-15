import type { LobbySnapshot } from './stores'
import { createSignal, Match, onCleanup, onMount, Switch } from 'solid-js'
import { ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  draftStore,
  fetchLobbyForChannel,
  fetchLobbyForUser,
  fetchMatchForChannel,
  fetchMatchForUser,

  setAuthenticatedUser,
  userId,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'lobby-waiting', lobby: LobbySnapshot }
    | { status: 'no-match' }
    | { status: 'authenticated', matchId: string, autoStart: boolean }

/** Activity host — websocket goes through same-origin /api/parties proxy */
const ACTIVITY_HOST = (import.meta.env.VITE_ACTIVITY_HOST as string | undefined)
  || (typeof window !== 'undefined' ? window.location.host : 'localhost:5173')
const LOBBY_POLL_MS = 3000

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })
  let lobbyPoll: ReturnType<typeof setInterval> | null = null

  const stopLobbyPoll = () => {
    if (!lobbyPoll) return
    clearInterval(lobbyPoll)
    lobbyPoll = null
  }

  onCleanup(() => stopLobbyPoll())

  onMount(async () => {
    try {
      const auth = await setupDiscordSdk()
      setAuthenticatedUser(auth)
      const channelId = discordSdk.channelId

      if (!channelId) {
        setState({ status: 'error', message: 'No channel ID found — start from Discord' })
        return
      }

      // Match lookup order:
      // 1) direct channel mapping
      // 2) open lobby by channel/user (pre-draft waiting)
      // 3) participant fallback (for voice-channel launches)
      let matchId = await fetchMatchForChannel(channelId)
      const resolveOpenLobby = async () => {
        const channelLobby = await fetchLobbyForChannel(channelId)
        if (channelLobby) return channelLobby
        return fetchLobbyForUser(auth.user.id)
      }

      if (!matchId) {
        const lobby = await resolveOpenLobby()
        if (lobby) {
          setState({ status: 'lobby-waiting', lobby })

          let pollInFlight = false
          stopLobbyPoll()
          lobbyPoll = setInterval(async () => {
            if (pollInFlight) return
            pollInFlight = true
            try {
              const nextLobby = await resolveOpenLobby()
              if (nextLobby) {
                setState((prev) => {
                  if (prev.status !== 'lobby-waiting') return prev
                  if (nextLobby.revision < prev.lobby.revision) return prev
                  if (isSameLobbySnapshot(prev.lobby, nextLobby)) return prev
                  return { status: 'lobby-waiting', lobby: nextLobby }
                })
                return
              }

              let nextMatchId = await fetchMatchForChannel(channelId)
              if (!nextMatchId) {
                nextMatchId = await fetchMatchForUser(auth.user.id)
              }

              if (nextMatchId) {
                if (state().status !== 'lobby-waiting') return
                stopLobbyPoll()
                setState({ status: 'authenticated', matchId: nextMatchId, autoStart: false })
                connectToRoom(ACTIVITY_HOST, nextMatchId, auth.user.id)
                return
              }

              if (state().status !== 'lobby-waiting') return
              stopLobbyPoll()
              setState({ status: 'no-match' })
            }
            finally {
              pollInFlight = false
            }
          }, LOBBY_POLL_MS)

          return
        }

        matchId = await fetchMatchForUser(auth.user.id)
      }

      if (!matchId) {
        if (import.meta.env.DEV) {
          console.warn('No match found for channel, using channelId as fallback')
          setState({ status: 'authenticated', matchId: channelId, autoStart: false })
          connectToRoom(ACTIVITY_HOST, channelId, auth.user.id)
          return
        }

        setState({ status: 'no-match' })
        return
      }

      setState({ status: 'authenticated', matchId, autoStart: false })
      connectToRoom(ACTIVITY_HOST, matchId, auth.user.id)
    }
    catch (err) {
      console.error('Discord SDK setup failed:', err)
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  })

  return (
    <Switch>
      {/* Loading state */}
      <Match when={state().status === 'loading'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent-gold font-bold mb-2">CivUp</div>
            <div class="text-sm text-text-secondary">Connecting to Discord...</div>
          </div>
        </main>
      </Match>

      {/* Error state */}
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

      {/* Waiting lobby */}
      <Match when={state().status === 'lobby-waiting'}>
        <ConfigScreen
          lobby={(state() as Extract<AppState, { status: 'lobby-waiting' }>).lobby}
          onLobbyStarted={(matchId) => {
            const currentUserId = userId()
            if (!currentUserId) {
              setState({ status: 'error', message: 'Could not identify your Discord user. Reopen the activity.' })
              return
            }
            stopLobbyPoll()
            setState({ status: 'authenticated', matchId, autoStart: true })
            connectToRoom(ACTIVITY_HOST, matchId, currentUserId)
          }}
        />
      </Match>

      {/* No match available */}
      <Match when={state().status === 'no-match'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
            <div class="text-lg text-text-muted font-bold mb-2">No Draft Available</div>
            <div class="text-sm text-text-secondary">
              No active draft in this channel. Use
              {' '}
              <code class="text-accent-gold">/match create</code>
              {' '}
              to open a lobby first.
            </div>
          </div>
        </main>
      </Match>

      {/* Authenticated */}
      <Match when={state().status === 'authenticated'}>
        <DraftWithConnection
          matchId={(state() as Extract<AppState, { status: 'authenticated' }>).matchId}
          autoStart={(state() as Extract<AppState, { status: 'authenticated' }>).autoStart}
        />
      </Match>
    </Switch>
  )
}

/** Intermediate component: shows connection status or Draft UI */
function DraftWithConnection(props: { matchId: string, autoStart: boolean }) {
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
        <DraftView matchId={props.matchId} autoStart={props.autoStart} />
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
        <DraftView matchId={props.matchId} autoStart={props.autoStart} />
      </Match>

      {/* Disconnected fallback */}
      <Match when={connectionStatus() === 'disconnected'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
            <div class="text-lg text-text-muted font-bold mb-2">Disconnected</div>
            <div class="text-sm text-text-secondary">
              Lost connection to the draft room.
            </div>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function isSameLobbySnapshot(a: LobbySnapshot, b: LobbySnapshot): boolean {
  if (a.revision !== b.revision) return false
  if (a.mode !== b.mode) return false
  if (a.hostId !== b.hostId) return false
  if (a.status !== b.status) return false
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
  }

  return true
}
