import { createSignal, createTrackedEffect as createEffect, onCleanup } from 'solid-js'
import { cn } from '~/client/lib/css'

interface TimerProps {
  /** Absolute timestamp (ms) when the timer expires */
  endsAt: number | null
  /** Total duration in seconds */
  duration: number
  class?: string
}

export function Timer(props: TimerProps) {
  const [remaining, setRemaining] = createSignal(0)

  createEffect(() => {
    const endsAt = props.endsAt
    if (endsAt == null) {
      setRemaining(0)
      return
    }

    function tick() {
      const left = Math.max(0, endsAt! - Date.now())
      setRemaining(left)
    }

    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })

  const seconds = () => Math.ceil(remaining() / 1000)
  const progress = () => {
    if (!props.endsAt || props.duration <= 0) return 0
    return Math.min(1, remaining() / (props.duration * 1000))
  }

  const isUrgent = () => seconds() <= 10 && seconds() > 5
  const isCritical = () => seconds() <= 5 && seconds() > 0
  const isExpired = () => props.endsAt != null && remaining() <= 0

  return (
    <div class={cn('flex flex-col gap-1', props.class)}>
      {/* Timer text */}
      <div
        class={cn(
          'text-center font-mono text-lg font-bold tabular-nums transition-colors',
          isExpired() && 'text-fg-subtle',
          isCritical() && 'text-danger animate-pulse',
          isUrgent() && 'text-danger',
          !isUrgent() && !isCritical() && !isExpired() && 'text-fg',
        )}
      >
        {props.endsAt == null ? '∞' : `${seconds()}s`}
      </div>

      {/* Progress bar */}
      <div class="rounded-full bg-bg-subtle h-1 w-full overflow-hidden">
        <div
          class={cn(
            'h-full rounded-full transition-all duration-100 ease-linear',
            isCritical() && 'bg-danger animate-pulse',
            isUrgent() && 'bg-danger',
            !isUrgent() && !isCritical() && 'bg-accent',
          )}
          style={{ width: `${progress() * 100}%` }}
        />
      </div>
    </div>
  )
}
