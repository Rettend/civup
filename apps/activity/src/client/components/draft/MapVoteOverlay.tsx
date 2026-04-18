import type { JSXElement } from 'solid-js'
import type { MapScriptOption, MapTypeOption } from '~/client/lib/map-vote'
import { For, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import {
  MAP_SCRIPTS,
  MAP_TYPES,
} from '~/client/lib/map-vote'
import {
  confirmMapVote,
  draftStore,
  gridExpanded,
  gridOpen,
  isMobileLayout,
  mapVoteHasConfirmed,
  mapVotePhase,
  mapVoteReadyToConfirm,
  mapVoteSelectedScript,
  mapVoteSelectedType,
  setGridExpanded,
  setGridOpen,
  setMapVoteSelectedScript,
  setMapVoteSelectedType,
} from '~/client/stores'

const MAP_TYPES_WITH_RANDOM_FIRST = [...MAP_TYPES].sort((left, right) => Number(right.id === 'random') - Number(left.id === 'random'))
const MAP_SCRIPTS_WITH_RANDOM_FIRST = [...MAP_SCRIPTS].sort((left, right) => Number(right.id === 'random') - Number(left.id === 'random'))

export function MapVoteOverlay() {
  return (
    <Show when={mapVotePhase() === 'voting' || mapVotePhase() === 'reveal'}>
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
      <div class="px-3 pb-3 pt-2 border-b border-border-subtle flex items-center justify-between shrink-0">
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
      bodyClass={cn(
        'gap-4 grid overflow-y-auto overflow-x-hidden',
        isMobileLayout()
          ? 'grid-cols-1'
          : 'grid-cols-[10.5rem_minmax(0,1fr)] xl:grid-cols-[max-content_max-content] xl:justify-center',
      )}
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
          onClick={() => confirmMapVote()}
        >
          <Show when={!mapVoteHasConfirmed()} fallback="Vote Submitted">
            Confirm Vote
          </Show>
        </button>
      )}
    >
      <MapTypeColumn disabled={!canVote() || mapVoteHasConfirmed()} />
      <MapScriptColumn disabled={!canVote() || mapVoteHasConfirmed()} />
    </MapVotePanelFrame>
  )
}

function MapOptionSection(props: { title: string, gridClass: string, children: JSXElement }) {
  return (
    <div class="flex flex-col gap-2">
      <div class="px-1 text-sm text-white font-semibold leading-none">{props.title}</div>
      <div class={cn('pr-1', props.gridClass)}>{props.children}</div>
    </div>
  )
}

function MapTypeColumn(props: { disabled: boolean }) {
  return (
    <MapOptionSection
      title="Teamers Start Position"
      gridClass="flex flex-wrap content-start justify-start gap-2"
    >
      <For each={MAP_TYPES_WITH_RANDOM_FIRST}>
        {option => (
          <MapTypeOptionButton
            option={option}
            selected={mapVoteSelectedType() === option.id}
            disabled={props.disabled}
            onSelect={() => setMapVoteSelectedType(option.id)}
          />
        )}
      </For>
    </MapOptionSection>
  )
}

function MapScriptColumn(props: { disabled: boolean }) {
  return (
    <MapOptionSection
      title="Map"
      gridClass="flex flex-wrap content-start justify-start gap-2"
    >
      <For each={MAP_SCRIPTS_WITH_RANDOM_FIRST}>
        {option => (
          <MapVoteOptionCard
            option={option}
            selected={mapVoteSelectedScript() === option.id}
            disabled={props.disabled}
            onSelect={() => setMapVoteSelectedScript(option.id)}
          />
        )}
      </For>
    </MapOptionSection>
  )
}

function MapTypeOptionButton(props: {
  option: MapTypeOption
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      class={cn(
        'flex h-10 min-w-[8.5rem] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-bg/50 px-3 text-center transition-all',
        'hover:border-accent/60 hover:bg-bg/70',
        'disabled:cursor-default disabled:opacity-80 disabled:hover:border-border disabled:hover:bg-bg/50',
        props.selected && 'border-accent/80 bg-accent/10 hover:border-accent hover:bg-accent/18',
      )}
      onClick={() => props.onSelect()}
    >
      <span class={cn('text-xs font-semibold leading-tight', props.selected ? 'text-accent' : 'text-fg-muted')}>
        {props.option.name}
      </span>
    </button>
  )
}

function MapVoteOptionCard(props: {
  option: MapTypeOption | MapScriptOption
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const hint = () => 'hint' in props.option ? props.option.hint : undefined

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
      <div class="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-bg-muted/45">
        <Show
          when={'imageUrl' in props.option ? props.option.imageUrl : undefined}
          fallback={<MapVoteOptionIcon option={props.option} selected={props.selected} />}
        >
          {url => (
            <img
              src={resolveAssetUrl(url()) ?? url()}
              alt={props.option.name}
              class="inset-0 h-full w-full object-cover absolute"
            />
          )}
        </Show>

        <Show when={hint()}>
          {value => (
            <span class={cn(
              'px-1.5 py-0.5 rounded-tr-lg bottom-0 left-0 absolute z-10 font-medium leading-none whitespace-nowrap bg-black/45',
              props.selected ? 'text-accent' : 'text-fg-muted/90',
            )}
              style={{ 'font-size': '10px' }}
            >
              {value()}
            </span>
          )}
        </Show>

        <Show when={props.selected}>
          <div class="px-1.5 py-1 rounded-bl-lg top-0 right-0 absolute z-10 shadow-[0_2px_8px_rgba(0,0,0,0.35)] flex items-center justify-center bg-black/45">
            <span class="i-ph-check-bold text-sm text-accent" />
          </div>
        </Show>
      </div>

      <div class="px-2 py-1 border-t border-border-subtle h-8 flex items-center justify-center">
        <div class={cn('text-xs text-center font-semibold leading-tight', props.selected ? 'text-accent' : 'text-fg-muted')}>
          {props.option.name}
        </div>
      </div>
    </button>
  )
}

function MapVoteOptionIcon(props: { option: MapTypeOption | MapScriptOption, selected: boolean }) {
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
