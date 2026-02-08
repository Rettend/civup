import type { Auth } from './discord'
import { createSignal, Match, onMount, Switch } from 'solid-js'
import { DraftView } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  fetchMatchForChannel,
  fetchMatchForUser,
  setAuthenticatedUser,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'no-match' }
    | { status: 'authenticated', auth: Auth, matchId: string }

/** Activity host — websocket goes through same-origin /api/parties proxy */
const ACTIVITY_HOST = (import.meta.env.VITE_ACTIVITY_HOST as string | undefined)
  || (typeof window !== 'undefined' ? window.location.host : 'localhost:5173')

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })

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
          <div class="p-6 text-center max-w-md rounded-lg bg-bg-secondary">
            <div class="text-lg text-accent-red font-bold mb-2">Connection Failed</div>
            <div class="text-sm text-text-secondary">
              {(state() as Extract<AppState, { status: 'error' }>).message}
            </div>
          </div>
        </main>
      </Match>

      {/* No match available */}
      <Match when={state().status === 'no-match'}>
        <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
          <div class="p-6 text-center max-w-md rounded-lg bg-bg-secondary">
            <div class="text-lg text-text-muted font-bold mb-2">No Draft Available</div>
            <div class="text-sm text-text-secondary">
              No active draft in this channel. Use
              {' '}
              <code class="text-accent-gold">/lfg join</code>
              {' '}
              to queue up first!
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
          <div class="p-6 text-center max-w-md rounded-lg bg-bg-secondary">
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
          <div class="p-6 text-center max-w-md rounded-lg bg-bg-secondary">
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
