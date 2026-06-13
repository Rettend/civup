import type { ActivityTargetOption } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { createMemo, createSignal, For, Show } from 'solid-js'
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
type OverviewPlayer = NonNullable<ActivityTargetOption['players']>[number]

const NAME_PLAYER_PREVIEW_LIMIT = 6
const AVATAR_PLAYER_PREVIEW_LIMIT = 12

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
                      {formatTargetModeLabel(option)}
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
  const players = () => getCardDisplayPlayers(props.option)
  const namePreviewPlayers = () => players().slice(0, NAME_PLAYER_PREVIEW_LIMIT)
  const avatarPreviewPlayers = () => players().slice(0, AVATAR_PLAYER_PREVIEW_LIMIT)
  const showAvatarPreview = () => players().length > NAME_PLAYER_PREVIEW_LIMIT

  return (
    <button
      type="button"
      aria-label={formatTargetAriaLabel(props.option)}
      aria-pressed={props.selected}
      disabled={props.busy}
      onClick={() => props.onSelect(props.option)}
      class={cn(
        'group relative flex min-h-[156px] flex-col overflow-visible rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer',
        meta().surfaceClass,
        'disabled:opacity-60 disabled:cursor-wait',
        props.selected
          ? cn('ring-2', meta().selectedRingClass)
          : 'hover:ring-1 hover:ring-white/15',
      )}
    >
      <div class="flex gap-3 items-center justify-between">
        <div class="flex gap-2 min-w-0 items-center">
          <span class={cn(meta().icon, meta().iconColorClass, 'text-lg shrink-0')} />
          <span class="text-sm text-fg tracking-[0.08em] font-bold truncate uppercase">
            {formatTargetStatus(props.option)}
          </span>
        </div>

        <span class="text-xs text-accent tracking-[0.14em] font-bold shrink-0">
          {formatTargetModeLabel(props.option)}
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
        <Show
          when={showAvatarPreview()}
          fallback={(
            <div class={cn('mt-3 gap-1.5 grid', players().length > 4 ? 'grid-cols-3' : 'grid-cols-2')} data-overview-name-grid>
              <For each={namePreviewPlayers()}>
                {player => <PlayerPreviewPill player={player} />}
              </For>
            </div>
          )}
        >
          <PlayerAvatarTeamPreview players={avatarPreviewPlayers()} />
        </Show>
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

function PlayerPreviewPill(props: { player: OverviewPlayer }) {
  return (
    <div class="rounded-full pr-2 h-7 bg-white/6 flex gap-1.5 min-w-0 items-center">
      <PlayerAvatarBubble player={props.player} />
      <span class="text-xs text-fg leading-none truncate">{props.player.displayName}</span>
    </div>
  )
}

function PlayerAvatarTeamPreview(props: { players: OverviewPlayer[] }) {
  const columns = () => splitPlayersForAvatarColumns(props.players)

  return (
    <div class="mt-3 px-1 grid grid-cols-2 gap-4" data-overview-avatar-grid>
      <For each={columns()}>
        {column => (
          <div class="flex flex-wrap gap-1.5 min-w-0 items-center content-start">
            <For each={column}>
              {player => <PlayerPreviewAvatar player={player} />}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}

function PlayerPreviewAvatar(props: { player: OverviewPlayer }) {
  return (
    <span class="group/avatar relative inline-flex" role="img" aria-label={props.player.displayName} data-overview-player-avatar>
      <PlayerAvatarBubble player={props.player} />
      <span class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border-subtle bg-bg-elevated/96 px-2.5 py-1 text-[10px] text-fg shadow-[0_8px_20px_rgba(0,0,0,0.32)] opacity-0 transition-opacity duration-100 group-hover/avatar:duration-0 group-hover/avatar:opacity-100 group-focus-visible/avatar:duration-0 group-focus-visible/avatar:opacity-100" role="tooltip">
        {props.player.displayName}
        <span class="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-border-subtle bg-bg-elevated/96" />
      </span>
    </span>
  )
}

function PlayerAvatarBubble(props: { player: OverviewPlayer }) {
  return (
    <span class="rounded-full h-7 w-7 shrink-0 flex items-center justify-center overflow-hidden">
      <Show
        when={props.player.avatarUrl}
        fallback={(
          <span class="rounded-full flex h-6 w-6 items-center justify-center">
            <span class="text-[8px] text-fg-subtle font-bold leading-none">{getInitials(props.player.displayName)}</span>
          </span>
        )}
      >
        {avatarUrl => <img src={avatarUrl()} alt="" class="rounded-full h-6 w-6 object-cover" />}
      </Show>
    </span>
  )
}

function splitPlayersForAvatarColumns(players: OverviewPlayer[]): [OverviewPlayer[], OverviewPlayer[]] {
  const hasTeamData = players.some(player => typeof player.team === 'number')
  if (!hasTeamData) {
    const splitIndex = Math.ceil(players.length / 2)
    return [players.slice(0, splitIndex), players.slice(splitIndex)]
  }

  const columns: [OverviewPlayer[], OverviewPlayer[]] = [[], []]
  const ungrouped: OverviewPlayer[] = []

  for (const player of players) {
    if (typeof player.team === 'number') {
      const columnIndex = player.team % 2 === 0 ? 0 : 1
      columns[columnIndex].push(player)
    }
    else {
      ungrouped.push(player)
    }
  }

  for (const player of ungrouped) {
    columns[columns[0].length <= columns[1].length ? 0 : 1].push(player)
  }

  return columns
}

function getCardDisplayPlayers(option: ActivityTargetOption): OverviewPlayer[] {
  const players = option.players ?? []
  if (option.mode !== '2v2' || option.targetSize !== 4) return players
  return orderTwoVsTwoPlayersLeftToRight(players)
}

function orderTwoVsTwoPlayersLeftToRight(players: OverviewPlayer[]): OverviewPlayer[] {
  const teams: [OverviewPlayer[], OverviewPlayer[]] = [[], []]
  const ungrouped: OverviewPlayer[] = []

  for (const player of players) {
    if (player.team === 0 || player.team === 1) teams[player.team].push(player)
    else ungrouped.push(player)
  }

  if (teams[0].length === 0 || teams[1].length === 0) return players

  const ordered: OverviewPlayer[] = []
  const maxTeamSize = Math.max(teams[0].length, teams[1].length)
  for (let index = 0; index < maxTeamSize; index += 1) {
    const left = teams[0][index]
    const right = teams[1][index]
    if (left) ordered.push(left)
    if (right) ordered.push(right)
  }

  return [...ordered, ...ungrouped]
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
        surfaceClass: 'bg-note/12 border-note/30 hover:bg-note/18',
        selectedRingClass: 'ring-note/80',
      }
    case 'closed':
      return {
        icon: 'i-ph:minus-circle-duotone',
        iconColorClass: 'text-[#a78bfa]',
        surfaceClass: 'bg-[#a78bfa]/12 border-[#a78bfa]/30 hover:bg-[#a78bfa]/18',
        selectedRingClass: 'ring-[#a78bfa]/80',
      }
    case 'drafting':
      return {
        icon: 'i-ph:play-circle-duotone',
        iconColorClass: 'text-info',
        surfaceClass: 'bg-info/12 border-info/30 hover:bg-info/18',
        selectedRingClass: 'ring-info/80',
      }
    case 'completed':
      return {
        icon: 'i-ph:check-circle-duotone',
        iconColorClass: 'text-accent',
        surfaceClass: 'bg-accent/10 border-accent/25 hover:bg-accent/16',
        selectedRingClass: 'ring-accent/80',
      }
  }
}

function getInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.slice(0, 2).toUpperCase()
}

function formatTargetAriaLabel(option: ActivityTargetOption): string {
  return `${formatTargetModeLabel(option)} ${formatTargetStatus(option)} ${option.participantCount}/${option.targetSize}`
}

function formatTargetModeLabel(option: ActivityTargetOption): string {
  return formatModeLabel(option.mode, option.mode, { redDeath: option.redDeath, civBlitz: option.civBlitz })
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
