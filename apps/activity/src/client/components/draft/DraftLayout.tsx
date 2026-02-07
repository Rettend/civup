import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  confirmMatchResult,
  draftStore,
  fetchMatchState,
  reportMatchResult,
  userId,
} from '~/client/stores'
import { ActionBar } from './ActionBar'
import { LeaderDetail } from './LeaderDetail'
import { LeaderGrid } from './LeaderGrid'
import { TeamPanel } from './TeamPanel'
import { TopBar } from './TopBar'
import { Button } from '../ui'

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
  const [status, setStatus] = createSignal<'idle' | 'loading' | 'reported' | 'confirming' | 'confirmed' | 'error'>('idle')
  const [message, setMessage] = createSignal('Share winner here, then confirm once all agree.')

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
      setStatus('confirmed')
      setMessage('Result already confirmed. Ratings are updated.')
      return
    }

    const allPlaced = snapshot.participants.length > 0
      && snapshot.participants.every(p => p.placement !== null)
    if (allPlaced) {
      setStatus('reported')
      setMessage('Result already reported. Confirm to apply ratings.')
    }
  })

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

  const canInteract = () => status() !== 'loading' && status() !== 'confirming' && status() !== 'confirmed'

  const reportWinner = async (team: 'A' | 'B') => {
    const currentUserId = userId()
    if (!currentUserId) {
      setStatus('error')
      setMessage('Could not identify your Discord user. Reopen the activity.')
      return
    }

    setStatus('loading')
    const result = await reportMatchResult(props.matchId, currentUserId, team)
    if (!result.ok) {
      setStatus('error')
      setMessage(result.error)
      return
    }

    setStatus('reported')
    setMessage(`Team ${team} reported as winner. Any participant can confirm now.`)
  }

  const confirmResult = async () => {
    const currentUserId = userId()
    if (!currentUserId) {
      setStatus('error')
      setMessage('Could not identify your Discord user. Reopen the activity.')
      return
    }

    setStatus('confirming')
    const result = await confirmMatchResult(props.matchId, currentUserId)
    if (!result.ok) {
      setStatus('error')
      setMessage(result.error)
      return
    }

    setStatus('confirmed')
    setMessage('Result confirmed. Leaderboard ratings updated.')
  }

  return (
    <main class="h-screen overflow-y-auto bg-bg-primary text-text-primary font-sans">
      <div class="mx-auto max-w-5xl flex flex-col gap-6 px-4 py-8 md:px-8">
        <section class="panel p-6 md:p-8 text-center">
          <div class="mb-2 text-sm text-accent-gold text-heading">Game In Progress</div>
          <h1 class="mb-3 text-3xl text-heading md:text-4xl">Draft Complete</h1>
          <div class="text-4xl font-mono text-accent-gold md:text-5xl">
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
              <div class="text-sm text-text-secondary">
                FFA reporting from activity is not wired yet. Use
                {' '}
                <code class="text-accent-gold">/report {props.matchId}</code>
                {' '}
                in Discord for now.
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
              <Button
                variant="ghost"
                size="lg"
                disabled={status() === 'loading' || status() === 'confirming' || status() === 'confirmed'}
                onClick={confirmResult}
              >
                {status() === 'confirming' ? 'Confirming...' : 'Confirm Result'}
              </Button>
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
    <div class="rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
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
