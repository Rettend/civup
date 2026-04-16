import { Match, Show, Switch } from 'solid-js'
import { DraftView } from '~/client/components/draft'
import { connectionError, connectionStatus, draftStore } from '~/client/stores'

export interface DraftPageProps {
  matchId: string
  autoStart: boolean
  steamLobbyLink: string | null
  lobbyId: string | null
  lobbyMode: string | null
  onSwitchTarget?: () => void
}

/** Draft page wrapper used while DraftView still owns the page implementation. */
export function DraftPage(props: DraftPageProps) {
  const hasDraftState = () => draftStore.state != null
  const hasTerminalState = () => {
    const status = draftStore.state?.status
    return status === 'complete' || status === 'cancelled'
  }
  const shouldRenderDraftView = () => {
    const status = connectionStatus()
    return status === 'connected' || (status === 'reconnecting' && hasDraftState())
  }

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
          <DraftView {...props} />
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
        <DraftView {...props} />
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
