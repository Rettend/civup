import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

interface SliderProps {
  /** Current value */
  value: number
  /** Minimum value */
  min: number
  /** Maximum value */
  max: number
  /** Step increment */
  step?: number
  /** Accessible label */
  ariaLabel?: string
  /** Disabled state */
  disabled?: boolean
  /** Called on value change */
  onInput?: (value: number) => void
  /** Additional class for the wrapper */
  class?: string
}

export function Slider(props: SliderProps) {
  const [local, rest] = splitProps(props, ['value', 'min', 'max', 'step', 'ariaLabel', 'disabled', 'onInput', 'class'])

  const progress = () => {
    const range = local.max - local.min
    if (range <= 0) return 0
    return ((local.value - local.min) / range) * 100
  }

  return (
    <input
      type="range"
      aria-label={local.ariaLabel}
      min={local.min}
      max={local.max}
      step={local.step}
      value={local.value}
      disabled={local.disabled}
      class={cn('civup-slider min-w-0 flex-1', local.disabled && 'opacity-45 pointer-events-none', local.class)}
      style={{ '--civup-slider-progress': `${progress()}%` }}
      onInput={event => local.onInput?.(event.currentTarget.valueAsNumber)}
      {...rest}
    />
  )
}
