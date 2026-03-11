import type { Leader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  currentStep,
  detailLeaderId,
  draftStore,
  isMyTurn,
  isRandomSelected,
  selectedLeader,
  setBanSelections,
  setDetailLeaderId,
  setIsRandomSelected,
  setSelectedLeader,
  toggleBanSelection,
  toggleDetail,
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

interface LeaderCardProps {
  leader: Leader
  singleClickShowsDetail?: boolean
  /** Called while hovering to position the lightweight tooltip */
  onHoverMove?: (leader: Leader, x: number, y: number) => void
  /** Called when hover/focus leaves this card */
  onHoverLeave?: () => void
}

interface ClickSnapshot {
  selectedLeaderId: string | null
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
  const isSelected = (): boolean => selectedLeader() === props.leader.id
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)
  const isActive = (): boolean => isSelected() || isBanSelected()

  const isClickable = (): boolean => {
    if (isBanned()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active'
  }

  const captureClickSnapshot = (): ClickSnapshot => ({
    selectedLeaderId: selectedLeader(),
    banSelectionIds: [...banSelections()],
    detailLeaderId: detailLeaderId(),
    randomSelected: isRandomSelected(),
  })

  const restoreClickSnapshot = (snapshot: ClickSnapshot) => {
    setSelectedLeader(snapshot.selectedLeaderId)
    setBanSelections(snapshot.banSelectionIds)
    setDetailLeaderId(snapshot.detailLeaderId)
    setIsRandomSelected(snapshot.randomSelected)
  }

  const handleSingleClick = () => {
    if (props.singleClickShowsDetail) toggleDetail(props.leader.id)

    if (!isClickable()) return

    if (isRandomSelected()) setIsRandomSelected(false)

    const s = step()
    if (!s) return

    if (s.action === 'ban') {
      toggleBanSelection(props.leader.id, s.count)
    }
    else {
      const id = props.leader.id
      setSelectedLeader(prev => prev === id ? null : id)
    }
  }

  const handleDoubleClick = () => {
    toggleDetail(props.leader.id)
  }

  const handleClick = () => {
    props.onHoverLeave?.()

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

  const handleHoverMove = (event: MouseEvent) => {
    props.onHoverMove?.(props.leader, event.clientX, event.clientY)
  }

  const handleHoverLeave = () => {
    props.onHoverLeave?.()
  }

  return (
    <button
      class={cn(
        'relative aspect-square p-0.5 group',
        'focus:outline-none',
        isBanned() && 'pointer-events-none',
        isClickable() && 'cursor-pointer',
        !isClickable() && !isUnavailable() && 'cursor-pointer',
      )}
      onClick={handleClick}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      disabled={isBanned()}
    >
      {/* Circular visual container */}
      <div
        class={cn(
          'relative w-full h-full rounded-full overflow-hidden transition-all duration-150',
          'ring-2 ring-inset',

          !isActive() && 'ring-transparent',

          // Hover
          !isActive() && isClickable() && 'group-hover:ring-white/30 group-hover:brightness-115',
          !isActive() && !isClickable() && !isUnavailable() && 'group-hover:ring-white/15',

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
      </div>
    </button>
  )
}
