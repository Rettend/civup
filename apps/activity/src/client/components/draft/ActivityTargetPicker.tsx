import type { ActivityTargetOption } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { MiniFrame } from './MiniLayout'

interface ActivityTargetPickerProps {
  mini?: boolean
  error?: string | null
  options: ActivityTargetOption[]
  busy?: boolean
  selectedKey?: string | null
  onSelect: (option: ActivityTargetOption) => void
  onClose?: () => void
}

export function ActivityTargetPicker(props: ActivityTargetPickerProps) {
  if (props.mini) {
    const visibleOptions = () => props.options.slice(0, 4)
    const hiddenCount = () => Math.max(0, props.options.length - visibleOptions().length)

    return (
      <MiniFrame title="Lobby Overview" titleAccent="gold">
        <Show
          when={visibleOptions().length > 0}
          fallback={(
            <div class="border border-white/8 rounded-lg bg-bg-secondary/90 flex flex-1 items-center justify-center px-4 text-center">
              <span class="text-[10px] text-text-secondary">No active lobbies</span>
            </div>
          )}
        >
          <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
            <div class="grid grid-cols-2 gap-1.5">
              <For each={visibleOptions()}>
                {option => (
                  <div class="border border-white/8 rounded bg-bg-secondary/92 flex min-w-0 flex-col gap-1 overflow-hidden px-2 py-1.5">
                    <div class="flex min-w-0 items-center justify-between gap-1">
                      <span class="text-[9px] text-accent-gold truncate tracking-[0.14em] font-semibold uppercase">
                        {formatModeLabel(option.mode, option.mode)}
                      </span>
                      <span class={cn(
                        'text-[8px] font-semibold uppercase shrink-0',
                        option.kind === 'lobby'
                          ? 'text-[#93c5fd]'
                          : option.status === 'drafting'
                            ? 'text-[#99f6e4]'
                            : 'text-[#fcd34d]',
                      )}
                      >
                        {formatMiniTargetStatus(option)}
                      </span>
                    </div>

                    <div class="text-[10px] text-text-secondary flex items-center justify-between gap-1 leading-none">
                      <span>
                        {option.participantCount}
                        /
                        {option.targetSize}
                      </span>
                      <Show when={option.isHost || option.isMember}>
                        <span class="text-[8px] text-accent-gold tracking-[0.1em] font-semibold uppercase">
                          {option.isHost ? 'H' : 'J'}
                        </span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <Show when={hiddenCount() > 0 || props.error}>
              <div class="flex items-center justify-between gap-2 px-1 text-[9px] leading-none">
                <span class="text-text-secondary/80">
                  {hiddenCount() > 0 ? `+${hiddenCount()} more` : ''}
                </span>
                <Show when={props.error}>
                  {error => <span class="text-accent-red truncate">{error()}</span>}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </MiniFrame>
    )
  }

  return (
    <section class="flex flex-col gap-6">
      {/* Header: spacer | title | close button */}
      <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
        <div class="h-9 w-9" />
        <div class="text-center">
          <h1 class="text-2xl text-heading mb-1">Lobby Overview</h1>
          <span class="text-sm text-transparent select-none">&nbsp;</span>
        </div>
        <Show when={props.onClose} fallback={<div class="h-9 w-9" />}>
          <button
            type="button"
            class="text-text-secondary border border-border-subtle rounded-md flex shrink-0 h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-text-primary hover:bg-bg-hover"
            title="Return"
            aria-label="Return"
            onClick={() => props.onClose?.()}
          >
            <span class="i-ph-arrow-right-bold text-base" />
          </button>
        </Show>
      </div>

      <Show
        when={props.options.length > 0}
        fallback={(
          <div class="px-6 py-8 text-center border border-white/8 rounded-2xl bg-bg-secondary/90">
            <div class="text-lg text-text-primary font-semibold">No active lobbies right now</div>
            <div class="text-sm text-text-secondary mt-2">
              Use
              {' '}
              <code class="text-accent-gold">/match create</code>
              {' '}
              in Discord to open a new lobby in this channel.
            </div>
          </div>
        )}
      >
        <div class="gap-3 grid md:grid-cols-2 xl:grid-cols-3">
          <For each={props.options}>
            {(option) => {
              const selected = () => props.selectedKey === activityTargetOptionKey(option)

              return (
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onSelect(option)}
                  class={cn(
                    'group flex flex-col rounded-xl border p-4 text-left transition-all duration-150 cursor-pointer min-h-[120px]',
                    'bg-bg-secondary/95 border-white/8',
                    'disabled:opacity-60 disabled:cursor-wait',
                    selected()
                      ? 'border-accent-gold/60 bg-accent-gold/8 shadow-[0_0_0_1px_rgba(200,170,110,0.2)] hover:border-accent-gold/80 hover:bg-accent-gold/14'
                      : 'hover:border-accent-gold/40 hover:bg-bg-secondary',
                  )}
                >
                  {/* Top: mode + title */}
                  <div class="flex gap-3 items-start justify-between">
                    <div>
                      <div class="text-[11px] text-accent-gold tracking-[0.16em] font-semibold">
                        {formatModeLabel(option.mode, option.mode)}
                      </div>
                      <div class="text-base text-text-primary font-semibold mt-0.5">{formatTargetTitle(option)}</div>
                    </div>

                    <span class={cn(
                      'px-2 py-1 rounded-full text-[10px] tracking-[0.12em] font-semibold uppercase shrink-0',
                      option.kind === 'lobby'
                        ? 'bg-[#2563eb]/15 text-[#93c5fd]'
                        : option.status === 'drafting'
                          ? 'bg-[#0ea5a4]/15 text-[#99f6e4]'
                          : 'bg-[#d97706]/15 text-[#fcd34d]',
                    )}
                    >
                      {formatTargetStatus(option)}
                    </span>
                  </div>

                  {/* Bottom: player count + host/member indicator — pinned to bottom */}
                  <div class="text-sm text-text-secondary mt-auto pt-3 flex items-center justify-between">
                    <span class="flex gap-1.5 items-center">
                      <span class="i-ph:users-duotone text-base" />
                      {option.participantCount}
                      /
                      {option.targetSize}
                    </span>
                    <Show when={option.isHost || option.isMember}>
                      <span class="text-[10px] text-accent-gold tracking-[0.12em] font-semibold uppercase">
                        {option.isHost ? 'Host' : 'Joined'}
                      </span>
                    </Show>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

export function activityTargetOptionKey(option: Pick<ActivityTargetOption, 'kind' | 'id'>): string {
  return `${option.kind}:${option.id}`
}

function formatTargetTitle(option: ActivityTargetOption): string {
  if (option.kind === 'lobby') return 'Lobby'
  return option.status === 'drafting' ? 'Draft' : 'Live Match'
}

function formatTargetStatus(option: ActivityTargetOption): string {
  if (option.kind === 'lobby') return 'Open'
  if (option.status === 'drafting') return 'Drafting'
  return 'Completed'
}

function formatMiniTargetStatus(option: ActivityTargetOption): string {
  if (option.kind === 'lobby') return 'O'
  if (option.status === 'drafting') return 'D'
  return 'C'
}
