import { getLeader } from '@civup/game'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, phaseAccent, phaseLabel } from '~/client/stores'

/** Minimized PiP view (402x227) — status card with phase, timer, whose turn, last pick */
export function MiniView() {
  const state = () => draftStore.state
  const accent = () => phaseAccent()

  // Timer
  const [remaining, setRemaining] = createSignal(0)
  createEffect(() => {
    const endsAt = draftStore.timerEndsAt
    if (endsAt == null) {
      setRemaining(0)
      return
    }
    const tick = () => setRemaining(Math.max(0, endsAt! - Date.now()))
    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })
  const seconds = () => Math.ceil(remaining() / 1000)

  /** Format name */
  const formatName = () => state()?.formatId?.replace(/-/g, ' ').toUpperCase() ?? ''

  /** Active seat's display name */
  const activeSeatName = () => {
    const s = state()
    if (!s || s.status !== 'active') return null
    const step = s.steps[s.currentStepIndex]
    if (!step) return null
    if (step.seats === 'all') return 'All Players'
    const seat = s.seats[step.seats[0]!]
    return seat?.displayName ?? null
  }

  /** Last pick info */
  const lastPick = () => {
    const s = state()
    if (!s || s.picks.length === 0) return null
    const last = s.picks[s.picks.length - 1]!
    try {
      const leader = getLeader(last.civId)
      return { name: leader.name, portraitUrl: leader.portraitUrl }
    }
    catch { return { name: last.civId, portraitUrl: undefined } }
  }

  return (
    <div class="text-text-primary font-sans p-3 bg-bg-primary flex flex-col h-screen">
      {/* Top row: format, phase, timer */}
      <div class="flex items-center justify-between">
        <span class="text-xs text-text-muted font-medium">{formatName()}</span>
        <span class={cn(
          'text-xs font-bold tracking-widest uppercase',
          accent() === 'red' ? 'text-accent-red' : 'text-accent-gold',
        )}
        >
          {phaseLabel()}
        </span>
        <Show when={draftStore.timerEndsAt != null}>
          <span class="text-sm text-text-primary font-bold font-mono tabular-nums">
            {Math.floor(seconds() / 60)}
            :
            {(seconds() % 60).toString().padStart(2, '0')}
          </span>
        </Show>
      </div>

      {/* Whose turn */}
      <div class="mt-4 flex-1">
        <Show when={activeSeatName()}>
          {name => (
            <div>
              <div class="text-xs text-text-muted">Waiting for</div>
              <div class={cn(
                'text-lg font-bold',
                accent() === 'red' ? 'text-accent-red' : 'text-accent-gold',
              )}
              >
                {name()}
              </div>
            </div>
          )}
        </Show>

        <Show when={state()?.status === 'waiting'}>
          <div class="text-sm text-text-muted">Waiting to start...</div>
        </Show>

        <Show when={state()?.status === 'complete'}>
          <div class="text-sm text-accent-gold font-bold">Draft Complete</div>
        </Show>
      </div>

      {/* Last pick */}
      <Show when={lastPick()}>
        {pick => (
          <div class="flex gap-2 items-center">
            <Show when={pick().portraitUrl}>
              {url => <img src={url()} alt={pick().name} class="rounded h-8 w-8 object-cover" />}
            </Show>
            <div>
              <div class="text-[10px] text-text-muted uppercase">Last Pick</div>
              <div class="text-xs text-text-primary font-medium">{pick().name}</div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
