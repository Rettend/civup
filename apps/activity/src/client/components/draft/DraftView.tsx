import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  canOpenLeaderGrid,
  currentStep,
  draftStore,
  gridOpen,
  hasSubmitted,
  isMiniView,
  isMobileLayout,
  isMyOwnPickTurn,
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
  const [autoOpenedGridToken, setAutoOpenedGridToken] = createSignal<string | null>(null)
  const [showAutoStartSplash, setShowAutoStartSplash] = createSignal(Boolean(props.autoStart))
  const [steamLobbyLink, setSteamLobbyLink] = createSignal<string | null>(props.steamLobbyLink ?? null)
  const [steamLobbySavePending, setSteamLobbySavePending] = createSignal(false)
  let autoStartSplashTimeout: ReturnType<typeof setTimeout> | null = null
  let scrubRedirectTimeout: ReturnType<typeof setTimeout> | null = null
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

  createEffect(() => {
    const current = state()
    if (current?.status !== 'cancelled' || current.cancelReason !== 'scrub' || !props.onSwitchTarget) {
      if (!scrubRedirectTimeout) return
      clearTimeout(scrubRedirectTimeout)
      scrubRedirectTimeout = null
      return
    }
    if (scrubRedirectTimeout) return

    scrubRedirectTimeout = setTimeout(() => {
      scrubRedirectTimeout = null
      props.onSwitchTarget?.()
    }, 5000)
  })

  onCleanup(() => {
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  })

  onCleanup(() => {
    if (!scrubRedirectTimeout) return
    clearTimeout(scrubRedirectTimeout)
    scrubRedirectTimeout = null
  })

  const isMyPickTurn = () => {
    const step = currentStep()
    return !!step && step.action === 'pick' && isMyOwnPickTurn() && !hasSubmitted()
  }

  const [showTurnFlash, setShowTurnFlash] = createSignal(false)
  let lastFlashedStep = -1
  let turnFlashTimeout: ReturnType<typeof setTimeout> | null = null

  createEffect(() => {
    if (!isMyPickTurn()) return
    const s = draftStore.state
    if (!s) return
    const stepIdx = s.currentStepIndex
    if (stepIdx === lastFlashedStep) return
    lastFlashedStep = stepIdx
    if (turnFlashTimeout) clearTimeout(turnFlashTimeout)
    setShowTurnFlash(true)
    turnFlashTimeout = setTimeout(() => {
      setShowTurnFlash(false)
      turnFlashTimeout = null
    }, 550)
  })

  onCleanup(() => {
    if (turnFlashTimeout) {
      clearTimeout(turnFlashTimeout)
      turnFlashTimeout = null
    }
  })

  createEffect(() => {
    if (!isMiniView()) return
    setGridOpen(false)
  })

  createEffect(() => {
    const current = state()
    const seatIndex = draftStore.seatIndex
    if (!current || current.status !== 'active' || seatIndex == null) {
      setAutoOpenedGridToken(null)
      return
    }
    if (isMiniView()) return
    if (!canOpenLeaderGrid()) return
    if (currentStep()?.action === 'pick' && !isMyOwnPickTurn()) return

    const nextToken = `${draftStore.initVersion}:${current.matchId}:${seatIndex}`
    if (autoOpenedGridToken() === nextToken) return

    setGridOpen(true)
    setAutoOpenedGridToken(nextToken)
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
              <div class="flex flex-1 min-h-0 relative z-0">
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
                        canOpenLeaderGrid() && 'hover:bg-bg-muted hover:text-fg transition-colors',
                        !canOpenLeaderGrid() && 'cursor-default opacity-50',
                      )}
                      disabled={!canOpenLeaderGrid()}
                      onClick={() => {
                        if (!canOpenLeaderGrid()) return
                        setGridOpen(!gridOpen())
                      }}
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
                  <div class="flex inset-x-0 top-16 justify-center absolute z-50">
                    <div class="px-4 py-2 border border-border-subtle rounded-lg bg-bg-subtle/80 flex flex-col gap-1 shadow-2xl shadow-black/50 items-center backdrop-blur-sm">
                      <span class="text-base text-accent font-bold">You can close the activity!</span>
                      <span class="text-sm text-fg/80">Don't forget to report the result</span>
                    </div>
                  </div>
                </Show>
              </div>

              <Show when={isMyPickTurn()}>
                <div class="screen-glow-mask opacity-20 w-14 pointer-events-none inset-y-0 left-0 absolute z-30 from-[var(--accent)] to-transparent bg-gradient-to-r" />
                <div class="screen-glow-mask opacity-20 w-14 pointer-events-none inset-y-0 right-0 absolute z-30 from-[var(--accent)] to-transparent bg-gradient-to-l" />
              </Show>

              <Show when={showTurnFlash()}>
                <div
                  class="anim-turn-flash pointer-events-none inset-0 absolute z-0"
                  style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(200, 170, 110, 0.5) 100%)' }}
                />
              </Show>
            </div>
          </Show>
        </Show>
      )}
    >
      <Show when={!isMiniView()} fallback={<MiniView />}>
        <CancelledDraftScreen
          steamLobbyLink={steamLobbyLink()}
          isHost={amHost()}
          onSwitchTarget={props.onSwitchTarget}
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
  onSwitchTarget?: () => void
}) {
  const state = () => draftStore.state
  const reason = () => state()?.cancelReason ?? 'scrub'

  const title = () => {
    if (reason() === 'cancel') return 'Draft Cancelled'
    if (reason() === 'timeout') return 'Draft Auto-Scrubbed'
    if (reason() === 'revert') return 'Draft Reverted'
    return 'Match Scrubbed'
  }

  const detail = () => {
    if (reason() === 'cancel') return 'Host cancelled this draft before lock-in.'
    if (reason() === 'timeout') return 'A player timed out picking a leader.'
    if (reason() === 'revert') return 'Host returned everyone to draft setup.'
    return 'Host scrubbed this match.'
  }

  return (
    <main class="text-fg font-sans bg-bg h-screen relative overflow-y-auto">
      <Show when={props.onSwitchTarget}>
        <button
          type="button"
          class={cn(
            'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
            isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6',
          )}
          title="Lobby Overview"
          aria-label="Lobby Overview"
          onClick={() => props.onSwitchTarget?.()}
        >
          <span class="i-ph-squares-four-bold text-base" />
        </button>
      </Show>
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
