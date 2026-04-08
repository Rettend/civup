import type { Leader } from '@civup/game'
import { Show, type JSX } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  canManagePickQueue,
  currentStep,
  draftStore,
  isLeaderFavorited,
  isMyTurn,
  isRandomSelected,
  isRedDeathDraft,
  pickSelectionIndex,
  setDetailLeaderId,
  setIsRandomSelected,
  toggleBanSelection,
  toggleDetail,
  togglePickSelection,
} from '~/client/stores'

const ZOOMED_LEADERS = [
  'Ahiram',
  'Al-Hasan ibn Sulaiman',
  'Kiviuq',
  'Spearthrower Owl',
  'Trisong Detsen',
  'Vercingetorix',
]

const SLIGHTLY_ZOOMED_LEADERS = [
  'Te\' K\'inich II',
]
const PICK_QUEUE_LONG_PRESS_MS = 350

interface LeaderCardProps {
  leader: Leader
  singleClickShowsDetail?: boolean
  /** Called while hovering to position the lightweight tooltip */
  onHoverMove?: (leader: Leader, x: number, y: number) => void
  /** Called when hover/focus leaves this card */
  onHoverLeave?: () => void
}

function useLeaderCardState(props: LeaderCardProps) {
  const state = () => draftStore.state
  const step = currentStep

  const isBanned = (): boolean => state()?.bans.some(b => b.civId === props.leader.id) ?? false
  const isPicked = (): boolean => state()?.picks.some(p => p.civId === props.leader.id) ?? false
  const isUnavailable = (): boolean => isBanned() || isPicked()
  const pickQueueIndex = (): number => pickSelectionIndex(props.leader.id)
  const isSelected = (): boolean => pickQueueIndex() === 0
  const isQueuedPick = (): boolean => pickQueueIndex() > 0
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)
  const isActive = (): boolean => isSelected() || isBanSelected()
  const hasSelectionVisual = (): boolean => isActive() || isQueuedPick()
  const isFavorited = (): boolean => isLeaderFavorited(props.leader.id)
  let longPressTimeout: ReturnType<typeof setTimeout> | null = null
  let suppressNextClick = false

  const canToggleBanSelection = (): boolean => {
    if (isUnavailable()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active' && step()?.action === 'ban'
  }

  const seatHasLockedPickForCard = (): boolean => {
    const seat = draftStore.seatIndex
    if (seat == null) return false
    return state()?.picks.some(pick => pick.seatIndex === seat) ?? false
  }

  const canTogglePickSelection = (): boolean => {
    if (isUnavailable()) return false
    if (state()?.status !== 'active') return false
    if (step()?.action !== 'pick') return false
    if (isRedDeathDraft()) return isMyTurn() && !seatHasLockedPickForCard()
    return canManagePickQueue()
  }

  const isInteractive = (): boolean => {
    return canToggleBanSelection() || canTogglePickSelection()
  }

  const clearLongPress = () => {
    if (!longPressTimeout) return
    clearTimeout(longPressTimeout)
    longPressTimeout = null
  }

  const handlePickSelection = (extendQueue: boolean) => {
    if (!canTogglePickSelection()) return
    if (isRandomSelected()) setIsRandomSelected(false)
    togglePickSelection(props.leader.id, extendQueue)
  }

  const handleSingleClick = () => {
    const s = step()
    const willDeselect = s?.action === 'pick' ? hasSelectionVisual() : isBanSelected()

    if (props.singleClickShowsDetail && !willDeselect) {
      setDetailLeaderId(props.leader.id)
    }

    if (!isInteractive()) return

    if (isRandomSelected()) setIsRandomSelected(false)

    if (!s) return

    if (s.action === 'ban') {
      toggleBanSelection(props.leader.id, s.count)
    }
    else {
      handlePickSelection(false)
    }
  }

  const handleQueuedClick = () => {
    handlePickSelection(true)
  }

  const handleClick = (event: MouseEvent) => {
    props.onHoverLeave?.()

    if (suppressNextClick) {
      suppressNextClick = false
      return
    }

    if (!isRedDeathDraft() && event.shiftKey && canTogglePickSelection()) {
      handleQueuedClick()
      return
    }
    handleSingleClick()
  }

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    props.onHoverLeave?.()
    toggleDetail(props.leader.id)
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (!canTogglePickSelection()) return
    if (isRedDeathDraft()) return

    suppressNextClick = false
    clearLongPress()
    longPressTimeout = setTimeout(() => {
      longPressTimeout = null
      suppressNextClick = true
      props.onHoverLeave?.()
      handleQueuedClick()
    }, PICK_QUEUE_LONG_PRESS_MS)
  }

  const handlePointerUp = () => {
    clearLongPress()
  }

  const handleHoverMove = (event: MouseEvent) => {
    props.onHoverMove?.(props.leader, event.clientX, event.clientY)
  }

  const handleHoverLeave = () => {
    clearLongPress()
    props.onHoverLeave?.()
  }

  return {
    state,
    step,
    isBanned,
    isPicked,
    isUnavailable,
    pickQueueIndex,
    isSelected,
    isQueuedPick,
    isBanSelected,
    isActive,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
    handlePointerDown,
    handlePointerUp,
    handleHoverMove,
    handleHoverLeave,
  }
}

