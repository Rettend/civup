import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { openCivBlitzModDownload } from '~/client/lib/civblitz-mod-download'
import { cn } from '~/client/lib/css'
import { preloadLeaderFullPortraitIds } from '~/client/lib/leader-full-portrait'
import {
  canOpenLeaderGrid,
  currentPickTargetSeatIndex,
  currentStep,
  draftStore,
  gridOpen,
  hasSubmitted,
  isHiddenDraftComplete,
  isMapVotePhase,
  isMiniView,
  isMobileLayout,
  isMyTurn,
  isSpectator,
  isTeamFormationPhase,
  mapVotePhase,
  setGridOpen,
  updateDraftSteamLobbyLink,
  updateLobbyConfig,
  userId,
} from '~/client/stores'
import { FloatingUiScaleMenu } from '../ui/UiScaleMenu'
import { DraftHeader } from './DraftHeader'
import { DraftTimeline } from './DraftTimeline'
import { CaptainPickOverlay } from './CaptainPickOverlay'
import { LeaderGridOverlay } from './LeaderGridOverlay'
import { MapVoteOverlay } from './MapVoteOverlay'
import { MiniView } from './MiniView'
import { SlotStrip } from './SlotStrip'
import { SteamLobbyButton } from './SteamLobbyButton'

interface DraftViewProps {
  matchId: string
  steamLobbyLink?: string | null
  lobbyId?: string | null
  lobbyMode?: string | null
  onSwitchTarget?: () => void
  reportResultStatus?: 'idle' | 'submitting' | 'done'
  onReportStarted?: (matchId: string) => void
  onReportComplete?: (matchId: string) => void
  onReportFailed?: (matchId: string) => void
}

