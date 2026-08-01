import { formatModeLabel, inferGameMode } from '@civup/game'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { PlayerStatsPopover } from '~/client/components/player/PlayerStatsPopover'
import { cn } from '~/client/lib/css'
import { draftStore, isCivBlitzDraft, isMyTeamFormationTurn, isRedDeathDraft, sendTeamFormationPick } from '~/client/stores'

export function CaptainPickOverlay() {
  const state = () => draftStore.state
  const formation = () => draftStore.teamFormation
  const [statsSeatIndex, setStatsSeatIndex] = createSignal<number | null>(null)
  const [popoverPosition, setPopoverPosition] = createSignal<{ left: string, top: string }>()
  const statsSeat = createMemo(() => {
    const seatIndex = statsSeatIndex()
    return seatIndex == null ? null : state()?.seats[seatIndex] ?? null
  })
  const statsLabel = () => {
    if (isCivBlitzDraft()) return 'CivBlitz'
    if (isRedDeathDraft()) return 'Red Death'
    return `${formatModeLabel(inferGameMode(state()?.formatId), 'Draft', { targetSize: state()?.seats.length })} Stats`
  }

  const openStats = (seatIndex: number, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect()
    setStatsSeatIndex(seatIndex)
    setPopoverPosition({
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 304))}px`,
      top: `${Math.max(8, rect.bottom + 8)}px`,
    })
  }

  return (
    <Show when={formation().enabled && formation().phase === 'active'}>
      <section class="p-3 flex flex-1 min-h-0 w-full overflow-y-auto sm:p-5">
        <div class="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <div class="text-center">
            <h2 class="text-xl text-accent font-bold">Captain Pick</h2>
            <p class="mt-1 text-sm text-fg-muted">
              <Show
                when={formation().currentTeam != null}
                fallback="Forming teams"
              >
                {`Team ${String.fromCharCode(65 + formation().currentTeam!)} captain is choosing`}
              </Show>
            </p>
          </div>

          <div class="gap-3 grid grid-cols-1 sm:grid-cols-2">
            <For each={[0, 1] as const}>
              {team => (
                <div class={cn('p-3 rounded-lg border bg-bg-subtle/70', formation().currentTeam === team ? 'border-accent/60' : 'border-border-subtle')}>
                  <div class="mb-2 text-xs text-accent tracking-wider font-bold uppercase">
                    Team
                    {' '}
                    {String.fromCharCode(65 + team)}
                  </div>
                  <div class="flex flex-col gap-2">
                    <For each={formation().teamSeatIndices[team]}>
                      {seatIndex => <FormationPlayer seatIndex={seatIndex} captain={seatIndex === formation().captainSeatIndices[team]} onOpenStats={openStats} onCloseStats={() => setStatsSeatIndex(null)} />}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="p-3 rounded-lg border border-border-subtle bg-bg-subtle/45">
            <div class="mb-1 text-xs text-fg tracking-wider font-bold uppercase">Unassigned players</div>
            <div class="mb-3 text-xs text-fg-subtle">
              {isMyTeamFormationTurn() ? 'Choose a legal player or party.' : 'Parties are selected together.'}
            </div>
            <div class="gap-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              <For each={formation().groups}>
                {(group) => {
                  const legal = () => formation().legalGroupIds.includes(group.id)
                  const canPick = () => legal() && isMyTeamFormationTurn()
                  return (
                    <div
                      class={cn(
                        'p-2 text-left rounded-md border flex flex-col gap-1.5 transition-colors',
                        legal() ? 'border-accent/35 bg-white/7' : 'border-transparent bg-white/4 opacity-45',
                        canPick() ? 'hover:border-accent hover:bg-accent/10' : '',
                      )}
                    >
                      <For each={group.seatIndices}>
                        {seatIndex => <FormationPlayer seatIndex={seatIndex} compact onOpenStats={openStats} onCloseStats={() => setStatsSeatIndex(null)} />}
                      </For>
                      <button
                        type="button"
                        class={cn('mt-1 rounded px-2 py-1 text-xs font-semibold', canPick() ? 'bg-accent text-black cursor-pointer' : 'bg-white/7 text-fg-subtle cursor-default')}
                        disabled={!canPick()}
                        onClick={() => sendTeamFormationPick(group.id, formation().revision)}
                      >
                        {group.seatIndices.length > 1 ? 'Pick party' : 'Pick player'}
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </section>

      <Show when={statsSeat()}>
        {seat => (
          <Portal>
            <PlayerStatsPopover
              name={seat().displayName}
              avatarUrl={seat().avatarUrl}
              stats={formation().statsBySeat[statsSeatIndex()!]}
              statsLabel={statsLabel()}
              unranked={isCivBlitzDraft()}
              style={popoverPosition()}
            />
          </Portal>
        )}
      </Show>
    </Show>
  )
}

function FormationPlayer(props: {
  seatIndex: number
  captain?: boolean
  compact?: boolean
  onOpenStats: (seatIndex: number, anchor: HTMLElement) => void
  onCloseStats: () => void
}) {
  const seat = () => draftStore.state?.seats[props.seatIndex]
  return (
    <Show when={seat()}>
      {player => (
        <div
          class={cn('rounded-md bg-white/7 flex gap-2 items-center', props.compact ? 'px-2 py-1.5' : 'px-3 py-2')}
          tabIndex={0}
          aria-label={`${player().displayName} stats`}
          onPointerEnter={event => props.onOpenStats(props.seatIndex, event.currentTarget)}
          onPointerLeave={props.onCloseStats}
          onFocus={event => props.onOpenStats(props.seatIndex, event.currentTarget)}
          onBlur={props.onCloseStats}
        >
          <Show when={player().avatarUrl} fallback={<span class="i-ph:user-bold text-fg-subtle" />}>
            {avatar => <img src={avatar()} alt="" class="rounded-full h-5 w-5 object-cover" draggable={false} />}
          </Show>
          <span class="text-sm flex-1 truncate">{player().displayName}</span>
          <Show when={props.captain}><span class="text-[10px] text-accent font-bold uppercase">Captain</span></Show>
        </div>
      )}
    </Show>
  )
}
