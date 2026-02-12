import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore } from '~/client/stores'

/** Horizontal step sequence indicator: BAN > PICK T1 > PICK T2 > ... */
export function DraftTimeline() {
  const state = () => draftStore.state
  const steps = () => state()?.steps ?? []
  const currentIdx = () => state()?.currentStepIndex ?? -1
  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false

  /** Label for a step */
  const stepLabel = (step: { action: 'pick' | 'ban', seats: number[] | 'all' }): string => {
    if (step.action === 'ban') return 'BAN'

    if (step.seats === 'all') return 'PICK'

    // FFA: P1, P2...
    if (!isTeamMode()) {
      return step.seats.length === 1 ? `PICK P${step.seats[0]! + 1}` : 'PICK'
    }

    // Team mode: T1, T2...
    return step.seats.map(s => `PICK T${s + 1}`).join(' & ')
  }

  return (
    <Show when={steps().length > 0}>
      <div class="px-4 py-1.5 flex gap-1 items-center justify-center">
        <For each={steps()}>
          {(step: { action: 'pick' | 'ban', seats: number[] | 'all', count: number }, idx) => {
            const isCurrent = () => idx() === currentIdx()
            const isPast = () => idx() < currentIdx()
            const isBan = () => step.action === 'ban'

            return (
              <>
                <Show when={idx() > 0}>
                  <div class={cn('h-px w-3 shrink-0', isPast() ? 'bg-text-muted/50' : 'bg-text-muted/30')} />
                </Show>
                <span class={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase leading-none whitespace-nowrap',
                  isCurrent() && isBan() && 'bg-accent-red/20 text-accent-red',
                  isCurrent() && !isBan() && 'bg-accent-gold/20 text-accent-gold',
                  isPast() && 'text-text-muted/40',
                  !isCurrent() && !isPast() && 'text-text-muted/50',
                )}
                >
                  {stepLabel(step)}
                </span>
              </>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
