import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { placementIconClass } from '~/client/lib/placement-icons'
import { createCellGridLayout, createSeatGridLayout } from '~/client/lib/seat-grid'
import { draftStore, isMobileLayout, teamPlacementOrder, userId } from '~/client/stores'
import { PlayerSlot } from './PlayerSlot'

/** Arranges PlayerSlots for team and responsive FFA seat grids. */
export function SlotStrip() {
  const state = () => draftStore.state
  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const seatCount = () => state()?.seats.length ?? 0
  const teamIndices = () => Array.from(new Set(
    (state()?.seats ?? []).flatMap(seat => seat.team == null ? [] : [seat.team]),
  )).sort((a, b) => a - b)
  const isMultiTeamLayout = () => isTeamMode() && teamIndices().length > 2
  const isParticipant = () => {
    const uid = userId()
    const s = state()
    if (!uid || !s) return false
    return s.seats.some(seat => seat.playerId === uid)
  }
  const isTeamResultMode = () => state()?.status === 'complete' && isTeamMode() && isParticipant()

  const teamSeats = (team: number) => {
    const s = state()
    if (!s) return [] as number[]
    return s.seats.map((seat, i) => ({ seat, i })).filter(x => x.seat.team === team).map(x => x.i)
  }

  const ffaLayout = () => createSeatGridLayout(
    seatCount(),
    isMobileLayout() ? 2 : Math.ceil(seatCount() / 2),
  )

  const shouldUseTeamGrid = (seatIndices: number[]) => isMobileLayout() || seatIndices.length >= 4

  const teamGridLayout = (seatIndices: number[]) => createCellGridLayout(
    seatIndices,
    isMobileLayout() ? 1 : 2,
  )

  const teamPlacementRank = (team: number) => teamPlacementOrder().indexOf(team)
  const hasTeamPlacements = () => teamPlacementOrder().length > 0
  const teamLabel = (team: number) => `Team ${String.fromCharCode(65 + team)}`
  const isTwoTeamResultMode = () => isTeamResultMode() && teamIndices().length <= 2
  const isMultiTeamResultMode = () => isTeamResultMode() && teamIndices().length > 2
  const isPlacedTeam = (team: number) => teamPlacementRank(team) >= 0

  const teamWrapperOverlayClass = (team: number) => {
    if (!isTeamResultMode()) return 'hidden'
    if (isPlacedTeam(team)) {
      return 'shadow-[inset_0_0_0_2px_var(--accent-muted),inset_0_0_28px_var(--glow-gold-dim)]'
    }
    if (hasTeamPlacements()) return 'bg-black/20'
    return 'hidden'
  }

  const teamOverlayWidth = (slotCount: number) => {
    return `min(${slotCount * 400 + Math.max(0, slotCount - 1)}px, 100%)`
  }

  const teamSeatWrapperClass = (align: 'start' | 'end', seatIndices: number[]) => cn(
    'relative h-full w-full overflow-hidden transition-all duration-300',
    shouldUseTeamGrid(seatIndices)
      ? cn('grid gap-0 max-w-full', align === 'end' && 'ml-auto')
      : align === 'end'
        ? 'flex items-stretch justify-end'
        : 'flex items-stretch justify-start',
  )

  const teamSeatWrapperStyle = (seatIndices: number[]) => {
    if (!shouldUseTeamGrid(seatIndices)) return undefined

    const layout = teamGridLayout(seatIndices)
    const style: Record<string, string> = {
      'grid-template-columns': `repeat(${layout.columns}, minmax(0, 1fr))`,
      'grid-template-rows': `repeat(${layout.rows}, minmax(0, 1fr))`,
    }

    if (!isMobileLayout()) {
      style.width = `min(100%, ${layout.columns * 400}px)`
    }

    return style
  }

  const teamOverlayClass = (align: 'start' | 'end', seatIndices: number[], zClass: string) => cn(
    'pointer-events-none absolute',
    zClass,
    shouldUseTeamGrid(seatIndices)
      ? 'inset-0'
      : align === 'end'
        ? 'inset-y-0 right-0'
        : 'inset-y-0 left-0',
  )

  const teamOverlayStyle = (seatIndices: number[]) => {
    if (shouldUseTeamGrid(seatIndices)) return undefined
    return { width: teamOverlayWidth(seatIndices.length) }
  }

  const winnerGlowStyle = {
    background: [
      'radial-gradient(ellipse farthest-side at 50% 130%, var(--glow-gold) 0%, var(--glow-gold-dim) 40%, transparent 72%)',
      'radial-gradient(ellipse closest-side at 50% 100%, rgba(255,215,100,0.26) 0%, transparent 55%)',
      'linear-gradient(to top, var(--glow-gold-dim) 0%, transparent 40%)',
    ].join(', '),
  }

  const renderResultBadge = (team: number, seatIndices: number[], align: 'start' | 'end') => {
    return (
      <Show when={isTeamResultMode() && isPlacedTeam(team)}>
        <div
          class={cn(
            'flex items-center justify-center',
            teamOverlayClass(align, seatIndices, 'z-40'),
          )}
          style={teamOverlayStyle(seatIndices)}
        >
          <div
            class={cn(
              'anim-fade-in flex items-center justify-center rounded-full border shadow-[0_4px_12px_rgba(0,0,0,0.5),0_8px_28px_rgba(0,0,0,0.4),0_16px_48px_rgba(0,0,0,0.25)]',
              'h-14 w-14 bg-accent text-2xl font-black leading-none',
            )}
            style={{ 'color': 'var(--badge-gold-text)', 'border-color': 'var(--badge-gold-border)', 'font-weight': 900 }}
          >
            <span
              class={cn(
                isTwoTeamResultMode() ? 'i-ph-trophy-fill' : placementIconClass(teamPlacementRank(team) + 1),
                'text-[32px]',
              )}
            />
          </div>
        </div>
      </Show>
    )
  }

  const renderTeamSeats = (team: number, seatIndices: number[], align: 'start' | 'end', showLabel = false) => (
    <div class={cn('flex flex-1 h-full items-stretch', align === 'end' ? 'justify-end' : 'justify-start')}>
      <div class="flex flex-col gap-2 h-full w-full">
        <Show when={showLabel}>
          <div class="text-xs text-accent tracking-wider font-bold uppercase">{teamLabel(team)}</div>
        </Show>
        <div class={teamSeatWrapperClass(align, seatIndices)} style={teamSeatWrapperStyle(seatIndices)}>
          <Show when={isTeamResultMode()}>
            <div
              class={cn(
                teamOverlayClass(align, seatIndices, 'z-30'),
                teamWrapperOverlayClass(team),
              )}
              style={teamOverlayStyle(seatIndices)}
            />
          </Show>
          <Show when={isTeamResultMode() && isPlacedTeam(team)}>
            <div
              class={cn(
                'anim-fade-in',
                teamOverlayClass(align, seatIndices, 'z-20'),
              )}
              style={{ ...winnerGlowStyle, ...(teamOverlayStyle(seatIndices) ?? {}) }}
            />
          </Show>
          {renderResultBadge(team, seatIndices, align)}
          <For each={shouldUseTeamGrid(seatIndices) ? teamGridLayout(seatIndices).cells : seatIndices}>
            {seatIdx => (
              <Show
                when={seatIdx != null}
                fallback={<div class="h-full min-h-0 w-full" />}
              >
                <div class={shouldUseTeamGrid(seatIndices) ? 'h-full min-h-0 w-full' : 'slot-cell'}>
                  <PlayerSlot seatIndex={seatIdx!} />
                </div>
              </Show>
            )}
          </For>
        </div>
      </div>
    </div>
  )

  return (
    <div class="flex flex-1 min-h-0 items-end justify-center">
      {isTeamMode() && !isMultiTeamLayout() && (
        <div class={cn('slot-strip-team flex h-full w-full justify-center', isMobileLayout() ? 'items-stretch py-2' : 'items-end')}>
          {renderTeamSeats(0, teamSeats(0), 'end')}

          <div class={cn('flex shrink-0 flex-col items-center self-center justify-center', isMobileLayout() ? 'w-7' : 'w-12')}>
            <span class={cn('text-fg-muted/30 tracking-widest font-bold', isMobileLayout() ? 'text-xs' : 'text-lg')}>VS</span>
          </div>

          {renderTeamSeats(1, teamSeats(1), 'start')}
        </div>
      )}

      {isMultiTeamLayout() && (
        <div
          class={cn('slot-strip-team h-full w-full mx-auto grid grid-cols-2', isMobileLayout() ? 'gap-2 py-2' : 'gap-4')}
          style={!isMobileLayout() ? { 'max-width': `${Math.max(...teamIndices().map(t => teamSeats(t).length), 1) * 400 * 2 + 16}px` } : undefined}
        >
          <For each={teamIndices()}>
            {team => renderTeamSeats(team, teamSeats(team), 'start', true)}
          </For>
        </div>
      )}

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
