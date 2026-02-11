import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, phaseAccent } from '~/client/stores'

interface PlayerSlotProps {
  /** Seat index in the draft */
  seatIndex: number
  /** Whether this is a half-height FFA slot */
  compact?: boolean
}

/** Individual player slot — empty, active, or filled with a leader portrait */
export function PlayerSlot(props: PlayerSlotProps) {
  const state = () => draftStore.state

  const seat = () => state()?.seats[props.seatIndex]

  /** The pick assigned to this seat */
  const pick = () => state()?.picks.find(p => p.seatIndex === props.seatIndex)

  /** Resolved leader from pick */
  const leader = (): Leader | null => {
    const p = pick()
    if (!p) return null
    try { return getLeader(p.civId) }
    catch { return null }
  }

  /** Whether this seat is active in the current step */
  const isActive = (): boolean => {
    const s = state()
    if (!s || s.status !== 'active') return false
    const step = s.steps[s.currentStepIndex]
    if (!step) return false
    if (step.seats === 'all') return true
    return step.seats.includes(props.seatIndex)
  }

  const accent = () => phaseAccent()
  const filled = () => !!pick()
  const seatAvatarUrl = () => seat()?.avatarUrl ?? null

  return (
    <div
      class={cn(
        'relative flex flex-col overflow-hidden bg-bg-secondary h-full',
        // Custom breathing inner shadow (left/right only) when active
        isActive() && 'anim-slot-breathe',
      )}
      classList={{
        'slot-accent-gold': isActive() && accent() === 'gold',
        'slot-accent-red': isActive() && accent() === 'red',
      }}
    >
      {/* Portrait */}
      <Show when={leader()}>
        {l => (
          <img
            src={`/assets/leaders-full/${l().id}.webp`}
            alt={l().name}
            class={cn(
              'absolute inset-0 h-full w-full object-cover',
              props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
              'anim-portrait-in',
            )}
          />
        )}
      </Show>

      {/* Empty state icon */}
      <Show when={!filled()}>
        <div class="flex flex-1 items-center justify-center">
          <div class={cn(
            'i-ph-user-bold text-3xl',
            isActive() ? (accent() === 'red' ? 'text-accent-red/40' : 'text-accent-gold/40') : 'text-text-muted/20',
          )}
          />
        </div>
      </Show>

      {/* Bottom gradient overlay for name readability */}
      <div class={cn(
        'absolute inset-x-0 bottom-0 px-2 pb-2 pt-8',
        filled() ? 'bg-gradient-to-t from-black/80 to-transparent' : 'bg-gradient-to-t from-bg-primary/40 to-transparent',
      )}
      >
        {/* Leader name (when picked) */}
        <Show when={leader()}>
          {l => (
            <div class="mb-1">
              <div class="text-base text-text-primary leading-tight font-semibold truncate">{l().name}</div>
              <div class="text-sm text-text-secondary/80 leading-tight truncate">{l().civilization}</div>
            </div>
          )}
        </Show>

        {/* Discord name and avatar */}
        <Show when={seat()}>
          {s => (
            <div class={cn(
              'flex items-center gap-2',
              isActive() ? (accent() === 'red' ? 'text-accent-red' : 'text-accent-gold') : 'text-text-secondary',
              filled() && !isActive() && 'text-text-secondary/60',
            )}
            >
              <Show when={seatAvatarUrl()}>
                {url => (
                  <img
                    src={url()}
                    alt=""
                    class="rounded-full shrink-0 h-5 w-5 object-cover"
                  />
                )}
              </Show>
              <span class="text-sm leading-tight truncate">{s().displayName}</span>
            </div>
          )}
        </Show>
      </div>

      {/* Pick order label at top-left */}
      <div class="left-1.5 top-1.5 absolute">
        <span class={cn(
          'text-[10px] font-bold tracking-wide uppercase',
          isActive() ? (accent() === 'red' ? 'text-accent-red' : 'text-accent-gold') : 'text-text-muted/40',
        )}
        >
          {props.seatIndex + 1}
        </span>
      </div>
    </div>
  )
}
