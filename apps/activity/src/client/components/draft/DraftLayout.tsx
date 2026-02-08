import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  draftStore,
  fetchMatchState,
  reportMatchResult,
  userId,
} from '~/client/stores'
import { Button } from '../ui'
import { ActionBar } from './ActionBar'
import { LeaderDetail } from './LeaderDetail'
import { LeaderGrid } from './LeaderGrid'
import { TeamPanel } from './TeamPanel'
import { TopBar } from './TopBar'

interface DraftLayoutProps {
  matchId: string
}

export function DraftLayout(props: DraftLayoutProps) {
  const state = () => draftStore.state
  const seatCount = () => state()?.seats.length ?? 0
  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false

  return (
    <Show
      when={state()?.status === 'complete'}
      fallback={(
        <div class="h-screen flex flex-col overflow-hidden bg-bg-primary text-text-primary font-sans">
          <TopBar />

          <div class="relative min-h-0 flex flex-1">
            <Show when={isTeamMode()}>
              <div class="w-56 overflow-y-auto border-r border-border-subtle">
                <TeamPanel seatIndex={0} side="left" />
              </div>

              <div class="min-w-0 flex-1">
                <LeaderGrid />
              </div>

              <div class="w-56 overflow-y-auto border-l border-border-subtle">
                <TeamPanel seatIndex={1} side="right" />
              </div>
            </Show>

            <Show when={!isTeamMode() && seatCount() > 0}>
              <div class="min-h-0 flex flex-1 flex-col">
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

                <div class="min-h-0 flex-1">
                  <LeaderGrid />
                </div>
              </div>
            </Show>

            <LeaderDetail />
          </div>

          <ActionBar />
        </div>
      )}
    >
      <PostDraftScreen matchId={props.matchId} />
    </Show>
  )
}

