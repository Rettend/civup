import type { MiniSeatItem } from './MiniLayout'
import { formatModeLabel, inferGameMode } from '@civup/game'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { draftStore, phaseAccent, phaseLabel } from '~/client/stores'
import { MiniFrame, MiniSeatGrid } from './MiniLayout'

/** Minimized PiP view */
export function MiniView() {
  const state = () => draftStore.state
  const accent = () => phaseAccent()

  const [remaining, setRemaining] = createSignal(0)
  createEffect(() => {
    const endsAt = draftStore.timerEndsAt
    if (endsAt == null) {
      setRemaining(0)
      return
    }

    const tick = () => setRemaining(Math.max(0, endsAt - Date.now()))
    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })

  const modeLabel = () => formatModeLabel(inferGameMode(state()?.formatId))
  const timerLabel = () => {
    if (state()?.status !== 'active' || draftStore.timerEndsAt == null) return null

    const seconds = Math.ceil(remaining() / 1000)
    const minutes = Math.floor(seconds / 60)
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`
  }

  const title = () => {
    const current = state()
    if (!current) return 'Draft'
    if (current.status === 'waiting') return 'Draft Setup'
    if (current.status === 'complete') return 'Draft Complete'
    if (current.status === 'cancelled') {
      if (current.cancelReason === 'cancel') return 'Draft Cancelled'
      if (current.cancelReason === 'timeout') return 'Auto-Scrubbed'
      if (current.cancelReason === 'revert') return 'Draft Reverted'
      return 'Match Scrubbed'
    }
    return phaseLabel()
  }

  const titleAccent = (): 'gold' | 'red' => {
    const current = state()
    if (current?.status === 'cancelled') return 'red'
    if (current?.status === 'active' && accent() === 'red') return 'red'
    return 'gold'
  }

  const activeSeatSet = () => {
    const current = state()
    if (!current || current.status !== 'active') return new Set<number>()

    const step = current.steps[current.currentStepIndex]
    if (!step) return new Set<number>()

    const activeSeats = step.seats === 'all'
      ? current.seats.map((_, seatIndex) => seatIndex)
      : step.seats

    return new Set(activeSeats.filter((seatIndex) => {
      const submittedCount = current.submissions[seatIndex]?.length ?? 0
      return submittedCount < step.count
    }))
  }

  const seatItems = (): MiniSeatItem[] => {
    const current = state()
    if (!current) return []

    const picksBySeat = new Map(current.picks.map(pick => [pick.seatIndex, pick.civId]))
    const previewPicksBySeat = new Map(Object.entries(draftStore.previews.picks).map(([seatIndex, civIds]) => [Number(seatIndex), civIds[0] ?? null]))
    const activeSeats = activeSeatSet()

    return current.seats.map((seat, seatIndex) => ({
      key: `${seat.playerId}:${seatIndex}`,
      name: seat.displayName,
      avatarUrl: seat.avatarUrl ?? null,
      leaderId: picksBySeat.get(seatIndex) ?? null,
      previewLeaderId: picksBySeat.get(seatIndex) ? null : (previewPicksBySeat.get(seatIndex) ?? null),
      team: seat.team ?? null,
      active: activeSeats.has(seatIndex),
    }))
  }

  const columns = () => {
    const items = seatItems()
    if (items.some(item => item.team != null)) {
      const teamIndices = Array.from(new Set(items.flatMap(item => item.team == null ? [] : [item.team]))).sort((a, b) => a - b)
      return teamIndices.map(team => items.filter(item => item.team === team))
    }

    const midpoint = Math.ceil(items.length / 2)
    return [items.slice(0, midpoint), items.slice(midpoint)]
  }

  return (
    <MiniFrame
      modeLabel={modeLabel()}
      title={title()}
      titleAccent={titleAccent()}
      rightLabel={timerLabel()}
    >
      <MiniSeatGrid
        columns={columns()}
        activeTone={accent()}
      />
    </MiniFrame>
  )
}
