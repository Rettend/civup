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
        <label class="text-[11px] text-text-muted tracking-wider font-semibold pl-0.5 uppercase">
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
        class={cn(
          'text-sm text-text-primary px-3.5 py-2.5 rounded-lg',
          'bg-bg-primary/60 border border-white/8',
          'outline-none transition-all duration-150',
          'placeholder:text-text-muted/60',
          'focus:border-accent-gold/50 focus:bg-bg-primary/80 focus:shadow-[0_0_0_3px_rgba(200,170,110,0.08)]',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          props.class,
        )}
      />
    </div>
  )
}
