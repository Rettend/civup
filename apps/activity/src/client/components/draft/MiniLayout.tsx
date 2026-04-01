import type { JSX } from 'solid-js'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import { draftStore } from '~/client/stores'

const MINI_NAME_FADE_STYLE = {
  'mask-image': 'linear-gradient(to right, black calc(100% - 2.5rem), transparent calc(100% - 1.2rem))',
  '-webkit-mask-image': 'linear-gradient(to right, black calc(100% - 2.5rem), transparent calc(100% - 1.2rem))',
}

export interface MiniSeatItem {
  key: string
  name: string
  avatarUrl?: string | null
  leaderId?: string | null
  previewLeaderId?: string | null
  team?: number | null
  active?: boolean
  empty?: boolean
}

interface MiniFrameProps {
  modeLabel?: string | null
  title: string
  titleAccent?: 'gold' | 'red' | 'orange'
  rightLabel?: string | null
  children: JSX.Element
}

interface MiniSeatGridProps {
  columns: MiniSeatItem[][]
  activeTone?: 'gold' | 'red' | 'orange'
  footer?: string | null
}

/**
 * Shared frame for all minimized PiP views.
 * Header matches the original MiniView style: flex justify-between, same sizes/colors.
 */
export function MiniFrame(props: MiniFrameProps) {
  const titleColorClass = () => {
    if (props.titleAccent === 'red') return 'text-danger'
    if (props.titleAccent === 'orange') return 'text-[#f97316]'
    if (props.titleAccent === 'gold') return 'text-accent'
    return 'text-accent'
  }

  return (
    <div class="text-fg font-sans p-3 bg-bg flex flex-col h-screen overflow-hidden">
      <div class="shrink-0 h-5 relative">
        <Show when={props.modeLabel}>
          {label => (
            <span class="text-xs text-fg-subtle font-medium max-w-[34%] truncate left-0 top-1/2 absolute -translate-y-1/2">
              {label()}
            </span>
          )}
        </Show>

        <span class={cn('absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs tracking-widest font-bold uppercase', titleColorClass())}>
          {props.title}
        </span>

        <Show when={props.rightLabel}>
          {label => (
            <span class="text-sm text-fg font-bold font-mono text-right max-w-[34%] truncate right-0 top-1/2 absolute tabular-nums -translate-y-1/2">
              {label()}
            </span>
          )}
        </Show>
      </div>

      {/* Content */}
      <div class="mt-3 flex flex-1 flex-col min-h-0 overflow-hidden">
        {props.children}
      </div>
    </div>
  )
}

export function MiniSeatGrid(props: MiniSeatGridProps) {
  const columnCount = () => Math.max(props.columns.length, 1)

  return (
    <div class="flex flex-1 flex-col gap-1.5 min-h-0 overflow-hidden">
      <div
        class="flex-1 gap-2 grid min-h-0 overflow-hidden"
        style={{
          'grid-template-columns': `repeat(${columnCount()}, minmax(0, 1fr))`,
        }}
      >
        <For each={props.columns}>
          {column => (
            <div class="flex flex-col gap-1 min-h-0 overflow-hidden">
              <For each={column}>
                {item => <MiniSeatRow item={item} activeTone={props.activeTone ?? 'gold'} />}
              </For>
            </div>
          )}
        </For>
      </div>

      <Show when={props.footer}>
        {footer => <div class="text-[9px] text-fg-muted/80 leading-none px-1 truncate">{footer()}</div>}
      </Show>
    </div>
  )
}

function MiniSeatRow(props: { item: MiniSeatItem, activeTone: 'gold' | 'red' | 'orange' }) {
  const leaderPortraitUrl = () => {
    const leaderId = props.item.leaderId ?? props.item.previewLeaderId
    if (!leaderId) return null

    try {
      return getLeader(leaderId, draftStore.leaderDataVersion).portraitUrl ?? null
    }
    catch {
      return null
    }
  }

  const showingPreview = () => !props.item.leaderId && !!props.item.previewLeaderId

  const backgroundClass = () => {
    if (props.item.empty) return 'border border-dashed border-border-subtle bg-bg/26'
    return 'border border-border bg-white/6'
  }

  const activeClass = () => {
    if (!props.item.active) return ''
    if (props.activeTone === 'red') return 'border-danger/55 shadow-[inset_0_0_0_1px_var(--danger-subtle)]'
    if (props.activeTone === 'orange') return 'border-[#f97316]/55 shadow-[inset_0_0_0_1px_rgba(249,115,22,0.15)]'
    return 'border-accent/55 shadow-[inset_0_0_0_1px_var(--accent-subtle)]'
  }

  return (
    <div class={cn('relative flex h-6 items-center gap-1 overflow-hidden rounded px-1.5', backgroundClass(), activeClass())}>
      {/* Avatar — small, matching leader icon size */}
      <Show
        when={!props.item.empty && props.item.avatarUrl}
        fallback={(
          <div class={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            props.item.empty ? 'bg-white/4 text-fg-subtle/60' : 'bg-bg/70 text-fg-subtle/80',
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
            class="rounded-full shrink-0 h-4 w-4 object-cover"
          />
        )}
      </Show>

      {/* Name */}
      <div class="flex-1 min-w-0 overflow-hidden">
        <span
          class={cn('block overflow-hidden whitespace-nowrap text-[6px] leading-none', props.item.empty ? 'text-fg-subtle/75' : 'text-fg')}
          style={MINI_NAME_FADE_STYLE}
        >
          {props.item.name}
        </span>
      </div>

      {/* Leader portrait or active pulse */}
      <div class="flex h-5 w-5 items-center right-1 top-1/2 justify-center absolute -translate-y-1/2">
        <Show
          when={leaderPortraitUrl()}
          fallback={(
            <Show
              when={props.item.leaderId}
              fallback={(
                <Show when={props.item.active}>
                  <div class="flex h-5 w-5 items-center justify-center">
                    <span class={cn(
                      'h-1.5 w-1.5 rounded-full animate-pulse',
                      props.activeTone === 'red' ? 'bg-danger' : props.activeTone === 'orange' ? 'bg-[#f97316]' : 'bg-accent',
                    )}
                    />
                  </div>
                </Show>
              )}
            >
              <div class="border border-border rounded-full bg-bg/80 flex h-5 w-5 items-center justify-center">
                <span class="i-ph-crown-simple-fill text-[8px] text-accent" />
              </div>
            </Show>
          )}
        >
          {portraitUrl => (
            <img
              src={resolveAssetUrl(portraitUrl()) ?? portraitUrl()}
              alt=""
              class={cn(
                'border border-border rounded-full h-5 w-5 object-cover',
                showingPreview() && 'opacity-55 saturate-80',
              )}
            />
          )}
        </Show>
      </div>
    </div>
  )
}
