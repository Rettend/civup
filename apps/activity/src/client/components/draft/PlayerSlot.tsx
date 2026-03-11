import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { createEffect, createSignal, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, ffaPlacementOrder, getOptimisticSeatPick, phaseAccent, resultSelectionsLocked, selectedWinningTeam, selectWinningTeam, toggleFfaPlacement, userId } from '~/client/stores'

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
  const isTeamResultMode = () => isComplete() && !isFfa() && amHost()
  const canSelectResult = () => !resultSelectionsLocked()

  const placementRank = () => {
    if (!isFfaPlacementMode()) return -1
    return ffaPlacementOrder().indexOf(props.seatIndex)
  }

  const isPlaced = () => placementRank() >= 0
  const anyFfaPlaced = () => ffaPlacementOrder().length > 0

  /** Boosted glow for compact FFA slots (smaller area needs higher intensity) */
  const ffaWinnerGlowStyle = {
    background: [
      'radial-gradient(ellipse farthest-side at 50% 130%, var(--glow-gold) 0%, var(--glow-gold-dim) 40%, transparent 72%)',
      'radial-gradient(ellipse closest-side at 50% 100%, rgba(255,215,100,0.38) 0%, transparent 55%)',
      'linear-gradient(to top, var(--glow-gold-dim) 0%, transparent 40%)',
    ].join(', '),
  }

  const ffaGoldBorderColor = 'var(--accent-muted)'

  const ffaGridMetrics = () => {
    const count = state()?.seats.length ?? 0
    const perRow = Math.ceil(count / 2)
    const bottomCount = count - perRow
    const bottomStart = Math.floor((perRow - bottomCount) / 2)
    return { count, perRow, bottomCount, bottomStart }
  }

  const ffaGridPosition = () => {
    const { perRow, bottomStart } = ffaGridMetrics()
    if (props.seatIndex < perRow) {
      return { row: 0 as const, col: props.seatIndex }
    }
    return { row: 1 as const, col: bottomStart + (props.seatIndex - perRow) }
  }

  const ffaSeatAt = (row: number, col: number): number | null => {
    const { perRow, bottomCount, bottomStart } = ffaGridMetrics()
    if (row === 0) {
      return col >= 0 && col < perRow ? col : null
    }
    if (row === 1) {
      return col >= bottomStart && col < bottomStart + bottomCount ? perRow + (col - bottomStart) : null
    }
    return null
  }

  const ffaHasPlacedLeft = () => {
    if (!isPlaced()) return false
    const { row, col } = ffaGridPosition()
    const leftSeat = ffaSeatAt(row, col - 1)
    return leftSeat != null && ffaPlacementOrder().includes(leftSeat)
  }

  const ffaHasPlacedAbove = () => {
    if (!isPlaced()) return false
    const { row, col } = ffaGridPosition()
    const aboveSeat = ffaSeatAt(row - 1, col)
    return aboveSeat != null && ffaPlacementOrder().includes(aboveSeat)
  }

  const ffaHasPlacedRight = () => {
    if (!isPlaced()) return false
    const { row, col } = ffaGridPosition()
    const rightSeat = ffaSeatAt(row, col + 1)
    return rightSeat != null && ffaPlacementOrder().includes(rightSeat)
  }

  const ffaHasPlacedBelow = () => {
    if (!isPlaced()) return false
    const { row, col } = ffaGridPosition()
    const belowSeat = ffaSeatAt(row + 1, col)
    return belowSeat != null && ffaPlacementOrder().includes(belowSeat)
  }

  const ffaGoldBorderStyle = () => {
    if (!isPlaced()) return ''
    return [
      'box-sizing:border-box',
      `border-top:${ffaHasPlacedAbove() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-left:${ffaHasPlacedLeft() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-right:${ffaHasPlacedRight() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-bottom:${ffaHasPlacedBelow() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      'box-shadow:inset 0 0 28px var(--glow-gold-dim)',
    ].join(';')
  }

  const digitIconClass = (digit: string) => {
    switch (digit) {
      case '0': return 'i-ph:number-zero-bold'
      case '1': return 'i-ph:number-one-bold'
      case '2': return 'i-ph:number-two-bold'
      case '3': return 'i-ph:number-three-bold'
      case '4': return 'i-ph:number-four-bold'
      case '5': return 'i-ph:number-five-bold'
      case '6': return 'i-ph:number-six-bold'
      case '7': return 'i-ph:number-seven-bold'
      case '8': return 'i-ph:number-eight-bold'
      case '9': return 'i-ph:number-nine-bold'
      case '10': return 'i-custom:number-ten-bold'
      default: return ''
    }
  }

  const placementNumber = () => placementRank() + 1
  const placementIconClass = () => digitIconClass(String(placementNumber()))
  const seatTeam = () => seat()?.team ?? null
  const isLosingTeamDimmed = () => {
    const team = seatTeam()
    const selectedTeam = selectedWinningTeam()
    return isTeamResultMode() && team != null && selectedTeam != null && selectedTeam !== team
  }

  const handleSlotClick = () => {
    if (!isFfaPlacementMode() || !canSelectResult()) return
    toggleFfaPlacement(props.seatIndex)
  }

  const handleTeamResultClick = () => {
    if (!isTeamResultMode() || !canSelectResult()) return
    const team = seatTeam()
    if (team == null || (team !== 0 && team !== 1)) return
    selectWinningTeam(team)
  }

  return (
    <div
      class={cn(
        'relative flex flex-col overflow-hidden bg-bg-subtle h-full isolate',
        canSelectResult() && (isFfaPlacementMode() || isTeamResultMode()) && 'cursor-pointer',
      )}
      classList={{
        'slot-accent-gold': isActive() && accent() === 'gold',
        'slot-accent-red': isActive() && accent() === 'red',
      }}
      onClick={() => {
        handleSlotClick()
        handleTeamResultClick()
      }}
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
        {/* Bottom radial glow on selected slots */}
        <Show when={isPlaced()}>
          <div
            class="anim-fade-in pointer-events-none inset-0 absolute z-20"
            style={ffaWinnerGlowStyle}
          />
        </Show>

        {/* Gold border with neighbor-aware collapse */}
        <Show when={isPlaced()}>
          <div class="pointer-events-none inset-0 absolute z-30" style={ffaGoldBorderStyle()} />
        </Show>

        {/* Placement badge */}
        <Show when={isPlaced()}>
          <div class="anim-fade-in left-1/2 top-1/2 absolute z-40 -translate-x-1/2 -translate-y-1/2">
            <div
              class={cn(
                'flex items-center justify-center rounded-full leading-none',
                'border border-[var(--badge-gold-border)] bg-accent font-black shadow-[0_4px_12px_rgba(0,0,0,0.5),0_8px_28px_rgba(0,0,0,0.4),0_16px_48px_rgba(0,0,0,0.25)]',
                props.compact ? 'h-12 w-12 text-xl' : 'h-14 w-14 text-2xl',
              )}
              style={{ 'color': 'var(--badge-gold-text)', 'font-weight': 900 }}
            >
              <span class={cn(placementIconClass(), props.compact ? 'text-[28px]' : 'text-[32px]')} />
            </div>
          </div>
        </Show>

        {/* Dim unselected slots when any placement has been made */}
        <Show when={anyFfaPlaced() && !isPlaced()}>
          <div class="bg-black/50 pointer-events-none inset-0 absolute z-25" />
        </Show>
      </Show>

      {/* Team result overlay */}
      <Show when={isTeamResultMode()}>
        <Show when={isLosingTeamDimmed()}>
          <div class="bg-black/40 pointer-events-none transition-all duration-300 inset-0 absolute z-30" />
        </Show>
      </Show>

      {/* Portrait */}
      <Show when={leader()} keyed>
        {l => (
          <img
            src={`/assets/leaders-full/${l.id}.webp`}
            alt={l.name}
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
            isActive() ? (accent() === 'red' ? 'text-danger/80' : 'text-accent/80') : 'text-fg-muted/40',
          )}
          />
        </div>
      </Show>

      {/* Bottom gradient overlay */}
      <div class={cn(
        'absolute inset-x-0 bottom-0 px-2 pb-2 pt-8 z-20',
        filled() ? 'bg-gradient-to-t from-black/80 to-transparent' : 'bg-gradient-to-t from-bg/40 to-transparent',
      )}
      >
        {/* Leader name (when picked) */}
        <Show when={leader()} keyed>
          {l => (
            <div class="mb-1">
              <div class="text-base text-fg leading-tight font-semibold truncate">{l.name}</div>
              <div class="text-sm text-fg-muted/80 leading-tight truncate">{l.civilization}</div>
            </div>
          )}
        </Show>

        {/* Discord name and avatar */}
        <Show when={seat()} keyed>
          {s => (
            <div class={cn(
              'flex items-center gap-2',
              isActive() ? (accent() === 'red' ? 'text-danger' : 'text-accent') : 'text-fg-muted',
              filled() && !isActive() && 'text-fg-muted/60',
            )}
            >
              <Show when={seatAvatarUrl()} keyed>
                {url => (
                  <img
                    src={url}
                    alt=""
                    class="rounded-full shrink-0 h-5 w-5 object-cover"
                  />
                )}
              </Show>
              <span class="text-sm leading-tight truncate">{s.displayName}</span>
            </div>
          )}
        </Show>
      </div>

      {/* Pick order label at top-left */}
      <div class="left-1.5 top-1.5 absolute z-20">
        <span class={cn(
          'text-[10px] font-bold tracking-wide uppercase',
          isActive() ? (accent() === 'red' ? 'text-danger' : 'text-accent') : (filled() ? 'text-white/80 drop-shadow-md' : 'text-fg-muted/50'),
        )}
        >
          {props.seatIndex + 1}
        </span>
      </div>
    </div>
  )
}
