import type { Leader, LeaderUnique } from '@civup/game'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { detailLeaderId, setDetailLeaderId } from '~/client/stores'
import { RichLeaderText } from './RichLeaderText'

/** Click-to-open detail panel beside the grid — improved unique item layout */
export function LeaderDetailPanel() {
  const leader = (): Leader | null => {
    const id = detailLeaderId()
    if (!id) return null
    try { return getLeader(id) }
    catch { return null }
  }

  const allUniques = (): { label: string, items: LeaderUnique[] }[] => {
    const l = leader()
    if (!l) return []
    const sections: { label: string, items: LeaderUnique[] }[] = []
    if (l.uniqueUnits.length > 0) sections.push({ label: 'Unique Units', items: l.uniqueUnits })
    if (l.uniqueBuilding) sections.push({ label: 'Unique Building', items: [l.uniqueBuilding] })
    if (l.uniqueImprovement) sections.push({ label: 'Unique Improvement', items: [l.uniqueImprovement] })
    return sections
  }

  return (
    <Show when={leader()}>
      {l => (
        <div class="relative w-80 shrink-0 overflow-y-auto border-l border-white/5 bg-bg-primary/80 p-4 anim-detail-in">
          {/* Close button */}
          <button
            class="absolute right-2 top-2 cursor-pointer text-text-muted hover:text-text-secondary"
            onClick={() => setDetailLeaderId(null)}
          >
            <div class="i-ph-x-bold text-base" />
          </button>

          {/* Header: portrait + name */}
          <div class="mb-3 flex items-center gap-3">
            <Show when={l().portraitUrl}>
              {url => (
                <img src={url()} alt={l().name} class="h-12 w-12 shrink-0 rounded object-cover" />
              )}
            </Show>
            <div class="min-w-0">
              <h3 class="truncate text-base text-text-primary font-bold">{l().name}</h3>
              <span class="text-sm text-text-secondary">{l().civilization}</span>
            </div>
          </div>

          {/* Tags */}
          <Show when={l().tags.length > 0}>
            <div class="mb-3 flex flex-wrap gap-1">
              <For each={l().tags}>
                {tag => (
                  <span class="rounded bg-accent-gold/10 px-1.5 py-0.5 text-[10px] text-accent-gold font-medium capitalize">
                    {tag}
                  </span>
                )}
              </For>
            </div>
          </Show>

          {/* Ability */}
          <div class="mb-3">
            <div class="mb-1 text-[10px] text-accent-gold font-bold tracking-widest uppercase">Ability</div>
            <p class="text-sm text-text-primary font-medium">{l().ability.name}</p>
            <RichLeaderText text={l().ability.description} class="mt-0.5 block text-xs text-text-secondary leading-relaxed" />
          </div>

          {/* Uniques */}
          <For each={allUniques()}>
            {section => (
              <div class="mb-3">
                <div class="mb-1.5 text-[10px] text-accent-gold font-bold tracking-widest uppercase">{section.label}</div>
                <For each={section.items}>
                  {item => <UniqueRow item={item} />}
                </For>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

/** Single unique item row: 32x32 icon, name (replaces X) on one line, description below */
function UniqueRow(props: { item: LeaderUnique }) {
  return (
    <div class="mb-2">
      {/* Name row: icon + name + replaces */}
      <div class="flex items-center gap-2">
        <Show when={props.item.iconUrl}>
          {icon => (
            <img
              src={icon()}
              alt={props.item.name}
              class="h-8 w-8 shrink-0"
              onError={(event) => { event.currentTarget.style.display = 'none' }}
            />
          )}
        </Show>
        <div class={cn('flex items-baseline gap-1.5 min-w-0', !props.item.iconUrl && 'ml-0')}>
          <span class="shrink-0 text-sm text-text-primary font-medium whitespace-nowrap">{props.item.name}</span>
          <Show when={props.item.replaces}>
            <span class="shrink-0 text-xs text-text-muted whitespace-nowrap">({props.item.replaces})</span>
          </Show>
        </div>
      </div>

      {/* Description */}
      <RichLeaderText text={props.item.description} class="mt-0.5 block text-xs text-text-secondary leading-relaxed" />
    </div>
  )
}
