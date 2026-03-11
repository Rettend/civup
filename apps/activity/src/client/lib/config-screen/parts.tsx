import type { MinRoleMismatchDetail, MinRoleSetDetail, PlayerRow } from './helpers'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { buildRolePillStyle } from './helpers'

interface PlayerChipProps {
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
  onDragLeave?: () => void
  onDrop?: () => void
}

interface PremadeLinkButtonProps {
  linked: boolean
  interactive: boolean
  pending: boolean
  title: string
  onToggle?: () => void
}

export function PlayerChip(props: PlayerChipProps) {
  return (
    <div
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
      onDragOver={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        props.onDragEnter?.()
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        props.onDragLeave?.()
      }}
      onDrop={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        props.onDrop?.()
      }}
    >
      <div class="flex shrink-0 h-5 w-5 items-center justify-center">
        <Show
          when={!props.row.empty && props.row.avatarUrl}
          fallback={<div class="i-ph-user-bold text-sm text-fg-subtle" />}
        >
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

export function PremadeLinkButton(props: PremadeLinkButtonProps) {
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

export function ReadonlyTimerRow(props: { label: string, value: string }) {
  return (
    <div class="text-sm px-3 py-2 rounded-md bg-bg/35 flex items-center justify-between">
      <span class="text-fg-muted">{props.label}</span>
      <span class="text-fg font-medium">{props.value}</span>
    </div>
  )
}

export function MinRoleMismatchNotice(props: { detail: MinRoleMismatchDetail }) {
  return (
    <span class="leading-relaxed">
      <strong class="text-fg font-semibold">{props.detail.playerName}</strong>
      {' '}
      does not meet the new min rank
      {' '}
      <span
        class="font-semibold px-1.5 py-0.5 border rounded-sm inline-flex items-center"
        style={buildRolePillStyle(props.detail.roleColor)}
      >
        {props.detail.roleLabel}
      </span>
    </span>
  )
}

export function MinRoleSetNotice(props: { detail: MinRoleSetDetail }) {
  return (
    <span class="leading-relaxed">
      Min rank set to
      {' '}
      <span
        class="font-semibold px-1.5 py-0.5 border rounded-sm inline-flex items-center"
        style={buildRolePillStyle(props.detail.roleColor)}
      >
        {props.detail.roleLabel}
      </span>
    </span>
  )
}
