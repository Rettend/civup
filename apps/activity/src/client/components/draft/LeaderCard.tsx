import type { Leader } from '@civup/game'
import { Show, type JSX } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  currentStep,
  draftStore,
  isLeaderFavorited,
  isMyTurn,
  isRandomSelected,
  isRedDeathDraft,
  setDetailLeaderId,
  setIsRandomSelected,
  selectedLeader,
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

interface LeaderCardProps {
  leader: Leader
  singleClickShowsDetail?: boolean
  /** Called while hovering to position the lightweight tooltip */
  onHoverMove?: (leader: Leader, x: number, y: number) => void
  /** Called when hover/focus leaves this card */
  onHoverLeave?: () => void
}

export interface LeaderListNeighborState {
  selectedAbove: boolean
  selectedBelow: boolean
  selectedLeft: boolean
  selectedRight: boolean
  hoveredAbove: boolean
  hoveredBelow: boolean
  hoveredLeft: boolean
  hoveredRight: boolean
}

const TRANSPARENT_SELECTION_SHADOW = [
  'inset 0 1.5px 0 0 transparent',
  'inset 0 -1.5px 0 0 transparent',
  'inset 1.5px 0 0 0 transparent',
  'inset -1.5px 0 0 0 transparent',
  '0 0 8px transparent',
].join(', ')

export function computeListItemBorderRadius(
  hasSelection: boolean,
  ns: LeaderListNeighborState | undefined,
): string {
  if (!hasSelection || !ns) return '0.375rem'

  const corner = (adjV: boolean, adjH: boolean, hovV: boolean, hovH: boolean) => {
    if (adjV || adjH) return '2px'
    if (hovV || hovH) return '4px'
    return '6px'
  }

  const tl = corner(ns.selectedAbove, ns.selectedLeft, ns.hoveredAbove, ns.hoveredLeft)
  const tr = corner(ns.selectedAbove, ns.selectedRight, ns.hoveredAbove, ns.hoveredRight)
  const br = corner(ns.selectedBelow, ns.selectedRight, ns.hoveredBelow, ns.hoveredRight)
  const bl = corner(ns.selectedBelow, ns.selectedLeft, ns.hoveredBelow, ns.hoveredLeft)

  return `${tl} ${tr} ${br} ${bl}`
}

export function computeListItemBoxShadow(
  hasSelection: boolean,
  colorScheme: 'accent' | 'danger',
  ns: LeaderListNeighborState | undefined,
): string {
  if (!hasSelection) return TRANSPARENT_SELECTION_SHADOW

  const border = colorScheme === 'accent' ? 'var(--accent)' : 'var(--danger)'
  const muted = colorScheme === 'accent' ? 'var(--accent-muted)' : 'var(--danger-muted)'

  return [
    ns?.selectedAbove ? `inset 0 1px 0 0 ${muted}` : `inset 0 1.5px 0 0 ${border}`,
    ns?.selectedBelow ? `inset 0 -1px 0 0 ${muted}` : `inset 0 -1.5px 0 0 ${border}`,
    ns?.selectedLeft ? `inset 1px 0 0 0 ${muted}` : `inset 1.5px 0 0 0 ${border}`,
    ns?.selectedRight ? `inset -1px 0 0 0 ${muted}` : `inset -1.5px 0 0 0 ${border}`,
    `0 0 8px ${muted}`,
  ].join(', ')
}

function useLeaderCardState(props: LeaderCardProps) {
  const state = () => draftStore.state
  const step = currentStep

  const isBanned = (): boolean => state()?.bans.some(b => b.civId === props.leader.id) ?? false
  const isPicked = (): boolean => state()?.picks.some(p => p.civId === props.leader.id) ?? false
  const allowsDuplicatePicks = (): boolean => isRedDeathDraft() && state()?.duplicateFactions === true
  const isUnavailable = (): boolean => isBanned() || (isPicked() && !allowsDuplicatePicks())
  const isSelected = (): boolean => selectedLeader() === props.leader.id
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)
  const hasSelectionVisual = (): boolean => isSelected() || isBanSelected()
  const isFavorited = (): boolean => isLeaderFavorited(props.leader.id)

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
    if (seatHasLockedPickForCard()) return false
    if (isRedDeathDraft()) return isMyTurn()
    return true
  }

  const isInteractive = (): boolean => {
    return canToggleBanSelection() || canTogglePickSelection()
  }

  const handlePickSelection = () => {
    if (!canTogglePickSelection()) return
    if (isRandomSelected()) setIsRandomSelected(false)
    togglePickSelection(props.leader.id)
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
      handlePickSelection()
    }
  }

  const handleClick = () => {
    props.onHoverLeave?.()
    handleSingleClick()
  }

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    props.onHoverLeave?.()
    toggleDetail(props.leader.id)
  }

  const handleHoverMove = (event: MouseEvent) => {
    props.onHoverMove?.(props.leader, event.clientX, event.clientY)
  }

  const handleHoverLeave = () => {
    props.onHoverLeave?.()
  }

  return {
    state,
    step,
    isBanned,
    isPicked,
    isUnavailable,
    isSelected,
    isBanSelected,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
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
    isSelected,
    isBanSelected,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
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
      disabled={isBanned()}
    >
      <Show when={isFavorited()}>
        <LeaderCornerBadge class="right-1 top-1 min-w-4 bg-bg-subtle px-1 py-0.5 shadow shadow-black/30">
          <span class="i-ph-star-fill text-[11px] text-accent" />
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

          // Selected ban
          isBanSelected() && 'ring-danger shadow-[0_0_10px_var(--danger-muted)]',
          isBanSelected() && 'group-hover:ring-danger group-hover:brightness-115 group-hover:shadow-[0_0_14px_var(--danger-muted)]',
        )}
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
    </button>
  )
}

/** Compact list-row leader card for the list view */
export function LeaderListItem(props: LeaderCardProps & { neighborState?: LeaderListNeighborState }) {
  const {
    isBanned,
    isUnavailable,
    isSelected,
    isBanSelected,
    hasSelectionVisual,
    isFavorited,
    isInteractive,
    handleClick,
    handleContextMenu,
    handleHoverMove,
    handleHoverLeave,
  } = useLeaderCardState(props)

  return (
    <button
      class={cn(
        'relative flex w-full items-center gap-2 px-1.5 py-1 text-left group min-w-0 transition-all duration-150',
        'focus:outline-none',
        isBanned() && 'pointer-events-none',
        (isInteractive() || !isUnavailable()) && 'cursor-pointer',

        !hasSelectionVisual() && isInteractive() && 'hover:bg-white/6',
        !hasSelectionVisual() && !isInteractive() && !isUnavailable() && 'hover:bg-white/4',

        isSelected() && 'bg-accent/8 hover:bg-accent/14',
        isBanSelected() && 'bg-danger/8 hover:bg-danger/14',
      )}
      style={{
        'border-radius': computeListItemBorderRadius(hasSelectionVisual(), props.neighborState),
        'box-shadow': computeListItemBoxShadow(hasSelectionVisual(), isSelected() ? 'accent' : 'danger', props.neighborState),
      }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
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
        !hasSelectionVisual() && !isUnavailable() && 'text-fg-muted group-hover:text-fg',
      )}
      >
        {props.leader.name}
      </span>
    </button>
  )
}
