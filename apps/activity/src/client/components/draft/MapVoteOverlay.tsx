import type { MapVoteMapOption } from '@civup/game'
import type { JSXElement } from 'solid-js'
import { MAP_VOTE_MAPS } from '@civup/game'
import { For, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import {
  confirmMapVote,
  draftStore,
  gridExpanded,
  gridOpen,
  isMobileLayout,
  mapVoteHasConfirmed,
  mapVotePhase,
  mapVoteReadyToConfirm,
  mapVoteSelectedMaps,
  setGridExpanded,
  setGridOpen,
  toggleMapVoteSelectedMap,
} from '~/client/stores'

const MAPS_WITH_RANDOM_FIRST = [...MAP_VOTE_MAPS].sort((left, right) => Number(right.id === 'random') - Number(left.id === 'random'))

export function MapVoteOverlay() {
  return (
    <Show when={mapVotePhase() === 'voting'}>
      <Show when={gridOpen()}>
        <div class="bg-black/40 inset-0 absolute z-10" onClick={() => setGridOpen(false)} />
        <div
          class={cn(
            'flex pointer-events-none inset-x-0 bottom-14 justify-center absolute z-20',
            gridExpanded() ? 'items-stretch top-3' : 'items-end top-6',
          )}
        >
          <div class={cn(
            'pointer-events-auto relative z-30',
            isMobileLayout()
              ? 'w-[min(calc(100vw-1rem),32rem)]'
              : 'w-[min(calc(100vw-1.5rem),52rem)] xl:w-fit xl:max-w-[calc(100vw-1.5rem)]',
            gridExpanded() && 'h-full',
          )}
          >
            <VotePanel />
          </div>
        </div>
      </Show>
    </Show>
  )
}

function MapVotePanelFrame(props: { children: JSXElement, footer?: JSXElement, footerClass?: string, bodyClass?: string }) {
  const expandLabel = () => gridExpanded() ? 'Restore map vote size' : 'Expand map vote'

  return (
    <div
      class={cn(
        'anim-overlay-in relative z-10 flex w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle shadow-2xl grid-panel-glow',
        gridExpanded() ? 'h-full' : 'max-h-[50vh] sm:max-h-[56vh] lg:max-h-[62vh] xl:max-h-[68vh]',
      )}
    >
      <div class="px-3 pb-3 pt-2 border-b border-border-subtle flex shrink-0 items-center justify-between">
        <button
          class="text-fg-subtle shrink-0 cursor-pointer hover:text-fg-muted"
          title={expandLabel()}
          aria-label={expandLabel()}
          onClick={() => setGridExpanded(prev => !prev)}
        >
          <Show when={gridExpanded()} fallback={<div class="i-ph-caret-line-up-bold text-sm" />}>
            <div class="i-ph-caret-line-down-bold text-sm" />
          </Show>
        </button>

        <button
          class="text-fg-subtle shrink-0 cursor-pointer hover:text-fg-muted"
          title="Close map vote"
          aria-label="Close map vote"
          onClick={() => setGridOpen(false)}
        >
          <div class="i-ph-x-bold text-sm" />
        </button>
      </div>

      <div class={cn('px-4 pb-4 pt-3 min-h-0 flex-1', props.bodyClass)}>
        {props.children}
      </div>

      <Show when={props.footer != null}>
        <div class={cn('px-4 py-3 border-t border-border-subtle flex items-center justify-center shrink-0', props.footerClass)}>
          {props.footer}
        </div>
      </Show>
    </div>
  )
}

function VotePanel() {
  const canVote = () => draftStore.seatIndex != null
  const isRevealing = () => mapVotePhase() === 'reveal'

  return (
    <MapVotePanelFrame
      bodyClass="overflow-y-auto overflow-x-hidden"
      footerClass={isRevealing() ? 'h-0 overflow-hidden border-t-0 py-0' : ''}
      footer={(
        <button
          type="button"
          class={cn(
            'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
            isRevealing() && 'pointer-events-none opacity-0',
            mapVoteReadyToConfirm() && canVote()
              ? 'bg-accent text-black cursor-pointer hover:bg-accent/80'
              : 'bg-accent/20 text-accent/50 cursor-default',
          )}
          disabled={isRevealing() || !mapVoteReadyToConfirm() || !canVote()}
          onClick={() => {
            if (confirmMapVote()) setGridOpen(false)
          }}
        >
          <Show when={!mapVoteHasConfirmed()} fallback="Vote Submitted">Confirm Vote</Show>
        </button>
      )}
    >
      <MapColumn disabled={!canVote() || mapVoteHasConfirmed()} />
    </MapVotePanelFrame>
  )
}

function MapOptionSection(props: { title: string, gridClass: string, children: JSXElement }) {
  return (
    <div class="flex flex-col gap-2">
      <div class="text-sm text-white leading-none font-semibold px-1">{props.title}</div>
      <div class={cn('pr-1', props.gridClass)}>{props.children}</div>
    </div>
  )
}

function MapColumn(props: { disabled: boolean }) {
  return (
    <MapOptionSection
      title="Map"
      gridClass="flex flex-wrap content-start justify-start gap-2"
    >
      <For each={MAPS_WITH_RANDOM_FIRST}>
        {option => (
          <MapVoteOptionCard
            option={option}
            rank={mapVoteSelectedMaps().indexOf(option.id) + 1}
            selected={mapVoteSelectedMaps().includes(option.id)}
            disabled={props.disabled}
            onSelect={() => toggleMapVoteSelectedMap(option.id)}
          />
        )}
      </For>
    </MapOptionSection>
  )
}

function MapVoteOptionCard(props: {
  option: MapVoteMapOption
  rank: number
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      class={cn(
        'group relative flex w-20 max-w-20 shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-bg/50 text-left transition-all',
        'hover:border-accent/60 hover:bg-bg/70',
        'disabled:cursor-default disabled:opacity-80 disabled:hover:border-border disabled:hover:bg-bg/50',
        props.selected && 'border-accent/80 bg-accent/10 shadow-[0_0_0_2px_var(--accent-subtle)] hover:border-accent hover:bg-accent/18',
      )}
      onClick={() => props.onSelect()}
    >
      <div class="bg-bg-muted/45 flex w-full aspect-square items-center justify-center relative overflow-hidden">
        <MapVoteSelectionRankBadge rank={props.rank} />
        <Show when={props.option.imageUrl} fallback={<MapVoteOptionIcon option={props.option} selected={props.selected} />}>
          {url => (
            <img
              src={resolveAssetUrl(url()) ?? url()}
              alt={props.option.name}
              class="h-full w-full inset-0 absolute object-cover"
            />
          )}
        </Show>

        <Show when={props.option.badgeLeft}>
          {value => (
            <span
              class={cn(
                'px-1.5 py-0.5 rounded-tr-lg bottom-0 left-0 absolute z-10 font-medium leading-none whitespace-nowrap bg-black/65',
                props.selected ? 'text-accent' : 'text-fg-muted/90',
              )}
              style={{ 'font-size': '10px' }}
            >
              {value()}
            </span>
          )}
        </Show>
        <Show when={props.option.badgeRight}>
          {value => (
            <span
              class={cn(
                'px-1.5 py-0.5 rounded-bl-lg right-0 top-0 absolute z-10 font-medium leading-none whitespace-nowrap bg-black/65',
                props.selected ? 'text-accent' : 'text-fg-muted/90',
              )}
              style={{ 'font-size': '10px' }}
            >
              {value()}
            </span>
          )}
        </Show>
      </div>

      <div class="px-2 py-1 border-t border-border-subtle flex h-8 items-center justify-center">
        <div class={cn('text-xs text-center font-semibold leading-tight', props.selected ? 'text-accent' : 'text-fg-muted')}>
          {props.option.name}
        </div>
      </div>
    </button>
  )
}

function MapVoteSelectionRankBadge(props: { rank: number }) {
  const iconClass = () => {
    switch (props.rank) {
      case 1:
        return 'i-ph-number-one-bold'
      case 2:
        return 'i-ph-number-two-bold'
      case 3:
        return 'i-ph-number-three-bold'
      default:
        return null
    }
  }

  return (
    <Show when={iconClass()} keyed>
      {icon => (
        <span class="px-1.5 py-0.5 rounded-br-lg bg-black/65 left-0 top-0 absolute z-10">
          <span class={cn(icon, 'block h-3.5 w-3.5 text-accent')} />
        </span>
      )}
    </Show>
  )
}

function MapVoteOptionIcon(props: { option: MapVoteMapOption, selected: boolean }) {
  const isRandom = () => props.option.id === 'random'

  return (
    <span
      class={cn(
        isRandom() ? 'i-ph-dice-five-bold h-8 w-8' : 'i-ph-map-trifold-bold h-9 w-9',
        props.selected ? 'text-accent' : 'text-fg-muted/80 group-hover:text-fg-muted',
      )}
    />
  )
}
