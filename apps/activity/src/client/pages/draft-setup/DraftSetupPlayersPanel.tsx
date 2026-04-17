import type { PlayerRow } from './helpers'
import type { useDraftSetupState } from './useDraftSetupState'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'

type DraftSetupPlayersPanelState = ReturnType<typeof useDraftSetupState>['players']

export function DraftSetupPlayersPanel(props: { state: DraftSetupPlayersPanelState }) {
  const state = () => props.state
  return (
    <Show
      when={state().isTeamMode()}
      fallback={(
        <div class="gap-3 grid grid-cols-2">
          <For each={state().ffaColumns()}>
            {rows => <DraftSetupPlayerColumn {...createPlayerColumnProps(state(), rows)} />}
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
                {...createPlayerColumnProps(state(), state().teamRows(team))}
                showPremadeLinks
              />
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function DraftSetupPlayerColumn(props: ReturnType<typeof createPlayerColumnProps> & { showPremadeLinks?: boolean }) {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.rows}>
        {(row, index) => {
          const nextRow = () => props.rows[index() + 1] ?? null
          return (
            <>
              <PlayerChip
                row={row}
                pending={props.pending}
                draggable={props.canDragRow(row)}
                allowDrop={props.canDropOnRow(row)}
                dropActive={props.canDropOnRow(row) && props.dragOverSlot === row.slot}
                showJoin={props.canJoinSlot(row)}
                showRemove={props.canRemoveSlot(row)}
                onJoin={() => props.onJoin(row.slot)}
                onRemove={() => props.onRemove(row.slot)}
                onDragStart={() => props.onDragStart(row.playerId)}
                onDragEnd={props.onDragEnd}
                onDragEnter={() => props.onDragEnter(row.slot)}
                onDrop={() => props.onDrop(row.slot)}
              />
              <Show when={props.showPremadeLinks && nextRow()}>
                {next => {
                  const linked = () => props.areRowsPremadeLinked(row, next())
                  const canToggle = () => props.canTogglePremadeLink(row, next())
                  return (
                    <PremadeLinkButton
                      linked={linked()}
                      interactive={canToggle()}
                      pending={props.pendingWithActions}
                      title={linked() ? 'Unlink premade' : 'Link premade'}
                      onToggle={() => props.onTogglePremadeLink(row, next())}
                    />
                  )
                }}
              </Show>
            </>
          )
        }}
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
  onJoin?: () => void
  onRemove?: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragEnter?: () => void
  onDrop?: () => void
}) {
  return (
    <div
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

function PremadeLinkButton(props: {
  linked: boolean
  interactive: boolean
  pending: boolean
  title: string
  onToggle?: () => void
}) {
  return (
    <button
      type="button"
      class={cn(
        'group flex h-2 w-full items-center justify-center rounded-sm transition-colors',
        props.interactive && !props.pending ? 'cursor-pointer hover:bg-white/3' : 'cursor-default',
        props.pending && 'pointer-events-none',
      )}
      disabled={!props.interactive || props.pending}
      title={props.title}
      aria-label={props.title}
      onClick={() => props.onToggle?.()}
    >
      <span
        class={cn(
          'h-[2px] w-12 rounded-full transition-colors',
          props.linked
            ? props.interactive && !props.pending
              ? 'bg-accent/55 group-hover:bg-accent/65'
              : 'bg-accent/50'
            : props.interactive
              ? 'bg-white/16 group-hover:bg-white/28'
              : 'bg-white/6',
        )}
      />
    </button>
  )
}

function createPlayerColumnProps(state: DraftSetupPlayersPanelState, rows: PlayerRow[]) {
  return {
    rows,
    pending: state.pending.lobbyAction(),
    pendingWithActions: state.pending.lobbyAction() || state.pending.start() || state.pending.cancel(),
    dragOverSlot: state.dragOverSlot(),
    canDragRow: state.permissions.canDragRow,
    canDropOnRow: state.permissions.canDropOnRow,
    canJoinSlot: state.permissions.canJoinSlot,
    canRemoveSlot: state.permissions.canRemoveSlot,
    areRowsPremadeLinked: state.permissions.areRowsPremadeLinked,
    canTogglePremadeLink: state.permissions.canTogglePremadeLink,
    onJoin: state.actions.join,
    onRemove: state.actions.remove,
    onDragStart: state.actions.dragStart,
    onDragEnd: state.actions.dragEnd,
    onDragEnter: state.actions.dragEnter,
    onDrop: state.actions.drop,
    onTogglePremadeLink: state.actions.togglePremadeLink,
  }
}
