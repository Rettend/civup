import { formatDraftStepLabel } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore } from '~/client/stores'

/** Horizontal step sequence indicator: BAN > PICK T1 > PICK T2 > ... */
export function DraftTimeline() {
  const state = () => draftStore.state
  const steps = () => state()?.steps ?? []
  const currentIdx = () => state()?.currentStepIndex ?? -1

  return (
    <Show when={steps().length > 0}>
      <div class="px-4 py-1.5 flex gap-1 items-center justify-center">
        <For each={steps()}>
          {(step, idx) => {
            const isCurrent = () => idx() === currentIdx()
            const isPast = () => idx() < currentIdx()
            const isBan = () => step().action === 'ban'

            return (
              <>
                <Show when={idx() > 0}>
                  <div class={cn('h-px w-3 shrink-0', isPast() ? 'bg-fg-muted/50' : 'bg-fg-muted/30')} />
                </Show>
                <span class={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase leading-none whitespace-nowrap',
                  isCurrent() && isBan() && 'bg-danger/20 text-danger',
                  isCurrent() && !isBan() && 'bg-accent/20 text-accent',
                  isPast() && 'text-fg-muted/40',
                  !isCurrent() && !isPast() && 'text-fg-muted/50',
                )}
                >
                  {formatDraftStepLabel(step(), state()?.seats ?? [])}
                </span>
              </>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
