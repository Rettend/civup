import type { JSX } from 'solid-js'
import { cn } from '~/client/lib/css'

interface TextInputProps {
  type?: 'text' | 'number'
  label?: string
  value?: string | number
  placeholder?: string
  min?: string
  max?: string
  step?: string
  disabled?: boolean
  onInput?: JSX.EventHandlerUnion<HTMLInputElement, InputEvent>
  onFocus?: JSX.EventHandlerUnion<HTMLInputElement, FocusEvent>
  onBlur?: JSX.EventHandlerUnion<HTMLInputElement, FocusEvent>
  onClamp?: (detail: { previousValue: string, nextValue: string }) => void
  roundOnBlur?: boolean
  class?: string
}

export function TextInput(props: TextInputProps) {
  const normalizeNumberValue = (value: string): { nextValue: string, adjusted: boolean } => {
    if (props.type !== 'number') return { nextValue: value, adjusted: false }

    const trimmed = value.trim()
    if (!trimmed) return { nextValue: '', adjusted: false }

    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return { nextValue: value, adjusted: false }

    let bounded = numeric

    if (props.min != null) {
      const minimum = Number(props.min)
      if (Number.isFinite(minimum)) bounded = Math.max(minimum, bounded)
    }

    if (props.max != null) {
      const maximum = Number(props.max)
      if (Number.isFinite(maximum)) bounded = Math.min(maximum, bounded)
    }

    const step = props.step == null ? Number.NaN : Number(props.step)
    const shouldRoundToInteger = (props.roundOnBlur ?? true) && (!Number.isFinite(step) || Number.isInteger(step))
    if (shouldRoundToInteger) bounded = Math.round(bounded)

    return {
      nextValue: String(bounded),
      adjusted: bounded !== numeric || (shouldRoundToInteger && !Number.isInteger(numeric)),
    }
  }

  return (
    <div class="flex flex-col gap-1.5">
      {props.label && (
        <label class="text-[11px] text-fg-subtle tracking-wider font-semibold pl-0.5 uppercase">
          {props.label}
        </label>
      )}
      <input
        type={props.type ?? 'text'}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onInput={(e) => { if (typeof props.onInput === 'function') props.onInput(e) }}
        onFocus={(e) => { if (typeof props.onFocus === 'function') props.onFocus(e) }}
        onBlur={(e) => {
          const previousValue = e.currentTarget.value
          const { nextValue, adjusted } = normalizeNumberValue(previousValue)
          if (nextValue !== previousValue) {
            e.currentTarget.value = nextValue
            e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }))
          }
          if (adjusted) props.onClamp?.({ previousValue, nextValue })
          if (typeof props.onBlur === 'function') props.onBlur(e)
        }}
        style={props.type === 'number'
          ? {
              'appearance': 'textfield',
              '-moz-appearance': 'textfield',
            }
          : undefined}
        class={cn(
          'text-sm text-fg px-3.5 py-2.5 rounded-lg',
          'bg-bg/60 border border-border-subtle',
          'outline-none transition-all duration-150',
          'placeholder:text-fg-subtle/60',
          'focus:border-accent/50 focus:bg-bg/80 focus:shadow-[0_0_0_3px_var(--accent-subtle)]',
          'disabled:opacity-50',
          props.type === 'number' && '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          props.class,
        )}
      />
    </div>
  )
}
