import type { ActivityTargetOption } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { isMobileLayout } from '~/client/stores'
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
                      <span class="text-[10px] text-fg tracking-[0.14em] font-bold truncate uppercase">
                        {formatModeLabel(option.mode, option.mode, { redDeath: option.redDeath })}
                      </span>
                      <span class={cn(
                        'text-[6px] font-semibold uppercase shrink-0',
                        option.kind === 'lobby'
                          ? 'text-note'
                          : option.status === 'drafting'
                            ? 'text-info'
                            : 'text-accent',
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

  return (
    <section class={cn('flex flex-col gap-6', isMobileLayout() && 'pt-12')}>
      {/* Header: spacer | title | close button */}
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
            <div class="text-lg text-fg font-semibold">No active lobbies right now</div>
            <div class="text-sm text-fg-muted mt-2">
              Use
              {' '}
              <code class="text-accent">/match create</code>
              {' '}
              to open a new lobby.
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
                    'bg-bg-subtle/95 border-border-subtle',
                    'disabled:opacity-60 disabled:cursor-wait',
                    selected()
                      ? 'border-accent/60 bg-accent/8 shadow-[0_0_0_1px_var(--accent-subtle)] hover:border-accent/80 hover:bg-accent/14'
                      : 'hover:border-accent/40 hover:bg-bg-subtle',
                  )}
                >
                  {/* Top: mode + title */}
                  <div class="flex gap-3 items-start justify-between">
                    <div>
                      <div class="text-[11px] text-accent tracking-[0.16em] font-semibold">
                        {formatModeLabel(option.mode, option.mode, { redDeath: option.redDeath })}
                      </div>
                      <div class="text-base text-fg font-semibold mt-0.5">{formatTargetTitle(option)}</div>
                    </div>

                    <span class={cn(
                      'px-2 py-1 rounded-full text-[8px] tracking-[0.12em] font-semibold uppercase shrink-0',
                      option.kind === 'lobby'
                        ? 'bg-note/15 text-note'
                        : option.status === 'drafting'
                          ? 'bg-info/15 text-info'
                          : 'bg-accent/15 text-accent',
                    )}
                    >
                      {formatTargetStatus(option)}
                    </span>
                  </div>

                  {/* Bottom: player count + host/member indicator — pinned to bottom */}
                  <div class="text-sm text-fg-muted mt-auto pt-3 flex items-center justify-between">
                    <span class="flex gap-1.5 items-center">
                      <span class="i-ph:users-duotone text-base" />
                      {option.participantCount}
                      /
                      {option.targetSize}
                    </span>
                    <Show when={option.isHost || option.isMember}>
                      <span class="text-[10px] text-accent tracking-[0.12em] font-semibold uppercase">
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
  if (option.kind === 'lobby') return 'Open'
  if (option.status === 'drafting') return 'Draft'
  return 'Done'
}
