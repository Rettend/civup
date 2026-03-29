import { For } from 'solid-js'
import { cn } from '~/client/lib/css'

const ICON_TOKEN_FILENAME_OVERRIDES: Record<string, string> = {
  glorygoldenage: 'ICON_GLORY_GOLDEN_AGE.webp',
  glorynormalage: 'ICON_GLORY_NORMAL_AGE.webp',
  glorysupergoldenage: 'ICON_GLORY_SUPER_GOLDEN_AGE.webp',
  greatworkartifact: 'ICON_GREATWORK_ARTIFACT.webp',
  greatworklandscape: 'ICON_GREATWORK_LANDSCAPE.webp',
  greatworkmusic: 'ICON_GREATWORK_MUSIC.webp',
  greatworkrelic: 'ICON_GREATWORK_RELIC.webp',
  greatworksculpture: 'ICON_GREATWORK_SCULPTURE.webp',
  greatworkwriting: 'ICON_GREATWORK_WRITING.webp',
  resourcecoal: 'ICON_RESOURCE_COAL.webp',
  resourceiron: 'ICON_RESOURCE_IRON.webp',
  resourcewhales: 'ICON_RESOURCE_WHALES.webp',
  statgrievance: 'ICON_STAT_GRIEVANCE.webp',
}

function resolveLeaderIconUrl(token: string): string {
  const fileName = ICON_TOKEN_FILENAME_OVERRIDES[token] ?? `ICON_${token.toUpperCase()}.webp`
  return `/assets/bbg/icons/${fileName}`
}

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

          const isResource = token.startsWith('resource')

          return (
            <img
              src={resolveLeaderIconUrl(token)}
              alt={token.replace(/_/g, ' ')}
              class={cn(
                'mx-0.5 inline-block object-contain',
                isResource ? 'h-[1.2em] w-[1.2em] align-[-0.25em]' : 'h-[0.95em] w-[0.95em] align-[-0.125em]'
              )}
            />
          )
        }}
      </For>
    </span>
  )
}
