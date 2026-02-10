import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  currentStepDuration,
  draftStore,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
} from '~/client/stores'
import { BanSquare } from './BanSquare'

/** Header bar: bans on left/right, phase label centered, timer with shrinking line */
export function DraftHeader() {
  const state = () => draftStore.state
  const accent = () => phaseAccent()
  const [phaseFlash, setPhaseFlash] = createSignal(false)
  let phaseFlashTimeout: ReturnType<typeof setTimeout> | null = null

  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false

  const clearPhaseFlashTimeout = () => {
    if (phaseFlashTimeout == null) return
    clearTimeout(phaseFlashTimeout)
    phaseFlashTimeout = null
  }

  /** Bans for team A (seatIndex 0) or all bans for FFA */
  const leftBans = () => {
    const s = state()
    if (!s) return [] as string[]
    if (isTeamMode()) return s.bans.filter(b => b.seatIndex === 0).map(b => b.civId)
    return s.bans.map(b => b.civId)
  }

  /** Bans for team B (seatIndex 1) — only in team mode */
  const rightBans = () => {
    const s = state()
    if (!s || !isTeamMode()) return [] as string[]
    return s.bans.filter(b => b.seatIndex === 1).map(b => b.civId)
  }

  // Timer
  const [remaining, setRemaining] = createSignal(0)

  createEffect(() => {
    const endsAt = draftStore.timerEndsAt
    if (endsAt == null) { setRemaining(0); return }

    function tick() { setRemaining(Math.max(0, endsAt! - Date.now())) }
    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })

  const seconds = () => Math.ceil(remaining() / 1000)
  const duration = () => currentStepDuration()
  const progress = () => {
    if (!draftStore.timerEndsAt || duration() <= 0) return 0
    return Math.min(1, remaining() / (duration() * 1000))
  }

  const isUrgent = () => seconds() <= 10 && seconds() > 5
  const isCritical = () => seconds() <= 5 && seconds() > 0
  const isExpired = () => draftStore.timerEndsAt != null && remaining() <= 0

  // Brief phase flash on ban/pick transitions
  createEffect(on(accent, (next, prev) => {
    const s = state()
    if (!prev || prev === next || !s || s.status !== 'active') return

    clearPhaseFlashTimeout()
    setPhaseFlash(true)
    phaseFlashTimeout = setTimeout(() => {
      setPhaseFlash(false)
      phaseFlashTimeout = null
    }, 220)
  }, { defer: true }))

  onCleanup(() => {
    clearPhaseFlashTimeout()
  })

  return (
    <header class={cn('relative flex flex-col shrink-0 overflow-hidden', phaseHeaderBg(), 'transition-colors duration-200')}>
      <Show when={phaseFlash()}>
        <div class={cn(
          'pointer-events-none absolute inset-0 z-0 anim-phase-flash',
          accent() === 'red' ? 'bg-accent-red/20' : 'bg-accent-gold/20',
        )}
        />
      </Show>

      {/* Main row */}
      <div class="px-4 py-2.5 flex items-center justify-between relative z-10">
        {/* Left bans */}
        <div class="flex gap-1.5 items-center">
          <For each={leftBans()}>
            {civId => <BanSquare civId={civId} />}
          </For>
          <Show when={leftBans().length === 0 && state()?.status !== 'waiting'}>
            <span class="text-xs text-text-muted/30">No bans</span>
          </Show>
        </div>

        {/* Center: phase + timer */}
        <div class="flex flex-col gap-0.5 items-center">
          <span class={cn(
            'text-xs font-bold tracking-widest uppercase',
            accent() === 'red' ? 'text-accent-red' : 'text-accent-gold',
          )}
          >
            {phaseLabel()}
          </span>

          <Show when={draftStore.timerEndsAt != null}>
            <span class={cn(
              'font-mono text-lg font-bold tabular-nums leading-none',
              isExpired() && 'text-text-muted',
              isCritical() && 'text-accent-red animate-pulse',
              isUrgent() && !isCritical() && 'text-accent-red',
              !isUrgent() && !isCritical() && !isExpired() && 'text-text-primary',
            )}
            >
              {seconds()}
              s
            </span>
          </Show>
        </div>

        {/* Right bans (team mode) or empty */}
        <div class="flex gap-1.5 items-center">
          <Show when={isTeamMode()}>
            <For each={rightBans()}>
              {civId => <BanSquare civId={civId} />}
            </For>
            <Show when={rightBans().length === 0 && state()?.status !== 'waiting'}>
              <span class="text-xs text-text-muted/30">No bans</span>
            </Show>
          </Show>
        </div>
      </div>

      {/* Shrinking timer line — full width, shrinks from edges to center */}
      <Show when={draftStore.timerEndsAt != null && !isExpired()}>
        <div class="flex h-0.5 w-full items-center justify-center relative z-10">
          <div
            class={cn(
              'h-full transition-[width] duration-100 ease-linear rounded-full',
              isCritical() && 'animate-pulse',
            )}
            style={{
              'width': `${progress() * 100}%`,
              'background-color': isCritical() || isUrgent() ? '#e84057' : phaseAccentColor(),
            }}
          />
        </div>
      </Show>
    </header>
  )
}
