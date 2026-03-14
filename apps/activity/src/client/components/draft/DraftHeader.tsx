import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  clearFfaPlacements,
  clearResultSelections,
  currentStepDuration,
  draftStore,
  ffaPlacementOrder,
  isMobileLayout,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
  reportMatchResult,
  scrubMatchResult,
  selectedWinningTeam,
  sendScrub,
  setResultSelectionsLocked,
  userId,
} from '~/client/stores'
import { Button, HorizontalScroller } from '../ui'
import { BanSquare } from './BanSquare'
import { SteamLobbyButton } from './SteamLobbyButton'

interface DraftHeaderProps {
  steamLobbyLink?: string | null
  onSaveSteamLink?: (link: string | null) => void
  savePending?: boolean
  onSwitchTarget?: () => void
}

/** Header bar: bans on left/right, phase label centered, timer with shrinking line */
export function DraftHeader(props: DraftHeaderProps) {
  const state = () => draftStore.state
  const accent = () => phaseAccent()
  const amHost = () => userId() === draftStore.hostId
  const [phaseFlash, setPhaseFlash] = createSignal(false)
  let phaseFlashTimeout: ReturnType<typeof setTimeout> | null = null

  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const isComplete = () => state()?.status === 'complete'
  const seatCount = () => state()?.seats.length ?? 0

  const clearPhaseFlashTimeout = () => {
    if (phaseFlashTimeout == null) return
    clearTimeout(phaseFlashTimeout)
    phaseFlashTimeout = null
  }

  const allBans = () => state()?.bans.map(b => b.civId) ?? []
  const ffaSplitIndex = () => Math.ceil(allBans().length / 2)

  /** Bans for team A or the first half of FFA bans. */
  const leftBans = () => {
    const s = state()
    if (!s) return [] as string[]
    if (isTeamMode()) return s.bans.filter(b => b.seatIndex === 0).map(b => b.civId)
    return allBans().slice(0, ffaSplitIndex())
  }

  /** Bans for team B or the second half of FFA bans. */
  const rightBans = () => {
    const s = state()
    if (!s) return [] as string[]
    if (isTeamMode()) return s.bans.filter(b => b.seatIndex === 1).map(b => b.civId)
    return allBans().slice(ffaSplitIndex())
  }

  const [remaining, setRemaining] = createSignal(0)

  createEffect(() => {
    const endsAt = draftStore.timerEndsAt
    if (endsAt == null) {
      setRemaining(0)
      return
    }

    function tick() { setRemaining(Math.max(0, endsAt! - Date.now())) }
    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })

  const seconds = () => Math.ceil(remaining() / 1000)
  const duration = () => currentStepDuration()
  const progress = () => {
    if (!draftStore.timerEndsAt || duration() <= 0) return 0
    return Math.min(1, remaining() / (duration() * 1000))
  }

  const isUrgent = () => seconds() <= 10 && seconds() > 5
  const isCritical = () => seconds() <= 5 && seconds() > 0
  const isExpired = () => draftStore.timerEndsAt != null && remaining() <= 0

  // Brief phase flash on ban/pick transitions
  createEffect(on(accent, (next, prev) => {
    const s = state()
    if (!prev || prev === next || !s || s.status !== 'active') return

    clearPhaseFlashTimeout()
    setPhaseFlash(true)
    phaseFlashTimeout = setTimeout(() => {
      setPhaseFlash(false)
      phaseFlashTimeout = null
    }, 220)
  }, { defer: true }))

  onCleanup(() => {
    clearPhaseFlashTimeout()
    setResultSelectionsLocked(false)
  })

  // ── Result Reporting ────────────────────────
  const [resultStatus, setResultStatus] = createSignal<'idle' | 'submitting:result' | 'submitting:scrub' | 'done'>('idle')

  createEffect(() => {
    setResultSelectionsLocked(resultStatus() !== 'idle')
  })

  createEffect(on(() => state()?.matchId, () => {
    setResultStatus('idle')
    clearResultSelections()
  }, { defer: true }))

  createEffect(() => {
    if (state()?.status === 'complete') return
    setResultStatus('idle')
    clearResultSelections()
  })

  const reportSelectedTeam = async () => {
    const uid = userId()
    const team = selectedWinningTeam()
    if (!uid || team == null) return

    setResultStatus('submitting:result')
    const teamToken = team === 0 ? 'A' : 'B'
    const res = await reportMatchResult(draftStore.state!.matchId, uid, teamToken)
    setResultStatus(res.ok ? 'done' : 'idle')
  }

  const reportFfa = async () => {
    const uid = userId()
    if (!uid) return
    const order = ffaPlacementOrder()
    const s = state()
    if (!s || order.length !== seatCount()) return
    setResultStatus('submitting:result')
    const placements = order.map(idx => `<@${s.seats[idx]!.playerId}>`).join('\n')
    const res = await reportMatchResult(s.matchId, uid, placements)
    if (res.ok) {
      setResultStatus('done')
    }
    else { setResultStatus('idle'); clearFfaPlacements() }
  }

  const confirmResult = async () => {
    if (isTeamMode()) {
      await reportSelectedTeam()
      return
    }
    await reportFfa()
  }

  const scrubMatch = async () => {
    const uid = userId()
    const s = state()
    if (!amHost() || !uid || !s) return

    setResultStatus('submitting:scrub')

    if (s.status === 'complete') {
      const res = await scrubMatchResult(s.matchId, uid)
      setResultStatus(res.ok ? 'done' : 'idle')
      return
    }

    sendScrub()
    setResultStatus('idle')
  }

  const canInteract = () => amHost() && !resultStatus().startsWith('submitting') && resultStatus() !== 'done'
  const resultSelectionReady = () => isTeamMode() ? selectedWinningTeam() != null : ffaPlacementOrder().length === seatCount()
  const showMobileActionRow = () => isMobileLayout() && amHost() && (state()?.status === 'active' || isComplete())
  const showLeftNoBans = () => state()?.status !== 'waiting' && (isTeamMode() ? leftBans().length === 0 : allBans().length === 0)
  const showRightNoBans = () => state()?.status !== 'waiting' && isTeamMode() && rightBans().length === 0
  const hasSteamLobbyButton = () => (amHost() && Boolean(props.onSaveSteamLink)) || Boolean(props.steamLobbyLink)
  const hasOverviewButton = () => Boolean(props.onSwitchTarget)
  const mobileRailInsetCount = () => Number(hasSteamLobbyButton()) + Number(hasOverviewButton())

  const renderOverviewButton = () => (
    <Show when={props.onSwitchTarget}>
      <button
        type="button"
        class="text-fg-muted border border-border rounded-md flex shrink-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
        title="Lobby Overview"
        aria-label="Lobby Overview"
        onClick={() => props.onSwitchTarget?.()}
      >
        <span class="i-ph-squares-four-bold text-sm" />
      </button>
    </Show>
  )

  const renderSteamLobbyButton = (sizeClass: string) => (
    <SteamLobbyButton
      steamLobbyLink={props.steamLobbyLink ?? null}
      isHost={amHost()}
      onSaveSteamLink={props.onSaveSteamLink}
      savePending={props.savePending}
      class={sizeClass}
    />
  )

  const renderScrubButton = () => (
    <button
      class="text-xs text-fg-muted px-3 py-1.5 border border-border rounded-full bg-bg-muted/30 cursor-pointer whitespace-nowrap transition-colors hover:border-border-hover hover:bg-bg-muted/50"
      onClick={sendScrub}
    >
      Scrub
    </button>
  )

  const renderResultActions = () => (
    <Show
      when={resultStatus() !== 'done'}
      fallback={(
        <span class="text-sm text-accent tracking-widest font-bold uppercase sm:text-lg">Result reported</span>
      )}
    >
      <div class="flex flex-wrap gap-2 items-center justify-center">
        <Button
          size="sm"
          disabled={!canInteract() || !resultSelectionReady()}
          onClick={confirmResult}
        >
          {resultStatus() === 'submitting:result' ? 'Submitting' : 'Confirm Result'}
        </Button>
        <Button
          size="sm"
          variant="redOutline"
          disabled={!canInteract()}
          onClick={scrubMatch}
        >
          {resultStatus() === 'submitting:scrub' ? 'Submitting' : 'Scrub'}
        </Button>
      </div>
    </Show>
  )

  const renderBanItems = (bans: string[], showPlaceholder: boolean) => (
    <Show
      when={bans.length > 0}
      fallback={showPlaceholder
        ? <span class="text-xs text-fg-muted/30 whitespace-nowrap">No bans</span>
        : null}
    >
      <For each={bans}>
        {civId => <BanSquare civId={civId} />}
      </For>
    </Show>
  )

  const renderBanRail = (side: 'left' | 'right', bans: string[], showPlaceholder: boolean) => (
    <div class={cn('flex min-w-0 flex-1 overflow-hidden', side === 'left' ? 'justify-start' : 'justify-end')}>
      <HorizontalScroller
        class="max-w-full w-fit"
        contentClass="flex flex-nowrap items-center gap-1.5 whitespace-nowrap"
      >
        {renderBanItems(bans, showPlaceholder)}
      </HorizontalScroller>
    </div>
  )

  const renderMobileBanRail = () => (
    <HorizontalScroller
      class="max-w-full"
      style={{ width: `calc(100% - ${mobileRailInsetCount() * 2.75}rem)` }}
      contentClass={cn(
        'flex min-w-full items-center whitespace-nowrap',
        isTeamMode() ? 'justify-between gap-2' : 'justify-center gap-1.5',
      )}
    >
      <Show
        when={isTeamMode()}
        fallback={renderBanItems(allBans(), state()?.status !== 'waiting' && allBans().length === 0)}
      >
        <>
          <div class="flex gap-1.5 whitespace-nowrap items-center">
            {renderBanItems(leftBans(), state()?.status !== 'waiting' && leftBans().length === 0)}
          </div>
          <div class="shrink-0 h-8 w-8" />
          <div class="flex gap-1.5 whitespace-nowrap items-center">
            {renderBanItems(rightBans(), state()?.status !== 'waiting' && rightBans().length === 0)}
          </div>
        </>
      </Show>
    </HorizontalScroller>
  )

  return (
    <header class={cn('relative flex flex-col shrink-0 overflow-hidden', isComplete() ? 'bg-bg-subtle' : phaseHeaderBg(), 'transition-colors duration-200')}>
      <Show when={phaseFlash()}>
        <div class={cn(
          'pointer-events-none absolute inset-0 z-0 anim-phase-flash',
          accent() === 'red' ? 'bg-danger/20' : 'bg-accent/20',
        )}
        />
      </Show>

      <Show when={isMobileLayout()}>
        <div class="flex flex-col relative z-10">
          <div class="px-12 pb-1.5 pt-2 text-center flex flex-col pointer-events-none items-center justify-center">
            <div class="flex min-h-4 items-center justify-center">
              <span class={cn(
                'text-xs font-bold tracking-widest uppercase',
                accent() === 'red' ? 'text-danger' : 'text-accent',
              )}
              >
                {phaseLabel()}
              </span>
            </div>

            <div class="flex min-h-5 items-center justify-center">
              <Show when={draftStore.timerEndsAt != null}>
                <span class={cn(
                  'font-mono text-base font-bold tabular-nums leading-none',
                  isExpired() && 'text-fg-subtle',
                  isCritical() && 'text-danger animate-pulse',
                  isUrgent() && !isCritical() && 'text-danger',
                  !isUrgent() && !isCritical() && !isExpired() && 'text-fg',
                )}
                >
                  {seconds()}
                  s
                </span>
              </Show>
            </div>
          </div>

          <div class="px-3 pb-2 min-h-8 relative">
            {renderMobileBanRail()}
            <div class="flex items-center left-3 top-1/2 justify-start absolute z-20 -translate-y-1/2">
              {renderSteamLobbyButton('h-8 w-8')}
            </div>
            <div class="flex items-center right-3 top-1/2 justify-end absolute z-20 -translate-y-1/2">
              {renderOverviewButton()}
            </div>
          </div>

          <Show when={showMobileActionRow()}>
            <div class="px-3 pb-2 flex justify-center">
              <Show when={state()?.status === 'active'} fallback={renderResultActions()}>
                {renderScrubButton()}
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={!isMobileLayout()}>
        {/* Main row */}
        <div class="px-4 py-2.5 relative z-10">
          <div class="left-4 top-1/2 absolute z-20 -translate-y-1/2">
            {renderSteamLobbyButton('h-8 w-8')}
          </div>
          <div class="right-4 top-1/2 absolute z-20 -translate-y-1/2">
            {renderOverviewButton()}
          </div>

          <div class={cn(
            'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4',
            hasSteamLobbyButton() && 'pl-12',
            hasOverviewButton() && 'pr-12',
          )}
          >
            {renderBanRail('left', leftBans(), showLeftNoBans())}

            {/* Center: phase + timer / post-draft controls */}
            <Show
              when={!isComplete()}
              fallback={(
                <div class="flex gap-3 items-center relative">
                  <Show
                    when={amHost()}
                    fallback={
                      <span class="text-lg text-accent tracking-widest font-bold uppercase">{phaseLabel()}</span>
                    }
                  >
                    {renderResultActions()}
                  </Show>
                </div>
              )}
            >
              <div class="flex flex-col gap-0.5 items-center relative">
                <span class={cn(
                  'text-xs font-bold tracking-widest uppercase',
                  accent() === 'red' ? 'text-danger' : 'text-accent',
                )}
                >
                  {phaseLabel()}
                </span>

                <Show when={draftStore.timerEndsAt != null}>
                  <span class={cn(
                    'font-mono text-lg font-bold tabular-nums leading-none',
                    isExpired() && 'text-fg-subtle',
                    isCritical() && 'text-danger animate-pulse',
                    isUrgent() && !isCritical() && 'text-danger',
                    !isUrgent() && !isCritical() && !isExpired() && 'text-fg',
                  )}
                  >
                    {seconds()}
                    s
                  </span>
                </Show>

                <Show when={amHost() && state()?.status === 'active'}>
                  <div class="ml-6 left-full top-1/2 absolute -translate-y-1/2">
                    {renderScrubButton()}
                  </div>
                </Show>
              </div>
            </Show>

            {renderBanRail('right', rightBans(), showRightNoBans())}
          </div>
        </div>
      </Show>

      {/* Shrinking timer line */}
      <Show when={draftStore.timerEndsAt != null && !isExpired()}>
        <div class="flex h-0.5 w-full items-center justify-center relative z-10">
          <div
            class={cn(
              'h-full transition-[width] duration-100 ease-linear rounded-full',
              isCritical() && 'animate-pulse',
            )}
            style={{
              'width': `${progress() * 100}%`,
              'background-color': isCritical() || isUrgent() ? 'var(--danger)' : phaseAccentColor(),
            }}
          />
        </div>
      </Show>
    </header>
  )
}
