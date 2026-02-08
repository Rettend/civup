import { For } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore } from '~/client/stores'
import { PlayerSlot } from './PlayerSlot'

/** Arranges PlayerSlots for team (left/right + center gap with "vs") and FFA (2-row grid) */
export function SlotStrip() {
  const state = () => draftStore.state
  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const seatCount = () => state()?.seats.length ?? 0

  /** Seat indices for left team (team 0) */
  const leftSeats = () => {
    const s = state()
    if (!s) return [] as number[]
    return s.seats.map((seat, i) => ({ seat, i })).filter(x => x.seat.team === 0).map(x => x.i)
  }

  /** Seat indices for right team (team 1) */
  const rightSeats = () => {
    const s = state()
    if (!s) return [] as number[]
    return s.seats.map((seat, i) => ({ seat, i })).filter(x => x.seat.team === 1).map(x => x.i)
  }

  /** FFA: split seats into two rows */
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

  return (
    <div class="flex flex-1 items-stretch">
      {/* Team mode layout */}
      {isTeamMode() && (
        <div class="flex flex-1 items-stretch">
          {/* Left team */}
          <div class="flex flex-1 items-stretch">
            <For each={leftSeats()}>
              {seatIdx => (
                <div class="flex-1 border-r border-white/5">
                  <PlayerSlot seatIndex={seatIdx} />
                </div>
              )}
            </For>
          </div>

          {/* Center gap */}
          <div class="flex w-16 shrink-0 flex-col items-center justify-center">
            <span class="text-lg text-text-muted/30 font-bold tracking-widest">VS</span>
          </div>

          {/* Right team */}
          <div class="flex flex-1 items-stretch">
            <For each={rightSeats()}>
              {seatIdx => (
                <div class="flex-1 border-l border-white/5">
                  <PlayerSlot seatIndex={seatIdx} />
                </div>
              )}
            </For>
          </div>
        </div>
      )}

      {/* FFA layout: two-row grid */}
      {!isTeamMode() && seatCount() > 0 && (
        <div class="flex flex-1 flex-col">
          {/* Top row */}
          <div class="flex flex-1 items-stretch justify-center">
            <For each={ffaTopRow()}>
              {seatIdx => (
                <div class={cn('flex-1 max-w-48 border-r border-b border-white/5 last:border-r-0')}>
                  <PlayerSlot seatIndex={seatIdx} compact />
                </div>
              )}
            </For>
          </div>

          {/* Bottom row */}
          <div class="flex flex-1 items-stretch justify-center">
            <For each={ffaBottomRow()}>
              {seatIdx => (
                <div class={cn('flex-1 max-w-48 border-r border-white/5 last:border-r-0')}>
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
