import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  draftStore,
  gridOpen,
  isMobileLayout,
  isMiniView,
  isSpectator,
  sendStart,
  setGridOpen,
  updateLobbyConfig,
  userId,
} from '~/client/stores'
import { ConfigScreen } from './ConfigScreen'
import { DraftHeader } from './DraftHeader'
import { DraftTimeline } from './DraftTimeline'
import { LeaderGridOverlay } from './LeaderGridOverlay'
import { MiniView } from './MiniView'
import { SlotStrip } from './SlotStrip'
import { SteamLobbyButton } from './SteamLobbyButton'

interface DraftViewProps {
  matchId: string
  autoStart?: boolean
  steamLobbyLink?: string | null
  lobbyId?: string | null
  lobbyMode?: string | null
  onSwitchTarget?: () => void
}

/** Main draft layout */
export function DraftView(props: DraftViewProps) {
  const state = () => draftStore.state
  const [autoStartSent, setAutoStartSent] = createSignal(false)
  const [showAutoStartSplash, setShowAutoStartSplash] = createSignal(Boolean(props.autoStart))
  const [steamLobbyLink, setSteamLobbyLink] = createSignal<string | null>(props.steamLobbyLink ?? null)
  const [steamLobbySavePending, setSteamLobbySavePending] = createSignal(false)
  let autoStartSplashTimeout: ReturnType<typeof setTimeout> | null = null
  const hostId = () => draftStore.hostId
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === hostId()
  }

  createEffect(() => {
    setSteamLobbyLink(props.steamLobbyLink ?? null)
  })

  createEffect(() => {
    const current = state()
    if (!current || current.status === 'waiting') return
    setShowAutoStartSplash(false)
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  })

  createEffect(() => {
    if (!props.autoStart || autoStartSent()) return
    if (state()?.status !== 'waiting') return
    if (!amHost()) return

    const sent = sendStart()
    if (!sent) return

    setShowAutoStartSplash(true)
    if (autoStartSplashTimeout) clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = setTimeout(() => {
      setShowAutoStartSplash(false)
      autoStartSplashTimeout = null
    }, 5000)
    setAutoStartSent(true)
  })

  onCleanup(() => {
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  })

  createEffect(() => {
    if (!isMiniView()) return
    setGridOpen(false)
  })

  const isActiveOrComplete = () => state()?.status === 'active' || state()?.status === 'complete'
  const canSaveSteamLobbyLink = () => amHost() && Boolean(props.lobbyId) && Boolean(props.lobbyMode)

  const handleSaveSteamLink = async (link: string | null) => {
    const currentUserId = userId()
    if (!canSaveSteamLobbyLink() || !currentUserId || steamLobbySavePending()) return
    if (link === steamLobbyLink()) return

    setSteamLobbySavePending(true)
    try {
      const result = await updateLobbyConfig(props.lobbyMode!, props.lobbyId!, currentUserId, {
        steamLobbyLink: link,
      })
      if (!result.ok) {
        console.error('Failed to update Steam lobby link:', result.error)
        return
      }

      setSteamLobbyLink(result.lobby.steamLobbyLink)
    }
    finally {
      setSteamLobbySavePending(false)
    }
  }

  return (
    <Show
      when={state()?.status === 'cancelled'}
      fallback={(
        <Show
          when={!isMiniView()}
          fallback={<MiniView />}
        >
          <Show
            when={isActiveOrComplete()}
            fallback={showAutoStartSplash()
              ? <AutoStartingDraftScreen />
              : <ConfigScreen steamLobbyLink={props.steamLobbyLink ?? null} onSwitchTarget={props.onSwitchTarget} />}
            >
              {/* Active + Complete draft view */}
              <div class="text-fg font-sans bg-bg flex flex-col h-screen relative overflow-hidden">
                <DraftHeader
                  steamLobbyLink={steamLobbyLink()}
                  onSaveSteamLink={canSaveSteamLobbyLink() ? handleSaveSteamLink : undefined}
                  savePending={steamLobbySavePending()}
                  onSwitchTarget={props.onSwitchTarget}
                />
                <DraftTimeline />

              {/* Main area */}
              <div class="flex flex-1 min-h-0 relative">
                <SlotStrip />
                <Show when={state()?.status === 'active'}>
                  <LeaderGridOverlay />
                </Show>

                {/* Grid toggle button */}
                <Show when={state()?.status === 'active'}>
                  <div class="flex inset-x-0 bottom-3 justify-center absolute z-50">
                    <button
                      class={cn(
                        'flex items-center gap-1 rounded-full px-5 py-1.5 text-xs font-medium cursor-pointer',
                        'bg-bg-subtle border border-border text-fg-muted',
                        'hover:bg-bg-muted hover:text-fg transition-colors',
                      )}
                      onClick={() => setGridOpen(!gridOpen())}
                    >
                      <Show when={gridOpen()} fallback={<div class="i-ph-caret-up-bold anim-fade-in text-sm" />}>
                        <div class="i-ph-caret-down-bold anim-fade-in text-sm" />
                      </Show>
                    </button>
                  </div>
                </Show>

                {/* Status indicator */}
                <Show when={!gridOpen() && state()?.status === 'active'}>
                  <div class="flex inset-x-0 bottom-12 justify-center absolute z-5">
                    <Show when={isSpectator()}>
                      <span class="text-xs text-fg-subtle px-3 py-1 rounded-full bg-bg-subtle/80">Spectating</span>
                    </Show>
                  </div>
                </Show>

                {/* Post-draft message */}
                <Show when={state()?.status === 'complete'}>
                  <div class="flex inset-x-0 top-8 justify-center absolute z-50">
                    <div class="px-4 py-2 border border-border-subtle rounded-lg bg-bg-subtle/80 flex flex-col gap-1 shadow-2xl shadow-black/50 items-center backdrop-blur-sm">
                      <span class="text-base text-accent font-bold">You can close the activity!</span>
                      <span class="text-sm text-fg/80">Don't forget to report the result</span>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      )}
    >
      <Show when={!isMiniView()} fallback={<MiniView />}>
        <CancelledDraftScreen
          steamLobbyLink={steamLobbyLink()}
          isHost={amHost()}
        />
      </Show>
    </Show>
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

function CancelledDraftScreen(props: {
  steamLobbyLink: string | null
  isHost: boolean
}) {
  const state = () => draftStore.state
  const reason = () => state()?.cancelReason ?? 'scrub'

  const title = () => {
    if (reason() === 'cancel') return 'Draft Cancelled'
    if (reason() === 'timeout') return 'Draft Auto-Scrubbed'
    return 'Match Scrubbed'
  }

  const detail = () => {
    if (reason() === 'cancel') return 'Host cancelled this draft before lock-in.'
    if (reason() === 'timeout') return 'A player timed out without a valid leader queued.'
    return 'Host scrubbed this match.'
  }

  return (
    <main class="text-fg font-sans bg-bg h-screen overflow-y-auto relative">
      <Show when={reason() !== 'scrub'}>
        <SteamLobbyButton
          steamLobbyLink={props.steamLobbyLink}
          isHost={props.isHost}
          class={cn('z-20 absolute', isMobileLayout() ? 'top-12 left-4 h-9 w-9' : 'top-4 left-4 h-9 w-9')}
        />
      </Show>
      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl md:px-8">
        <section class="p-7 text-center border border-border rounded-lg bg-bg-subtle/70">
          <div class="text-[11px] text-fg-subtle tracking-[0.14em] font-semibold mb-2 uppercase">Session Closed</div>
          <h1 class="text-3xl text-fg font-semibold mb-3">{title()}</h1>
          <p class="text-sm text-fg-muted leading-relaxed">{detail()}</p>
        </section>
      </div>
    </main>
  )
}
