import { createEffect, createSignal, Match, Show, Switch } from 'solid-js'
import { DraftView } from '~/client/components/draft'
import { connectionError, connectionStatus, draftStore, isMapVotePhase, isMiniView, sendStart, userId } from '~/client/stores'

type ReportResultStatus = 'idle' | 'submitting' | 'done'

export interface DraftPageProps {
  matchId: string
  autoStart: boolean
  steamLobbyLink: string | null
  lobbyId: string | null
  lobbyMode: string | null
  reported?: boolean
  onSwitchTarget?: () => void
}

export function DraftPage(props: DraftPageProps) {
  const [autoStartSent, setAutoStartSent] = createSignal(false)
  const [submittingReportMatchId, setSubmittingReportMatchId] = createSignal<string | null>(null)
  const [reportedMatchId, setReportedMatchId] = createSignal<string | null>(null)

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
    return status === 'connected'
      || (status === 'reconnecting' && hasDraftState())
      || (hasTerminalState() && (status === 'error' || status === 'disconnected'))
  }
  const isWaitingForDraftStart = () => draftStore.state?.status === 'waiting' && !isMapVotePhase()
  const shouldShowDraftView = () => draftStore.state != null && (isMiniView() || !isWaitingForDraftStart())
  const reportResultStatus = (): ReportResultStatus => {
    if (props.reported) return 'done'
    if (reportedMatchId() === props.matchId) return 'done'
    if (submittingReportMatchId() === props.matchId) return 'submitting'
    return 'idle'
  }

  const handleReportStarted = (matchId: string) => {
    if (matchId !== props.matchId) return
    setSubmittingReportMatchId(matchId)
  }

  const handleReportComplete = (matchId: string) => {
    if (matchId !== props.matchId) return
    setSubmittingReportMatchId(null)
    setReportedMatchId(matchId)
  }

  const handleReportFailed = (matchId: string) => {
    if (matchId !== props.matchId) return
    setSubmittingReportMatchId(null)
  }

  createEffect(() => {
    if (!props.autoStart || autoStartSent()) return
    if (connectionStatus() !== 'connected') return
    if (draftStore.state?.status !== 'waiting') return
    if (isMapVotePhase()) return
    if (!amHost()) return

    const sent = sendStart()
    if (!sent) return

    setAutoStartSent(true)
  })

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
            when={shouldShowDraftView()}
            fallback={hasDraftState()
              ? autoStartSent() || (props.autoStart && amHost())
                ? <AutoStartingDraftScreen />
                : (
                    <WaitingForDraftStartScreen
                      isHost={amHost()}
                      onStart={() => {
                        const sent = sendStart()
                        if (sent) setAutoStartSent(true)
                      }}
                    />
                  )
              : <JoiningDraftRoomScreen />}
          >
            <DraftView
              matchId={props.matchId}
              steamLobbyLink={props.steamLobbyLink}
              lobbyId={props.lobbyId}
              lobbyMode={props.lobbyMode}
              onSwitchTarget={props.onSwitchTarget}
              reportResultStatus={reportResultStatus()}
              onReportStarted={handleReportStarted}
              onReportComplete={handleReportComplete}
              onReportFailed={handleReportFailed}
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

function JoiningDraftRoomScreen() {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
        <div class="text-sm text-fg-muted">Joining draft room...</div>
      </div>
    </main>
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

function WaitingForDraftStartScreen(props: { isHost: boolean, onStart: () => void }) {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="p-6 text-center border border-border-subtle rounded-lg bg-bg-subtle flex flex-col gap-3 max-w-md items-center">
        <div class="text-2xl text-accent font-bold">CivUp</div>
        <div class="text-sm text-fg-muted">
          {props.isHost ? 'Preparing draft room...' : 'Waiting for host to start draft...'}
        </div>
        <Show when={props.isHost}>
          <button
            type="button"
            class="text-sm text-black font-semibold px-4 py-1.5 rounded bg-accent cursor-pointer transition-colors hover:bg-accent/85"
            onClick={props.onStart}
          >
            Start Draft
          </button>
        </Show>
      </div>
    </main>
  )
}
