import type { Leader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  currentStep,
  draftStore,
  isMyTurn,
  selectedLeader,
  setSelectedLeader,
  toggleBanSelection,
  toggleDetail,
} from '~/client/stores'

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

  const isClickable = (): boolean => {
    if (isUnavailable()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active'
  }

  const handleClick = () => {
    props.onHoverLeave?.()

    // Always toggle detail on click
    toggleDetail(props.leader.id)

    if (!isClickable()) return

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
        'relative aspect-square overflow-hidden rounded transition-all duration-150',
        'border-2 border-transparent',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/50',

        // Unavailable
        isUnavailable() && 'pointer-events-none',

        // Clickable hover
        isClickable() && 'cursor-pointer hover:border-white/20',
        !isClickable() && !isUnavailable() && 'cursor-pointer',

        // Selected for pick
        isSelected() && 'border-accent-gold',

        // Selected for ban
        isBanSelected() && 'border-accent-red',
      )}
      onClick={handleClick}
      onMouseEnter={handleHoverMove}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      onBlur={handleHoverLeave}
      disabled={isUnavailable()}
    >
      {/* Portrait — icon only */}
      <Show
        when={props.leader.portraitUrl}
        fallback={(
          <div class={cn(
            'bg-bg-secondary flex h-full w-full items-center justify-center',
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
    </button>
  )
}
