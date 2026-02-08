import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { draftStore, isSpectator, sendStart, userId } from '~/client/stores'

/** Pre-draft config screen — host configures timer, sees connected players, presses Start */
export function ConfigScreen() {
  const state = () => draftStore.state
  const seats = () => state()?.seats ?? []
  const formatId = () => state()?.formatId?.replace(/-/g, ' ').toUpperCase() ?? 'DRAFT'

  const hostId = () => state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const id = userId()
    if (!id) return false
    return id === hostId()
  }

  const seatCount = () => seats().length
  const isTeamMode = () => seats().some(s => s.team != null)

  /** Seats grouped by team (or all in one group for FFA) */
  const teamASeats = () => isTeamMode() ? seats().filter(s => s.team === 0) : []
  const teamBSeats = () => isTeamMode() ? seats().filter(s => s.team === 1) : []

  return (
    <div class="h-screen flex flex-col items-center justify-center bg-bg-primary text-text-primary font-sans">
      <div class="w-full max-w-lg flex flex-col gap-6 px-6">
        {/* Title */}
        <div class="text-center">
          <h1 class="mb-1 text-2xl text-heading">Draft Setup</h1>
          <span class="text-sm text-accent-gold font-medium">{formatId()}</span>
        </div>

        {/* Format info */}
        <div class="rounded-lg bg-bg-secondary p-4">
          <div class="mb-3 text-xs text-text-muted font-bold tracking-widest uppercase">Format</div>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div class="text-text-secondary">Players</div>
            <div class="text-text-primary font-medium">{seatCount()}</div>
            <div class="text-text-secondary">Mode</div>
            <div class="text-text-primary font-medium">{isTeamMode() ? 'Teams' : 'FFA'}</div>
            <div class="text-text-secondary">Steps</div>
            <div class="text-text-primary font-medium">{state()?.steps.length ?? 0}</div>
          </div>
        </div>

        {/* Players */}
        <div class="rounded-lg bg-bg-secondary p-4">
          <div class="mb-3 text-xs text-text-muted font-bold tracking-widest uppercase">Players</div>

          <Show
            when={isTeamMode()}
            fallback={
              <div class="flex flex-col gap-2">
                <For each={seats()}>
                  {(seat, i) => <PlayerChip name={seat.displayName} index={i()} isHost={i() === 0} />}
                </For>
              </div>
            }
          >
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="mb-2 text-xs text-accent-gold font-bold tracking-wider">Team A</div>
                <div class="flex flex-col gap-2">
                  <For each={teamASeats()}>
                    {(seat, i) => <PlayerChip name={seat.displayName} index={i()} isHost={seat.playerId === hostId()} />}
                  </For>
                </div>
              </div>
              <div>
                <div class="mb-2 text-xs text-accent-gold font-bold tracking-wider">Team B</div>
                <div class="flex flex-col gap-2">
                  <For each={teamBSeats()}>
                    {(seat, i) => <PlayerChip name={seat.displayName} index={i()} isHost={seat.playerId === hostId()} />}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        </div>

        {/* Start button */}
        <div class="flex justify-center">
          <Show
            when={amHost()}
            fallback={
              <span class="text-sm text-text-muted">
                {isSpectator() ? 'Spectating — waiting for host to start' : 'Waiting for host to start...'}
              </span>
            }
          >
            <button
              class="rounded-lg bg-accent-gold px-8 py-2.5 text-sm text-black font-bold cursor-pointer hover:bg-accent-gold/80 transition-colors"
              onClick={sendStart}
            >
              Start Draft
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

function PlayerChip(props: { name: string, index: number, isHost: boolean }) {
  return (
    <div class={cn(
      'flex items-center gap-2 rounded-md bg-bg-primary/40 px-3 py-2',
    )}
    >
      <div class="i-ph-user-bold text-sm text-text-muted" />
      <span class="flex-1 truncate text-sm text-text-primary">{props.name}</span>
      <Show when={props.isHost}>
        <span class="text-[10px] text-accent-gold font-bold tracking-wider uppercase">Host</span>
      </Show>
    </div>
  )
}
