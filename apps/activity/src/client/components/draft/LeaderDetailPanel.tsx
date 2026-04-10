import type { Leader, LeaderUnique } from '@civup/game'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import { detailLeaderId, draftStore, isLeaderFavorited, setDetailLeaderId, toggleLeaderFavorite } from '~/client/stores'
import { RichLeaderText } from './RichLeaderText'

/** Click-to-open detail panel beside the grid */
export function LeaderDetailPanel() {
  const leader = (): Leader | null => {
    const id = detailLeaderId()
    if (!id) return null
    try { return getLeader(id, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const allUniques = (): { label: string, items: LeaderUnique[] }[] => {
    const l = leader()
    if (!l) return []
    const sections: { label: string, items: LeaderUnique[] }[] = []
    if (l.uniqueUnits.length > 0) sections.push({ label: 'Unique Units', items: l.uniqueUnits })
    if (l.uniqueBuildings.length > 0) sections.push({ label: 'Unique Buildings / Districts', items: l.uniqueBuildings })
    if (l.uniqueImprovements.length > 0) sections.push({ label: l.uniqueImprovements.length > 1 ? 'Unique Improvements' : 'Unique Improvement', items: l.uniqueImprovements })
    return sections
  }

  const isRedDeathEntry = () => leader()?.id.startsWith('rd-') ?? false
  const isFavorited = () => {
    const id = detailLeaderId()
    return id ? isLeaderFavorited(id) : false
  }

  return (
    <Show when={leader()}>
      {l => (
        <div class="p-4 h-full w-full select-text relative overflow-x-hidden overflow-y-auto sm:overflow-x-visible">
          <div class="top-2 right-4 absolute z-10 flex flex-col items-end gap-1">
            <button
              class="text-fg-subtle rounded-full h-8 w-8 flex items-center justify-center cursor-pointer hover:bg-bg-muted hover:text-fg-muted"
              onClick={() => setDetailLeaderId(null)}
            >
              <div class="i-ph-x-bold text-base" />
            </button>

            <button
              class={cn(
                'rounded-full h-8 w-8 flex items-center justify-center border transition-colors cursor-pointer',
                isFavorited()
                  ? 'border-accent/50 bg-accent/12 text-accent hover:bg-accent/18'
                  : 'border-border bg-bg/75 text-fg-subtle hover:border-border-hover hover:text-fg-muted',
              )}
              title={isFavorited() ? 'Remove favorite' : 'Favorite leader'}
              aria-label={isFavorited() ? 'Remove favorite' : 'Favorite leader'}
              onClick={() => toggleLeaderFavorite(l().id)}
            >
              <div class={cn(isFavorited() ? 'i-ph-star-fill' : 'i-ph-star-bold', 'text-sm')} />
            </button>
          </div>

          {/* Header: portrait + name */}
          <div class="mb-3 flex gap-3 items-center pr-12">
            <Show when={l().portraitUrl}>
              {url => (
                <img src={resolveAssetUrl(url()) ?? url()} alt={l().name} class="rounded shrink-0 h-12 w-12 object-cover" />
              )}
            </Show>
            <div class="min-w-0">
              <h3 class="text-base text-fg font-bold truncate">{l().name}</h3>
              <span class="text-sm text-fg-muted">{l().civilization}</span>
            </div>
          </div>

          <Show when={l().civilizationAbility}>
            {ability => (
              <div class="mb-3">
                <div class="text-[10px] text-accent tracking-widest font-bold mb-1 uppercase">{isRedDeathEntry() ? 'Additional Ability' : 'Civilization Ability'}</div>
                <p class="text-sm text-fg font-medium">{ability().name}</p>
                <RichLeaderText text={ability().description} class="text-xs text-fg-muted leading-relaxed mt-0.5 block" />
              </div>
            )}
          </Show>

          {/* Ability */}
          <div class="mb-3">
            <div class="text-[10px] text-accent tracking-widest font-bold mb-1 uppercase">{l().civilizationAbility && !isRedDeathEntry() ? 'Leader Ability' : 'Ability'}</div>
            <p class="text-sm text-fg font-medium">{l().ability.name}</p>
            <RichLeaderText text={l().ability.description} class="text-xs text-fg-muted leading-relaxed mt-0.5 block" />
          </div>

          {/* Uniques */}
          <For each={allUniques()}>
            {section => (
              <div class="mb-3">
                <div class="text-[10px] text-accent tracking-widest font-bold mb-1.5 uppercase">{section.label}</div>
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
  const replacesText = () => props.item.replaces?.replace(/\s+district$/i, '')

  return (
    <div class="mb-2">
      {/* Name row: icon + name + replaces */}
      <div class="flex gap-2 items-center">
        <Show when={props.item.iconUrl}>
          {icon => (
            <img
              src={resolveAssetUrl(icon()) ?? icon()}
              alt={props.item.name}
              class="shrink-0 h-8 w-8 object-contain"
              onError={(event) => { event.currentTarget.style.display = 'none' }}
            />
          )}
        </Show>
        <div class={cn('flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5', !props.item.iconUrl && 'ml-0')}>
          <span class="text-sm text-fg font-medium min-w-0 whitespace-normal break-words">{props.item.name}</span>
          <Show when={replacesText()}>
            <span class="text-xs text-fg-subtle min-w-0 whitespace-normal break-words">
              (
              {replacesText()}
              )
            </span>
          </Show>
        </div>
      </div>

      {/* Description */}
      <RichLeaderText text={props.item.description} class="text-xs text-fg-muted leading-relaxed mt-0.5 block" />
    </div>
  )
}
