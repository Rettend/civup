import { buildRolePillStyle, type LobbyBalanceTeamSummary, type PlayerRow } from './helpers'
import type { useDraftSetupState } from './useDraftSetupState'
import type { LobbyArrangeStrategy, RankedRoleOptionSnapshot } from '~/client/stores'
import { formatLeaderPoolRankLabel } from '@civup/game'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { cn } from '~/client/lib/css'
import { PlayerStatsPopover } from '~/client/components/player/PlayerStatsPopover'
export { formatRating, formatRecord, formatWinRate } from '~/client/components/player/PlayerStatsPopover'

type DraftSetupPlayersPanelState = ReturnType<typeof useDraftSetupState>['players']

interface PlayerFlipApi {
  register: (playerId: string, element: HTMLElement) => void
  unregister: (playerId: string, element: HTMLElement) => void
}

const FLIP_EASING = 'cubic-bezier(0.18, 0.88, 0.22, 1)'
const FLIP_DURATION_MS = 1400
const ARRANGE_OVERLAY_LEAD_MS = 360
const ARRANGE_OVERLAY_TAIL_MS = 180
const ARRANGE_OVERLAY_VISIBLE_MS = ARRANGE_OVERLAY_LEAD_MS + FLIP_DURATION_MS + ARRANGE_OVERLAY_TAIL_MS
const PLAYER_POPOVER_MIN_WIDTH = 288
const PLAYER_POPOVER_HEIGHT_ESTIMATE = 160
const PLAYER_POPOVER_GAP = 8
const PLAYER_POPOVER_VIEWPORT_PADDING = 8

