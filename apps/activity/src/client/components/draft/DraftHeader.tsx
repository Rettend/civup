import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { MAP_SCRIPT_BY_ID, MAP_TYPE_BY_ID } from '~/client/lib/map-vote'
import {
  MAP_VOTE_REVEAL_DURATION_SECONDS,
  MAP_VOTE_VOTING_DURATION_SECONDS,
  clearFfaPlacements,
  clearResultSelections,
  currentStepDuration,
  draftStore,
  ffaPlacementOrder,
  isMapVotePhase,
  isMobileLayout,
  mapVotePhase,
  mapVoteRevealEndsAt,
  mapVoteVotingEndsAt,
  mapVoteWinningScript,
  mapVoteWinningType,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
  reportMatchResult,
  scrubMatchResult,
  selectedWinningTeam,
  sendRevert,
  sendScrub,
  setResultSelectionsLocked,
  teamPlacementOrder,
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
  type DraftHostAction = 'scrub' | 'revert'

  const state = () => draftStore.state
  const accent = () => isMapVotePhase() ? ('gold' as const) : phaseAccent()
  const accentColor = () => isMapVotePhase() ? 'var(--accent)' : phaseAccentColor()
  const headerBg = () => isComplete() ? 'bg-bg-subtle' : isMapVotePhase() ? 'bg-bg-subtle' : phaseHeaderBg()
  const amHost = () => userId() === draftStore.hostId
  const isParticipant = () => {
    const uid = userId()
    const s = state()
    if (!uid || !s) return false
    return s.seats.some(seat => seat.playerId === uid)
  }
  const [phaseFlash, setPhaseFlash] = createSignal(false)
  const [armedHostAction, setArmedHostAction] = createSignal<DraftHostAction | null>(null)
  let phaseFlashTimeout: ReturnType<typeof setTimeout> | null = null
  let armedHostActionTimeout: ReturnType<typeof setTimeout> | null = null

  const isTeamMode = () => state()?.seats.some(s => s.team != null) ?? false
  const teamCount = () => new Set((state()?.seats ?? []).flatMap(seat => seat.team == null ? [] : [seat.team])).size
  const isComplete = () => state()?.status === 'complete'
  const seatCount = () => state()?.seats.length ?? 0

  const displayPhaseLabel = () => isMapVotePhase() ? 'MAP VOTING' : phaseLabel()
  const winningMapTypeOption = () => {
    const id = mapVoteWinningType()
    return id ? MAP_TYPE_BY_ID[id] : null
  }
  const winningMapScriptOption = () => {
    const id = mapVoteWinningScript()
    return id ? MAP_SCRIPT_BY_ID[id] : null
  }
  const hasWinningMap = () => winningMapTypeOption() != null && winningMapScriptOption() != null
  const showWinningMapBadge = () => hasWinningMap() && !isMapVotePhase() && state()?.status === 'active'

  const clearPhaseFlashTimeout = () => {
    if (phaseFlashTimeout == null) return
    clearTimeout(phaseFlashTimeout)
    phaseFlashTimeout = null
  }

  const clearArmedHostActionTimeout = () => {
    if (armedHostActionTimeout == null) return
    clearTimeout(armedHostActionTimeout)
    armedHostActionTimeout = null
  }

  const disarmHostAction = () => {
    clearArmedHostActionTimeout()
    setArmedHostAction(null)
  }

  const armHostAction = (action: DraftHostAction) => {
    clearArmedHostActionTimeout()
    setArmedHostAction(action)
    armedHostActionTimeout = setTimeout(() => {
      setArmedHostAction(null)
      armedHostActionTimeout = null
    }, 4000)
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
  const timerEndsAt = () => {
    if (!isMapVotePhase()) return draftStore.timerEndsAt
    return mapVotePhase() === 'voting' ? mapVoteVotingEndsAt() : mapVoteRevealEndsAt()
  }

  createEffect(() => {
    const endsAt = timerEndsAt()
    if (endsAt == null) {
      setRemaining(0)
      return
    }
    const nextEndsAt = endsAt

    function tick() { setRemaining(Math.max(0, nextEndsAt - Date.now())) }
    tick()
    const interval = setInterval(tick, 100)
    onCleanup(() => clearInterval(interval))
  })

  const seconds = () => Math.ceil(remaining() / 1000)
  const duration = () => {
    if (!isMapVotePhase()) return currentStepDuration()
    return mapVotePhase() === 'voting' ? MAP_VOTE_VOTING_DURATION_SECONDS : MAP_VOTE_REVEAL_DURATION_SECONDS
  }
  const progress = () => {
    if (!timerEndsAt() || duration() <= 0) return 0
    return Math.min(1, remaining() / (duration() * 1000))
  }

  const usesDangerTimerState = () => !isMapVotePhase()
  const isUrgent = () => usesDangerTimerState() && seconds() <= 10 && seconds() > 5
  const isCritical = () => usesDangerTimerState() && seconds() <= 5 && seconds() > 0
  const isExpired = () => timerEndsAt() != null && remaining() <= 0

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
    clearArmedHostActionTimeout()
    setResultSelectionsLocked(false)
  })

  // ── Result Reporting ────────────────────────
  const [resultStatus, setResultStatus] = createSignal<'idle' | 'submitting:result' | 'submitting:scrub' | 'submitting:revert' | 'done'>('idle')

  createEffect(() => {
    setResultSelectionsLocked(resultStatus() !== 'idle')
  })

  createEffect(on(() => state()?.matchId, () => {
    setResultStatus('idle')
    clearResultSelections()
    disarmHostAction()
  }, { defer: true }))

  createEffect(() => {
    if (state()?.status === 'complete') return
    setResultStatus('idle')
    clearResultSelections()
  })

  createEffect(on(
    () => `${state()?.status ?? 'none'}:${state()?.currentStepIndex ?? -1}:${isMapVotePhase() ? mapVotePhase() : 'draft'}`,
    () => disarmHostAction(),
    { defer: true },
  ))

  const reportSelectedTeam = async () => {
    const uid = userId()
    const team = selectedWinningTeam()
    if (!uid || team == null) return

    setResultStatus('submitting:result')
    const teamToken = teamIndexToken(team)
    const res = await reportMatchResult(draftStore.state!.matchId, uid, teamToken)
    setResultStatus(res.ok ? 'done' : 'idle')
  }

  const reportOrderedTeams = async () => {
    const uid = userId()
    const order = teamPlacementOrder()
    const totalTeams = teamCount()
    if (!uid || order.length !== totalTeams) return

    setResultStatus('submitting:result')
    const placements = order.map(teamIndexToken).join('\n')
    const res = await reportMatchResult(draftStore.state!.matchId, uid, placements)
    if (res.ok) {
      setResultStatus('done')
      return
    }

    setResultStatus('idle')
    clearResultSelections()
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
      if (teamCount() > 2) {
        await reportOrderedTeams()
        return
      }
      await reportSelectedTeam()
      return
    }
    await reportFfa()
  }

  const scrubMatch = async () => {
    const uid = userId()
    const s = state()
    if (!amHost() || !uid || !s) return

    if (s.status === 'complete') {
      setResultStatus('submitting:scrub')
      const res = await scrubMatchResult(s.matchId, uid)
      setResultStatus(res.ok ? 'done' : 'idle')
      return
    }

    setResultStatus('submitting:scrub')
    sendScrub()
    setResultStatus('idle')
  }

  const revertDraft = () => {
    const s = state()
    if (!amHost() || !s || s.status !== 'active') return

    setResultStatus('submitting:revert')
    sendRevert()
    setResultStatus('idle')
  }

  const confirmHostAction = (action: DraftHostAction) => {
    if (!canManageDraft()) return
    if (armedHostAction() !== action) {
      armHostAction(action)
      return
    }

    disarmHostAction()
    if (action === 'revert') {
      revertDraft()
      return
    }
    void scrubMatch()
  }

  const canManageDraft = () => amHost() && !resultStatus().startsWith('submitting') && resultStatus() !== 'done'
  const canSubmitResult = () => isParticipant() && !resultStatus().startsWith('submitting') && resultStatus() !== 'done'
  const resultSelectionReady = () => {
    if (!isTeamMode()) return ffaPlacementOrder().length === seatCount()
    if (teamCount() > 2) return teamPlacementOrder().length === teamCount()
    return selectedWinningTeam() != null
  }
  const showMobileActionRow = () => {
    if (!isMobileLayout()) return false
    if (state()?.status === 'active') return amHost()
    if (isComplete()) return isParticipant()
    return false
  }
  const showLeftNoBans = () => state()?.status !== 'waiting' && (isTeamMode() ? leftBans().length === 0 : allBans().length === 0)
  const showRightNoBans = () => state()?.status !== 'waiting' && isTeamMode() && rightBans().length === 0
  const hasSteamLobbyButton = () => true
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

  const confirmationHint = () => {
    if (armedHostAction() === 'revert') return { line1: 'Revert will return everyone to the lobby.', line2: 'Click again to confirm.' }
    if (armedHostAction() === 'scrub') return { line1: 'Scrub will cancel the draft completely.', line2: 'Click again to confirm.' }
    return null
  }

  const renderHostActionButton = (
    action: DraftHostAction,
    label: string,
    iconClass: string,
    iconOnly: boolean,
  ) => (
    <button
      type="button"
      class={cn(
        'border rounded-full bg-bg-muted/30 cursor-pointer whitespace-nowrap transition-colors',
        'disabled:opacity-50 disabled:pointer-events-none',
        iconOnly ? 'flex h-9 w-9 items-center justify-center px-0 py-0 text-sm' : 'px-3 py-1.5 text-xs text-fg-muted',
        armedHostAction() === action
          ? 'border-danger/70 bg-danger/20 text-danger hover:border-danger hover:bg-danger/25'
          : 'border-border text-fg-muted hover:border-border-hover hover:bg-bg-muted/50',
      )}
      disabled={!canManageDraft()}
      title={label}
      aria-label={label}
      onClick={() => confirmHostAction(action)}
    >
      <Show when={iconOnly} fallback={label}>
        <span class={cn(iconClass, 'text-sm')} />
      </Show>
    </button>
  )

  const renderActiveHostActions = (iconOnly: boolean) => (
    <div class="flex gap-2 items-center relative">
      <div class="flex gap-2 items-center">
        {renderHostActionButton('revert', 'Revert', 'i-ph-arrow-u-up-left-bold', iconOnly)}
        {renderHostActionButton('scrub', 'Scrub', 'i-ph-x-bold', iconOnly)}
      </div>
      <Show when={confirmationHint()}>
        {hint => (
          <div
            class={cn(
              'pointer-events-none absolute z-20 border border-border rounded-lg bg-bg-subtle/80 px-3 py-1.5 text-xs text-fg-muted shadow-lg backdrop-blur-sm text-center',
              iconOnly
                ? 'left-1/2 top-full mt-2 -translate-x-1/2 w-max max-w-[calc(100vw-2rem)]'
                : 'left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap',
            )}
          >
            {hint().line1}
            <br />
            {hint().line2}
          </div>
        )}
      </Show>
    </div>
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
          disabled={!canSubmitResult() || !resultSelectionReady()}
          onClick={confirmResult}
        >
          {resultStatus() === 'submitting:result' ? 'Submitting' : 'Confirm Result'}
        </Button>
        <Show when={amHost()}>
          <Button
            size="sm"
            variant="redOutline"
            disabled={!canManageDraft()}
            onClick={scrubMatch}
          >
            {resultStatus() === 'submitting:scrub' ? 'Submitting' : 'Scrub'}
          </Button>
        </Show>
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
      class="mx-auto max-w-full"
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
    <header class={cn('relative z-30 flex flex-col shrink-0 overflow-x-clip', headerBg(), 'transition-colors duration-200')}>
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
            <div class="flex min-h-4 gap-2 items-center justify-center">
              <span class={cn(
                'text-xs font-bold tracking-widest uppercase',
                accent() === 'red' ? 'text-danger' : 'text-accent',
              )}
              >
                {displayPhaseLabel()}
              </span>
            </div>

            <div class="flex min-h-5 items-center justify-center relative">
              <Show when={timerEndsAt() != null}>
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
              <div class="relative w-fit">
                <Show when={showWinningMapBadge()}>
                  <div class="mr-2 right-full top-1/2 absolute min-w-0 -translate-y-1/2">
                    <WinningMapBadge compact />
                  </div>
                </Show>

                <Show when={state()?.status === 'active'} fallback={renderResultActions()}>
                  {renderActiveHostActions(true)}
                </Show>
              </div>
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
                    when={isParticipant()}
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
                  {displayPhaseLabel()}
                </span>

                <div class="min-h-6 relative flex items-center justify-center">
                  <Show when={showWinningMapBadge()}>
                    <div class="mr-6 right-full top-1/2 absolute min-w-0 -translate-y-1/2">
                      <WinningMapBadge />
                    </div>
                  </Show>

                  <Show when={timerEndsAt() != null}>
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
                      {renderActiveHostActions(false)}
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {renderBanRail('right', rightBans(), showRightNoBans())}
          </div>
        </div>
      </Show>

      {/* Shrinking timer line */}
      <Show when={timerEndsAt() != null && !isExpired()}>
        <div class="flex h-0.5 w-full items-center justify-center relative z-0">
          <div
            class={cn(
              'h-full transition-[width] duration-100 ease-linear rounded-full',
              isCritical() && 'animate-pulse',
            )}
            style={{
              'width': `${progress() * 100}%`,
              'background-color': isCritical() || isUrgent() ? 'var(--danger)' : accentColor(),
            }}
          />
        </div>
      </Show>
    </header>
  )
}

