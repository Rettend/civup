import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { createSeatGridLayout } from '~/client/lib/seat-grid'
import { draftStore, isMobileLayout, selectedWinningTeam, userId } from '~/client/stores'
import { PlayerSlot } from './PlayerSlot'

/** Arranges PlayerSlots for team and responsive FFA seat grids. */
export function SlotStrip() {
  const state = () => draftStore.state
  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const seatCount = () => state()?.seats.length ?? 0
  const amHost = () => userId() === draftStore.hostId
  const isTeamResultMode = () => state()?.status === 'complete' && isTeamMode() && amHost()

  const leftSeats = () => {
    const s = state()
    if (!s) return [] as number[]
    return s.seats.map((seat, i) => ({ seat, i })).filter(x => x.seat.team === 0).map(x => x.i)
  }

  const rightSeats = () => {
    const s = state()
    if (!s) return [] as number[]
    return s.seats.map((seat, i) => ({ seat, i })).filter(x => x.seat.team === 1).map(x => x.i)
  }

  const ffaLayout = () => createSeatGridLayout(
    seatCount(),
    isMobileLayout() ? 2 : Math.ceil(seatCount() / 2),
  )

  const teamWrapperClass = (_team: 0 | 1) => {
    return ''
  }

  const teamWrapperOverlayClass = (team: 0 | 1) => {
    if (!isTeamResultMode()) return 'hidden'
    const selectedTeam = selectedWinningTeam()
    if (selectedTeam === team) {
      return 'shadow-[inset_0_0_0_2px_var(--accent-muted),inset_0_0_28px_var(--glow-gold-dim)]'
    }
    if (selectedTeam != null) {
      return 'bg-black/20'
    }
    // No border when nothing is selected yet — overlay stays invisible
    return 'hidden'
  }

  const teamOverlayWidth = (slotCount: number) => {
    if (isMobileLayout()) return '100%'
    // Each .slot-cell is flex: 1 1 0 with max-width: 400px.
    // Inter-slot borders: (N-1) * 1px (border-r on all but last).
    return `min(${slotCount * 400 + Math.max(0, slotCount - 1)}px, 100%)`
  }

  const teamSeatWrapperClass = (align: 'start' | 'end') => cn(
    'relative h-full w-full overflow-hidden transition-all duration-300',
    isMobileLayout()
      ? 'grid gap-0'
      : align === 'end'
        ? 'flex items-stretch justify-end'
        : 'flex items-stretch justify-start',
  )

  const teamSeatWrapperStyle = (seatIndices: number[]) => {
    if (!isMobileLayout()) return undefined

    return {
      'grid-template-columns': 'minmax(0, 1fr)',
      'grid-template-rows': `repeat(${seatIndices.length}, minmax(0, 1fr))`,
    }
  }

  const renderTeamSeats = (team: 0 | 1, seatIndices: number[], align: 'start' | 'end') => (
    <div class={cn('flex flex-1 h-full items-stretch', align === 'end' ? 'justify-end' : 'justify-start')}>
      <div class={cn(teamSeatWrapperClass(align), teamWrapperClass(team))} style={teamSeatWrapperStyle(seatIndices)}>
        <Show when={isTeamResultMode()}>
          <div
            class={cn(
              'pointer-events-none absolute inset-y-0 z-30',
              align === 'end' ? 'right-0' : 'left-0',
              teamWrapperOverlayClass(team),
            )}
            style={{ width: teamOverlayWidth(seatIndices.length) }}
          />
        </Show>
        <Show when={isTeamResultMode() && selectedWinningTeam() === team}>
          <div
            class={cn(
              'flex pointer-events-none items-center inset-y-0 justify-center absolute z-40',
              align === 'end' ? 'right-0' : 'left-0',
            )}
            style={{ width: teamOverlayWidth(seatIndices.length) }}
          >
            <div class="anim-fade-in border rounded-full bg-accent flex h-16 w-16 shadow-[0_4px_12px_rgba(0,0,0,0.5),0_8px_28px_rgba(0,0,0,0.4),0_16px_48px_rgba(0,0,0,0.25)] items-center justify-center" style={{ 'color': 'var(--badge-gold-text)', 'border-color': 'var(--badge-gold-border)' }}>
              <span class="i-ph:trophy-fill text-[30px]" />
            </div>
          </div>
        </Show>
        <Show when={isTeamResultMode() && selectedWinningTeam() === team}>
          <div
            class={cn(
              'anim-fade-in pointer-events-none inset-y-0 absolute z-20',
              align === 'end' ? 'right-0' : 'left-0',
            )}
            style={{ ...winnerGlowStyle, width: teamOverlayWidth(seatIndices.length) }}
          />
        </Show>
        <For each={seatIndices}>
          {seatIdx => (
            <div class={isMobileLayout() ? 'h-full min-h-0 w-full' : 'slot-cell'}>
              <PlayerSlot seatIndex={seatIdx} />
            </div>
          )}
        </For>
      </div>
    </div>
  )

  /** Dramatic golden radial glow — three layers emanating from bottom center */
  const winnerGlowStyle = {
    background: [
      'radial-gradient(ellipse farthest-side at 50% 130%, var(--glow-gold) 0%, var(--glow-gold-dim) 40%, transparent 72%)',
      'radial-gradient(ellipse closest-side at 50% 100%, rgba(255,215,100,0.26) 0%, transparent 55%)',
      'linear-gradient(to top, var(--glow-gold-dim) 0%, transparent 40%)',
    ].join(', '),
  }

  return (
    <div class="flex flex-1 min-h-0 items-end justify-center">
      {/* Team mode layout */}
      {isTeamMode() && (
        <div class={cn('slot-strip-team flex h-full w-full justify-center', isMobileLayout() ? 'items-stretch px-2 py-2' : 'items-end')}>
          {/* Left team */}
          {renderTeamSeats(0, leftSeats(), 'end')}

          {/* Center gap */}
          <div class={cn('flex shrink-0 flex-col items-center self-center justify-center', isMobileLayout() ? 'w-7' : 'w-12')}>
            <span class={cn('text-fg-muted/30 tracking-widest font-bold', isMobileLayout() ? 'text-xs' : 'text-lg')}>VS</span>
          </div>

          {/* Right team */}
          {renderTeamSeats(1, rightSeats(), 'start')}
        </div>
      )}

      {/* FFA layout */}
      {!isTeamMode() && seatCount() > 0 && (
        <div class="slot-strip-ffa flex h-full w-full items-end justify-center">
          <div
            class="grid h-full items-stretch justify-center"
            style={{
              'width': `min(100%, ${ffaLayout().columns * (isMobileLayout() ? 220 : 240)}px)`,
              'grid-template-columns': `repeat(${ffaLayout().columns}, minmax(0, 1fr))`,
              'grid-template-rows': `repeat(${ffaLayout().rows}, minmax(0, 1fr))`,
            }}
          >
            <For each={ffaLayout().cells}>
              {seatIdx => (
                <div class="slot-cell-ffa h-full min-h-0 w-full">
                  <Show when={seatIdx != null}>
                    <PlayerSlot seatIndex={seatIdx!} compact />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </div>
  )
}
