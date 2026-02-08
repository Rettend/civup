import type { JSX } from 'solid-js'
import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

const variants = {
  gold: 'bg-accent-gold text-bg-primary hover:bg-accent-gold/90 font-semibold',
  red: 'bg-accent-red text-white hover:bg-accent-red/90 font-semibold',
  ghost: 'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  outline: 'border border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary',
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
  const [local, rest] = splitProps(props, ['variant', 'size', 'class', 'children'])

  return (
    <button
      class={cn(
        'inline-flex items-center justify-center rounded-md transition-all duration-200 cursor-pointer',
        'disabled:opacity-50 disabled:pointer-events-none',
        'active:scale-95',
        variants[local.variant ?? 'gold'],
        sizes[local.size ?? 'md'],
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </button>
  )
}
