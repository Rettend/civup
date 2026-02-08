import type { JSX } from 'solid-js'
import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

const variants = {
  default: 'bg-bg-hover text-text-secondary',
  gold: 'bg-accent-gold/20 text-accent-gold',
  red: 'bg-accent-red/20 text-accent-red',
  blue: 'bg-accent-blue/20 text-accent-blue',
} as const

export type BadgeVariant = keyof typeof variants

interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ['variant', 'class', 'children'])

  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variants[local.variant ?? 'default'],
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </span>
  )
}