function LeaderCornerBadge(props: { class?: string, children: JSX.Element }) {
  return (
    <span class={cn('absolute z-10 flex items-center justify-center rounded-full text-center leading-none', props.class)}>
      {props.children}
    </span>
  )
}

/** Icon-only leader card for the grid overlay */
export function LeaderCard(props: LeaderCardProps) {
  const {
    isBanned,
    isUnavailable,
    pickQueueIndex,
    isSelected,
    isQueuedPick,
    isBanSelected,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
    handlePointerDown,
    handlePointerUp,
    handleHoverMove,
    handleHoverLeave,
  } = useLeaderCardState(props)

  return (
    <button
      class={cn(
        'relative aspect-square p-0.5 group',
        'focus:outline-none',
        isBanned() && 'pointer-events-none',
        isInteractive() && 'cursor-pointer',
        !isInteractive() && !isUnavailable() && 'cursor-pointer',
      )}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      disabled={isBanned()}
    >
      <Show when={isFavorited() && !isQueuedPick()}>
        <LeaderCornerBadge class="right-1 top-1 min-w-4 bg-bg-subtle px-1 py-0.5 shadow shadow-black/30">
          <span class="i-ph-star-fill text-[10px] text-accent" />
        </LeaderCornerBadge>
      </Show>

      {/* Circular visual container */}
      <div
        class={cn(
          'relative w-full h-full rounded-full overflow-hidden transition-all duration-150',
          'ring-2 ring-inset',

          !hasSelectionVisual() && 'ring-transparent',

          // Hover
          !hasSelectionVisual() && isInteractive() && 'group-hover:ring-white/30 group-hover:brightness-115',
          !hasSelectionVisual() && !isInteractive() && !isUnavailable() && 'group-hover:ring-white/15',

          // Selected pick
          isSelected() && 'ring-accent shadow-[0_0_10px_var(--accent-muted)]',
          isSelected() && 'group-hover:ring-accent group-hover:brightness-115 group-hover:shadow-[0_0_14px_var(--accent-muted)]',

          // Queued fallback pick
          isQueuedPick() && 'ring-transparent',
          isQueuedPick() && 'group-hover:brightness-110',

          // Selected ban
          isBanSelected() && 'ring-danger shadow-[0_0_10px_var(--danger-muted)]',
          isBanSelected() && 'group-hover:ring-danger group-hover:brightness-115 group-hover:shadow-[0_0_14px_var(--danger-muted)]',
        )}
        style={isQueuedPick()
          ? { 'box-shadow': 'inset 0 0 0 2px rgba(182, 143, 50, 0.92), 0 0 10px rgba(182, 143, 50, 0.18)' }
          : undefined}
      >
        {/* Portrait */}
        <Show
          when={props.leader.portraitUrl}
          fallback={(
            <div class={cn(
              'bg-bg-subtle flex h-full w-full items-center justify-center rounded-full',
              isUnavailable() && 'opacity-25',
            )}
            >
              <span class="text-lg text-accent/40 font-bold">
                {props.leader.name.slice(0, 1)}
              </span>
            </div>
          )}
        >
          {url => (
            <img
              src={resolveAssetUrl(url()) ?? url()}
              alt={props.leader.name}
              class={cn(
                'h-full w-full object-cover',
                isBanned() && 'grayscale',
                isUnavailable() && 'opacity-25',
                ZOOMED_LEADERS.includes(props.leader.name) && 'scale-90',
                SLIGHTLY_ZOOMED_LEADERS.includes(props.leader.name) && 'scale-95',
              )}
            />
          )}
        </Show>

        {/* Banned overlay */}
        <Show when={isBanned()}>
          <div class="rounded-full bg-danger/10 flex items-center inset-0 justify-center absolute">
            <span class="text-2xl text-danger font-bold">✕</span>
          </div>
        </Show>
      </div>

      <Show when={isQueuedPick()}>
        <LeaderCornerBadge class="right-1 top-1 min-w-4 bg-bg-subtle px-1 py-0.5 shadow shadow-black/30">
          <span class="text-[10px] font-semibold text-accent">{pickQueueIndex() + 1}</span>
        </LeaderCornerBadge>
      </Show>
    </button>
  )
}

