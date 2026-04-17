import { createEffect, createSignal, Match, onCleanup, Show, Switch } from 'solid-js'
import { DraftView } from '~/client/components/draft'
import { DraftSetupPage } from './draft-setup'
import { connectionError, connectionStatus, draftStore, sendStart, userId } from '~/client/stores'

export interface DraftPageProps {
  matchId: string
  autoStart: boolean
  steamLobbyLink: string | null
  lobbyId: string | null
  lobbyMode: string | null
  onSwitchTarget?: () => void
}

export function DraftPage(props: DraftPageProps) {
  const [autoStartSent, setAutoStartSent] = createSignal(false)
  const [showAutoStartSplash, setShowAutoStartSplash] = createSignal(Boolean(props.autoStart))
  let autoStartSplashTimeout: ReturnType<typeof setTimeout> | null = null

  const hasDraftState = () => draftStore.state != null
  const hasTerminalState = () => {
    const status = draftStore.state?.status
    return status === 'complete' || status === 'cancelled'
  }
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === draftStore.hostId
  }
  const shouldRenderDraftView = () => {
    const status = connectionStatus()
    return status === 'connected' || (status === 'reconnecting' && hasDraftState())
  }
  const clearAutoStartSplashTimeout = () => {
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  }

  createEffect(() => {
    const current = draftStore.state
    if (!current || current.status === 'waiting') return
    setShowAutoStartSplash(false)
    clearAutoStartSplashTimeout()
  })

  createEffect(() => {
    if (!props.autoStart || autoStartSent()) return
    if (draftStore.state?.status !== 'waiting') return
    if (!amHost()) return

    const sent = sendStart()
    if (!sent) return

    setShowAutoStartSplash(true)
    clearAutoStartSplashTimeout()
    autoStartSplashTimeout = setTimeout(() => {
      setShowAutoStartSplash(false)
      autoStartSplashTimeout = null
    }, 5000)
    setAutoStartSent(true)
  })

  onCleanup(() => clearAutoStartSplashTimeout())

  return (
    <Switch>
      <Match when={connectionStatus() === 'connecting'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">Joining draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={shouldRenderDraftView()}>
        <>
          <Show
            when={draftStore.state?.status !== 'waiting'}
            fallback={showAutoStartSplash()
              ? <AutoStartingDraftScreen />
              : <DraftSetupPage steamLobbyLink={props.steamLobbyLink ?? null} onSwitchTarget={props.onSwitchTarget} />}
          >
            <DraftView
              matchId={props.matchId}
              steamLobbyLink={props.steamLobbyLink}
              lobbyId={props.lobbyId}
              lobbyMode={props.lobbyMode}
              onSwitchTarget={props.onSwitchTarget}
            />
          </Show>
          <Show when={connectionStatus() === 'reconnecting'}>
            <div class="pointer-events-none bottom-3 left-3 fixed z-50 sm:bottom-4 sm:left-4">
              <div class="text-xs text-fg px-3 py-1.5 border border-border rounded-full bg-bg-subtle/90 shadow-2xl shadow-black/30 backdrop-blur-sm">
                Reconnecting...
              </div>
            </div>
          </Show>
        </>
      </Match>

      <Match when={connectionStatus() === 'reconnecting'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="text-center">
            <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
            <div class="text-sm text-fg-muted">Reconnecting to draft room...</div>
          </div>
        </main>
      </Match>

      <Match when={hasTerminalState() && (connectionStatus() === 'error' || connectionStatus() === 'disconnected')}>
        <DraftView
          matchId={props.matchId}
          steamLobbyLink={props.steamLobbyLink}
          lobbyId={props.lobbyId}
          lobbyMode={props.lobbyMode}
          onSwitchTarget={props.onSwitchTarget}
        />
      </Match>

      <Match when={connectionStatus() === 'error'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-danger font-bold mb-2">Connection Error</div>
            <div class="text-sm text-fg-muted">
              {connectionError() ?? 'Failed to connect to draft room'}
            </div>
          </div>
        </main>
      </Match>

      <Match when={connectionStatus() === 'disconnected'}>
        <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
          <div class="p-6 text-center rounded-lg bg-bg-subtle max-w-md">
            <div class="text-lg text-fg-subtle font-bold mb-2">Disconnected</div>
            <div class="text-sm text-fg-muted">Lost connection to the draft room.</div>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function AutoStartingDraftScreen() {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
        <div class="text-sm text-fg-muted">Starting draft...</div>
      </div>
    </main>
  )
}
