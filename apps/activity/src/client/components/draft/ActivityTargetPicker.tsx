import type { ActivityTargetOption } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { For, Show } from 'solid-js'
import { Button } from '~/client/components/ui'
import { cn } from '~/client/lib/css'

interface ActivityTargetPickerProps {
  options: ActivityTargetOption[]
  busy?: boolean
  selectedKey?: string | null
  title?: string
  subtitle?: string
  onSelect: (option: ActivityTargetOption) => void
  onClose?: () => void
  closeLabel?: string
}

export function ActivityTargetPicker(props: ActivityTargetPickerProps) {
  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-[11px] text-text-muted tracking-[0.18em] font-semibold uppercase">Activity Targets</div>
          <h1 class="text-2xl text-heading font-semibold mt-1">{props.title ?? 'Pick a lobby or live draft'}</h1>
          <Show when={props.subtitle}>
            <p class="text-sm text-text-secondary mt-2">{props.subtitle}</p>
          </Show>
        </div>

        <Show when={props.onClose}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => props.onClose?.()}
          >
            {props.closeLabel ?? 'Close'}
          </Button>
        </Show>
      </div>

      <Show
        when={props.options.length > 0}
        fallback={(
          <div class="rounded-2xl border border-white/8 bg-bg-secondary/90 px-6 py-8 text-center">
            <div class="text-lg text-text-primary font-semibold">No active lobbies right now</div>
            <div class="mt-2 text-sm text-text-secondary">
              Use <code class="text-accent-gold">/match create</code> in Discord to open a new lobby in this channel.
            </div>
          </div>
        )}
      >
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <For each={props.options}>
            {option => {
              const selected = () => props.selectedKey === activityTargetOptionKey(option)

              return (
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onSelect(option)}
                  class={cn(
                    'group flex flex-col gap-4 rounded-xl border p-4 text-left transition-all duration-150 cursor-pointer',
                    'bg-bg-secondary/95 border-white/8 hover:border-accent-gold/40 hover:bg-bg-secondary',
                    'disabled:opacity-60 disabled:cursor-wait',
                    selected() && 'border-accent-gold/60 bg-accent-gold/8 shadow-[0_0_0_1px_rgba(200,170,110,0.2)]',
                  )}
                >
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-[11px] text-accent-gold tracking-[0.16em] font-semibold uppercase">
                        {formatModeLabel(option.mode, option.mode)}
                      </div>
                      <div class="text-lg text-text-primary font-semibold mt-1">{formatTargetTitle(option)}</div>
                    </div>

                    <div class="flex flex-col items-end gap-1">
                      <span class={cn(
                        'px-2 py-1 rounded-full text-[10px] tracking-[0.14em] font-semibold uppercase',
                        option.kind === 'lobby'
                          ? 'bg-[#2563eb]/15 text-[#93c5fd]'
                          : option.status === 'drafting'
                            ? 'bg-[#0ea5a4]/15 text-[#99f6e4]'
                            : 'bg-[#d97706]/15 text-[#fcd34d]',
                      )}
                      >
                        {formatTargetStatus(option)}
                      </span>
                      <Show when={option.isHost || option.isMember}>
                        <span class="px-2 py-1 rounded-full text-[10px] tracking-[0.14em] font-semibold uppercase bg-white/6 text-text-secondary">
                          {option.isHost ? 'You are hosting' : 'You are in this'}
                        </span>
                      </Show>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1 text-sm text-text-secondary">
                    <span>{formatTargetCapacity(option)}</span>
                    <span>{option.kind === 'lobby' ? 'Open this waiting room in the shared activity.' : 'Spectate or rejoin this live draft.'}</span>
                  </div>

                  <div class="flex items-center justify-between text-xs text-text-muted">
                    <span>{selected() ? 'Currently selected' : 'Switch activity target'}</span>
                    <span class="i-ph-arrow-right text-sm transition-transform group-hover:translate-x-0.5" />
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
  return 'Active'
}

function formatTargetCapacity(option: ActivityTargetOption): string {
  return `${option.participantCount}/${option.targetSize} players`
}