/** Main draft layout */
export function DraftView(props: DraftViewProps) {
  const state = () => draftStore.state
  const [autoOpenedGridToken, setAutoOpenedGridToken] = createSignal<string | null>(null)
  const [autoOpenedMapVoteToken, setAutoOpenedMapVoteToken] = createSignal<string | null>(null)
  const [steamLobbySavePending, setSteamLobbySavePending] = createSignal(false)
  const [modDownloadPending, setModDownloadPending] = createSignal(false)
  let scrubRedirectTimeout: ReturnType<typeof setTimeout> | null = null
  const hostId = () => draftStore.hostId
  const amHost = () => {
    const currentUserId = userId()
    if (!currentUserId) return false
    return currentUserId === hostId()
  }

  const steamLobbyLink = () => state() ? draftStore.steamLobbyLink : props.steamLobbyLink ?? null

  createEffect(() => {
    const current = state()
    if (!current || current.status === 'cancelled') return

    const leaderIds = new Set(current.availableCivIds)
    for (const selection of current.bans) leaderIds.add(selection.civId)
    for (const selection of current.pendingBlindBans) leaderIds.add(selection.civId)
    for (const selection of current.blindPickBans ?? []) leaderIds.add(selection.civId)
    for (const selection of current.picks) leaderIds.add(selection.civId)
    for (const selections of Object.values(draftStore.previews.bans)) {
      for (const civId of selections) leaderIds.add(civId)
    }
    for (const selections of Object.values(draftStore.previews.picks)) {
      for (const civId of selections) leaderIds.add(civId)
    }

    preloadLeaderFullPortraitIds(leaderIds, draftStore.leaderDataVersion)
  })

  createEffect(() => {
    const current = state()
    if (current?.status !== 'cancelled' || current.cancelReason !== 'scrub' || !props.onSwitchTarget) {
      if (!scrubRedirectTimeout) return
      clearTimeout(scrubRedirectTimeout)
      scrubRedirectTimeout = null
      return
    }
    if (scrubRedirectTimeout) return

    scrubRedirectTimeout = setTimeout(() => {
      scrubRedirectTimeout = null
      props.onSwitchTarget?.()
    }, 5000)
  })

  onCleanup(() => {
    if (!scrubRedirectTimeout) return
    clearTimeout(scrubRedirectTimeout)
    scrubRedirectTimeout = null
  })

  const isMyPickTurn = () => {
    const step = currentStep()
    return !!step && step.action === 'pick' && currentPickTargetSeatIndex() != null && !hasSubmitted()
  }

  const [showTurnFlash, setShowTurnFlash] = createSignal(false)
  let lastFlashedStep = -1
  let turnFlashTimeout: ReturnType<typeof setTimeout> | null = null

  createEffect(() => {
    if (!isMyPickTurn()) return
    const s = draftStore.state
    if (!s) return
    const stepIdx = s.currentStepIndex
    if (stepIdx === lastFlashedStep) return
    lastFlashedStep = stepIdx
    if (turnFlashTimeout) clearTimeout(turnFlashTimeout)
    setShowTurnFlash(true)
    turnFlashTimeout = setTimeout(() => {
      setShowTurnFlash(false)
      turnFlashTimeout = null
    }, 550)
  })

  onCleanup(() => {
    if (turnFlashTimeout) {
      clearTimeout(turnFlashTimeout)
      turnFlashTimeout = null
    }
  })

  createEffect(() => {
    if (!isMiniView()) return
    setGridOpen(false)
  })

  createEffect(() => {
    if (isTeamFormationPhase()) setGridOpen(false)
  })

  const isMapVoteVoting = () => mapVotePhase() === 'voting'
  const isMapVoteReveal = () => mapVotePhase() === 'reveal'
  const canReviewCompleteDraft = () => state()?.status === 'complete' && !isHiddenDraftComplete()
  const isCompleteCivBlitz = () => state()?.status === 'complete' && state()?.civBlitz != null
  const canDownloadCivBlitzMod = () => isCompleteCivBlitz()
    && state()?.civBlitz?.excludeBbgExpanded === true
    && !isSpectator()

  createEffect(() => {
    const current = state()
    if (!current || !isMapVoteVoting()) {
      setAutoOpenedMapVoteToken(null)
      return
    }
    if (isMiniView()) return

    const nextToken = `${draftStore.initVersion}:${current.matchId}:map-vote`
    if (autoOpenedMapVoteToken() === nextToken) return

    setGridOpen(true)
    setAutoOpenedMapVoteToken(nextToken)
  })

  createEffect(() => {
    if (!isMapVoteReveal()) return
    if (!gridOpen()) return
    setGridOpen(false)
  })

  createEffect(() => {
    const current = state()
    const seatIndex = draftStore.seatIndex
    if (!current || current.status !== 'active' || seatIndex == null) {
      setAutoOpenedGridToken(null)
      return
    }
    if (isMiniView()) return
    if (isMapVotePhase()) return
    if (!canOpenLeaderGrid()) return
    if (!isMyTurn() || hasSubmitted()) return

    const step = currentStep()
    const targetSeatIndex = step?.action === 'pick' ? currentPickTargetSeatIndex() : seatIndex
    if (step?.action === 'pick' && targetSeatIndex == null) return
    if (step?.action === 'pick' && targetSeatIndex !== seatIndex) return

    const nextToken = `${draftStore.initVersion}:${current.matchId}:${current.currentStepIndex}:${seatIndex}:${targetSeatIndex ?? seatIndex}`
    if (autoOpenedGridToken() === nextToken) return

    setGridOpen(true)
    setAutoOpenedGridToken(nextToken)
  })

  const isActiveOrComplete = () => isTeamFormationPhase() || isMapVotePhase() || state()?.status === 'active' || state()?.status === 'complete'
  const canSaveSteamLobbyLink = () => draftStore.seatIndex != null && Boolean(props.lobbyId) && Boolean(props.lobbyMode)
  const canToggleOverlay = () => isMapVoteVoting() || canOpenLeaderGrid() || isHiddenDraftComplete() || canReviewCompleteDraft()
  const showOverlayToggle = () => state()?.status === 'active' || isMapVoteVoting() || isHiddenDraftComplete() || canReviewCompleteDraft()
  const overlayToggleLabel = () => {
    if (isMapVoteVoting()) return gridOpen() ? 'Close map vote' : 'Open map vote'
    return gridOpen() ? 'Close leader grid' : 'Open leader grid'
  }

  const handleSaveSteamLink = async (link: string | null) => {
    const currentUserId = userId()
    if (!canSaveSteamLobbyLink() || !currentUserId || steamLobbySavePending()) return
    if (link === steamLobbyLink()) return

    setSteamLobbySavePending(true)
    try {
      const result = await updateLobbyConfig(props.lobbyMode!, props.lobbyId!, currentUserId, {
        steamLobbyLink: link,
      })
      if (!result.ok) {
        console.error('Failed to update Steam lobby link:', result.error)
        return
      }

      updateDraftSteamLobbyLink(result.lobby.steamLobbyLink)
    }
    finally {
      setSteamLobbySavePending(false)
    }
  }

  const handleModDownload = async () => {
    if (!canDownloadCivBlitzMod() || modDownloadPending()) return
    setModDownloadPending(true)
    try {
      await openCivBlitzModDownload(props.matchId)
    }
    catch (error) {
      console.error('Failed to open the match mod download:', error)
    }
    finally {
      setModDownloadPending(false)
    }
  }

  return (
    <Show
      when={state()?.status === 'cancelled'}
      fallback={(
        <Show
          when={!isMiniView()}
          fallback={<MiniView />}
        >
          <Show when={isActiveOrComplete()}>
            {/* Active + Complete draft view */}
            <div class="text-fg font-sans bg-bg flex flex-col h-screen relative overflow-hidden">
              <DraftHeader
                steamLobbyLink={steamLobbyLink()}
                onSaveSteamLink={canSaveSteamLobbyLink() ? handleSaveSteamLink : undefined}
                savePending={steamLobbySavePending()}
                onSwitchTarget={props.onSwitchTarget}
                reportResultStatus={props.reportResultStatus}
                onReportStarted={props.onReportStarted}
                onReportComplete={props.onReportComplete}
                onReportFailed={props.onReportFailed}
              />
              <DraftTimeline />

              {/* Main area */}
              <div class="flex flex-1 min-h-0 relative z-0">
                <FloatingUiScaleMenu class={gridOpen() ? 'z-5' : 'z-40'} disabled={gridOpen()} />
                <Show when={!isTeamFormationPhase()}><SlotStrip /></Show>
                <Show when={isTeamFormationPhase()}><CaptainPickOverlay /></Show>
                <Show when={!isTeamFormationPhase() && ((state()?.status === 'active' && !isMapVotePhase()) || isHiddenDraftComplete() || canReviewCompleteDraft())}>
                  <LeaderGridOverlay />
                </Show>
                <Show when={isMapVoteVoting()}>
                  <MapVoteOverlay />
                </Show>

                {/* Grid toggle button */}
                <Show when={showOverlayToggle()}>
                  <div class="flex pointer-events-none inset-x-0 bottom-3 justify-center absolute z-50">
                    <button
                      class={cn(
                        'flex items-center gap-1 rounded-full px-5 py-1.5 text-xs font-medium cursor-pointer',
                        'pointer-events-auto',
                        'bg-bg-subtle border border-border text-fg-muted',
                        canToggleOverlay() && 'hover:bg-bg-muted hover:text-fg transition-colors',
                        !canToggleOverlay() && 'cursor-default opacity-50',
                      )}
                      title={overlayToggleLabel()}
                      aria-label={overlayToggleLabel()}
                      disabled={!canToggleOverlay()}
                      onClick={() => {
                        if (!canToggleOverlay()) return
                        setGridOpen(!gridOpen())
                      }}
                    >
                      <Show when={gridOpen()} fallback={<div class="i-ph-caret-up-bold anim-fade-in text-sm" />}>
                        <div class="i-ph-caret-down-bold anim-fade-in text-sm" />
                      </Show>
                    </button>
                  </div>
                </Show>

                {/* Status indicator */}
                <Show when={!gridOpen() && showOverlayToggle()}>
                  <div class="flex inset-x-0 bottom-12 justify-center absolute z-5">
                    <Show when={isSpectator()}>
                      <span class="text-xs text-fg-subtle px-3 py-1 rounded-full bg-bg-subtle/80">Spectating</span>
                    </Show>
                  </div>
                </Show>

                {/* Post-draft message */}
                <Show when={state()?.status === 'complete'}>
                  <div class="flex pointer-events-none inset-x-0 top-16 justify-center absolute z-50">
                    <div class="px-4 py-2 border border-border-subtle rounded-lg bg-bg-subtle/80 flex flex-col gap-2 pointer-events-auto shadow-2xl shadow-black/50 items-center backdrop-blur-sm">
                      <span class="text-base text-accent font-bold">{isCompleteCivBlitz() ? 'Draft complete' : 'You can close the activity!'}</span>
                      <Show
                        when={isCompleteCivBlitz()}
                        fallback={<span class="text-sm text-fg/80">Don't forget to report the result</span>}
                      >
                        <Show
                          when={state()?.civBlitz?.excludeBbgExpanded === true}
                          fallback={<span class="text-sm text-fg/80">Shared mod download is not available for BBG Expanded drafts.</span>}
                        >
                          <Show when={!isSpectator()}>
                            <button
                              type="button"
                              class="text-bg bg-accent rounded-md flex gap-2 px-3 py-1.5 text-sm font-semibold cursor-pointer transition-opacity items-center hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                              disabled={!canDownloadCivBlitzMod() || modDownloadPending()}
                              onClick={() => void handleModDownload()}
                            >
                              <span class={modDownloadPending() ? 'i-ph-spinner-gap-bold animate-spin' : 'i-ph-download-simple-bold'} />
                              {modDownloadPending() ? 'Opening download...' : 'Download leaders mod'}
                            </button>
                            <span class="text-xs text-fg/70">Everyone installs this same mod.</span>
                          </Show>
                        </Show>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>

              <Show when={isMyPickTurn()}>
                <div class="screen-glow-mask opacity-20 w-14 pointer-events-none inset-y-0 left-0 absolute z-30 from-[var(--accent)] to-transparent bg-gradient-to-r" />
                <div class="screen-glow-mask opacity-20 w-14 pointer-events-none inset-y-0 right-0 absolute z-30 from-[var(--accent)] to-transparent bg-gradient-to-l" />
              </Show>

              <Show when={showTurnFlash()}>
                <div
                  class="anim-turn-flash pointer-events-none inset-0 absolute z-0"
                  style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(200, 170, 110, 0.5) 100%)' }}
                />
              </Show>
            </div>
          </Show>
        </Show>
      )}
    >
      <Show when={!isMiniView()} fallback={<MiniView />}>
        <CancelledDraftScreen
          steamLobbyLink={steamLobbyLink()}
          onSwitchTarget={props.onSwitchTarget}
        />
      </Show>
    </Show>
  )
}

