import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  draftStore,
  fetchMatchState,
  gridOpen,
  isMiniView,
  isSpectator,
  reportMatchResult,
  sendScrub,
  sendStart,
  setGridOpen,
  setIsMiniView,
  userId,
} from '~/client/stores'
import { Button } from '../ui'
import { ConfigScreen } from './ConfigScreen'
import { DraftHeader } from './DraftHeader'
import { DraftTimeline } from './DraftTimeline'
import { LeaderGridOverlay } from './LeaderGridOverlay'
import { MiniView } from './MiniView'
import { SlotStrip } from './SlotStrip'

interface DraftViewProps {
  matchId: string
  autoStart?: boolean
}

/** Main draft layout */
export function DraftView(props: DraftViewProps) {
  const state = () => draftStore.state
  const [autoStartSent, setAutoStartSent] = createSignal(false)
  const [showAutoStartSplash, setShowAutoStartSplash] = createSignal(Boolean(props.autoStart))
  let autoStartSplashTimeout: ReturnType<typeof setTimeout> | null = null
  const hostId = () => draftStore.hostId
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === hostId()
  }

  createEffect(() => {
    if (state()?.status === 'waiting') return
    setShowAutoStartSplash(false)
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  })

  createEffect(() => {
    if (!props.autoStart || autoStartSent()) return
    if (state()?.status !== 'waiting') return
    if (!amHost()) return

    const sent = sendStart()
    if (!sent) return

    setShowAutoStartSplash(true)
    if (autoStartSplashTimeout) clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = setTimeout(() => {
      setShowAutoStartSplash(false)
      autoStartSplashTimeout = null
    }, 5000)
    setAutoStartSent(true)
  })

  onCleanup(() => {
    if (!autoStartSplashTimeout) return
    clearTimeout(autoStartSplashTimeout)
    autoStartSplashTimeout = null
  })

  createEffect(() => {
    const check = () => setIsMiniView(window.innerWidth < 500)
    check()
    window.addEventListener('resize', check)
    onCleanup(() => window.removeEventListener('resize', check))
  })

  return (
    <Show
      when={state()?.status === 'cancelled'}
      fallback={(
        <Show
          when={state()?.status === 'complete'}
          fallback={(
            <Show
              when={!isMiniView()}
              fallback={<MiniView />}
            >
              <Show
                when={state()?.status !== 'waiting'}
                fallback={showAutoStartSplash() ? <AutoStartingDraftScreen /> : <ConfigScreen />}
              >
                {/* Active draft view */}
                <div class="text-text-primary font-sans bg-bg-primary flex flex-col h-screen relative overflow-hidden">
                  <DraftHeader />
                  <DraftTimeline />

                  {/* Main area */}
                  <div class="flex flex-1 min-h-0 relative">
                    <SlotStrip />
                    <LeaderGridOverlay />

                    {/* Grid toggle button */}
                    <div class="flex inset-x-0 bottom-3 justify-center absolute z-50">
                      <button
                        class={cn(
                          'flex items-center gap-1 rounded-full px-5 py-1.5 text-xs font-medium cursor-pointer',
                          'bg-bg-secondary border border-white/10 text-text-secondary',
                          'hover:bg-bg-hover hover:text-text-primary transition-colors',
                        )}
                        onClick={() => setGridOpen(!gridOpen())}
                      >
                        <Show when={gridOpen()} fallback={<div class="i-ph-caret-up-bold anim-fade-in text-sm" />}>
                          <div class="i-ph-caret-down-bold anim-fade-in text-sm" />
                        </Show>
                      </button>
                    </div>

                    {/* Status indicator */}
                    <Show when={!gridOpen() && state()?.status === 'active'}>
                      <div class="flex inset-x-0 bottom-12 justify-center absolute z-5">
                        <Show when={isSpectator()}>
                          <span class="text-xs text-text-muted px-3 py-1 rounded-full bg-bg-secondary/80">Spectating</span>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>
          )}
        >
          <PostDraftScreen matchId={props.matchId} />
        </Show>
      )}
    >
      <CancelledDraftScreen />
    </Show>
  )
}

function AutoStartingDraftScreen() {
  return (
    <main class="text-text-primary font-sans bg-bg-primary flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent-gold font-bold mb-2">CivUp</div>
        <div class="text-sm text-text-secondary">Starting draft...</div>
      </div>
    </main>
  )
}

function CancelledDraftScreen() {
  const state = () => draftStore.state
  const reason = () => state()?.cancelReason ?? 'scrub'

  const title = () => {
    if (reason() === 'cancel') return 'Draft Cancelled'
    if (reason() === 'timeout') return 'Draft Auto-Scrubbed'
    return 'Match Scrubbed'
  }

  const detail = () => {
    if (reason() === 'cancel') return 'Host cancelled this draft before lock-in.'
    if (reason() === 'timeout') return 'A player timed out picking a leader.'
    return 'Host scrubbed this match.'
  }

  return (
    <main class="text-text-primary font-sans bg-bg-primary h-screen overflow-y-auto">
      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl md:px-8">
        <section class="p-7 text-center border border-[#aeb6c2]/20 rounded-lg bg-[#111827]/70">
          <div class="text-[11px] text-[#9aa3af] tracking-[0.14em] font-semibold mb-2 uppercase">Session Closed</div>
          <h1 class="text-3xl text-[#d6dde6] font-semibold mb-3">{title()}</h1>
          <p class="text-sm text-[#9ca6b3] leading-relaxed">{detail()}</p>
        </section>
      </div>
    </main>
  )
}

