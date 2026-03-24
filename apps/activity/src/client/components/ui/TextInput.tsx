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
  class?: string
}

export function TextInput(props: TextInputProps) {
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
        onBlur={(e) => { if (typeof props.onBlur === 'function') props.onBlur(e) }}
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
