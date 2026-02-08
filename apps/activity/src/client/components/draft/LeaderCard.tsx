import type { Leader } from '@civup/game'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/cn'
import {
  banSelections,
  currentStep,
  draftStore,
  isMyTurn,
  selectedLeader,
  setHoveredLeader,
  setSelectedLeader,
  toggleBanSelection,
} from '~/client/stores'

interface LeaderCardProps {
  leader: Leader
}

/** Leader card component: shows portrait/name, handles pick/ban clicks */
export function LeaderCard(props: LeaderCardProps) {
  const state = () => draftStore.state
  const step = currentStep

  /** Is this leader banned? */
  const isBanned = (): boolean => {
    return state()?.bans.some(b => b.civId === props.leader.id) ?? false
  }

  /** Is this leader already picked? */
  const isPicked = (): boolean => {
    return state()?.picks.some(p => p.civId === props.leader.id) ?? false
  }

  /** Is this leader unavailable (banned or picked)? */
  const isUnavailable = (): boolean => isBanned() || isPicked()

  /** Is this the currently selected leader (for single pick)? */
  const isSelected = (): boolean => selectedLeader() === props.leader.id

  /** Is this leader in the ban selection list? */
  const isBanSelected = (): boolean => banSelections().includes(props.leader.id)

  /** Can this leader be clicked? */
  const isClickable = (): boolean => {
    if (isUnavailable()) return false
    if (!isMyTurn()) return false
    return state()?.status === 'active'
  }

  const handleClick = () => {
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

  return (
    <button
      class={cn(
        'relative flex flex-col items-center rounded-lg p-2 transition-all duration-200',
        'border border-transparent',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/50',

        // Unavailable (banned/picked)
        isUnavailable() && 'opacity-30 pointer-events-none',

        // Clickable states
        isClickable() && 'cursor-pointer hover:bg-bg-hover hover:border-border-subtle',
        !isClickable() && !isUnavailable() && 'cursor-default',

        // Selected for pick
        isSelected() && 'border-accent-gold bg-accent-gold/10 gold-glow',

        // Selected for ban
        isBanSelected() && 'border-accent-red bg-accent-red/10 red-glow',
      )}
      onClick={handleClick}
      onMouseEnter={() => setHoveredLeader(props.leader.id)}
      onMouseLeave={() => setHoveredLeader(null)}
      disabled={isUnavailable()}
    >
      {/* Portrait */}
      <div class="mb-1.5 h-16 w-16 flex items-center justify-center overflow-hidden rounded-md bg-bg-secondary">
        <Show
          when={props.leader.portraitUrl}
          fallback={(
            <span class="text-xl text-accent-gold/60 font-bold">
              {props.leader.name.slice(0, 1)}
            </span>
          )}
        >
          {url => (
            <img
              src={url()}
              alt={props.leader.name}
              class={cn(
                'w-full h-full object-cover',
                isBanned() && 'grayscale',
              )}
            />
          )}
        </Show>
      </div>

      {/* Name */}
      <span class="w-full truncate text-center text-xs text-text-primary font-medium">
        {props.leader.name}
      </span>
      <span class="w-full truncate text-center text-[10px] text-text-muted">
        {props.leader.civilization}
      </span>

      {/* Banned overlay */}
      <Show when={isBanned()}>
        <div class="absolute inset-0 flex items-center justify-center rounded-lg bg-accent-red/5">
          <span class="text-2xl text-accent-red font-bold">✕</span>
        </div>
      </Show>
    </button>
  )
}
