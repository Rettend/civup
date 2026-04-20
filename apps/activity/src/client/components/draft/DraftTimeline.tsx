import { formatDraftStepLabel } from '@civup/game'
import { createEffect, For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, isMapVotePhase, mapVotePhase } from '~/client/stores'
import { HorizontalScroller } from '../ui'

/** Horizontal step sequence indicator: BAN > PICK T1 > PICK T2 > ... */
export function DraftTimeline() {
  const state = () => draftStore.state
  const steps = () => state()?.steps ?? []
  const hasMapStep = () => mapVotePhase() !== 'idle'
  const timelineSteps = () => {
    const draftSteps = steps().map(step => ({ kind: 'draft' as const, step }))
    return hasMapStep()
      ? [{ kind: 'map' as const }, ...draftSteps]
      : draftSteps
  }
  const currentIdx = () => {
    if (!hasMapStep()) return state()?.currentStepIndex ?? -1
    if (isMapVotePhase()) return 0
    return (state()?.currentStepIndex ?? -1) + 1
  }
  let currentStepRef: HTMLSpanElement | undefined

  createEffect(() => {
    currentIdx()
    currentStepRef?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })

  return (
    <Show when={timelineSteps().length > 0}>
      <HorizontalScroller class="px-4 py-1.5" contentClass="flex w-full items-center justify-center gap-1 whitespace-nowrap">
        <For each={timelineSteps()}>
          {(entry, idx) => {
            const isCurrent = () => idx() === currentIdx()
            const isPast = () => idx() < currentIdx()
            const isBan = () => entry.kind === 'draft' && entry.step.action === 'ban'
            const label = () => entry.kind === 'map' ? 'MAP' : formatDraftStepLabel(entry.step, state()?.seats ?? [])

            return (
              <>
                <Show when={idx() > 0}>
                  <div class={cn('h-px w-3 shrink-0', isPast() ? 'bg-fg-muted/50' : 'bg-fg-muted/30')} />
                </Show>
                <span
                  ref={(element) => {
                    if (!isCurrent()) return
                    currentStepRef = element
                  }}
                  class={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase leading-none whitespace-nowrap',
                    isCurrent() && isBan() && 'bg-danger/20 text-danger',
                    isCurrent() && !isBan() && 'bg-accent/20 text-accent',
                    isPast() && 'text-fg-muted/40',
                    !isCurrent() && !isPast() && 'text-fg-muted/50',
                  )}
                >
                  {label()}
                </span>
              </>
            )
          }}
        </For>
      </HorizontalScroller>
    </Show>
  )
}