function teamIndexToken(team: number): string {
  return String.fromCharCode(65 + team)
}

/**
 * Compact badge showing the map that was voted in. Rendered near the phase
 * label so the picked map is visible throughout the ban/pick draft.
 */
function WinningMapBadge(props: { compact?: boolean }) {
  const typeSuffix = () => {
    const mapType = mapVoteWinningType()
    if (mapType == null || mapType === 'standard') return ''
    if (mapType === 'east-vs-west') return 'EvW'
    return MAP_TYPE_BY_ID[mapType]?.name ?? mapType
  }
  const scriptLabel = () => {
    const mapScript = mapVoteWinningScript()
    const script = mapScript ? MAP_SCRIPT_BY_ID[mapScript] : null
    if (!script) return ''
    return script.hint ? `${script.name} ${script.hint}` : script.name
  }
  const label = () => {
    const script = scriptLabel()
    const suffix = typeSuffix()
    if (!script) return suffix
    return suffix ? `${script} ${suffix}` : script
  }

  return (
    <div
      class={cn(
        'rounded-full bg-bg/60 border border-border flex max-w-full items-center overflow-hidden',
        props.compact ? 'max-w-[calc(50vw-3rem)] px-2 py-0.5' : 'mt-0.5 max-w-[14rem] px-2.5 py-0.5',
      )}
      title={label()}
      aria-label={label()}
    >
      <span class={cn('block truncate whitespace-nowrap text-fg font-medium tracking-wide', props.compact ? 'text-[10px]' : 'text-[11px]')}>
        {label()}
      </span>
    </div>
  )
}
