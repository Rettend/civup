import { For } from 'solid-js'
import { cn } from '~/client/lib/css'

interface RichLeaderTextProps {
  text: string
  class?: string
}

export function RichLeaderText(props: RichLeaderTextProps) {
  const parts = () => props.text.split(/(:[a-z0-9_]+:)/g).filter(part => part.length > 0)

  return (
    <span class={cn('inline', props.class)}>
      <For each={parts()}>
        {(part) => {
          const token = part.match(/^:([a-z0-9_]+):$/)?.[1]
          if (!token) return part

          return (
            <img
              src={`/assets/bbg/icons/ICON_${token.toUpperCase()}.webp`}
              alt={token.replace(/_/g, ' ')}
              class="mx-0.5 align-[-0.125em] h-[0.95em] w-[0.95em] inline-block object-contain"
            />
          )
        }}
      </For>
    </span>
  )
}
