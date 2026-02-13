import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  clearFfaPlacements,
  currentStepDuration,
  draftStore,
  ffaPlacementOrder,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
  reportMatchResult,
  sendScrub,
  userId,
} from '~/client/stores'
import { Button } from '../ui'
import { BanSquare } from './BanSquare'

/** Header bar: bans on left/right, phase label centered, timer with shrinking line */
export function DraftHeader() {
  const state = () => draftStore.state
  const accent = () => phaseAccent()
  const amHost = () => userId() === draftStore.hostId
  const [phaseFlash, setPhaseFlash] = createSignal(false)
  let phaseFlashTimeout: ReturnType<typeof setTimeout> | null = null

  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const isComplete = () => state()?.status === 'complete'
  const seatCount = () => state()?.seats.length ?? 0

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

  const [remaining, setRemaining] = createSignal(0)

  createEffect(() => {
    const endsAt = draftStore.timerEndsAt
    if (endsAt == null) {
      setRemaining(0)
      return
    }

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

  // ── Result Reporting ────────────────────────
  const [resultStatus, setResultStatus] = createSignal<'idle' | 'submitting:A' | 'submitting:B' | 'submitting:ffa' | 'submitting:scrub' | 'done'>('idle')

  const reportWinner = async (team: 'A' | 'B') => {
    const uid = userId()
    if (!uid) return
    setResultStatus(`submitting:${team}`)
    const res = await reportMatchResult(draftStore.state!.matchId, uid, team)
    setResultStatus(res.ok ? 'done' : 'idle')
  }

  const reportFfa = async () => {
    const uid = userId()
    if (!uid) return
    const order = ffaPlacementOrder()
    const s = state()
    if (!s || order.length !== seatCount()) return
    setResultStatus('submitting:ffa')
    const placements = order.map(idx => `<@${s.seats[idx]!.playerId}>`).join('\n')
    const res = await reportMatchResult(s.matchId, uid, placements)
    if (res.ok) {
      setResultStatus('done')
    }
    else { setResultStatus('idle'); clearFfaPlacements() }
  }

  const scrubMatch = async () => {
    if (!amHost()) return
    setResultStatus('submitting:scrub')
    await sendScrub()
    setResultStatus('idle')
  }

  const canInteract = () => amHost() && !resultStatus().startsWith('submitting') && resultStatus() !== 'done'

  return (
    <header class={cn('relative flex flex-col shrink-0 overflow-hidden', isComplete() ? 'bg-bg-secondary' : phaseHeaderBg(), 'transition-colors duration-200')}>
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

        {/* Center: phase + timer / post-draft controls */}
        <Show
          when={!isComplete()}
          fallback={(
            <div class="flex gap-3 items-center relative">
              {/* Post-draft center content */}
              <Show
                when={amHost()}
                fallback={
                  <span class="text-lg text-accent-gold tracking-widest font-bold uppercase">{phaseLabel()}</span>
                }
              >
                <Show
                  when={resultStatus() !== 'done'}
                  fallback={
                    <span class="text-lg text-accent-gold tracking-widest font-bold uppercase">Result reported</span>
                  }
                >
                  {/* Host controls */}
                  <Show
                    when={isTeamMode()}
                    fallback={(
                      <div class="flex gap-2 items-center">
                        <Button
                          size="sm"
                          disabled={!canInteract() || ffaPlacementOrder().length !== seatCount()}
                          onClick={reportFfa}
                        >
                          {resultStatus() === 'submitting:ffa' ? 'Submitting...' : 'Confirm Result'}
                        </Button>
                        <Button
                          size="sm"
                          variant="redOutline"
                          disabled={!canInteract()}
                          onClick={scrubMatch}
                        >
                          {resultStatus() === 'submitting:scrub' ? 'Submitting...' : 'Scrub'}
                        </Button>
                      </div>
                    )}
                  >
                    <div class="flex gap-2 items-center">
                      <Button
                        size="sm"
                        disabled={!canInteract()}
                        onClick={() => reportWinner('A')}
                      >
                        {resultStatus() === 'submitting:A' ? 'Submitting...' : 'Team A Won'}
                      </Button>
                      <Button
                        size="sm"
                        class="text-white/90 border-white/25 bg-white/5 hover:text-white hover:border-white/40 hover:bg-white/10"
                        variant="outline"
                        disabled={!canInteract()}
                        onClick={() => reportWinner('B')}
                      >
                        {resultStatus() === 'submitting:B' ? 'Submitting...' : 'Team B Won'}
                      </Button>
                      <Button
                        size="sm"
                        variant="redOutline"
                        disabled={!canInteract()}
                        onClick={scrubMatch}
                      >
                        {resultStatus() === 'submitting:scrub' ? 'Submitting...' : 'Scrub'}
                      </Button>
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>
          )}
        >
          <div class="flex flex-col gap-0.5 items-center relative">
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

            <Show when={amHost() && state()?.status === 'active'}>
              <div class="ml-6 left-full top-1/2 absolute -translate-y-1/2">
                <button
                  class="text-xs text-[#cdd5df] px-3 py-1.5 border border-[#aeb6c2]/25 rounded-full bg-[#8f99a8]/8 cursor-pointer whitespace-nowrap transition-colors hover:border-[#aeb6c2]/40 hover:bg-[#8f99a8]/15"
                  onClick={sendScrub}
                >
                  Scrub
                </button>
              </div>
            </Show>
          </div>
        </Show>

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

      {/* Shrinking timer line */}
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
