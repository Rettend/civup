import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, selectedWinningTeam, userId } from '~/client/stores'
import { PlayerSlot } from './PlayerSlot'

/** Arranges PlayerSlots for team (left/right + center gap with "vs") and FFA (2-row grid) */
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

  const ffaTopRow = () => {
    const count = seatCount()
    const perRow = Math.ceil(count / 2)
    return Array.from({ length: perRow }, (_, i) => i)
  }

  const ffaBottomRow = () => {
    const count = seatCount()
    const perRow = Math.ceil(count / 2)
    return Array.from({ length: count - perRow }, (_, i) => perRow + i)
  }

  const teamWrapperClass = (team: 0 | 1) => {
    return ''
  }

  const teamWrapperOverlayClass = (team: 0 | 1) => {
    if (!isTeamResultMode()) return 'hidden'
    const selectedTeam = selectedWinningTeam()
    if (selectedTeam === team) {
      return 'shadow-[inset_0_0_0_2px_rgba(200,170,110,0.58),inset_0_0_28px_rgba(200,170,110,0.14)]'
    }
    if (selectedTeam != null) {
      return 'bg-black/20'
    }
    // No border when nothing is selected yet — overlay stays invisible
    return 'hidden'
  }

  const teamOverlayWidth = (slotCount: number) => {
    // Each .slot-cell is flex: 1 1 0 with max-width: 400px.
    // Inter-slot borders: (N-1) * 1px (border-r on all but last).
    return `min(${slotCount * 400 + Math.max(0, slotCount - 1)}px, 100%)`
  }

  /** Dramatic golden radial glow — three layers emanating from bottom center */
  const winnerGlowStyle = {
    background: [
      'radial-gradient(ellipse farthest-side at 50% 130%, rgba(200,170,110,0.38) 0%, rgba(200,170,110,0.14) 40%, transparent 72%)',
      'radial-gradient(ellipse closest-side at 50% 100%, rgba(255,215,100,0.26) 0%, transparent 55%)',
      'linear-gradient(to top, rgba(200,170,110,0.10) 0%, transparent 40%)',
    ].join(', '),
  }

  return (
    <div class="flex flex-1 min-h-0 items-end justify-center">
      {/* Team mode layout */}
      {isTeamMode() && (
        <div class="slot-strip-team flex h-full w-full items-end justify-center">
          {/* Left team */}
          <div class="flex flex-1 h-full items-stretch justify-end">
            <div class={cn(
              'relative flex h-full w-full items-stretch justify-end overflow-hidden transition-all duration-300',
              teamWrapperClass(0),
            )}
            >
              <Show when={isTeamResultMode()}>
                <div
                  class={cn('pointer-events-none absolute inset-y-0 right-0 z-30', teamWrapperOverlayClass(0))}
                  style={{ width: teamOverlayWidth(leftSeats().length) }}
                />
              </Show>
              <Show when={isTeamResultMode() && selectedWinningTeam() === 0}>
                <div
                  class="pointer-events-none absolute inset-y-0 right-0 z-40 flex items-center justify-center"
                  style={{ width: teamOverlayWidth(leftSeats().length) }}
                >
                  <div class="anim-fade-in flex h-16 w-16 items-center justify-center rounded-full border border-[#f4dca8]/45 bg-accent-gold text-[#17130d] shadow-[0_0_14px_-3px_rgba(200,170,110,0.8),0_0_44px_-8px_rgba(200,170,110,0.45),0_0_80px_-12px_rgba(200,170,110,0.2),0_4px_16px_rgba(0,0,0,0.35)]">
                    <span class="i-ph:trophy-fill text-[30px]" />
                  </div>
                </div>
              </Show>
              {/* Full-width dramatic bottom glow for winning team */}
              <Show when={isTeamResultMode() && selectedWinningTeam() === 0}>
                <div
                  class="anim-fade-in pointer-events-none absolute inset-y-0 right-0 z-20"
                  style={{ ...winnerGlowStyle, width: teamOverlayWidth(leftSeats().length) }}
                />
              </Show>
              <For each={leftSeats()}>
                {seatIdx => (
                  <div class="slot-cell">
                    <PlayerSlot seatIndex={seatIdx} />
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* Center gap */}
          <div class="flex shrink-0 flex-col w-12 items-center self-center justify-center">
            <span class="text-lg text-text-muted/30 tracking-widest font-bold">VS</span>
          </div>

          {/* Right team */}
          <div class="flex flex-1 h-full items-stretch justify-start">
            <div class={cn(
              'relative flex h-full w-full items-stretch justify-start overflow-hidden transition-all duration-300',
              teamWrapperClass(1),
            )}
            >
              <Show when={isTeamResultMode()}>
                <div
                  class={cn('pointer-events-none absolute inset-y-0 left-0 z-30', teamWrapperOverlayClass(1))}
                  style={{ width: teamOverlayWidth(rightSeats().length) }}
                />
              </Show>
              <Show when={isTeamResultMode() && selectedWinningTeam() === 1}>
                <div
                  class="pointer-events-none absolute inset-y-0 left-0 z-40 flex items-center justify-center"
                  style={{ width: teamOverlayWidth(rightSeats().length) }}
                >
                  <div class="anim-fade-in flex h-16 w-16 items-center justify-center rounded-full border border-[#f4dca8]/45 bg-accent-gold text-[#17130d] shadow-[0_0_14px_-3px_rgba(200,170,110,0.8),0_0_44px_-8px_rgba(200,170,110,0.45),0_0_80px_-12px_rgba(200,170,110,0.2),0_4px_16px_rgba(0,0,0,0.35)]">
                    <span class="i-ph:trophy-fill text-[30px]" />
                  </div>
                </div>
              </Show>
              {/* Full-width dramatic bottom glow for winning team */}
              <Show when={isTeamResultMode() && selectedWinningTeam() === 1}>
                <div
                  class="anim-fade-in pointer-events-none absolute inset-y-0 left-0 z-20"
                  style={{ ...winnerGlowStyle, width: teamOverlayWidth(rightSeats().length) }}
                />
              </Show>
              <For each={rightSeats()}>
                {seatIdx => (
                  <div class="slot-cell">
                    <PlayerSlot seatIndex={seatIdx} />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      )}

      {/* FFA layout */}
      {!isTeamMode() && seatCount() > 0 && (
        <div class="slot-strip-ffa flex flex-col h-full w-full items-center justify-end">
          {/* Top row */}
          <div class="flex flex-1 min-h-0 w-full items-stretch justify-center">
            <For each={ffaTopRow()}>
              {seatIdx => (
                <div class="slot-cell-ffa">
                  <PlayerSlot seatIndex={seatIdx} compact />
                </div>
              )}
            </For>
          </div>

          {/* Bottom row */}
          <div class="flex flex-1 min-h-0 w-full items-stretch justify-center">
            <For each={ffaBottomRow()}>
              {seatIdx => (
                <div class="slot-cell-ffa">
                  <PlayerSlot seatIndex={seatIdx} compact />
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </div>
  )
}