/** Compact list-row leader card for the list view */
export function LeaderListItem(props: LeaderCardProps) {
  const {
    isBanned,
    isUnavailable,
    pickQueueIndex,
    isSelected,
    isQueuedPick,
    isBanSelected,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
    handlePointerDown,
    handlePointerUp,
    handleHoverMove,
    handleHoverLeave,
  } = useLeaderCardState(props)

  return (
    <button
      class={cn(
        'relative flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left group min-w-0 transition-all duration-150',
        'outline outline-2 outline-transparent',
        isBanned() && 'pointer-events-none',
        (isInteractive() || !isUnavailable()) && 'cursor-pointer',

        // Default
        !hasSelectionVisual() && isInteractive() && 'hover:bg-white/6',
        !hasSelectionVisual() && !isInteractive() && !isUnavailable() && 'hover:bg-white/4',

        // Selected pick
        isSelected() && 'outline-accent/50 bg-accent/8 hover:bg-accent/14 hover:outline-accent/65',

        // Ban selected
        isBanSelected() && 'outline-danger/50 bg-danger/8 hover:bg-danger/14 hover:outline-danger/65',

        // Queued fallback pick
        isQueuedPick() && 'outline-1 outline-accent/25 bg-accent/5 hover:bg-accent/8',
      )}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      disabled={isBanned()}
    >
      <div class="relative h-7 w-7 shrink-0">
        <Show when={isFavorited()}>
          <LeaderCornerBadge class="-right-1 top-0 h-4 w-4 border border-border/60 bg-bg/92 shadow shadow-black/30">
            <span class="i-ph-star-fill text-[8px] text-accent" />
          </LeaderCornerBadge>
        </Show>

        <div class="relative h-full w-full overflow-hidden rounded-full">
          <Show
            when={props.leader.portraitUrl}
            fallback={(
              <div class={cn(
                'bg-bg-subtle flex h-full w-full items-center justify-center rounded-full',
                isUnavailable() && 'opacity-25',
              )}
              >
                <span class="text-xs text-accent/40 font-bold">
                  {props.leader.name.slice(0, 1)}
                </span>
              </div>
            )}
          >
            {url => (
              <img
                src={resolveAssetUrl(url()) ?? url()}
                alt={props.leader.name}
                class={cn(
                  'h-full w-full object-cover',
                  isBanned() && 'grayscale',
                  isUnavailable() && 'opacity-25',
                  ZOOMED_LEADERS.includes(props.leader.name) && 'scale-90',
                  SLIGHTLY_ZOOMED_LEADERS.includes(props.leader.name) && 'scale-95',
                )}
              />
            )}
          </Show>

          <Show when={isBanned()}>
            <div class="rounded-full bg-danger/10 flex items-center inset-0 justify-center absolute">
              <span class="text-sm text-danger font-bold">✕</span>
            </div>
          </Show>
        </div>
      </div>

      <span class={cn(
        'text-xs truncate min-w-0 flex-1 transition-colors',
        isUnavailable() && 'text-fg-subtle/40',
        isBanSelected() && !isUnavailable() && 'text-danger group-hover:text-danger group-hover:drop-shadow-[0_0_4px_var(--danger)]',
        isSelected() && !isUnavailable() && 'text-accent group-hover:text-accent group-hover:drop-shadow-[0_0_4px_var(--accent)]',
        isQueuedPick() && !isUnavailable() && 'text-accent/70 group-hover:text-accent group-hover:drop-shadow-[0_0_3px_var(--accent-muted)]',
        !hasSelectionVisual() && !isUnavailable() && 'text-fg-muted group-hover:text-fg',
      )}
      >
        {props.leader.name}
      </span>

      <Show when={isQueuedPick()}>
        <span class="text-[9px] text-accent font-semibold ml-auto shrink-0">
          #
          {pickQueueIndex() + 1}
        </span>
      </Show>
    </button>
  )
}
