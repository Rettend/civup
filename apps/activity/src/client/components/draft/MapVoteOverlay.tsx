import type { MapScriptOption, MapTypeOption } from '~/client/lib/map-vote'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  MAP_SCRIPT_BY_ID,
  MAP_SCRIPTS,
  MAP_TYPE_BY_ID,
  MAP_TYPES,
} from '~/client/lib/map-vote'
import {
  confirmMapVote,
  draftStore,
  finishMapVote,
  isMobileLayout,
  mapVoteHasConfirmed,
  mapVotePhase,
  mapVoteReadyToConfirm,
  mapVoteSeatVotes,
  mapVoteSelectedScript,
  mapVoteSelectedType,
  mapVoteWinningScript,
  mapVoteWinningType,
  setMapVoteSelectedScript,
  setMapVoteSelectedType,
} from '~/client/stores'

const REVEAL_DURATION_MS = 5000

/**
 * Bottom overlay used for the dummy MAP phase.
 *
 * Layout mirrors `LeaderGridOverlay` (centered panel with a dim backdrop)
 * but the interior is a two-column voting UI: map types on the left,
 * map scripts on the right, with a single Confirm action at the bottom.
 */
export function MapVoteOverlay() {
  return (
    <Show when={mapVotePhase() === 'voting' || mapVotePhase() === 'reveal'}>
      <div class="inset-0 absolute z-20 flex flex-col">
        <div class="bg-black/40 inset-0 absolute z-0" />
        <div class="pointer-events-none inset-x-0 bottom-4 top-6 justify-center absolute z-10 flex items-stretch">
          <Show when={mapVotePhase() === 'voting'} fallback={<RevealPanel />}>
            <VotePanel />
          </Show>
        </div>
      </div>
    </Show>
  )
}

function VotePanel() {
  const mySeat = () => draftStore.seatIndex
  const canVote = () => mySeat() != null

  return (
    <div
      class={cn(
        'anim-overlay-in pointer-events-auto relative z-10 flex flex-col gap-3',
        'rounded-lg bg-bg-subtle border border-border shadow-2xl grid-panel-glow',
        'h-full w-[min(calc(100vw-1.5rem),90rem)]',
      )}
    >
      {/* Heading */}
      <div class="px-5 pt-4 pb-2 border-b border-border-subtle flex items-center justify-between shrink-0">
        <div class="flex flex-col">
          <span class="text-[11px] text-fg-subtle tracking-[0.18em] font-semibold uppercase">Map Vote</span>
          <h2 class="text-xl text-heading font-semibold">Pick a map type and script</h2>
        </div>
        <Show when={mapVoteHasConfirmed()}>
          <div class="text-sm text-accent flex gap-2 items-center">
            <span class="i-ph-check-circle-fill text-lg" />
            <span class="font-medium">Vote submitted — waiting for the others...</span>
          </div>
        </Show>
      </div>

      {/* Two-column body */}
      <div
        class={cn(
          'px-5 gap-5 grid min-h-0 flex-1',
          isMobileLayout()
            ? 'grid-rows-[auto_1fr] grid-cols-1 overflow-y-auto'
            : 'grid-cols-[minmax(0,22rem)_minmax(0,1fr)]',
        )}
      >
        <MapTypeColumn disabled={!canVote() || mapVoteHasConfirmed()} />
        <MapScriptColumn disabled={!canVote() || mapVoteHasConfirmed()} />
      </div>

      {/* Footer actions */}
      <div class="px-5 pb-4 pt-2 border-t border-border-subtle flex flex-wrap gap-3 items-center justify-between shrink-0">
        <Show
          when={!mapVoteHasConfirmed()}
          fallback={<span class="text-xs text-fg-subtle">Other players are still voting</span>}
        >
          <span class="text-xs text-fg-subtle">Blind vote — nobody sees your choice until everyone confirms</span>
        </Show>

        <button
          type="button"
          class={cn(
            'text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors',
            'hover:brightness-110 disabled:opacity-50 disabled:cursor-default',
          )}
          disabled={!mapVoteReadyToConfirm() || !canVote()}
          onClick={() => confirmMapVote()}
        >
          <Show when={!mapVoteHasConfirmed()} fallback="Vote Submitted">
            Confirm Vote
          </Show>
        </button>
      </div>
    </div>
  )
}

