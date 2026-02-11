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
        <div class="anim-detail-in select-text p-4 border-l border-white/5 bg-bg-primary/80 shrink-0 w-80 relative overflow-y-auto">
          {/* Close button */}
          <button
            class="text-text-muted cursor-pointer right-2 top-2 absolute hover:text-text-secondary"
            onClick={() => setDetailLeaderId(null)}
          >
            <div class="i-ph-x-bold text-base" />
          </button>

          {/* Header: portrait + name */}
          <div class="mb-3 flex gap-3 items-center">
            <Show when={l().portraitUrl}>
              {url => (
                <img src={url()} alt={l().name} class="rounded shrink-0 h-12 w-12 object-cover" />
              )}
            </Show>
            <div class="min-w-0">
              <h3 class="text-base text-text-primary font-bold truncate">{l().name}</h3>
              <span class="text-sm text-text-secondary">{l().civilization}</span>
            </div>
          </div>

          {/* Ability */}
          <div class="mb-3">
            <div class="text-[10px] text-accent-gold tracking-widest font-bold mb-1 uppercase">Ability</div>
            <p class="text-sm text-text-primary font-medium">{l().ability.name}</p>
            <RichLeaderText text={l().ability.description} class="text-xs text-text-secondary leading-relaxed mt-0.5 block" />
          </div>

          {/* Uniques */}
          <For each={allUniques()}>
            {section => (
              <div class="mb-3">
                <div class="text-[10px] text-accent-gold tracking-widest font-bold mb-1.5 uppercase">{section.label}</div>
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
      <div class="flex gap-2 items-center">
        <Show when={props.item.iconUrl}>
          {icon => (
            <img
              src={icon()}
              alt={props.item.name}
              class="shrink-0 h-8 w-8 object-contain"
              onError={(event) => { event.currentTarget.style.display = 'none' }}
            />
          )}
        </Show>
        <div class={cn('flex items-baseline gap-1.5 min-w-0', !props.item.iconUrl && 'ml-0')}>
          <span class="text-sm text-text-primary font-medium shrink-0 whitespace-nowrap">{props.item.name}</span>
          <Show when={props.item.replaces}>
            <span class="text-xs text-text-muted shrink-0 whitespace-nowrap">
              (
              {props.item.replaces}
              )
            </span>
          </Show>
        </div>
      </div>

      {/* Description */}
      <RichLeaderText text={props.item.description} class="text-xs text-text-secondary leading-relaxed mt-0.5 block" />
    </div>
  )
}
