import type { PlayerRow } from './helpers'
import type { useDraftSetupState } from './useDraftSetupState'
import type { LobbyArrangeStrategy } from '~/client/stores'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'

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

export function DraftSetupPlayersPanel(props: { state: DraftSetupPlayersPanelState }) {
  const state = () => props.state

  const elementsByPlayer = new Map<string, HTMLElement>()
  const prevRectByPlayer = new Map<string, DOMRect>()
  const [arrangeOverlayActive, setArrangeOverlayActive] = createSignal(false)
  const [arrangeOverlayStrategy, setArrangeOverlayStrategy] = createSignal<LobbyArrangeStrategy | null>(null)
  let arrangeOverlayTimeout: ReturnType<typeof setTimeout> | null = null
  let armedArrangeKey: string | null = null
  let lastSeenArrangeKey: string | null = null
  let hasInitializedArrangeKey = false
  let lastRenderSignature: string | null = null

  const pendingArrangeStrategy = () => state().pendingArrangeStrategy?.() ?? null
  const overlayActive = () => arrangeOverlayActive() || pendingArrangeStrategy() != null
  const overlayStrategy = () => pendingArrangeStrategy() ?? arrangeOverlayStrategy()

  const flip: PlayerFlipApi = {
    register: (playerId, element) => {
      elementsByPlayer.set(playerId, element)
    },
    unregister: (playerId, element) => {
      if (elementsByPlayer.get(playerId) === element) elementsByPlayer.delete(playerId)
    },
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

  onCleanup(() => {
    if (arrangeOverlayTimeout) clearTimeout(arrangeOverlayTimeout)
    elementsByPlayer.clear()
    prevRectByPlayer.clear()
  })

  return (
    <div class="relative">
      <Show
        when={state().isTeamMode()}
        fallback={(
          <div class="gap-3 grid grid-cols-2">
            <For each={state().ffaColumns()}>
              {rows => <DraftSetupPlayerColumn {...createPlayerColumnProps(state(), rows, flip)} />}
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
                <div class="mb-2 flex items-center justify-between gap-3">
                  <div class="text-xs text-accent tracking-wider font-bold">
                    Team{' '}{String.fromCharCode(65 + team)}
                  </div>
                  <Show when={state().teamBalance(team)}>
                    {summary => (
                      <div class="text-[11px] text-right text-accent font-semibold whitespace-nowrap">
                        {Math.round(summary().probability * 100)}%
                        <Show when={summary().uncertainty >= 0.01}>
                          <span class="ml-1 text-fg-subtle font-normal">
                            ±{Math.round(summary().uncertainty * 100)}
                          </span>
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
                <DraftSetupPlayerColumn
                  {...createPlayerColumnProps(state(), state().teamRows(team), flip)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>

      <div
        aria-hidden
        class={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300',
          overlayActive() ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div class="absolute inset-0 bg-bg/14" />
        <div
          class="h-64 w-64 absolute rounded-full"
          style={{
            'background': 'radial-gradient(circle, rgba(9, 9, 11, 0.78) 0%, rgba(9, 9, 11, 0.4) 38%, rgba(9, 9, 11, 0) 72%)',
            'filter': 'blur(12px)',
          }}
        />
        <span
          class={cn(getArrangeOverlayIconClass(overlayStrategy()), 'relative text-5xl')}
          style={{
            'color': '#b69a5c',
            'filter': 'drop-shadow(0 2px 10px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 22px rgba(200, 170, 110, 0.45))',
          }}
        />
      </div>
    </div>
  )
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
            showRemove={props.canRemoveSlot(row)}
            flip={props.flip}
            onJoin={() => props.onJoin(row.slot)}
            onRemove={() => props.onRemove(row.slot)}
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
  showRemove: boolean
  flip: PlayerFlipApi
  onJoin?: () => void
  onRemove?: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragEnter?: () => void
  onDrop?: () => void
}) {
  let chipEl: HTMLDivElement | undefined

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
        props.row.empty && props.showJoin && !props.pending && 'hover:bg-white/8 cursor-pointer',
        props.draggable && !props.pending && 'cursor-grab active:cursor-grabbing',
        props.dropActive && 'border-accent/65 border-dashed bg-accent/8',
      )}
      onClick={() => { if (props.showJoin && !props.pending) props.onJoin?.() }}
      draggable={props.draggable && !props.pending}
      onDragStart={(event) => {
        if (!event.dataTransfer) return
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

      <span class="text-sm flex-1 truncate">{props.row.name}</span>

      <Show when={props.showJoin && !props.pending}>
        <button
          class="text-fg-muted rounded-sm opacity-0 flex h-5 w-5 transition-opacity items-center justify-center hover:text-fg hover:bg-white/8 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onJoin?.()
          }}
        >
          <span class="i-ph-plus-bold text-xs" />
        </button>
      </Show>

      <Show when={props.showRemove && !props.pending}>
        <button
          class="text-fg-muted rounded-sm opacity-0 flex h-5 w-5 transition-opacity items-center justify-center hover:text-danger hover:bg-white/8 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onRemove?.()
          }}
        >
          <span class="i-ph-x-bold text-xs" />
        </button>
      </Show>

      <Show when={!props.row.pendingSelf && !props.showJoin && !props.showRemove && props.row.isHost}>
        <span class="text-[10px] text-accent tracking-wider font-bold uppercase">Host</span>
      </Show>
    </div>
  )
}

function createPlayerColumnProps(state: DraftSetupPlayersPanelState, rows: PlayerRow[], flip: PlayerFlipApi) {
  return {
    rows,
    flip,
    pending: state.pending.lobbyAction(),
    dragOverSlot: state.dragOverSlot(),
    canDragRow: state.permissions.canDragRow,
    canDropOnRow: state.permissions.canDropOnRow,
    canJoinSlot: state.permissions.canJoinSlot,
    canRemoveSlot: state.permissions.canRemoveSlot,
    onJoin: state.actions.join,
    onRemove: state.actions.remove,
    onDragStart: state.actions.dragStart,
    onDragEnd: state.actions.dragEnd,
    onDragEnter: state.actions.dragEnter,
    onDrop: state.actions.drop,
  }
}
