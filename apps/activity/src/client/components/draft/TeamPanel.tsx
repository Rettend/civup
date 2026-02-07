import type { DraftSeat, DraftSelection } from '@civup/game'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/cn'
import { draftStore } from '~/client/stores'

interface TeamPanelProps {
  /** Which side: left = Team A (seat 0), right = Team B (seat 1). For FFA, seat index. */
  seatIndex: number
  /** Panel position for mirror styling */
  side: 'left' | 'right'
}

export function TeamPanel(props: TeamPanelProps) {
  const state = () => draftStore.state

  const seat = (): DraftSeat | null => {
    return state()?.seats[props.seatIndex] ?? null
  }

  const picks = (): DraftSelection[] => {
    return state()?.picks.filter(p => p.seatIndex === props.seatIndex) ?? []
  }

  const bans = (): DraftSelection[] => {
    return state()?.bans.filter(b => b.seatIndex === props.seatIndex) ?? []
  }

  /** Whether this seat is currently active */
  const isActive = (): boolean => {
    const s = state()
    if (!s || s.status !== 'active') return false
    const step = s.steps[s.currentStepIndex]
    if (!step) return false
    if (step.seats === 'all') return true
    return step.seats.includes(props.seatIndex)
  }

  return (
    <div
      class={cn(
        'flex flex-col h-full p-4 min-w-48',
        props.side === 'right' && 'items-end text-right',
      )}
    >
      {/* Team header */}
      <div
        class={cn(
          'text-heading text-sm mb-4 pb-2 border-b',
          isActive() ? 'text-accent-gold border-accent-gold/30' : 'text-text-muted border-border-subtle',
        )}
      >
        <Show when={seat()} fallback={`Seat ${props.seatIndex + 1}`}>
          {s => (
            <span>
              {s().team != null ? `Team ${props.seatIndex === 0 ? 'A' : 'B'}` : s().displayName}
            </span>
          )}
        </Show>
      </div>

      {/* Players in this seat (for teams, show player names) */}
      <Show when={seat()?.team != null}>
        <div class="mb-3 flex flex-col gap-1">
          <For each={state()?.seats.filter(s => s.team === props.seatIndex)}>
            {player => (
              <span class="text-xs text-text-secondary">{player.displayName}</span>
            )}
          </For>
        </div>
      </Show>

      {/* Picks */}
      <div class="flex flex-1 flex-col gap-2">
        <For each={picks()}>
          {(pick) => {
            const leader = () => {
              try { return getLeader(pick.civId) }
              catch { return null }
            }
            return (
              <div
                class={cn(
                  'panel px-3 py-2 flex items-center gap-2',
                  props.side === 'right' && 'flex-row-reverse',
                )}
              >
                {/* Portrait placeholder */}
                <div class="h-10 w-10 flex flex-shrink-0 items-center justify-center overflow-hidden rounded bg-bg-secondary">
                  <Show
                    when={leader()?.portraitUrl}
                    fallback={(
                      <span class="text-xs text-accent-gold font-bold">
                        {(leader()?.name ?? pick.civId).slice(0, 2).toUpperCase()}
                      </span>
                    )}
                  >
                    {url => <img src={url()} class="h-full w-full object-cover" alt={leader()?.name} />}
                  </Show>
                </div>
                <div class="min-w-0 flex flex-col">
                  <span class="truncate text-sm text-text-primary font-medium">
                    {leader()?.name ?? pick.civId}
                  </span>
                  <span class="truncate text-xs text-text-muted">
                    {leader()?.civilization ?? ''}
                  </span>
                </div>
              </div>
            )
          }}
        </For>

        {/* Empty pick slots */}
        <For each={Array.from({ length: getExpectedPicks(props.seatIndex) - picks().length })}>
          {() => (
            <div
              class={cn(
                'border border-dashed border-border-subtle rounded-lg px-3 py-2 h-14',
                'flex items-center justify-center',
              )}
            >
              <span class="text-xs text-text-muted">—</span>
            </div>
          )}
        </For>
      </div>

      {/* Bans */}
      <Show when={bans().length > 0}>
        <div class="mt-4 border-t border-border-subtle pt-3">
          <div class="mb-2 text-xs text-text-muted tracking-wider uppercase">Bans</div>
          <div class={cn('flex gap-1 flex-wrap', props.side === 'right' && 'justify-end')}>
            <For each={bans()}>
              {(ban) => {
                const leader = () => {
                  try { return getLeader(ban.civId) }
                  catch { return null }
                }
                return (
                  <div
                    class="h-8 w-8 flex items-center justify-center border border-accent-red/30 rounded bg-accent-red/10"
                    title={leader()?.name ?? ban.civId}
                  >
                    <span class="text-xs text-accent-red font-bold line-through">
                      {(leader()?.name ?? ban.civId).slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** Estimate how many picks this seat will make across all steps */
function getExpectedPicks(seatIndex: number): number {
  const state = draftStore.state
  if (!state) return 0
  let count = 0
  for (const step of state.steps) {
    if (step.action !== 'pick') continue
    if (step.seats === 'all' || step.seats.includes(seatIndex)) {
      count += step.count
    }
  }
  return count
}
