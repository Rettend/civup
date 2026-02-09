import type { Auth } from './discord'
import type { LobbySnapshot } from './stores'
import { createSignal, For, Match, onCleanup, onMount, Switch } from 'solid-js'
import { DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  fetchLobbyForChannel,
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

      // Fetch the match ID from the bot API
      let matchId = await fetchMatchForChannel(channelId)

      // Voice-channel launches may use a different channel than where queue filled.
      // Fall back to participant-based lookup.
      if (!matchId) {
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

        const lobby = await fetchLobbyForChannel(channelId)
        if (lobby) {
          setState({ status: 'lobby-waiting', lobby })

          let pollInFlight = false
          stopLobbyPoll()
          lobbyPoll = setInterval(async () => {
            if (pollInFlight) return
            pollInFlight = true
            try {
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

              const nextLobby = await fetchLobbyForChannel(channelId)
              if (!nextLobby) {
                stopLobbyPoll()
                setState({ status: 'no-match' })
                return
              }

              setState({ status: 'lobby-waiting', lobby: nextLobby })
            }
            finally {
              pollInFlight = false
            }
          }, LOBBY_POLL_MS)

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
        <LobbyWaitingRoom lobby={(state() as Extract<AppState, { status: 'lobby-waiting' }>).lobby} />
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

function LobbyWaitingRoom(props: { lobby: LobbySnapshot }) {
  const isTeamMode = () => props.lobby.mode === 'duel' || props.lobby.mode === '2v2' || props.lobby.mode === '3v3'
  const teamSize = () => Math.max(1, Math.floor(props.lobby.targetSize / 2))

  const teamALines = () => Array.from({ length: teamSize() }, (_, i) => {
    const entry = props.lobby.entries[i]
    return `${i + 1}. ${entry ? entry.displayName : '[empty]'}`
  })

  const teamBLines = () => Array.from({ length: teamSize() }, (_, i) => {
    const entry = props.lobby.entries[teamSize() + i]
    return `${i + 1}. ${entry ? entry.displayName : '[empty]'}`
  })

  const ffaFirstColumn = () => {
    const half = Math.ceil(props.lobby.targetSize / 2)
    return Array.from({ length: half }, (_, i) => {
      const entry = props.lobby.entries[i]
      return `${i + 1}. ${entry ? entry.displayName : '[empty]'}`
    })
  }

  const ffaSecondColumn = () => {
    const half = Math.ceil(props.lobby.targetSize / 2)
    return Array.from({ length: props.lobby.targetSize - half }, (_, i) => {
      const index = half + i
      const entry = props.lobby.entries[index]
      return `${index + 1}. ${entry ? entry.displayName : '[empty]'}`
    })
  }

  return (
    <main class="text-text-primary font-sans px-4 bg-bg-primary flex min-h-screen items-center justify-center">
      <div class="p-6 rounded-lg bg-bg-secondary max-w-2xl w-full">
        <div class="text-lg text-heading mb-1">Lobby Open</div>
        <div class="text-sm text-text-secondary mb-4">
          You are in the activity lobby. Waiting for players to fill the room.
        </div>

        <div class="text-xs text-accent-gold tracking-widest font-bold mb-4 uppercase">
          Mode:
          {' '}
          {props.lobby.mode.toUpperCase()}
        </div>

        <Switch>
          <Match when={isTeamMode()}>
            <div class="gap-6 grid grid-cols-2">
              <div>
                <div class="text-xs text-text-muted tracking-wider font-bold mb-2 uppercase">Team A</div>
                <div class="flex flex-col gap-2">
                  <For each={teamALines()}>
                    {line => <div class="text-sm px-3 py-2 rounded bg-bg-primary/40">{line}</div>}
                  </For>
                </div>
              </div>
              <div>
                <div class="text-xs text-text-muted tracking-wider font-bold mb-2 uppercase">Team B</div>
                <div class="flex flex-col gap-2">
                  <For each={teamBLines()}>
                    {line => <div class="text-sm px-3 py-2 rounded bg-bg-primary/40">{line}</div>}
                  </For>
                </div>
              </div>
            </div>
          </Match>

          <Match when={!isTeamMode()}>
            <div class="gap-6 grid grid-cols-2">
              <div class="flex flex-col gap-2">
                <For each={ffaFirstColumn()}>
                  {line => <div class="text-sm px-3 py-2 rounded bg-bg-primary/40">{line}</div>}
                </For>
              </div>
              <div class="flex flex-col gap-2">
                <For each={ffaSecondColumn()}>
                  {line => <div class="text-sm px-3 py-2 rounded bg-bg-primary/40">{line}</div>}
                </For>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </main>
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
