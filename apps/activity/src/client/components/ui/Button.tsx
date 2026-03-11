import type { JSX } from 'solid-js'
import { omit } from 'solid-js'
import { cn } from '~/client/lib/css'

const variants = {
  gold: 'bg-accent text-bg hover:brightness-110 font-semibold',
  red: 'bg-danger text-white hover:brightness-110 font-semibold',
  ghost: 'bg-transparent text-fg-muted border border-border hover:bg-bg-muted hover:text-fg',
  redOutline: 'border border-danger/50 bg-danger/10 text-danger/90 hover:bg-danger/15 hover:border-danger/80 hover:text-danger font-medium',
  outline: 'border border-border text-fg-muted hover:bg-bg-muted hover:text-fg hover:border-border-hover',
} as const

const sizes = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
} as const

export type ButtonVariant = keyof typeof variants
export type ButtonSize = keyof typeof sizes

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button(props: ButtonProps) {
  const rest = omit(props, 'variant', 'size', 'class', 'children')

  return (
    <button
      class={cn(
        'inline-flex items-center justify-center rounded-md transition-all duration-200 cursor-pointer',
        'disabled:opacity-50 disabled:pointer-events-none',
        'active:scale-95',
        variants[props.variant ?? 'gold'],
        sizes[props.size ?? 'md'],
        props.class,
      )}
      {...rest}
    >
      {props.children}
    </button>
  )
}
