import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { createEffect, createSignal, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, ffaPlacementOrder, getOptimisticSeatPick, phaseAccent, toggleFfaPlacement, userId } from '~/client/stores'

interface PlayerSlotProps {
  /** Seat index in the draft */
  seatIndex: number
  /** Whether this is a half-height FFA slot */
  compact?: boolean
}

/** Individual player slot */
export function PlayerSlot(props: PlayerSlotProps) {
  const state = () => draftStore.state
  const seat = () => state()?.seats[props.seatIndex]

  const pick = () => {
    const serverPick = state()?.picks.find(p => p.seatIndex === props.seatIndex)
    if (serverPick) return serverPick

    const optimisticCivId = getOptimisticSeatPick(props.seatIndex)
    if (!optimisticCivId) return null

    return {
      seatIndex: props.seatIndex,
      civId: optimisticCivId,
    }
  }

  const leader = (): Leader | null => {
    const p = pick()
    if (!p) return null
    try { return getLeader(p.civId) }
    catch { return null }
  }

  const isActive = (): boolean => {
    const s = state()
    if (!s || s.status !== 'active') return false
    const step = s.steps[s.currentStepIndex]
    if (!step) return false
    const seatIsInStep = step.seats === 'all'
      ? props.seatIndex >= 0 && props.seatIndex < s.seats.length
      : step.seats.includes(props.seatIndex)
    if (!seatIsInStep) return false

    const submittedCount = s.submissions[props.seatIndex]?.length ?? 0
    return submittedCount < step.count
  }

  const accent = () => phaseAccent()
  const filled = () => !!pick()
  const seatAvatarUrl = () => seat()?.avatarUrl ?? null

  const [wasEverActive, setWasEverActive] = createSignal(false)
  createEffect(() => { if (isActive()) setWasEverActive(true) })

  // ── FFA Placement ────────────────────────────────────────
  const isComplete = () => state()?.status === 'complete'
  const isFfa = () => !(state()?.seats.some(s => s.team != null) ?? false)
  const amHost = () => userId() === draftStore.hostId
  const isFfaPlacementMode = () => isComplete() && isFfa() && amHost()

  const placementRank = () => {
    if (!isFfaPlacementMode()) return -1
    return ffaPlacementOrder().indexOf(props.seatIndex)
  }

  const isPlaced = () => placementRank() >= 0

  const handleSlotClick = () => {
    if (!isFfaPlacementMode()) return
    toggleFfaPlacement(props.seatIndex)
  }

  return (
    <div
      class={cn(
        'relative flex flex-col overflow-hidden bg-bg-secondary h-full isolate',
        isFfaPlacementMode() && 'cursor-pointer',
      )}
      classList={{
        'slot-accent-gold': isActive() && accent() === 'gold',
        'slot-accent-red': isActive() && accent() === 'red',
      }}
      onClick={handleSlotClick}
    >
      {/* Side Glows */}
      <div
        class="w-6 pointer-events-none inset-y-0 left-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-r"
        classList={{
          'anim-glow-breathe': isActive(),
          'anim-glow-fade-out': wasEverActive() && !isActive(),
          'opacity-0': !wasEverActive(),
        }}
        style={{
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />
      <div
        class="w-6 pointer-events-none inset-y-0 right-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-l"
        classList={{
          'anim-glow-breathe': isActive(),
          'anim-glow-fade-out': wasEverActive() && !isActive(),
          'opacity-0': !wasEverActive(),
        }}
        style={{
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />

      {/* FFA placement overlay */}
      <Show when={isFfaPlacementMode()}>
        {/* Interactive border glow */}
        <div
          class={cn(
            'absolute inset-0 z-30 pointer-events-none transition-all duration-300',
            isPlaced()
              ? 'ring-2 ring-inset ring-accent-gold/60 shadow-[inset_0_0_12px_rgba(200,170,110,0.15)]'
              : 'ring-1 ring-inset ring-white/10 hover-parent:ring-white/25',
          )}
        />

        {/* Placement badge */}
        <Show when={isPlaced()}>
          <div class="anim-fade-in left-1/2 top-1/2 absolute z-40 -translate-x-1/2 -translate-y-1/2">
            <div class={cn(
              'flex items-center justify-center rounded-full',
              'bg-accent-gold text-bg-primary font-bold shadow-lg shadow-accent-gold/25',
              props.compact ? 'w-8 h-8 text-sm' : 'w-10 h-10 text-lg',
            )}
            >
              {placementRank() + 1}
            </div>
          </div>
        </Show>

        {/* Darken when placed */}
        <Show when={isPlaced()}>
          <div class="bg-black/30 pointer-events-none inset-0 absolute z-25" />
        </Show>
      </Show>

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
            isActive() ? (accent() === 'red' ? 'text-accent-red/80' : 'text-accent-gold/80') : 'text-text-muted/50',
          )}
          />
        </div>
      </Show>

      {/* Bottom gradient overlay */}
      <div class={cn(
        'absolute inset-x-0 bottom-0 px-2 pb-2 pt-8 z-20',
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
      <div class="left-1.5 top-1.5 absolute z-20">
        <span class={cn(
          'text-[10px] font-bold tracking-wide uppercase',
          isActive() ? (accent() === 'red' ? 'text-accent-red' : 'text-accent-gold') : (filled() ? 'text-white/80 drop-shadow-md' : 'text-text-muted/70'),
        )}
        >
          {props.seatIndex + 1}
        </span>
      </div>
    </div>
  )
}
