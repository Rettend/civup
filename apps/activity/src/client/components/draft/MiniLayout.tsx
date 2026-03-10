import type { JSX } from 'solid-js'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'

export interface MiniSeatItem {
  key: string
  name: string
  avatarUrl?: string | null
  leaderId?: string | null
  team?: number | null
  active?: boolean
  empty?: boolean
}

interface MiniFrameProps {
  modeLabel?: string | null
  title: string
  titleAccent?: 'gold' | 'red'
  rightLabel?: string | null
  children: JSX.Element
}

interface MiniSeatGridProps {
  columns: MiniSeatItem[][]
  activeTone?: 'gold' | 'red'
  footer?: string | null
}

/**
 * Shared frame for all minimized PiP views.
 * Header matches the original MiniView style: flex justify-between, same sizes/colors.
 */
export function MiniFrame(props: MiniFrameProps) {
  const titleColorClass = () => {
    if (props.titleAccent === 'red') return 'text-accent-red'
    if (props.titleAccent === 'gold') return 'text-accent-gold'
    return 'text-accent-gold'
  }

  return (
    <div class="text-text-primary font-sans bg-bg-primary flex h-screen flex-col overflow-hidden p-3">
      <div class="relative h-5 shrink-0">
        <Show when={props.modeLabel}>
          {label => (
            <span class="absolute left-0 top-1/2 max-w-[34%] -translate-y-1/2 truncate text-xs text-text-muted font-medium">
              {label()}
            </span>
          )}
        </Show>

        <span class={cn('absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs tracking-widest font-bold uppercase', titleColorClass())}>
          {props.title}
        </span>

        <Show when={props.rightLabel}>
          {label => (
            <span class="absolute right-0 top-1/2 max-w-[34%] -translate-y-1/2 truncate text-right text-sm text-text-primary font-bold font-mono tabular-nums">
              {label()}
            </span>
          )}
        </Show>
      </div>

      {/* Content */}
      <div class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        {props.children}
      </div>
    </div>
  )
}

export function MiniSeatGrid(props: MiniSeatGridProps) {
  const columnCount = () => Math.max(props.columns.length, 1)

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
      <div
        class="grid min-h-0 flex-1 gap-2 overflow-hidden"
        style={{
          'grid-template-columns': `repeat(${columnCount()}, minmax(0, 1fr))`,
        }}
      >
        <For each={props.columns}>
          {column => (
            <div class="flex min-h-0 flex-col gap-1 overflow-hidden">
              <For each={column}>
                {item => <MiniSeatRow item={item} activeTone={props.activeTone ?? 'gold'} />}
              </For>
            </div>
          )}
        </For>
      </div>

      <Show when={props.footer}>
        {footer => <div class="px-1 text-[9px] text-text-secondary/80 truncate leading-none">{footer()}</div>}
      </Show>
    </div>
  )
}

function MiniSeatRow(props: { item: MiniSeatItem, activeTone: 'gold' | 'red' }) {
  const leaderPortraitUrl = () => {
    const leaderId = props.item.leaderId
    if (!leaderId) return null

    try {
      return getLeader(leaderId).portraitUrl ?? null
    }
    catch {
      return null
    }
  }

  const backgroundClass = () => {
    if (props.item.empty) return 'border border-dashed border-white/8 bg-bg-primary/26'
    return 'border border-white/10 bg-white/6'
  }

  const activeClass = () => {
    if (!props.item.active) return ''
    if (props.activeTone === 'red') return 'border-accent-red/55 shadow-[inset_0_0_0_1px_rgba(232,64,87,0.18)]'
    return 'border-accent-gold/55 shadow-[inset_0_0_0_1px_rgba(200,170,110,0.18)]'
  }

  return (
    <div class={cn('flex h-6 items-center gap-1 overflow-hidden rounded px-1.5', backgroundClass(), activeClass())}>
      {/* Avatar — small, matching leader icon size */}
      <Show
        when={!props.item.empty && props.item.avatarUrl}
        fallback={(
          <div class={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            props.item.empty ? 'bg-white/4 text-text-muted/60' : 'bg-bg-primary/70 text-text-muted/80',
          )}
          >
            <span class="i-ph-user-bold text-[8px]" />
          </div>
        )}
      >
        {avatar => (
          <img
            src={avatar()}
            alt=""
            class="h-4 w-4 shrink-0 rounded-full object-cover"
          />
        )}
      </Show>

      {/* Name */}
      <span class={cn('min-w-0 flex-1 truncate text-[8px] leading-none', props.item.empty ? 'text-text-muted/75' : 'text-text-primary')}>
        {props.item.name}
      </span>

      {/* Leader portrait or active pulse */}
      <Show
        when={leaderPortraitUrl()}
        fallback={(
          <Show
            when={props.item.leaderId}
            fallback={(
              <Show when={props.item.active}>
                <div class="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  <span class={cn(
                    'h-1.5 w-1.5 rounded-full animate-pulse',
                    props.activeTone === 'red' ? 'bg-accent-red' : 'bg-accent-gold',
                  )}
                  />
                </div>
              </Show>
            )}
          >
            <div class="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-bg-primary/80">
              <span class="i-ph-crown-simple-fill text-[8px] text-accent-gold" />
            </div>
          </Show>
        )}
      >
        {portraitUrl => (
          <img
            src={portraitUrl()}
            alt=""
            class="-mr-0.5 h-5 w-5 shrink-0 rounded-full border border-white/10 object-cover"
          />
        )}
      </Show>
    </div>
  )
}
