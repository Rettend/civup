import type { Auth } from './discord'
import type { LobbySnapshot } from './stores'
import { createSignal, Match, onCleanup, onMount, Switch } from 'solid-js'
import { ConfigScreen, DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  fetchLobbyForChannel,
  fetchLobbyForUser,
  fetchMatchForChannel,
  fetchMatchForUser,

  setAuthenticatedUser,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'lobby-waiting', lobby: LobbySnapshot }
    | { status: 'no-match' }
    | { status: 'authenticated', auth: Auth, matchId: string }

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

      // Get the channel ID to look up the match
      const channelId = discordSdk.channelId

      if (!channelId) {
        setState({ status: 'error', message: 'No channel ID found — start from Discord' })
        return
      }

      // Match lookup order:
      // 1) direct channel mapping
      // 2) open lobby by user/channel (pre-draft waiting)
      // 3) participant fallback (for voice-channel launches)
      let matchId = await fetchMatchForChannel(channelId)
      const resolveOpenLobby = async () => {
        const userLobby = await fetchLobbyForUser(auth.user.id)
        if (userLobby) return userLobby
        return fetchLobbyForChannel(channelId)
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
                  if (prev.status === 'lobby-waiting' && isSameLobbySnapshot(prev.lobby, nextLobby)) return prev
                  return { status: 'lobby-waiting', lobby: nextLobby }
                })
                return
              }

              let nextMatchId = await fetchMatchForChannel(channelId)
              if (!nextMatchId) {
                nextMatchId = await fetchMatchForUser(auth.user.id)
              }

              if (nextMatchId) {
                stopLobbyPoll()
                setState({ status: 'authenticated', auth, matchId: nextMatchId })
                connectToRoom(ACTIVITY_HOST, nextMatchId, auth.user.id)
                return
              }

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
        // No match found — could be dev mode or no queue filled yet
        // In dev, fall back to using channelId as room ID for testing
        if (import.meta.env.DEV) {
          console.warn('No match found for channel, using channelId as fallback')
          setState({ status: 'authenticated', auth, matchId: channelId })
          connectToRoom(ACTIVITY_HOST, channelId, auth.user.id)
          return
        }

        setState({ status: 'no-match' })
        return
      }

      // Connect to the PartyKit room using the match ID
      setState({ status: 'authenticated', auth, matchId })
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

      {/* Waiting lobby (before match room exists) */}
      <Match when={state().status === 'lobby-waiting'}>
        <ConfigScreen lobby={(state() as Extract<AppState, { status: 'lobby-waiting' }>).lobby} />
      </Match>

      {/* No match available */}
      <Match when={state().status === 'no-match'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-secondary max-w-md">
            <div class="text-lg text-text-muted font-bold mb-2">No Draft Available</div>
            <div class="text-sm text-text-secondary">
              No active draft in this channel. Use
              {' '}
              <code class="text-accent-gold">/lfg create</code>
              {' '}
              to open a lobby first.
            </div>
          </div>
        </main>
      </Match>

      {/* Authenticated — show draft */}
      <Match when={state().status === 'authenticated'}>
        <DraftWithConnection matchId={(state() as Extract<AppState, { status: 'authenticated' }>).matchId} />
      </Match>
    </Switch>
  )
}

/** Intermediate component: shows connection status or Draft UI */
function DraftWithConnection(props: { matchId: string }) {
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
        <DraftView matchId={props.matchId} />
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
  if (a.mode !== b.mode) return false
  if (a.hostId !== b.hostId) return false
  if (a.status !== b.status) return false
  if (a.targetSize !== b.targetSize) return false
  if (a.draftConfig.banTimerSeconds !== b.draftConfig.banTimerSeconds) return false
  if (a.draftConfig.pickTimerSeconds !== b.draftConfig.pickTimerSeconds) return false
  if (a.entries.length !== b.entries.length) return false

  for (let i = 0; i < a.entries.length; i++) {
    if (a.entries[i]?.playerId !== b.entries[i]?.playerId) return false
    if (a.entries[i]?.displayName !== b.entries[i]?.displayName) return false
    if ((a.entries[i]?.avatarUrl ?? null) !== (b.entries[i]?.avatarUrl ?? null)) return false
  }

  return true
}
