import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { Show } from 'solid-js'

interface BanSquareProps {
  /** Civ ID of the banned leader */
  civId: string
}

/** Small square showing a banned leader's icon */
export function BanSquare(props: BanSquareProps) {
  const leader = (): Leader | null => {
    try { return getLeader(props.civId) }
    catch { return null }
  }

  return (
    <div
      class="relative h-8 w-8 shrink-0 overflow-hidden rounded bg-bg-secondary"
      title={leader()?.name ?? props.civId}
    >
      <Show
        when={leader()?.portraitUrl}
        fallback={
          <div class="flex h-full w-full items-center justify-center">
            <span class="text-[10px] text-accent-red font-bold">
              {(leader()?.name ?? props.civId).slice(0, 2).toUpperCase()}
            </span>
          </div>
        }
      >
        {url => (
          <img
            src={url()}
            alt={leader()?.name}
            class="h-full w-full object-cover grayscale"
          />
        )}
      </Show>

      {/* Red X overlay */}
      <div class="absolute inset-0 flex items-center justify-center bg-accent-red/10">
        <span class="text-sm text-accent-red font-bold">✕</span>
      </div>
    </div>
  )
}
