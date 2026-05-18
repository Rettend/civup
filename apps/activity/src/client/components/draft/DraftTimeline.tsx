import type { DraftState, DraftStep } from '@civup/game'
import { formatDraftStepLabel } from '@civup/game'
import { createEffect, For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, isMapVotePhase, mapVotePhase } from '~/client/stores'
import { HorizontalScroller } from '../ui'

type TimelineEntry = { kind: 'map' } | { kind: 'draft', stepIndex: number, step: DraftStep }

/** Horizontal step sequence indicator: BAN > PICK T1 > PICK T2 > ... */
export function DraftTimeline() {
  const state = () => draftStore.state
  const steps = () => state()?.steps ?? []
  const hasMapStep = () => mapVotePhase() !== 'idle'
  const timelineSteps = (): TimelineEntry[] => {
    const draftSteps = steps().map((step, stepIndex) => ({ kind: 'draft' as const, stepIndex, step }))
    return hasMapStep()
      ? [{ kind: 'map' as const }, ...draftSteps]
      : draftSteps
  }
  const isCurrentEntry = (entry: TimelineEntry) => {
    if (entry.kind === 'map') return isMapVotePhase()
    return !isMapVotePhase() && entry.stepIndex === (state()?.currentStepIndex ?? -1)
  }
  const isPastEntry = (entry: TimelineEntry) => {
    if (entry.kind === 'map') return hasMapStep() && !isMapVotePhase()
    return entry.stepIndex < (state()?.currentStepIndex ?? -1)
  }
  let currentStepRef: HTMLSpanElement | undefined

  createEffect(() => {
    state()?.currentStepIndex
    isMapVotePhase()
    currentStepRef?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })

  return (
    <Show when={timelineSteps().length > 0}>
      <HorizontalScroller class="px-4 py-1.5" contentClass="flex w-full items-center justify-center gap-1 whitespace-nowrap">
        <For each={timelineSteps()}>
          {(entry, idx) => {
            const isCurrent = () => isCurrentEntry(entry)
            const isPast = () => isPastEntry(entry)
            const isBan = () => entry.kind === 'draft' && entry.step.action === 'ban'
            const labels = () => entry.kind === 'map' ? ['MAP'] : getDraftStepTimelineLabels(entry.step, state()?.seats ?? [])

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
                    'shrink-0 rounded inline-flex items-center overflow-hidden text-[10px] font-bold tracking-wide uppercase leading-none whitespace-nowrap',
                    isCurrent() && isBan() && 'bg-danger/20 text-danger',
                    isCurrent() && !isBan() && 'bg-accent/20 text-accent',
                    isPast() && 'text-fg-muted/40',
                    !isCurrent() && !isPast() && 'text-fg-muted/50',
                  )}
                >
                  <For each={labels()}>
                    {(label, labelIdx) => (
                      <>
                        <Show when={labelIdx() > 0}>
                          <span class="h-2.5 w-px bg-current/25" />
                        </Show>
                        <span class="px-1.5 py-0.5">{label}</span>
                      </>
                    )}
                  </For>
                </span>
              </>
            )
          }}
        </For>
      </HorizontalScroller>
    </Show>
  )
}

function getDraftStepTimelineLabels(
  step: DraftStep,
  seats: DraftState['seats'],
): string[] {
  if (!isFusedPickStep(step, seats)) return [formatDraftStepLabel(step, seats)]
  return step.seats.map(seatIndex => formatDraftStepLabel({ ...step, seats: [seatIndex] }, seats))
}

function isFusedPickStep(
  step: DraftStep,
  seats: DraftState['seats'],
): step is typeof step & { seats: number[] } {
  if (step.action !== 'pick') return false
  if (step.seats === 'all' || step.seats.length < 2) return false
  if (step.fallbackForStepIndex != null) return false

  const firstTeam = seats[step.seats[0] ?? -1]?.team
  return firstTeam != null && step.seats.every(seatIndex => seats[seatIndex]?.team === firstTeam)
}
