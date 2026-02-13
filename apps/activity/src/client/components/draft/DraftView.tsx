import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  draftStore,
  gridOpen,
  isMiniView,
  isSpectator,
  sendStart,
  setGridOpen,
  setIsMiniView,
  userId,
} from '~/client/stores'
import { ConfigScreen } from './ConfigScreen'
import { DraftHeader } from './DraftHeader'
import { DraftTimeline } from './DraftTimeline'
import { LeaderGridOverlay } from './LeaderGridOverlay'
import { MiniView } from './MiniView'
import { SlotStrip } from './SlotStrip'

interface DraftViewProps {
  matchId: string
  autoStart?: boolean
}

/** Main draft layout */
export function DraftView(props: DraftViewProps) {
  const state = () => draftStore.state
  const [autoStartSent, setAutoStartSent] = createSignal(false)
  const [showAutoStartSplash, setShowAutoStartSplash] = createSignal(Boolean(props.autoStart))
  let autoStartSplashTimeout: ReturnType<typeof setTimeout> | null = null
  const hostId = () => draftStore.hostId
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === hostId()
  }

  createEffect(() => {
    if (state()?.status === 'waiting') return
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
    const check = () => setIsMiniView(window.innerWidth < 500)
    check()
    window.addEventListener('resize', check)
    onCleanup(() => window.removeEventListener('resize', check))
  })

  const isActiveOrComplete = () => state()?.status === 'active' || state()?.status === 'complete'

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
            fallback={showAutoStartSplash() ? <AutoStartingDraftScreen /> : <ConfigScreen />}
          >
            {/* Active + Complete draft view */}
            <div class="text-text-primary font-sans bg-bg-primary flex flex-col h-screen relative overflow-hidden">
              <DraftHeader />
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
                        'bg-bg-secondary border border-white/10 text-text-secondary',
                        'hover:bg-bg-hover hover:text-text-primary transition-colors',
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
                      <span class="text-xs text-text-muted px-3 py-1 rounded-full bg-bg-secondary/80">Spectating</span>
                    </Show>
                  </div>
                </Show>

                {/* Post-draft message */}
                <Show when={state()?.status === 'complete'}>
                  <div class="flex inset-x-0 top-8 justify-center absolute z-5">
                    <div class="px-4 py-2 border border-white/5 rounded-lg bg-bg-secondary/80 flex flex-col gap-1 shadow-2xl shadow-black/50 items-center backdrop-blur-sm">
                      <span class="text-base text-accent-gold font-bold">You can close the activity!</span>
                      <span class="text-sm text-text-primary/80">Don't forget to report the result</span>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      )}
    >
      <CancelledDraftScreen />
    </Show>
  )
}

function AutoStartingDraftScreen() {
  return (
    <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent-gold font-bold mb-2">CivUp</div>
        <div class="text-sm text-text-secondary">Starting draft...</div>
      </div>
    </main>
  )
}

function CancelledDraftScreen() {
  const state = () => draftStore.state
  const reason = () => state()?.cancelReason ?? 'scrub'

  const title = () => {
    if (reason() === 'cancel') return 'Draft Cancelled'
    if (reason() === 'timeout') return 'Draft Auto-Scrubbed'
    return 'Match Scrubbed'
  }

  const detail = () => {
    if (reason() === 'cancel') return 'Host cancelled this draft before lock-in.'
    if (reason() === 'timeout') return 'A player timed out picking a leader.'
    return 'Host scrubbed this match.'
  }

  return (
    <main class="text-text-primary font-sans bg-bg-primary h-screen overflow-y-auto">
      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl md:px-8">
        <section class="p-7 text-center border border-[#aeb6c2]/20 rounded-lg bg-[#111827]/70">
          <div class="text-[11px] text-[#9aa3af] tracking-[0.14em] font-semibold mb-2 uppercase">Session Closed</div>
          <h1 class="text-3xl text-[#d6dde6] font-semibold mb-3">{title()}</h1>
          <p class="text-sm text-[#9ca6b3] leading-relaxed">{detail()}</p>
        </section>
      </div>
    </main>
  )
}
