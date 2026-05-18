import type { ActivityTargetOption } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { preloadActivityTargetRoute } from '~/client/activity/route-preloads'
import { MiniFrame } from '~/client/components/draft/MiniLayout'
import { activityTargetOptionKey } from '~/client/lib/activity-targets'
import { cn } from '~/client/lib/css'
import { isMobileLayout } from '~/client/stores'

interface LobbyOverviewTargetPickerProps {
  mini?: boolean
  error?: string | null
  options: ActivityTargetOption[]
  busy?: boolean
  selectedKey?: string | null
  onSelect: (option: ActivityTargetOption) => void
}

type OverviewFilter = 'all' | 'open' | 'drafting' | 'completed'
type OverviewStatus = 'open' | 'closed' | 'drafting' | 'completed'

const PLAYER_PREVIEW_LIMIT = 4

export function LobbyOverviewTargetPicker(props: LobbyOverviewTargetPickerProps) {
  return (
    <Show when={props.mini} fallback={<LobbyOverviewTargetPickerFull {...props} />}>
      <LobbyOverviewTargetPickerMini {...props} />
    </Show>
  )
}

function LobbyOverviewTargetPickerMini(props: LobbyOverviewTargetPickerProps) {
  const visibleOptions = () => props.options.slice(0, 4)
  const hiddenCount = () => Math.max(0, props.options.length - visibleOptions().length)

  return (
    <MiniFrame title="Lobby Overview" titleAccent="gold">
      <Show
        when={visibleOptions().length > 0}
        fallback={(
          <div class="px-4 text-center border border-border-subtle rounded-lg bg-bg-subtle/90 flex flex-1 items-center justify-center">
            <span class="text-[10px] text-fg-muted">No active lobbies</span>
          </div>
        )}
      >
        <div class="flex flex-1 flex-col gap-1.5 min-h-0 overflow-hidden">
          <div class="gap-1.5 grid grid-cols-2">
            <For each={visibleOptions()}>
              {option => (
                <div class="px-2 py-1.5 border border-border-subtle rounded bg-bg-subtle/92 flex flex-col gap-1 min-w-0 overflow-hidden">
                  <div class="flex gap-1 min-w-0 items-center justify-between">
                    <span class="text-[10px] text-fg tracking-[0.14em] font-bold truncate">
                      {formatModeLabel(option.mode, option.mode, { redDeath: option.redDeath })}
                    </span>
                    <span class={cn(
                      'text-[6px] font-semibold uppercase shrink-0',
                      getStatusMeta(getOptionStatus(option)).iconColorClass,
                    )}
                    >
                      {formatMiniTargetStatus(option)}
                    </span>
                  </div>

                  <div class="text-[10px] text-fg-muted leading-none flex gap-1 items-center justify-between">
                    <span>
                      {option.participantCount}
                      /
                      {option.targetSize}
                    </span>
                    <Show when={option.isHost || option.isMember}>
                      <span class="text-[8px] text-accent tracking-[0.1em] font-semibold uppercase">
                        {option.isHost ? 'Host' : 'Joined'}
                      </span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>

          <Show when={hiddenCount() > 0 || props.error}>
            <div class="text-[9px] leading-none px-1 flex gap-2 items-center justify-between">
              <span class="text-fg-muted/80">
                {hiddenCount() > 0 ? `+${hiddenCount()} more` : ''}
              </span>
              <Show when={props.error}>
                {error => <span class="text-danger truncate">{error()}</span>}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </MiniFrame>
  )
}

function LobbyOverviewTargetPickerFull(props: LobbyOverviewTargetPickerProps) {
  const [filter, setFilter] = createSignal<OverviewFilter>('all')
  const counts = createMemo(() => getOverviewCounts(props.options))
  const navItems = createMemo(() => buildNavItems(counts()))
  const visibleOptions = createMemo(() => {
    const activeFilter = filter()
    if (activeFilter === 'all') return props.options
    if (activeFilter === 'open') return props.options.filter((option) => {
      const status = getOptionStatus(option)
      return status === 'open' || status === 'closed'
    })
    return props.options.filter(option => getOptionStatus(option) === activeFilter)
  })

  return (
    <section class={cn('flex flex-col gap-4', isMobileLayout() && 'pt-12')}>
      <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
        <div class="h-9 w-9" />
        <div class="text-center">
          <h1 class="text-2xl text-heading mb-1">Lobby Overview</h1>
          <span class="text-sm text-transparent select-none">&nbsp;</span>
        </div>
        <div class="h-9 w-9" />
      </div>

      <Show
        when={props.options.length > 0}
        fallback={(
          <div class="px-6 py-8 text-center border border-border-subtle rounded-2xl bg-bg-subtle/90">
            <div class="mx-auto mb-3 border border-border-subtle rounded-full bg-bg-muted/40 flex h-12 w-12 items-center justify-center">
              <span class="i-ph:squares-four-duotone text-xl text-fg-subtle" />
            </div>
            <div class="text-base text-fg font-semibold">No active lobbies</div>
          </div>
        )}
      >
        <div class="flex flex-col gap-4">
          <div class="mx-auto p-1 border border-border-subtle rounded-2xl bg-bg-subtle/75 grid grid-cols-4 gap-1 w-full max-w-lg">
            <For each={navItems()}>
              {item => (
                <button
                  type="button"
                  aria-pressed={filter() === item.key}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => setFilter(item.key)}
                  class={cn(
                    'rounded-xl px-2 py-2 flex gap-1.5 min-w-0 items-center justify-center transition-colors',
                    filter() === item.key
                      ? item.activeClass
                      : 'text-fg-muted hover:text-fg hover:bg-bg-muted/60',
                  )}
                >
                  <span class={cn(item.icon, 'text-base shrink-0')} />
                  <span class="text-sm font-mono font-bold tabular-nums">{item.count}</span>
                </button>
              )}
            </For>
          </div>

          <Show
            when={visibleOptions().length > 0}
            fallback={(
              <div class="px-6 py-8 text-center border border-border-subtle rounded-2xl bg-bg-subtle/80">
                <span class="text-sm text-fg-muted">No lobbies</span>
              </div>
            )}
          >
            <div
              class="gap-3 grid"
              style={{ 'grid-template-columns': 'repeat(auto-fill, minmax(min(100%, 17rem), 1fr))' }}
            >
              <For each={visibleOptions()}>
                {(option) => {
                  const selected = () => props.selectedKey === activityTargetOptionKey(option)

                  return (
                    <OverviewTargetCard
                      option={option}
                      selected={selected()}
                      busy={props.busy === true}
                      onSelect={props.onSelect}
                    />
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function OverviewTargetCard(props: {
  option: ActivityTargetOption
  selected: boolean
  busy: boolean
  onSelect: (option: ActivityTargetOption) => void
}) {
  const status = () => getOptionStatus(props.option)
  const meta = () => getStatusMeta(status())
  const players = () => props.option.players ?? []
  const visiblePlayers = () => getVisiblePlayers(props.option)
  const hiddenPlayers = () => Math.max(0, players().length - visiblePlayers().length)

  return (
    <button
      type="button"
      aria-label={formatTargetAriaLabel(props.option)}
      aria-pressed={props.selected}
      disabled={props.busy}
      onPointerEnter={() => preloadActivityTargetRoute(props.option)}
      onFocus={() => preloadActivityTargetRoute(props.option)}
      onClick={() => props.onSelect(props.option)}
      class={cn(
        'group relative flex min-h-[156px] flex-col overflow-hidden rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer',
        'bg-bg-subtle/95 border-border-subtle',
        'disabled:opacity-60 disabled:cursor-wait',
        props.selected
          ? 'border-accent/60 bg-accent/8 shadow-[0_0_0_1px_var(--accent-subtle)] hover:border-accent/80 hover:bg-accent/14'
          : 'hover:border-accent/40 hover:bg-bg-subtle',
      )}
    >
      <span class={cn('left-0 right-0 top-0 h-0.5 absolute', meta().barClass)} />

      <div class="flex gap-3 items-center justify-between">
        <div class="flex gap-2 min-w-0 items-center">
          <span class={cn(meta().icon, meta().iconColorClass, 'text-lg shrink-0')} />
          <span class="text-sm text-fg tracking-[0.08em] font-bold truncate uppercase">
            {formatTargetStatus(props.option)}
          </span>
        </div>

        <span class="text-xs text-accent tracking-[0.14em] font-bold shrink-0">
          {formatModeLabel(props.option.mode, props.option.mode, { redDeath: props.option.redDeath })}
        </span>
      </div>

      <Show
        when={players().length > 0}
        fallback={(
          <div class="mt-3 px-2 py-2 border border-border-subtle rounded-lg bg-white/4 flex gap-2 items-center">
            <span class="i-ph:user-bold text-sm text-fg-subtle" />
            <span class="text-xs text-fg-muted font-mono tabular-nums">{props.option.participantCount}</span>
          </div>
        )}
      >
        <div class="mt-3 gap-1.5 grid grid-cols-2">
          <For each={visiblePlayers()}>
            {player => <PlayerPreviewPill player={player} />}
          </For>
          <Show when={hiddenPlayers() > 0}>
            <div class="rounded-md px-2 h-7 border border-border-subtle bg-white/4 flex gap-1.5 min-w-0 items-center justify-center">
              <span class="i-ph:dots-three-bold text-sm text-fg-subtle" />
              <span class="text-[11px] text-fg-muted font-mono font-bold tabular-nums">
                +
                {hiddenPlayers()}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <div class="mt-auto pt-3 flex gap-3 h-8 items-center justify-between">
        <Show when={props.option.isHost || props.option.isMember} fallback={<span />}>
          <span class="text-xs text-accent tracking-[0.12em] font-semibold uppercase inline-flex gap-1.5 items-center">
            <span class={cn(props.option.isHost ? 'i-ph:crown-simple-bold' : 'i-ph:user-check-bold', 'text-sm')} />
            {props.option.isHost ? 'Host' : 'Joined'}
          </span>
        </Show>

        <span class="text-sm text-fg-muted font-mono inline-flex gap-1 items-center tabular-nums shrink-0">
          <span class="i-ph:users-duotone text-base" />
          {props.option.participantCount}
          /
          {props.option.targetSize}
        </span>
      </div>
    </button>
  )
}

function PlayerPreviewPill(props: { player: NonNullable<ActivityTargetOption['players']>[number] }) {
  return (
    <div class="rounded-md px-1.5 h-7 border border-border-subtle bg-white/5 flex gap-1.5 min-w-0 items-center">
      <Show
        when={props.player.avatarUrl}
        fallback={(
          <span class="rounded-full bg-bg-muted flex h-4 w-4 shrink-0 items-center justify-center">
            <span class="text-[7px] text-fg-subtle font-bold leading-none">{getInitials(props.player.displayName)}</span>
          </span>
        )}
      >
        {avatarUrl => <img src={avatarUrl()} alt="" class="rounded-full h-4 w-4 object-cover shrink-0" />}
      </Show>
      <span class="text-[11px] text-fg leading-none truncate">{props.player.displayName}</span>
    </div>
  )
}

function getVisiblePlayers(option: ActivityTargetOption): NonNullable<ActivityTargetOption['players']> {
  const players = option.players ?? []
  return players.slice(0, players.length > PLAYER_PREVIEW_LIMIT ? PLAYER_PREVIEW_LIMIT - 1 : PLAYER_PREVIEW_LIMIT)
}

function getOverviewCounts(options: ActivityTargetOption[]): Record<OverviewFilter, number> {
  const counts: Record<OverviewFilter, number> = {
    all: options.length,
    open: 0,
    drafting: 0,
    completed: 0,
  }

  for (const option of options) {
    const status = getOptionStatus(option)
    counts[status === 'closed' ? 'open' : status] += 1
  }
  return counts
}

function buildNavItems(counts: Record<OverviewFilter, number>) {
  return [
    {
      key: 'all' as const,
      label: 'All',
      count: counts.all,
        icon: 'i-ph:squares-four-duotone',
      activeClass: 'text-fg bg-white/8',
    },
    {
      key: 'open' as const,
      label: 'Open',
      count: counts.open,
      icon: 'i-ph:circle-duotone',
      activeClass: 'text-note bg-note/12',
    },
    {
      key: 'drafting' as const,
      label: 'Drafting',
      count: counts.drafting,
      icon: 'i-ph:play-circle-duotone',
      activeClass: 'text-info bg-info/12',
    },
    {
      key: 'completed' as const,
      label: 'Completed',
      count: counts.completed,
      icon: 'i-ph:check-circle-duotone',
      activeClass: 'text-accent bg-accent/12',
    },
  ]
}

function getOptionStatus(option: ActivityTargetOption): OverviewStatus {
  if (option.kind === 'lobby') return option.status === 'closed' ? 'closed' : 'open'
  if (option.status === 'drafting') return 'drafting'
  return 'completed'
}

function getStatusMeta(status: OverviewStatus) {
  switch (status) {
    case 'open':
      return {
        icon: 'i-ph:circle-duotone',
        iconColorClass: 'text-note',
        barClass: 'bg-note',
      }
    case 'closed':
      return {
        icon: 'i-ph:minus-circle-duotone',
        iconColorClass: 'text-[#a78bfa]',
        barClass: 'bg-[#a78bfa]',
      }
    case 'drafting':
      return {
        icon: 'i-ph:play-circle-duotone',
        iconColorClass: 'text-info',
        barClass: 'bg-info',
      }
    case 'completed':
      return {
        icon: 'i-ph:check-circle-duotone',
        iconColorClass: 'text-accent',
        barClass: 'bg-accent',
      }
  }
}

function getInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.slice(0, 2).toUpperCase()
}

function formatTargetAriaLabel(option: ActivityTargetOption): string {
  return `${formatModeLabel(option.mode, option.mode, { redDeath: option.redDeath })} ${formatTargetStatus(option)} ${option.participantCount}/${option.targetSize}`
}

function formatTargetStatus(option: ActivityTargetOption): string {
  const status = getOptionStatus(option)
  if (status === 'open') return 'Open'
  if (status === 'closed') return 'Closed'
  if (status === 'drafting') return 'Drafting'
  return 'Completed'
}

function formatMiniTargetStatus(option: ActivityTargetOption): string {
  const status = getOptionStatus(option)
  if (status === 'open') return 'Open'
  if (status === 'closed') return 'Closed'
  if (status === 'drafting') return 'Draft'
  return 'Done'
}
