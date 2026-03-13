import type { Leader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  canManagePickQueue,
  banSelections,
  currentStep,
  detailLeaderId,
  draftStore,
  isMyTurn,
  isRandomSelected,
  pickSelectionIndex,
  pickSelections,
  setBanSelections,
  setDetailLeaderId,
  setIsRandomSelected,
  setPickSelections,
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
const DOUBLE_TAP_DETAIL_WINDOW_MS = 280
const PICK_QUEUE_LONG_PRESS_MS = 350

interface LeaderCardProps {
  leader: Leader
  singleClickShowsDetail?: boolean
  /** Called while hovering to position the lightweight tooltip */
  onHoverMove?: (leader: Leader, x: number, y: number) => void
  /** Called when hover/focus leaves this card */
  onHoverLeave?: () => void
}

interface ClickSnapshot {
  pickSelectionIds: string[]
  banSelectionIds: string[]
  detailLeaderId: string | null
  randomSelected: boolean
}

/** Icon-only leader card for the grid overlay */
export function LeaderCard(props: LeaderCardProps) {
  const state = () => draftStore.state
  const step = currentStep
  let pendingClickTimeout: ReturnType<typeof setTimeout> | null = null
  let pendingClickSnapshot: ClickSnapshot | null = null

  const isBanned = (): boolean => state()?.bans.some(b => b.civId === props.leader.id) ?? false
  const isPicked = (): boolean => state()?.picks.some(p => p.civId === props.leader.id) ?? false
  const isUnavailable = (): boolean => isBanned() || isPicked()
  const pickQueueIndex = (): number => pickSelectionIndex(props.leader.id)
  const isSelected = (): boolean => pickQueueIndex() === 0
  const isQueuedPick = (): boolean => pickQueueIndex() > 0
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)
  const isActive = (): boolean => isSelected() || isBanSelected()
  const hasSelectionVisual = (): boolean => isActive() || isQueuedPick()
  let longPressTimeout: ReturnType<typeof setTimeout> | null = null
  let suppressNextClick = false

  const canToggleBanSelection = (): boolean => {
    if (isUnavailable()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active' && step()?.action === 'ban'
  }

  const canTogglePickSelection = (): boolean => {
    if (isUnavailable()) return false
    if (state()?.status !== 'active') return false
    if (step()?.action !== 'pick') return false
    return canManagePickQueue()
  }

  const isInteractive = (): boolean => {
    return canToggleBanSelection() || canTogglePickSelection()
  }

  const captureClickSnapshot = (): ClickSnapshot => ({
    pickSelectionIds: [...pickSelections()],
    banSelectionIds: [...banSelections()],
    detailLeaderId: detailLeaderId(),
    randomSelected: isRandomSelected(),
  })

  const restoreClickSnapshot = (snapshot: ClickSnapshot) => {
    setPickSelections(snapshot.pickSelectionIds)
    setBanSelections(snapshot.banSelectionIds)
    setDetailLeaderId(snapshot.detailLeaderId)
    setIsRandomSelected(snapshot.randomSelected)
  }

  const clearPendingClick = () => {
    if (!pendingClickTimeout) return
    clearTimeout(pendingClickTimeout)
    pendingClickTimeout = null
    pendingClickSnapshot = null
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
    if (props.singleClickShowsDetail) toggleDetail(props.leader.id)

    if (!isInteractive()) return

    if (isRandomSelected()) setIsRandomSelected(false)

    const s = step()
    if (!s) return

    if (s.action === 'ban') {
      toggleBanSelection(props.leader.id, s.count)
    }
    else {
      handlePickSelection(false)
    }
  }

  const handleQueuedClick = () => {
    clearPendingClick()
    handlePickSelection(true)
  }

  const handleDoubleClick = () => {
    clearPendingClick()
    toggleDetail(props.leader.id)
  }

  const handleClick = (event: MouseEvent) => {
    props.onHoverLeave?.()

    if (suppressNextClick) {
      suppressNextClick = false
      return
    }

    if (event.shiftKey && canTogglePickSelection()) {
      handleQueuedClick()
      return
    }

    if (pendingClickTimeout) {
      clearTimeout(pendingClickTimeout)
      pendingClickTimeout = null

      if (pendingClickSnapshot) restoreClickSnapshot(pendingClickSnapshot)
      pendingClickSnapshot = null
      handleDoubleClick()
      return
    }

    pendingClickSnapshot = captureClickSnapshot()
    handleSingleClick()
    pendingClickTimeout = setTimeout(() => {
      pendingClickTimeout = null
      pendingClickSnapshot = null
    }, DOUBLE_TAP_DETAIL_WINDOW_MS)
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (!canTogglePickSelection()) return

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
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      disabled={isBanned()}
    >
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
              src={url()}
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

        <Show when={isQueuedPick()}>
          <span class="text-[10px] text-[var(--badge-gold-text)] font-semibold px-1 py-0.5 rounded-full bg-bg-subtle min-w-4 right-0 top-0 absolute translate-x-1/4 -translate-y-1/4 text-center">
            {pickQueueIndex() + 1}
          </span>
        </Show>
      </div>
    </button>
  )
}