// ── Post-Draft Screen ──────────────────────────────────────

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

  const hostId = () => draftStore.hostId
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
      setMessage(result.error); return
    }
    setStatus('completed')
    setMessage(`Team ${team} reported by host`)
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
      setMessage(result.error); return
    }
    setStatus('completed')
    setMessage('FFA result reported by host')
  }

  const scrubMatch = () => {
    if (!amHost()) return
    setStatus('submitting')
    setMessage('Scrub request sent. Closing this match...')
    sendScrub()
  }

  return (
    <main class="text-text-primary font-sans bg-bg-primary h-screen overflow-y-auto">
      <div class="mx-auto px-4 py-8 flex flex-col gap-6 max-w-5xl md:px-8">
        {/* Elapsed timer */}
        <section class="p-6 text-center rounded-lg bg-bg-secondary md:p-8">
          <div class="text-sm text-accent-gold text-heading mb-2">Game In Progress</div>
          <h1 class="text-3xl text-heading mb-3 md:text-4xl">Draft Complete</h1>
          <div class="text-4xl text-accent-gold font-mono md:text-5xl">{formatElapsed(elapsedMs())}</div>
          <div class="text-sm text-text-secondary mt-2">Elapsed since draft lock-in</div>
        </section>

        {/* Locked civs */}
        <section class="p-5 rounded-lg bg-bg-secondary md:p-6">
          <div class="text-sm text-text-muted text-heading mb-4">Locked Civs</div>
          <Show
            when={isTeamMode()}
            fallback={(
              <div class="gap-2 grid grid-cols-1">
                <For each={ffaRows()}>
                  {row => (
                    <div class="px-3 py-2 rounded-md bg-bg-primary/40 flex items-center justify-between">
                      <span class="text-sm text-text-secondary">{row.displayName}</span>
                      <span class="text-sm text-accent-gold">{row.civId ?? 'TBD'}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          >
            <div class="gap-4 grid grid-cols-1 md:grid-cols-2">
              <TeamResultCard label="Team A" rows={teamRows(0)} />
              <TeamResultCard label="Team B" rows={teamRows(1)} />
            </div>
          </Show>
        </section>

        {/* Post-game result */}
        <section class="p-5 rounded-lg bg-bg-secondary md:p-6">
          <div class="text-sm text-text-muted text-heading mb-3">Post-Game Result</div>
          <Show
            when={isTeamMode()}
            fallback={(
              <div class="flex flex-col gap-3 w-full">
                <div class="text-sm text-text-secondary">
                  Enter final standings (winner first), one player mention or ID per line.
                </div>
                <textarea
                  value={ffaPlacements()}
                  onInput={e => setFfaPlacements(e.currentTarget.value)}
                  placeholder={state()?.seats.map(seat => `<@${seat.playerId}>`).join('\n')}
                  class="text-sm text-text-primary px-3 py-2 outline-none border border-white/10 rounded-md bg-bg-primary h-32 w-full focus:border-accent-gold/60"
                />
                <div>
                  <div class="flex flex-wrap gap-3 items-center">
                    <Button size="lg" disabled={!canInteract() || ffaPlacements().trim().length === 0} onClick={reportFfa}>
                      Submit FFA Result
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      class="text-[#cdd5df] border-[#aeb6c2]/25 hover:border-[#aeb6c2]/40 hover:bg-[#8f99a8]/12"
                      disabled={!canInteract()}
                      onClick={scrubMatch}
                    >
                      Scrub Match
                    </Button>
                  </div>
                </div>
              </div>
            )}
          >
            <div class="flex flex-wrap gap-3 items-center">
              <Button size="lg" disabled={!canInteract()} onClick={() => reportWinner('A')}>
                Team A Won
              </Button>
              <Button variant="outline" size="lg" disabled={!canInteract()} onClick={() => reportWinner('B')}>
                Team B Won
              </Button>
              <Button
                variant="outline"
                size="lg"
                class="text-[#cdd5df] border-[#aeb6c2]/25 hover:border-[#aeb6c2]/40 hover:bg-[#8f99a8]/12"
                disabled={!canInteract()}
                onClick={scrubMatch}
              >
                Scrub Match
              </Button>
            </div>
          </Show>

          <Show when={!amHost() && status() !== 'completed'}>
            <div class="text-sm text-text-muted mt-3">Waiting for host to report winner.</div>
          </Show>
          <div class="text-sm text-text-secondary mt-3">{message()}</div>
        </section>
      </div>
    </main>
  )
}

function TeamResultCard(props: { label: string, rows: { playerId: string, displayName: string, civId: string | null }[] }) {
  return (
    <div class="p-3 border border-white/5 rounded-lg bg-bg-primary/40">
      <div class="text-sm text-accent-gold text-heading mb-2">{props.label}</div>
      <div class="flex flex-col gap-2">
        <For each={props.rows}>
          {row => (
            <div class="px-3 py-2 rounded-md bg-bg-secondary/40 flex items-center justify-between">
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