function CancelledDraftScreen(props: {
  steamLobbyLink: string | null
  onSwitchTarget?: () => void
}) {
  const state = () => draftStore.state
  const reason = () => state()?.cancelReason ?? 'scrub'

  const title = () => {
    if (reason() === 'cancel') return 'Draft Cancelled'
    if (reason() === 'timeout') return 'Draft Auto-Scrubbed'
    if (reason() === 'revert') return 'Draft Reverted'
    return 'Match Scrubbed'
  }

  const detail = () => {
    if (reason() === 'cancel') return 'Host cancelled this draft before lock-in.'
    if (reason() === 'timeout') return 'A player timed out picking a leader.'
    if (reason() === 'revert') return 'Host returned everyone to draft setup.'
    return 'Host scrubbed this match.'
  }

  return (
    <main class="text-fg font-sans bg-bg h-screen relative overflow-y-auto">
      <div class={cn('flex gap-2 items-center z-20 absolute', isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6')}>
        <Show when={props.onSwitchTarget}>
          <button
            type="button"
            class="text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
            title="Lobby Overview"
            aria-label="Lobby Overview"
            onClick={() => props.onSwitchTarget?.()}
          >
            <span class="i-ph-squares-four-bold text-base" />
          </button>
        </Show>
      </div>
      <FloatingUiScaleMenu />
      <Show when={reason() !== 'scrub'}>
        <SteamLobbyButton
          steamLobbyLink={props.steamLobbyLink}
          class={cn('z-20 absolute', isMobileLayout() ? 'top-12 left-4 h-9 w-9' : 'top-4 left-4 h-9 w-9')}
        />
      </Show>
      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl md:px-8">
        <section class="p-7 text-center border border-border rounded-lg bg-bg-subtle/70">
          <div class="text-[11px] text-fg-subtle tracking-[0.14em] font-semibold mb-2 uppercase">Session Closed</div>
          <h1 class="text-3xl text-fg font-semibold mb-3">{title()}</h1>
          <p class="text-sm text-fg-muted leading-relaxed">{detail()}</p>
        </section>
      </div>
    </main>
  )
}