function PostDraftScreen(props: { matchId: string }) {
  const state = () => draftStore.state
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [ffaPlacements, setFfaPlacements] = createSignal('')
  const [status, setStatus] = createSignal<'idle' | 'submitting' | 'completed' | 'error'>('idle')
  const [message, setMessage] = createSignal('Host can report the winner when the game ends.')

  createEffect(() => {
    const completedAt = draftStore.completedAt
    if (completedAt == null) {
      setElapsedMs(0)
      return
    }

    const tick = () => setElapsedMs(Math.max(0, Date.now() - completedAt))
    tick()
    const interval = setInterval(tick, 1000)
    onCleanup(() => clearInterval(interval))
  })

  onMount(async () => {
    const snapshot = await fetchMatchState(props.matchId)
    if (!snapshot) return

    if (snapshot.match.status === 'completed') {
      setStatus('completed')
      setMessage('Result already confirmed. Ratings are updated.')
    }
  })

  const hostId = () => state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === hostId()
  }

  const isTeamMode = () => {
    const s = state()
    if (!s) return false
    return s.seats.some(seat => seat.team != null)
  }

  const teamRows = (teamIndex: number) => {
    const s = state()
    if (!s) return [] as { playerId: string, displayName: string, civId: string | null }[]
    const players = s.seats.filter(seat => seat.team === teamIndex)
    const picks = s.picks.filter(p => p.seatIndex === teamIndex).map(p => p.civId)
    return players.map((player, idx) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      civId: picks[idx] ?? null,
    }))
  }

  const ffaRows = () => {
    const s = state()
    if (!s) return [] as { playerId: string, displayName: string, civId: string | null }[]
    return s.seats.map((player, seatIndex) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      civId: s.picks.find(p => p.seatIndex === seatIndex)?.civId ?? null,
    }))
  }

  const canInteract = () => amHost() && status() !== 'submitting' && status() !== 'completed'

  const reportWinner = async (team: 'A' | 'B') => {
    const currentUserId = userId()
    if (!currentUserId) {
      setStatus('error')
      setMessage('Could not identify your Discord user. Reopen the activity.')
      return
    }

    setStatus('submitting')
    const result = await reportMatchResult(props.matchId, currentUserId, team)
    if (!result.ok) {
      setStatus('error')
      setMessage(result.error)
      return
    }

    setStatus('completed')
    setMessage(`Team ${team} reported by host. Ratings updated.`)
  }

  const reportFfa = async () => {
    const currentUserId = userId()
    if (!currentUserId) {
      setStatus('error')
      setMessage('Could not identify your Discord user. Reopen the activity.')
      return
    }

    const placements = ffaPlacements().trim()
    if (!placements) {
      setStatus('error')
      setMessage('Enter placement order first (one player mention/id per line).')
      return
    }

    setStatus('submitting')
    const result = await reportMatchResult(props.matchId, currentUserId, placements)
    if (!result.ok) {
      setStatus('error')
      setMessage(result.error)
      return
    }

    setStatus('completed')
    setMessage('FFA result reported by host. Ratings updated.')
  }

  return (
    <main class="h-screen overflow-y-auto bg-bg-primary text-text-primary font-sans">
      <div class="mx-auto max-w-5xl flex flex-col gap-6 px-4 py-8 md:px-8">
        <section class="panel p-6 text-center md:p-8">
          <div class="mb-2 text-sm text-accent-gold text-heading">Game In Progress</div>
          <h1 class="mb-3 text-3xl text-heading md:text-4xl">Draft Complete</h1>
          <div class="text-4xl text-accent-gold font-mono md:text-5xl">
            {formatElapsed(elapsedMs())}
          </div>
          <div class="mt-2 text-sm text-text-secondary">Elapsed since draft lock-in</div>
        </section>

        <section class="panel p-5 md:p-6">
          <div class="mb-4 text-sm text-text-muted text-heading">Locked Civs</div>

          <Show
            when={isTeamMode()}
            fallback={(
              <div class="grid grid-cols-1 gap-2">
                <For each={ffaRows()}>
                  {row => (
                    <div class="flex items-center justify-between rounded-md bg-bg-secondary/60 px-3 py-2">
                      <span class="text-sm text-text-secondary">{row.displayName}</span>
                      <span class="text-sm text-accent-gold">{row.civId ?? 'TBD'}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          >
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TeamResultCard label="Team A" rows={teamRows(0)} />
              <TeamResultCard label="Team B" rows={teamRows(1)} />
            </div>
          </Show>
        </section>

        <section class="panel p-5 md:p-6">
          <div class="mb-3 text-sm text-text-muted text-heading">Post-Game Result</div>

          <Show
            when={isTeamMode()}
            fallback={(
              <div class="w-full flex flex-col gap-3">
                <div class="text-sm text-text-secondary">
                  Enter final standings (winner first), one player mention or ID per line.
                </div>
                <textarea
                  value={ffaPlacements()}
                  onInput={e => setFfaPlacements(e.currentTarget.value)}
                  placeholder={state()?.seats.map(seat => `<@${seat.playerId}>`).join('\n')}
                  class="h-32 w-full border border-border-subtle rounded-md bg-bg-secondary/70 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-gold/60"
                />
                <div>
                  <Button
                    size="lg"
                    disabled={!canInteract() || ffaPlacements().trim().length === 0}
                    onClick={reportFfa}
                  >
                    Submit FFA Result
                  </Button>
                </div>
              </div>
            )}
          >
            <div class="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                disabled={!canInteract()}
                onClick={() => reportWinner('A')}
              >
                Team A Won
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={!canInteract()}
                onClick={() => reportWinner('B')}
              >
                Team B Won
              </Button>
            </div>
          </Show>

          <Show when={!amHost() && status() !== 'completed'}>
            <div class="mt-3 text-sm text-text-muted">
              Waiting for host to report the winner.
            </div>
          </Show>

          <div class="mt-3 text-sm text-text-secondary">{message()}</div>
        </section>
      </div>
    </main>
  )
}

function TeamResultCard(
  props: {
    label: string
    rows: { playerId: string, displayName: string, civId: string | null }[]
  },
) {
  return (
    <div class="border border-border-subtle rounded-lg bg-bg-secondary/40 p-3">
      <div class="mb-2 text-sm text-accent-gold text-heading">{props.label}</div>
      <div class="flex flex-col gap-2">
        <For each={props.rows}>
          {row => (
            <div class="flex items-center justify-between rounded-md bg-bg-primary/40 px-3 py-2">
              <span class="text-sm text-text-secondary">{row.displayName}</span>
              <span class="text-sm text-accent-gold">{row.civId ?? 'TBD'}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
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