// ── Map type column ────────────────────────────────────────

function MapTypeColumn(props: { disabled: boolean }) {
  return (
    <div class="flex flex-col gap-2 min-h-0">
      <div class="text-[11px] text-fg-subtle tracking-widest font-bold uppercase">Map Type</div>
      <div class={cn('flex flex-col gap-2 flex-1 min-h-0', isMobileLayout() ? '' : 'overflow-y-auto pr-1')}>
        <For each={MAP_TYPES}>
          {option => (
            <MapTypeCard
              option={option}
              selected={mapVoteSelectedType() === option.id}
              disabled={props.disabled}
              onSelect={() => setMapVoteSelectedType(option.id)}
            />
          )}
        </For>
      </div>
    </div>
  )
}

function MapTypeCard(props: {
  option: MapTypeOption
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const isRandom = () => props.option.id === 'random'
  return (
    <button
      type="button"
      disabled={props.disabled}
      class={cn(
        'group relative flex flex-1 min-h-[110px] cursor-pointer select-none overflow-hidden',
        'rounded-lg border border-border bg-bg/50 text-left transition-all',
        'hover:border-accent/60 hover:bg-bg/70',
        'disabled:cursor-default disabled:opacity-80 disabled:hover:border-border disabled:hover:bg-bg/50',
        props.selected && 'border-accent/80 bg-accent/10 shadow-[0_0_0_2px_var(--accent-subtle)]',
      )}
      onClick={() => props.onSelect()}
    >
      <div
        class={cn(
          'flex h-full w-20 shrink-0 items-center justify-center border-r border-border-subtle',
          isRandom() ? 'bg-bg-muted/30' : 'bg-bg-muted/50',
        )}
      >
        <span
          class={cn(
            props.option.icon,
            'text-[32px]',
            props.selected ? 'text-accent' : 'text-fg-muted group-hover:text-fg',
          )}
        />
      </div>
      <div class="flex flex-1 flex-col justify-center gap-1 px-4 py-3">
        <div class={cn('text-base font-semibold', props.selected ? 'text-accent' : 'text-fg')}>
          {props.option.name}
        </div>
        <div class="text-xs text-fg-muted leading-tight">{props.option.description}</div>
      </div>
      <Show when={props.selected}>
        <span class="i-ph-check-bold text-accent text-base top-2 right-2 absolute" />
      </Show>
    </button>
  )
}

// ── Map script column ──────────────────────────────────────

function MapScriptColumn(props: { disabled: boolean }) {
  return (
    <div class="flex flex-col gap-2 min-h-0">
      <div class="text-[11px] text-fg-subtle tracking-widest font-bold uppercase">Map Script</div>
      <div class={cn('gap-2 grid flex-1 min-h-0', mapScriptGridClass())}>
        <For each={MAP_SCRIPTS}>
          {option => (
            <MapScriptCard
              option={option}
              selected={mapVoteSelectedScript() === option.id}
              disabled={props.disabled}
              onSelect={() => setMapVoteSelectedScript(option.id)}
            />
          )}
        </For>
      </div>
    </div>
  )
}

function mapScriptGridClass() {
  if (isMobileLayout()) return 'grid-cols-2'
  return 'grid-cols-3'
}

function MapScriptCard(props: {
  option: MapScriptOption
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const isRandom = () => props.option.id === 'random'
  return (
    <button
      type="button"
      disabled={props.disabled}
      class={cn(
        'group relative flex flex-col overflow-hidden cursor-pointer select-none',
        'rounded-lg border border-border bg-bg/50 text-left transition-all',
        'hover:border-accent/60 hover:bg-bg/70',
        'disabled:cursor-default disabled:opacity-80 disabled:hover:border-border disabled:hover:bg-bg/50',
        props.selected && 'border-accent/80 bg-accent/10 shadow-[0_0_0_2px_var(--accent-subtle)]',
      )}
      onClick={() => props.onSelect()}
    >
      <div
        class={cn(
          'relative flex flex-1 items-center justify-center border-b border-border-subtle',
          isRandom() ? 'bg-bg-muted/30' : 'bg-bg-muted/50',
        )}
      >
        <Show
          when={props.option.imageUrl}
          fallback={(
            <Show
              when={isRandom() || props.option.icon}
              fallback={<MapArtworkPlaceholder />}
            >
              <span
                class={cn(
                  props.option.icon ?? 'i-ph-map-trifold-bold',
                  'text-[44px]',
                  props.selected ? 'text-accent' : 'text-fg-muted/80 group-hover:text-fg-muted',
                )}
              />
            </Show>
          )}
        >
          {url => (
            <img
              src={url()}
              alt={props.option.name}
              class="inset-0 h-full w-full object-cover absolute"
            />
          )}
        </Show>
        <Show when={props.selected}>
          <span class="i-ph-check-bold text-accent text-base top-1.5 right-1.5 absolute z-10 rounded-full bg-bg/80 p-0.5" />
        </Show>
      </div>
      <div class="px-3 py-2 flex flex-col gap-0.5">
        <div class={cn('text-sm font-semibold truncate', props.selected ? 'text-accent' : 'text-fg')}>
          {props.option.name}
        </div>
        <Show
          when={props.option.hint}
          fallback={<div class="text-[11px] text-fg-muted/70 truncate invisible">-</div>}
        >
          <div class="text-[11px] text-fg-muted/80 truncate">{props.option.hint}</div>
        </Show>
      </div>
    </button>
  )
}

function MapArtworkPlaceholder() {
  return (
    <div class="inset-0 flex items-center justify-center opacity-40 absolute">
      <span class="i-ph-image-bold text-[36px] text-fg-subtle" />
    </div>
  )
}

// ── Reveal panel ───────────────────────────────────────────

function RevealPanel() {
  const [remainingMs, setRemainingMs] = createSignal(REVEAL_DURATION_MS)

  createEffect(() => {
    if (mapVotePhase() !== 'reveal') return
    const startedAt = Date.now()
    setRemainingMs(REVEAL_DURATION_MS)
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const left = Math.max(0, REVEAL_DURATION_MS - elapsed)
      setRemainingMs(left)
      if (left <= 0) {
        clearInterval(interval)
        finishMapVote()
      }
    }, 100)
    onCleanup(() => clearInterval(interval))
  })

  const progress = () => remainingMs() / REVEAL_DURATION_MS

  const winningType = createMemo(() => {
    const id = mapVoteWinningType()
    return id ? MAP_TYPE_BY_ID[id] : null
  })

  const winningScript = createMemo(() => {
    const id = mapVoteWinningScript()
    return id ? MAP_SCRIPT_BY_ID[id] : null
  })

  const seatVotes = mapVoteSeatVotes

  return (
    <div
      class={cn(
        'anim-overlay-in pointer-events-auto relative z-10 flex flex-col gap-4',
        'rounded-lg bg-bg-subtle border border-border shadow-2xl grid-panel-glow',
        'h-full w-[min(calc(100vw-1.5rem),72rem)]',
      )}
    >
      <div class="px-5 pt-4 pb-2 border-b border-border-subtle flex flex-col gap-0.5 shrink-0">
        <span class="text-[11px] text-accent tracking-[0.18em] font-bold uppercase">Map Vote Result</span>
        <h2 class="text-xl text-heading font-semibold">The map is set</h2>
      </div>

      <div class="px-5 flex-1 min-h-0 overflow-y-auto">
        <div
          class={cn(
            'gap-4 grid mb-5',
            isMobileLayout() ? 'grid-cols-1' : 'grid-cols-2',
          )}
        >
          <WinningCallout
            title="Map Type"
            name={winningType()?.name ?? '—'}
            icon={winningType()?.icon ?? 'i-ph-map-trifold-bold'}
            subtitle={winningType()?.description}
          />
          <WinningCallout
            title="Map Script"
            name={winningScript()?.name ?? '—'}
            icon={winningScript()?.icon ?? 'i-ph-mountains-bold'}
            subtitle={winningScript()?.hint}
          />
        </div>

        <div class="mb-2 text-[11px] text-fg-subtle tracking-widest font-bold uppercase">Ballots</div>
        <div
          class={cn(
            'gap-2 grid',
            isMobileLayout() ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
          )}
        >
          <For each={seatVotes()}>
            {vote => <BallotRow seatIndex={vote.seatIndex} mapType={vote.mapType} mapScript={vote.mapScript} />}
          </For>
        </div>
      </div>

      <div class="h-1 bg-border-subtle/50 rounded-full mx-5 mb-4 overflow-hidden shrink-0">
        <div
          class="h-full bg-accent transition-[width] duration-100 ease-linear"
          style={{ width: `${progress() * 100}%` }}
        />
      </div>
    </div>
  )
}

