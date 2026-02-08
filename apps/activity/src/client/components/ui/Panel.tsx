import type { JSX } from 'solid-js'
import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/cn'

interface PanelProps extends JSX.HTMLAttributes<HTMLDivElement> {
  /** Enable hover highlight effect */
  hoverable?: boolean
}

export function Panel(props: PanelProps) {
  const [local, rest] = splitProps(props, ['hoverable', 'class', 'children'])

  return (
    <div
      class={cn(
        local.hoverable ? 'panel-hover' : 'panel',
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  )
}