export function DraftSetupPlayersPanel(props: { state: DraftSetupPlayersPanelState }) {
  const state = () => props.state
  const showSourceGuild = createMemo(() => {
    const rows = state().isTeamMode()
      ? state().teamIndices().flatMap(team => state().teamRows(team))
      : state().ffaColumns().flat()
    return new Set(rows.flatMap(row => row.sourceGuild?.id ? [row.sourceGuild.id] : [])).size >= 2
  })

  const elementsByPlayer = new Map<string, HTMLElement>()
  const prevRectByPlayer = new Map<string, DOMRect>()
  const [arrangeOverlayActive, setArrangeOverlayActive] = createSignal(false)
  const [arrangeOverlayStrategy, setArrangeOverlayStrategy] = createSignal<LobbyArrangeStrategy | null>(null)
  const [openPlayerId, setOpenPlayerId] = createSignal<string | null>(null)
  const [playerPopoverPosition, setPlayerPopoverPosition] = createSignal<{ left: number, top: number } | null>(null)
  let arrangeOverlayTimeout: ReturnType<typeof setTimeout> | null = null
  let playerPopoverRef: HTMLDivElement | undefined
  let playerPopoverAnchor: HTMLElement | undefined
  let armedArrangeKey: string | null = null
  let lastSeenArrangeKey: string | null = null
  let hasInitializedArrangeKey = false
  let lastRenderSignature: string | null = null

  const pendingArrangeStrategy = () => state().pendingArrangeStrategy?.() ?? null
  const overlayActive = () => arrangeOverlayActive() || pendingArrangeStrategy() != null
  const overlayStrategy = () => pendingArrangeStrategy() ?? arrangeOverlayStrategy()
  const selectedPlayerRow = createMemo(() => {
    const playerId = openPlayerId()
    if (!playerId) return null
    return findPlayerRow(state(), playerId)
  })
  const playerPopoverStyle = () => {
    const position = playerPopoverPosition()
    if (!position) return undefined
    return {
      left: `calc(${position.left}px / var(--civup-ui-scale, 1))`,
      top: `calc(${position.top}px / var(--civup-ui-scale, 1))`,
    }
  }

  const flip: PlayerFlipApi = {
    register: (playerId, element) => {
      elementsByPlayer.set(playerId, element)
    },
    unregister: (playerId, element) => {
      if (elementsByPlayer.get(playerId) === element) elementsByPlayer.delete(playerId)
    },
  }

  const closePlayerPopover = () => {
    setOpenPlayerId(null)
    setPlayerPopoverPosition(null)
    playerPopoverAnchor = undefined
  }

  const updatePlayerPopoverPosition = (anchor = playerPopoverAnchor) => {
    if (typeof window === 'undefined' || !anchor) return
    const rect = anchor.getBoundingClientRect()
    const popoverWidth = playerPopoverRef?.offsetWidth ?? PLAYER_POPOVER_MIN_WIDTH
    const maxLeft = Math.max(PLAYER_POPOVER_VIEWPORT_PADDING, window.innerWidth - popoverWidth - PLAYER_POPOVER_VIEWPORT_PADDING)
    const left = Math.min(Math.max(PLAYER_POPOVER_VIEWPORT_PADDING, rect.left), maxLeft)
    const belowTop = rect.bottom + PLAYER_POPOVER_GAP
    const aboveTop = rect.top - PLAYER_POPOVER_HEIGHT_ESTIMATE - PLAYER_POPOVER_GAP
    const top = belowTop + PLAYER_POPOVER_HEIGHT_ESTIMATE <= window.innerHeight - PLAYER_POPOVER_VIEWPORT_PADDING
      ? belowTop
      : Math.max(PLAYER_POPOVER_VIEWPORT_PADDING, aboveTop)
    setPlayerPopoverPosition({ left, top })
  }

  const openPlayerPopover = (row: PlayerRow, anchor: HTMLElement) => {
    if (row.empty || !row.playerId) return
    playerPopoverAnchor = anchor
    if (openPlayerId() !== row.playerId) setOpenPlayerId(row.playerId)
    updatePlayerPopoverPosition(anchor)
    queueMicrotask(() => updatePlayerPopoverPosition(anchor))
  }

  if (typeof document !== 'undefined') {
    const handlePointerDown = (event: PointerEvent) => {
      if (!openPlayerId()) return
      const target = event.target
      if (!target) return
      const node = target as Node
      if (playerPopoverAnchor?.contains(node) || playerPopoverRef?.contains(node)) return
      closePlayerPopover()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openPlayerId()) closePlayerPopover()
    }

    const handleViewportChange = () => {
      if (openPlayerId()) updatePlayerPopoverPosition()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    onCleanup(() => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    })
  }

  const playerSlotMap = createMemo(() => {
    const map = new Map<string, number>()
    if (state().isTeamMode()) {
      for (const team of state().teamIndices()) {
        for (const row of state().teamRows(team)) {
          if (row.playerId) map.set(row.playerId, row.slot)
        }
      }
    }
    else {
      for (const column of state().ffaColumns()) {
        for (const row of column) {
          if (row.playerId) map.set(row.playerId, row.slot)
        }
      }
    }
    return map
  })

  const renderSignature = createMemo(() => {
    if (state().isTeamMode()) {
      return `team:${state().teamIndices().map((team) => {
        const rows = state().teamRows(team)
        return `${team}[${rows.map(row => `${row.playerId ?? 'empty'}@${row.slot}`).join(',')}]`
      }).join('|')}`
    }

    return `ffa:${state().ffaColumns().map((rows, columnIndex) => `${columnIndex}[${rows.map(row => `${row.playerId ?? 'empty'}@${row.slot}`).join(',')}]`).join('|')}`
  })

  createEffect(() => {
    const arrangeEvent = state().arrangeEvent()
    const arrangeKey = arrangeEvent ? `${arrangeEvent.strategy}:${arrangeEvent.at}` : null

    if (!hasInitializedArrangeKey) {
      hasInitializedArrangeKey = true
      lastSeenArrangeKey = arrangeKey
      return
    }

    if (!arrangeEvent || arrangeKey == null || arrangeKey === lastSeenArrangeKey) return
    lastSeenArrangeKey = arrangeKey
    armedArrangeKey = arrangeKey

    if (arrangeOverlayTimeout) clearTimeout(arrangeOverlayTimeout)
    state().clearPendingArrangeStrategy?.()
    setArrangeOverlayStrategy(arrangeEvent.strategy)
    setArrangeOverlayActive(true)
    arrangeOverlayTimeout = setTimeout(() => {
      arrangeOverlayTimeout = null
      setArrangeOverlayActive(false)
    }, ARRANGE_OVERLAY_VISIBLE_MS)
  })

  createEffect(() => {
    if (openPlayerId() && !selectedPlayerRow()) closePlayerPopover()
  })

  createEffect(() => {
    const signature = renderSignature()
    const map = playerSlotMap()
    queueMicrotask(() => {
      const shouldAnimate = lastRenderSignature != null && signature !== lastRenderSignature && armedArrangeKey != null
      const newRects = new Map<string, DOMRect>()

      for (const playerId of map.keys()) {
        const el = elementsByPlayer.get(playerId)
        if (!el) continue
        const newRect = el.getBoundingClientRect()
        newRects.set(playerId, newRect)

        const prevRect = prevRectByPlayer.get(playerId)
        if (!prevRect) continue

        const dx = prevRect.left - newRect.left
        const dy = prevRect.top - newRect.top
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
        if (!shouldAnimate) continue

        try {
          el.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: 'translate(0, 0)' },
            ],
            {
              duration: FLIP_DURATION_MS,
              delay: ARRANGE_OVERLAY_LEAD_MS,
              easing: FLIP_EASING,
              fill: 'backwards',
            },
          )
        }
        catch {}
      }

      prevRectByPlayer.clear()
      for (const [playerId, rect] of newRects) prevRectByPlayer.set(playerId, rect)
      for (const playerId of [...prevRectByPlayer.keys()]) {
        if (!map.has(playerId)) prevRectByPlayer.delete(playerId)
      }
      lastRenderSignature = signature
      if (shouldAnimate) armedArrangeKey = null
    })
  })

  onCleanup(() => {
    if (arrangeOverlayTimeout) clearTimeout(arrangeOverlayTimeout)
    elementsByPlayer.clear()
    prevRectByPlayer.clear()
    closePlayerPopover()
  })

  return (
    <div class="relative">
      <Show
        when={!state().captainPickSetupEnabled()}
        fallback={(
          <div class="flex flex-col gap-5">
            <div>
              <div class="mb-2 text-xs text-accent tracking-wider font-bold uppercase">Captains</div>
              <div class="gap-4 grid grid-cols-1 sm:grid-cols-2">
                <For each={state().captainRows()}>
                  {(row, index) => (
                    <div>
                      <div class="mb-1.5 text-[11px] text-fg-subtle tracking-wide font-semibold uppercase">
                        Team
                        {' '}
                        {String.fromCharCode(65 + index())}
                        {' '}
                        captain
                      </div>
                      <DraftSetupPlayerColumn {...createPlayerColumnProps(state(), [row], flip, openPlayerId(), openPlayerPopover, closePlayerPopover, showSourceGuild())} />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div class="pt-4 border-t border-border-subtle">
              <div class="mb-1 text-xs text-fg tracking-wider font-bold uppercase">Unassigned players</div>
              <div class="mb-3 text-xs text-fg-subtle">Captains will choose these players after the lobby starts.</div>
              <div class="gap-2 grid grid-cols-1 sm:grid-cols-2">
                <For each={state().unassignedRows()}>
                  {row => <DraftSetupPlayerColumn {...createPlayerColumnProps(state(), [row], flip, openPlayerId(), openPlayerPopover, closePlayerPopover, showSourceGuild())} />}
                </For>
              </div>
            </div>
          </div>
        )}
      >
        <Show
          when={state().isTeamMode()}
          fallback={(
            <div class="gap-3 grid grid-cols-2">
              <For each={state().ffaColumns()}>
                {rows => <DraftSetupPlayerColumn {...createPlayerColumnProps(state(), rows, flip, openPlayerId(), openPlayerPopover, closePlayerPopover, showSourceGuild())} />}
              </For>
            </div>
          )}
        >
          <div class={state().isLargeTeamLobbyMode()
            ? 'flex flex-col gap-4 lg:flex-row lg:overflow-x-auto lg:pb-1'
            : cn('gap-4 grid', state().teamIndices().length > 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2')}
          >
            <For each={state().teamIndices()}>
              {team => (
                <div class={state().isLargeTeamLobbyMode() ? 'min-w-0 lg:min-w-[280px] lg:flex-1' : undefined}>
                  <div class="mb-2 flex gap-3 items-center justify-between">
                    <div class="text-xs text-accent tracking-wider font-bold flex min-w-0 items-center gap-1.5">
                      <span>
                        Team
                        {' '}
                        {String.fromCharCode(65 + team)}
                      </span>
                      <Show when={state().teamGuild(team)}>
                        {guild => (
                          <span class="text-fg-muted normal-case tracking-normal font-medium min-w-0 flex items-center gap-1" title={`Locked to ${guild().name || guild().id}`}>
                            <Show
                              when={guild().iconUrl}
                              fallback={<span class="rounded-sm bg-white/12 text-[7px] text-fg-subtle font-bold shrink-0 inline-flex h-4 w-4 items-center justify-center">{(guild().name || 'S').slice(0, 1).toUpperCase()}</span>}
                            >
                              {iconUrl => <img src={iconUrl()} alt="" draggable={false} class="rounded-sm shrink-0 h-4 w-4 object-cover" />}
                            </Show>
                            <span class="truncate max-w-28">{guild().name || guild().id}</span>
                          </span>
                        )}
                      </Show>
                    </div>
                    <Show when={state().teamBalance(team)}>
                      {summary => (
                        <div class="text-[11px] text-accent font-semibold text-right whitespace-nowrap" title={formatTeamBalanceTitle(summary(), team)}>
                          {Math.round(summary().probability * 100)}
                          %
                          <Show when={formatTeamBalanceRange(summary())}>
                            {range => <span class="text-fg-subtle font-normal ml-1">({range()})</span>}
                          </Show>
                          <Show when={formatProjectedWinDelta(summary())}>
                            {delta => <span class="text-fg-subtle font-normal ml-1">· {delta()}</span>}
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                  <DraftSetupPlayerColumn
                    {...createPlayerColumnProps(state(), state().teamRows(team), flip, openPlayerId(), openPlayerPopover, closePlayerPopover, showSourceGuild())}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={selectedPlayerRow()}>
        {row => (
          <Portal>
            <PlayerStatsPopover
              name={row().name}
              avatarUrl={row().avatarUrl}
              stats={row().balanceRating}
              statsLabel={state().statsLabel()}
              unranked={state().unranked()}
              role={resolvePlayerRole(row(), state().rankedRoles())}
              style={playerPopoverStyle()}
              setRef={(element) => { playerPopoverRef = element }}
            />
          </Portal>
        )}
      </Show>

      <div
        aria-hidden
        class={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300',
          overlayActive() ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div class="bg-bg/14 inset-0 absolute" />
        <div
          class="rounded-full h-64 w-64 absolute"
          style={{
            background: 'radial-gradient(circle, rgba(9, 9, 11, 0.78) 0%, rgba(9, 9, 11, 0.4) 38%, rgba(9, 9, 11, 0) 72%)',
            filter: 'blur(12px)',
          }}
        />
        <span
          class={cn(getArrangeOverlayIconClass(overlayStrategy()), 'relative text-5xl')}
          style={{
            color: '#b69a5c',
            filter: 'drop-shadow(0 2px 10px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 22px rgba(200, 170, 110, 0.45))',
          }}
        />
      </div>
    </div>
  )
}

function findPlayerRow(state: DraftSetupPlayersPanelState, playerId: string | null): PlayerRow | null {
  if (!playerId) return null

  if (state.isTeamMode()) {
    for (const team of state.teamIndices()) {
      const row = state.teamRows(team).find(candidate => candidate.playerId === playerId)
      if (row) return row
    }
    return null
  }

  for (const rows of state.ffaColumns()) {
    const row = rows.find(candidate => candidate.playerId === playerId)
    if (row) return row
  }
  return null
}

function formatTeamBalanceRange(summary: LobbyBalanceTeamSummary): string | null {
  if (summary.uncertainty < 0.01) return null

  const lower = Math.round(Math.max(0, summary.probability - summary.uncertainty) * 100)
  const upper = Math.round(Math.min(1, summary.probability + summary.uncertainty) * 100)
  if (lower === upper) return null
  return `${lower}-${upper}%`
}

function formatProjectedWinDelta(summary: LobbyBalanceTeamSummary): string | null {
  if (!summary.projectedWinDelta) return null
  return formatSignedPublicRatingDelta(summary.projectedWinDelta.publicRatingDelta)
}

function formatSignedPublicRatingDelta(publicRatingDelta: number): string {
  if (publicRatingDelta !== 0 && Math.abs(publicRatingDelta) < 1) {
    const visible = Math.max(0.1, Math.round(Math.abs(publicRatingDelta) * 10) / 10)
    return `${publicRatingDelta > 0 ? '+' : '-'}${visible.toFixed(1)}`
  }
  const rounded = Math.round(publicRatingDelta)
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

function formatTeamBalanceTitle(summary: LobbyBalanceTeamSummary, team: number): string {
  const teamLabel = `Team ${String.fromCharCode(65 + team)}`
  const range = formatTeamBalanceRange(summary)
  const chanceText = `Win chance: ${Math.round(summary.probability * 100)}%${range ? ` (${range})` : ''}.`

  if (!summary.projectedWinDelta) return chanceText

  const delta = formatSignedPublicRatingDelta(summary.projectedWinDelta.publicRatingDelta)
  return `${chanceText} ${delta} RP is your rating change if ${teamLabel} wins.`
}

function getArrangeOverlayIconClass(strategy: LobbyArrangeStrategy | null) {
  switch (strategy) {
    case 'balance':
      return 'i-ph:scales-bold'
    case 'shuffle-teams':
      return 'i-ph:arrows-clockwise-bold'
    default:
      return 'i-ph:shuffle-simple-bold'
  }
}

function DraftSetupPlayerColumn(props: ReturnType<typeof createPlayerColumnProps>) {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.rows}>
        {row => (
          <PlayerChip
            row={row}
            pending={props.pending}
            draggable={props.canDragRow(row)}
            allowDrop={props.canDropOnRow(row)}
            dropActive={props.canDropOnRow(row) && props.dragOverSlot === row.slot}
            showJoin={props.canJoinSlot(row)}
            showTransferHost={props.canTransferHostToRow(row)}
            showRemove={props.canRemoveSlot(row)}
            flip={props.flip}
            popoverOpen={props.openPlayerId === row.playerId}
            showSourceGuild={props.showSourceGuild}
            teamUnavailable={row.team != null && !props.canCurrentUserUseTeam(row.team)}
            onJoin={() => props.onJoin(row.slot)}
            onTransferHost={() => { if (row.playerId) props.onTransferHost(row.playerId) }}
            onRemove={() => props.onRemove(row.slot)}
            onOpenPlayer={anchor => props.onOpenPlayer(row, anchor)}
            onClosePlayer={props.onClosePlayer}
            onDragStart={() => props.onDragStart(row.playerId)}
            onDragEnd={props.onDragEnd}
            onDragEnter={() => props.onDragEnter(row.slot)}
            onDrop={() => props.onDrop(row.slot)}
          />
        )}
      </For>
    </div>
  )
}

function PlayerChip(props: {
  row: PlayerRow
  pending: boolean
  draggable: boolean
  allowDrop: boolean
  dropActive: boolean
  showJoin: boolean
  showTransferHost: boolean
  showRemove: boolean
  flip: PlayerFlipApi
  popoverOpen: boolean
  showSourceGuild: boolean
  teamUnavailable: boolean
  onJoin?: () => void
  onTransferHost?: () => void
  onRemove?: () => void
  onOpenPlayer?: (anchor: HTMLElement) => void
  onClosePlayer?: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragEnter?: () => void
  onDrop?: () => void
}) {
  let chipEl: HTMLDivElement | undefined
  let suppressNextClick = false

  const openPlayer = (anchor: HTMLElement) => {
    if (!props.row.empty && !props.row.pendingSelf && !props.pending) props.onOpenPlayer?.(anchor)
  }

  const handlePrimaryAction = (anchor: HTMLElement, openOnPlayer: boolean) => {
    if (props.row.empty) {
      if (props.showJoin && !props.pending) props.onJoin?.()
      return
    }

    if (openOnPlayer) openPlayer(anchor)
  }

  createEffect(() => {
    const playerId = props.row.playerId
    const el = chipEl
    if (!el || !playerId) return
    props.flip.register(playerId, el)
    onCleanup(() => props.flip.unregister(playerId, el))
  })

  return (
    <div
      ref={chipEl}
      data-slot={props.row.slot}
      class={cn(
        'group flex items-center gap-2 rounded-md px-3 py-2 border transition-colors',
        props.row.empty ? 'bg-white/4 text-fg-subtle border-transparent' : 'bg-white/8 border-transparent',
        props.row.pendingSelf && 'opacity-45',
        props.row.empty && props.teamUnavailable && 'opacity-45 cursor-not-allowed',
        props.row.empty && props.showJoin && !props.pending && 'hover:bg-white/8 cursor-pointer',
        !props.row.empty && !props.draggable && !props.row.pendingSelf && 'hover:bg-white/10 cursor-pointer',
        !props.row.empty && !props.draggable && !props.showRemove && !props.row.pendingSelf && 'cursor-default',
        props.draggable && !props.pending && 'cursor-grab active:cursor-grabbing',
        props.dropActive && 'border-accent/65 border-dashed bg-accent/8',
      )}
      role={props.row.empty && !props.showJoin ? undefined : 'button'}
      tabIndex={(props.row.empty && !props.showJoin) || props.pending ? undefined : 0}
      aria-haspopup={!props.row.empty ? 'dialog' : undefined}
      aria-expanded={!props.row.empty ? props.popoverOpen : undefined}
      title={props.row.empty && props.teamUnavailable ? 'This team is locked to another server.' : undefined}
      onPointerEnter={(event) => openPlayer(event.currentTarget)}
      onPointerLeave={() => props.onClosePlayer?.()}
      onFocus={(event) => openPlayer(event.currentTarget)}
      onBlur={() => props.onClosePlayer?.()}
      onClick={(event) => {
        if (suppressNextClick) {
          suppressNextClick = false
          event.preventDefault()
          return
        }
        handlePrimaryAction(event.currentTarget, false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        handlePrimaryAction(event.currentTarget, true)
      }}
      draggable={props.draggable && !props.pending}
      onDragStart={(event) => {
        if (!event.dataTransfer) return
        suppressNextClick = true
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', props.row.playerId ?? '')
        props.onDragStart?.()
      }}
      onDragEnd={() => props.onDragEnd?.()}
      onDragEnter={() => {
        if (!props.allowDrop) return
        props.onDragEnter?.()
      }}
      onDragOver={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        props.onDrop?.()
      }}
    >
      {/* Keep row-level drag handlers; drop events still bubble from nested content. */}
      <div class="flex shrink-0 h-5 w-5 items-center justify-center">
        <Show when={!props.row.empty && props.row.avatarUrl} fallback={<div class="i-ph-user-bold text-sm text-fg-subtle" />}>
          {avatar => (
            <img
              src={avatar()}
              alt={props.row.name}
              draggable={false}
              class="rounded-full h-5 w-5 pointer-events-none object-cover"
            />
          )}
        </Show>
      </div>

      <Show when={props.showSourceGuild && !props.row.empty && props.row.sourceGuild}>
        {guild => (
          <Show
            when={guild().iconUrl}
            fallback={<span role="img" aria-label={guild().name || `Server ${guild().id}`} title={guild().name || `Server ${guild().id}`} class="rounded-sm bg-white/12 text-[7px] text-fg-subtle font-bold shrink-0 inline-flex h-4 w-4 items-center justify-center">{(guild().name || 'S').slice(0, 1).toUpperCase()}</span>}
          >
            {iconUrl => <img src={iconUrl()} alt={guild().name || `Server ${guild().id}`} title={guild().name || `Server ${guild().id}`} draggable={false} class="rounded-sm shrink-0 h-4 w-4 object-cover" />}
          </Show>
        )}
      </Show>

      <span class="text-sm flex-1 truncate">{props.row.name}</span>

      <Show when={props.row.empty && props.teamUnavailable}>
        <span class="i-ph:lock-simple-bold text-xs text-fg-subtle" aria-hidden />
      </Show>

      <Show when={!props.row.pendingSelf && !props.showJoin && !props.showRemove && props.row.isHost}>
        <span class="text-[10px] text-accent tracking-wider font-bold uppercase">Host</span>
      </Show>

      <Show when={props.showJoin && !props.pending}>
        <button
          type="button"
          title="Join lobby"
          class="text-fg-muted rounded-sm opacity-0 flex h-5 w-5 cursor-pointer transition-opacity items-center justify-center hover:text-fg hover:bg-white/8 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onJoin?.()
          }}
        >
          <span class="i-ph-plus-bold text-xs" />
        </button>
      </Show>

      <Show when={(props.showTransferHost || props.showRemove) && !props.pending}>
        <span class="flex items-center gap-0.5">
          <Show when={props.showTransferHost}>
            <button
              type="button"
              title="Make host"
              class="text-fg-muted rounded-sm opacity-0 flex h-5 w-5 cursor-pointer transition-opacity items-center justify-center hover:text-accent hover:bg-white/8 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                props.onTransferHost?.()
              }}
            >
              <span class="i-ph:crown-simple-bold text-xs" />
            </button>
          </Show>

          <Show when={props.showRemove}>
            <button
              type="button"
              title="Remove player"
              class="text-fg-muted rounded-sm opacity-0 flex h-5 w-5 cursor-pointer transition-opacity items-center justify-center hover:text-danger hover:bg-white/8 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                props.onRemove?.()
              }}
            >
              <span class="i-ph-x-bold text-xs" />
            </button>
          </Show>
        </span>
      </Show>
    </div>
  )
}

function resolvePlayerRole(row: PlayerRow, rankedRoles: RankedRoleOptionSnapshot[]): { label: string, style: Record<string, string> } | null {
  if (!row.rankedRole) return null
  const rankedRole = row.rankedRole
  const option = rankedRoles.find(candidate => candidate.tier === rankedRole.tier) ?? null
  return {
    label: option?.label ?? formatLeaderPoolRankLabel(rankedRole.tier),
    style: buildRolePillStyle(option?.color ?? null),
  }
}

function createPlayerColumnProps(
  state: DraftSetupPlayersPanelState,
  rows: PlayerRow[],
  flip: PlayerFlipApi,
  openPlayerId: string | null,
  openPlayerPopover: (row: PlayerRow, anchor: HTMLElement) => void,
  closePlayerPopover: () => void,
  showSourceGuild: boolean,
) {
  return {
    rows,
    flip,
    openPlayerId,
    showSourceGuild,
    pending: state.pending.lobbyAction(),
    dragOverSlot: state.dragOverSlot(),
    canDragRow: state.permissions.canDragRow,
    canDropOnRow: state.permissions.canDropOnRow,
    canJoinSlot: state.permissions.canJoinSlot,
    canCurrentUserUseTeam: state.canCurrentUserUseTeam,
    canTransferHostToRow: state.permissions.canTransferHostToRow,
    canRemoveSlot: state.permissions.canRemoveSlot,
    onJoin: state.actions.join,
    onTransferHost: state.actions.transferHost,
    onRemove: state.actions.remove,
    onOpenPlayer: openPlayerPopover,
    onClosePlayer: closePlayerPopover,
    onDragStart: (playerId: string | null) => {
      closePlayerPopover()
      state.actions.dragStart(playerId)
    },
    onDragEnd: state.actions.dragEnd,
    onDragEnter: state.actions.dragEnter,
    onDrop: state.actions.drop,
  }
}
