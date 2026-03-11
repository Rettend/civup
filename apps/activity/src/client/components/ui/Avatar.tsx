import type { JSX } from 'solid-js'
import { omit } from 'solid-js'
import { cn } from '~/client/lib/css'

interface AvatarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  src?: string | null
  alt?: string
  size?: 'sm' | 'md' | 'lg'
  ring?: 'gold' | 'red' | 'blue' | 'none'
}

const sizes = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-base',
} as const

const rings = {
  gold: 'ring-2 ring-accent',
  red: 'ring-2 ring-danger',
  blue: 'ring-2 ring-info',
  none: '',
} as const

export function Avatar(props: AvatarProps) {
  const rest = omit(props, 'src', 'alt', 'size', 'ring', 'class')

  const initials = () => {
    if (!props.alt) return '?'
    return props.alt.slice(0, 2).toUpperCase()
  }

  return (
    <div
      class={cn(
        'relative rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-bg-subtle',
        sizes[props.size ?? 'md'],
        rings[props.ring ?? 'none'],
        props.class,
      )}
      {...rest}
    >
      {props.src
        ? (
            <img
              src={props.src}
              alt={props.alt ?? ''}
              class="h-full w-full object-cover"
            />
          )
        : (
            <span class="text-fg-subtle font-semibold">{initials()}</span>
          )}
    </div>
  )
}
