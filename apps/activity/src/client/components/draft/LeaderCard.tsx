import type { Leader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  currentStep,
  draftStore,
  isMyTurn,
  isRandomSelected,
  selectedLeader,
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

interface LeaderCardProps {
  leader: Leader
  /** Called while hovering to position the lightweight tooltip */
  onHoverMove?: (leader: Leader, x: number, y: number) => void
  /** Called when hover/focus leaves this card */
  onHoverLeave?: () => void
}

/** Icon-only leader card for the grid overlay */
export function LeaderCard(props: LeaderCardProps) {
  const state = () => draftStore.state
  const step = currentStep

  const isBanned = (): boolean => state()?.bans.some(b => b.civId === props.leader.id) ?? false
  const isPicked = (): boolean => state()?.picks.some(p => p.civId === props.leader.id) ?? false
  const isUnavailable = (): boolean => isBanned() || isPicked()
  const isSelected = (): boolean => selectedLeader() === props.leader.id
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)
  const isActive = (): boolean => isSelected() || isBanSelected()

  const isClickable = (): boolean => {
    if (isUnavailable()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active'
  }

  const handleClick = () => {
    props.onHoverLeave?.()

    toggleDetail(props.leader.id)

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
        isUnavailable() && 'pointer-events-none',
        isClickable() && 'cursor-pointer',
        !isClickable() && !isUnavailable() && 'cursor-pointer',
      )}
      onClick={handleClick}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      disabled={isUnavailable()}
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
          isSelected() && 'ring-accent-gold shadow-[0_0_10px_rgba(200,170,110,0.3)]',
          isSelected() && 'group-hover:ring-accent-gold group-hover:brightness-115 group-hover:shadow-[0_0_14px_rgba(200,170,110,0.45)]',

          // Selected ban
          isBanSelected() && 'ring-accent-red shadow-[0_0_10px_rgba(232,64,87,0.3)]',
          isBanSelected() && 'group-hover:ring-accent-red group-hover:brightness-115 group-hover:shadow-[0_0_14px_rgba(232,64,87,0.45)]',
        )}
      >
        {/* Portrait */}
        <Show
          when={props.leader.portraitUrl}
          fallback={(
            <div class={cn(
              'bg-bg-secondary flex h-full w-full items-center justify-center rounded-full',
              isUnavailable() && 'opacity-25',
            )}
            >
              <span class="text-lg text-accent-gold/40 font-bold">
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
          <div class="rounded-full bg-accent-red/10 flex items-center inset-0 justify-center absolute">
            <span class="text-2xl text-accent-red font-bold">✕</span>
          </div>
        </Show>
      </div>
    </button>
  )
}
