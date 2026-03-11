import type { JSX } from 'solid-js'
import { omit } from 'solid-js'
import { cn } from '~/client/lib/css'

const variants = {
  default: 'bg-bg-muted text-fg-muted',
  gold: 'bg-accent/20 text-accent',
  red: 'bg-danger/20 text-danger',
  blue: 'bg-info/20 text-info',
} as const

export type BadgeVariant = keyof typeof variants

interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge(props: BadgeProps) {
  const rest = omit(props, 'variant', 'class', 'children')

  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variants[props.variant ?? 'default'],
        props.class,
      )}
      {...rest}
    >
      {props.children}
    </span>
  )
}
