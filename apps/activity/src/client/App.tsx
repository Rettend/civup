import type { Auth } from './discord'
import { createSignal, Match, onMount, Switch } from 'solid-js'
import { DraftLayout } from './components/draft'
import { discordSdk, setupDiscordSdk } from './discord'
import {
  connectionError,
  connectionStatus,
  connectToRoom,
  setAuthenticatedUser,
} from './stores'

type AppState
  = | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'authenticated', auth: Auth }

/** PartyKit host — uses local dev server in dev, deployed URL in prod */
const PARTY_HOST = import.meta.env.VITE_PARTY_HOST as string | undefined ?? 'localhost:1999'

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })

  onMount(async () => {
    try {
      const auth = await setupDiscordSdk()
      setAuthenticatedUser(auth)
      setState({ status: 'authenticated', auth })

      // Auto-connect to draft room using the Activity instance ID as room ID
      // The bot will have created a PartyKit room with the match ID
      // For now, use channelId as fallback room identifier
      const roomId = discordSdk.channelId ?? discordSdk.instanceId
      connectToRoom(PARTY_HOST, roomId, auth.user.id)
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
        <main class="min-h-screen flex items-center justify-center bg-bg-primary text-text-primary font-sans">
          <div class="text-center">
            <div class="mb-2 text-2xl text-accent-gold font-bold">CivUp</div>
            <div class="text-sm text-text-secondary">Connecting to Discord...</div>
          </div>
        </main>
      </Match>

      {/* Error state */}
      <Match when={state().status === 'error'}>
        <main class="min-h-screen flex items-center justify-center bg-bg-primary text-text-primary font-sans">
          <div class="max-w-md panel p-6 text-center">
            <div class="mb-2 text-lg text-accent-red font-bold">Connection Failed</div>
            <div class="text-sm text-text-secondary">
              {(state() as Extract<AppState, { status: 'error' }>).message}
            </div>
          </div>
        </main>
      </Match>

      {/* Authenticated — show draft */}
      <Match when={state().status === 'authenticated'}>
        <DraftWithConnection />
      </Match>
    </Switch>
  )
}

/** Intermediate component: shows connection status or Draft UI */
function DraftWithConnection() {
  return (
    <Switch>
      <Match when={connectionStatus() === 'connecting'}>
        <main class="min-h-screen flex items-center justify-center bg-bg-primary text-text-primary font-sans">
          <div class="text-center">
            <div class="mb-2 text-2xl text-accent-gold font-bold">CivUp</div>
            <div class="text-sm text-text-secondary">Joining draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={connectionStatus() === 'error'}>
        <main class="min-h-screen flex items-center justify-center bg-bg-primary text-text-primary font-sans">
          <div class="max-w-md panel p-6 text-center">
            <div class="mb-2 text-lg text-accent-red font-bold">Connection Error</div>
            <div class="text-sm text-text-secondary">
              {connectionError() ?? 'Failed to connect to draft room'}
            </div>
          </div>
        </main>
      </Match>

      <Match when={connectionStatus() === 'connected'}>
        <DraftLayout />
      </Match>

      {/* Disconnected fallback */}
      <Match when={connectionStatus() === 'disconnected'}>
        <main class="min-h-screen flex items-center justify-center bg-bg-primary text-text-primary font-sans">
          <div class="max-w-md panel p-6 text-center">
            <div class="mb-2 text-lg text-text-muted font-bold">Disconnected</div>
            <div class="text-sm text-text-secondary">
              Lost connection to the draft room.
            </div>
          </div>
        </main>
      </Match>
    </Switch>
  )
}
