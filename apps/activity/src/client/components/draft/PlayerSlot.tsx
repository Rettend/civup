import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { createEffect, createSignal, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import { placementIconClass } from '~/client/lib/placement-icons'
import { createSeatGridLayout, findSeatGridPosition, getSeatAtGridPosition } from '~/client/lib/seat-grid'
import { canRequestSwapWith, draftStore, ffaPlacementOrder, getOptimisticSeatPick, getPreviewPickForSeat, isMobileLayout, isSwapWindowOpen, phaseAccent, resultSelectionsLocked, seatHasIncomingSwap, selectWinningTeam, sendSwapAccept, sendSwapRequest, toggleFfaPlacement, toggleTeamPlacement, userId } from '~/client/stores'

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
    try { return getLeader(p.civId, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const filled = () => !!pick()
  const previewLeader = (): Leader | null => {
    if (filled()) return null
    const civId = getPreviewPickForSeat(props.seatIndex)
    if (!civId) return null
    try { return getLeader(civId, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const hasPreview = (): boolean => previewLeader() != null
  const displayLeader = (): Leader | null => leader() ?? previewLeader()
  const leaderFullPortraitUrl = (currentLeader: { id: string, fullPortraitUrl?: string }) => resolveAssetUrl(currentLeader.fullPortraitUrl ?? `/assets/leaders-full/${currentLeader.id}.webp`) ?? (currentLeader.fullPortraitUrl ?? `/assets/leaders-full/${currentLeader.id}.webp`)

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
  const seatAvatarUrl = () => seat()?.avatarUrl ?? null

  const [wasEverActive, setWasEverActive] = createSignal(false)
  createEffect(() => { if (isActive()) setWasEverActive(true) })

  // ── FFA Placement ────────────────────────────────────────
  const isComplete = () => state()?.status === 'complete'
  const isFfa = () => !(state()?.seats.some(s => s.team != null) ?? false)
  const teamCount = () => new Set((state()?.seats ?? []).flatMap(seat => seat.team == null ? [] : [seat.team])).size
  const isParticipant = () => {
    const uid = userId()
    const s = state()
    if (!uid || !s) return false
    return s.seats.some(current => current.playerId === uid)
  }
  const isFfaPlacementMode = () => isComplete() && isFfa() && isParticipant()
  const isTwoTeamResultMode = () => isComplete() && !isFfa() && isParticipant() && teamCount() <= 2
  const isMultiTeamResultMode = () => isComplete() && !isFfa() && isParticipant() && teamCount() > 2
  const isTeamResultMode = () => isTwoTeamResultMode() || isMultiTeamResultMode()
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

  const ffaGridLayout = () => createSeatGridLayout(
    state()?.seats.length ?? 0,
    isMobileLayout() ? 2 : Math.ceil((state()?.seats.length ?? 0) / 2),
  )

  const ffaGridPosition = () => {
    return findSeatGridPosition(ffaGridLayout(), props.seatIndex)
  }

  const ffaSeatAt = (row: number, col: number): number | null => {
    return getSeatAtGridPosition(ffaGridLayout(), row, col)
  }

  const ffaHasPlacedLeft = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const leftSeat = ffaSeatAt(row, col - 1)
    return leftSeat != null && ffaPlacementOrder().includes(leftSeat)
  }

  const ffaHasPlacedAbove = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const aboveSeat = ffaSeatAt(row - 1, col)
    return aboveSeat != null && ffaPlacementOrder().includes(aboveSeat)
  }

  const ffaHasPlacedRight = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const rightSeat = ffaSeatAt(row, col + 1)
    return rightSeat != null && ffaPlacementOrder().includes(rightSeat)
  }

  const ffaHasPlacedBelow = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
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

  const placementNumber = () => placementRank() + 1
  const seatTeam = () => seat()?.team ?? null

  const isMySeat = () => {
    const uid = userId()
    return !!uid && seat()?.playerId === uid
  }
  const showCornerSwapButton = () => canRequestSwapWith(props.seatIndex)
  const showFocusedSwapButton = () => isSwapWindowOpen() && isMySeat() && seatHasIncomingSwap(props.seatIndex)
  const isMobileFourVFourSwapLayout = () => {
    if (!isMobileLayout()) return false
    const team = seatTeam()
    if (team == null) return false
    return (state()?.seats.filter(current => current.team === team).length ?? 0) >= 4
  }
  const swapButtonClass = 'rounded-full border-2 bg-transparent text-[#e2c68b] border-[#e8d4ab]/72 shadow-[0_6px_18px_rgba(0,0,0,0.38),0_0_0_1px_rgba(200,170,110,0.08)] transition-[color,border-color,box-shadow,transform] duration-200 hover:text-[#f4dca8] hover:border-[#f4dca8]/92 hover:shadow-[0_8px_24px_rgba(0,0,0,0.46),0_0_18px_rgba(200,170,110,0.24)] active:scale-95'

  const handleSlotClick = () => {
    if (!isFfaPlacementMode() || !canSelectResult()) return
    toggleFfaPlacement(props.seatIndex)
  }

  const handleTeamResultClick = () => {
    if (!isTeamResultMode() || !canSelectResult()) return
    const team = seatTeam()
    if (team == null) return
    if (isMultiTeamResultMode()) {
      toggleTeamPlacement(team)
      return
    }
    if (team !== 0 && team !== 1) return
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

      {/* Top accent bar */}
      <div
        class="rounded-full bg-[var(--slot-glow)] h-[2px] pointer-events-none left-1/2 top-2 absolute z-10 -translate-x-1/2"
        classList={{
          'anim-bar-breathe': isActive(),
          'anim-bar-fade-out': wasEverActive() && !isActive(),
          'opacity-0 w-0': !wasEverActive(),
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
              <span class={cn(placementIconClass(placementNumber()), props.compact ? 'text-[28px]' : 'text-[32px]')} />
            </div>
          </div>
        </Show>

        {/* Dim unselected slots when any placement has been made */}
        <Show when={anyFfaPlaced() && !isPlaced()}>
          <div class="bg-black/50 pointer-events-none inset-0 absolute z-25" />
        </Show>
      </Show>

      {/* Small swap button on teammate portraits */}
      <Show when={showCornerSwapButton()}>
        <div class="right-2 top-2 absolute z-50">
          <button
            type="button"
            class={cn(
              'flex h-12 w-12 items-center justify-center cursor-pointer',
              swapButtonClass,
            )}
            title="Request leader swap"
            aria-label="Request leader swap"
            onClick={(e) => {
              e.stopPropagation()
              sendSwapRequest(props.seatIndex)
            }}
          >
            <span class="i-ph-arrows-left-right-bold text-[20px] pointer-events-none" />
          </button>
        </div>
      </Show>

      {/* Focused swap prompt for the selected teammate */}
      <Show when={showFocusedSwapButton()}>
        <>
          <div
            class="anim-swap-focus-flash pointer-events-none inset-0 absolute z-25"
            style={{ background: 'radial-gradient(ellipse at center, rgba(244,220,168,0.44) 0%, rgba(200,170,110,0.28) 48%, rgba(200,170,110,0.12) 100%)' }}
          />
          <div
            class={cn(
              'pointer-events-none inset-0 absolute z-50 flex',
              isMobileFourVFourSwapLayout() ? 'items-stretch justify-end' : 'items-center justify-center',
            )}
          >
            <div
              class={cn(
                'anim-fade-in border border-border-subtle bg-bg-subtle/72 flex flex-col gap-3 shadow-2xl shadow-black/50 items-center backdrop-blur-md',
                isMobileFourVFourSwapLayout()
                  ? 'h-full w-fit justify-center rounded-none px-3 py-3'
                  : 'w-full rounded-none px-4 py-4',
              )}
            >
              <span class="text-base text-accent font-bold">SWAP</span>
              <button
                type="button"
                class={cn(
                  'anim-swap-in pointer-events-auto flex h-[72px] w-[72px] items-center justify-center cursor-pointer',
                  swapButtonClass,
                )}
                title="Accept leader swap"
                aria-label="Accept leader swap"
                onClick={(e) => {
                  e.stopPropagation()
                  sendSwapAccept()
                }}
              >
                <span class="i-ph-arrows-left-right-bold text-[30px] pointer-events-none" />
              </button>
            </div>
          </div>
        </>
      </Show>

      {/* Portrait */}
      <Show when={leader()} keyed>
        {l => (
          <img
            src={leaderFullPortraitUrl(l)}
            alt={l.name}
            class={cn(
              'absolute inset-0 h-full w-full object-cover',
              props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
              'anim-portrait-in',
            )}
          />
        )}
      </Show>

      <Show when={!filled() && previewLeader()} keyed>
        {l => (
          <div class="opacity-50 inset-0 absolute saturate-85">
            <img
              src={leaderFullPortraitUrl(l)}
              alt={l.name}
              class={cn(
                'absolute inset-0 h-full w-full object-cover',
                props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
                'anim-portrait-in',
              )}
            />
          </div>
        )}
      </Show>

      {/* Empty state icon */}
      <Show when={!filled() && !hasPreview()}>
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
        filled() || hasPreview() ? 'bg-gradient-to-t from-black/80 to-transparent' : 'bg-gradient-to-t from-bg/40 to-transparent',
      )}
      >
        {/* Leader name (when picked) */}
        <Show when={displayLeader()} keyed>
          {l => (
            <div class="mb-1">
              <div class={cn('text-base leading-tight font-semibold truncate', filled() ? 'text-fg' : 'text-fg/72')}>
                {l.name}
              </div>
              <div class={cn('text-sm leading-tight truncate', filled() ? 'text-fg-muted/80' : 'text-fg-muted/65')}>
                {l.civilization}
              </div>
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
