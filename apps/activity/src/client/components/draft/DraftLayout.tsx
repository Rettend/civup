import { For, Show } from 'solid-js'
import { draftStore } from '~/client/stores'
import { ActionBar } from './ActionBar'
import { LeaderDetail } from './LeaderDetail'
import { LeaderGrid } from './LeaderGrid'
import { TeamPanel } from './TeamPanel'
import { TopBar } from './TopBar'

export function DraftLayout() {
  const state = () => draftStore.state
  const seatCount = () => state()?.seats.length ?? 0
  const isTeamMode = () => seatCount() === 2 && state()?.seats.some(s => s.team != null)

  return (
    <div class="h-screen flex flex-col overflow-hidden bg-bg-primary text-text-primary font-sans">
      <TopBar />

      <div class="relative min-h-0 flex flex-1">
        {/* Team mode: 2-panel layout */}
        <Show when={isTeamMode()}>
          {/* Team A */}
          <div class="w-56 overflow-y-auto border-r border-border-subtle">
            <TeamPanel seatIndex={0} side="left" />
          </div>

          {/* Center: Leader Grid */}
          <div class="min-w-0 flex-1">
            <LeaderGrid />
          </div>

          {/* Team B */}
          <div class="w-56 overflow-y-auto border-l border-border-subtle">
            <TeamPanel seatIndex={1} side="right" />
          </div>
        </Show>

        {/* FFA / non-team: panels on top/sides, grid center */}
        <Show when={!isTeamMode() && seatCount() > 0}>
          <div class="min-h-0 flex flex-1 flex-col">
            {/* Player slots bar */}
            <div class="flex items-center justify-center gap-2 overflow-x-auto border-b border-border-subtle px-4 py-2">
              <For each={state()?.seats}>
                {(seat, i) => (
                  <FfaSeatChip
                    name={seat.displayName}
                    seatIndex={i()}
                    isActive={isSeatActiveInCurrentStep(i())}
                    pick={state()?.picks.find(p => p.seatIndex === i())?.civId ?? null}
                  />
                )}
              </For>
            </div>

            {/* Leader Grid */}
            <div class="min-h-0 flex-1">
              <LeaderGrid />
            </div>
          </div>
        </Show>

        {/* Leader detail overlay (slides in from right on hover) */}
        <LeaderDetail />
      </div>

      <ActionBar />
    </div>
  )
}

// ── FFA Seat Chip ────────────────────────────────────────────

interface FfaSeatChipProps {
  name: string
  seatIndex: number
  isActive: boolean
  pick: string | null
}

function FfaSeatChip(props: FfaSeatChipProps) {
  return (
    <div
      class={` flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${props.isActive
        ? 'bg-accent-gold/20 text-accent-gold border border-accent-gold/30'
        : props.pick
          ? 'bg-bg-panel text-text-primary border border-border-subtle'
          : 'bg-bg-panel text-text-muted border border-transparent'
      }  `}
    >
      <span>{props.name}</span>
      <Show when={props.pick}>
        <span class="text-accent-gold">
          (
          {props.pick}
          )
        </span>
      </Show>
    </div>
  )
}

// ── Helper ──────────────────────────────────────────────────

function isSeatActiveInCurrentStep(seatIndex: number): boolean {
  const state = draftStore.state
  if (!state || state.status !== 'active') return false
  const step = state.steps[state.currentStepIndex]
  if (!step) return false
  if (step.seats === 'all') return true
  return step.seats.includes(seatIndex)
}
