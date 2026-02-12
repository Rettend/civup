import type { JSX } from 'solid-js'
import { splitProps } from 'solid-js'
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
  gold: 'ring-2 ring-accent-gold',
  red: 'ring-2 ring-accent-red',
  blue: 'ring-2 ring-accent-blue',
  none: '',
} as const

export function Avatar(props: AvatarProps) {
  const [local, rest] = splitProps(props, ['src', 'alt', 'size', 'ring', 'class'])

  const initials = () => {
    if (!local.alt) return '?'
    return local.alt.slice(0, 2).toUpperCase()
  }

  return (
    <div
      class={cn(
        'relative rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-bg-secondary',
        sizes[local.size ?? 'md'],
        rings[local.ring ?? 'none'],
        local.class,
      )}
      {...rest}
    >
      {local.src
        ? (
            <img
              src={local.src}
              alt={local.alt ?? ''}
              class="h-full w-full object-cover"
            />
          )
        : (
            <span class="text-text-muted font-semibold">{initials()}</span>
          )}
    </div>
  )
}