function WinningCallout(props: { title: string, name: string, icon: string, subtitle?: string }) {
  return (
    <div class="p-4 flex gap-4 items-center rounded-lg border border-accent/40 bg-accent/10 shadow-[0_0_0_2px_var(--accent-subtle)]">
      <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-bg-muted/60 border border-border-subtle">
        <span class={cn(props.icon, 'text-[36px] text-accent')} />
      </div>
      <div class="flex flex-col gap-0.5 min-w-0">
        <div class="text-[11px] text-accent tracking-widest font-bold uppercase">{props.title}</div>
        <div class="text-lg text-fg font-semibold truncate">{props.name}</div>
        <Show when={props.subtitle}>
          <div class="text-xs text-fg-muted truncate">{props.subtitle}</div>
        </Show>
      </div>
    </div>
  )
}

function BallotRow(props: { seatIndex: number, mapType: string, mapScript: string }) {
  const seat = () => draftStore.state?.seats[props.seatIndex] ?? null
  const mapType = () => MAP_TYPE_BY_ID[props.mapType as keyof typeof MAP_TYPE_BY_ID]
  const mapScript = () => MAP_SCRIPT_BY_ID[props.mapScript as keyof typeof MAP_SCRIPT_BY_ID]
  const isWinningType = () => props.mapType === mapVoteWinningType()
  const isWinningScript = () => props.mapScript === mapVoteWinningScript()

  return (
    <div class="p-2 rounded-md bg-bg/50 border border-border-subtle flex flex-col gap-1.5">
      <div class="flex gap-2 items-center">
        <div class="h-5 w-5 shrink-0 rounded-full bg-bg-muted/60 flex items-center justify-center text-[10px] text-fg-muted font-bold">
          {props.seatIndex + 1}
        </div>
        <span class="text-xs text-fg-muted truncate">{seat()?.displayName ?? `Seat ${props.seatIndex + 1}`}</span>
      </div>
      <div class="flex gap-1.5 items-center">
        <span
          class={cn(
            'text-[11px] px-1.5 py-0.5 rounded truncate',
            isWinningType() ? 'bg-accent/20 text-accent font-semibold' : 'bg-bg-muted/40 text-fg-muted',
          )}
          title={mapType()?.name}
        >
          {mapType()?.name ?? props.mapType}
        </span>
        <span
          class={cn(
            'text-[11px] px-1.5 py-0.5 rounded truncate',
            isWinningScript() ? 'bg-accent/20 text-accent font-semibold' : 'bg-bg-muted/40 text-fg-muted',
          )}
          title={mapScript()?.name}
        >
          {mapScript()?.name ?? props.mapScript}
        </span>
      </div>
    </div>
  )
}
