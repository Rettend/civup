import { createSignal, Match, onMount, Switch } from 'solid-js'
import { type Auth, discordSdk, setupDiscordSdk } from './discord.ts'

type AppState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'authenticated'; auth: Auth }

export default function App() {
  const [state, setState] = createSignal<AppState>({ status: 'loading' })

  onMount(async () => {
    try {
      const auth = await setupDiscordSdk()
      setState({ status: 'authenticated', auth })
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
    <main class="min-h-screen bg-bg-primary text-text-primary font-sans flex items-center justify-center">
      <Switch>
        <Match when={state().status === 'loading'}>
          <div class="text-center">
            <div class="text-2xl font-bold text-accent-gold mb-2">CivUp</div>
            <div class="text-text-secondary text-sm">Connecting to Discord...</div>
          </div>
        </Match>

        <Match when={state().status === 'error'}>
          <div class="text-center panel p-6 max-w-md">
            <div class="text-accent-red text-lg font-bold mb-2">Connection Failed</div>
            <div class="text-text-secondary text-sm">
              {(state() as Extract<AppState, { status: 'error' }>).message}
            </div>
          </div>
        </Match>

        <Match when={state().status === 'authenticated'}>
          {(() => {
            const auth = () => (state() as Extract<AppState, { status: 'authenticated' }>).auth
            return (
              <div class="text-center panel p-8 max-w-md">
                <div class="text-accent-gold text-heading text-xl mb-4">CivUp Draft</div>

                <div class="flex items-center justify-center gap-3 mb-4">
                  {auth().user.avatar && (
                    <img
                      src={`https://cdn.discordapp.com/avatars/${auth().user.id}/${auth().user.avatar}.png?size=64`}
                      alt={auth().user.username}
                      class="w-12 h-12 rounded-full"
                    />
                  )}
                  <span class="text-lg">
                    {auth().user.global_name ?? auth().user.username}
                  </span>
                </div>

                <div class="text-text-muted text-xs space-y-1">
                  <div>Instance: {discordSdk.instanceId}</div>
                  <div>Channel: {discordSdk.channelId ?? 'none'}</div>
                  <div>Guild: {discordSdk.guildId ?? 'DM'}</div>
                </div>

                <div class="mt-6 text-text-secondary text-sm">
                  Draft UI coming soon...
                </div>
              </div>
            )
          })()}
        </Match>
      </Switch>
    </main>
  )
}
