import type { Leader } from '@civup/game'
import { getLeader, MAP_SCRIPT_BY_ID, MAP_TYPE_BY_ID } from '@civup/game'
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import { getLeaderFullPortraitUrl } from '~/client/lib/leader-full-portrait'
import { placementIconClass } from '~/client/lib/placement-icons'
import { createSeatGridLayout, findSeatGridPosition, getSeatAtGridPosition } from '~/client/lib/seat-grid'
import { getVisualSeatOrder } from '~/client/lib/seat-order'
import { canSwapLeadersWith, draftNow, draftStore, ffaPlacementOrder, getOptimisticSeatPick, getPreviewPickForSeat, getSeatMapVote, gridOpen, hiddenDraftLeaderSelections, isHiddenDraftComplete, isMapVotePhase, isMobileLayout, isSeatMapVoteConfirmed, MAP_VOTE_REVEAL_DURATION_SECONDS, MAP_VOTE_VOTING_DURATION_SECONDS, mapVotePhase, mapVoteRevealEndsAt, mapVoteWinningScriptCandidate, mapVoteWinningTypeCandidate, phaseAccent, resultSelectionsLocked, seatJustSwapped, selectWinningTeam, sendLeaderSwap, toggleFfaPlacement, toggleTeamPlacement, userId } from '~/client/stores'

interface PlayerSlotProps {
  /** Seat index in the draft */
  seatIndex: number
  /** Whether this is a half-height FFA slot */
  compact?: boolean
  /** One-based visual slot number shown in the slot corner. */
  displayNumber?: number
}

const SLOT_BREATHE_CYCLE_MS = 3000

function SlotPortraitImage(props: {
  src: string
  alt: string
  class?: string
  animate?: boolean
  waitForDecode?: boolean
}) {
  const [ready, setReady] = createSignal(!props.waitForDecode)

  const markReady = (image: HTMLImageElement) => {
    if (!props.waitForDecode) return
    const decode = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
    void decode.catch(() => undefined).finally(() => setReady(true))
  }

  return (
    <img
      ref={(image) => {
        if (props.waitForDecode && image.complete && image.naturalWidth > 0) markReady(image)
      }}
      src={props.src}
      alt={props.alt}
      class={cn(
        props.class,
        props.animate && props.waitForDecode && !ready() && 'opacity-0',
        props.animate && (!props.waitForDecode || ready()) && 'anim-portrait-in',
      )}
      onLoad={event => markReady(event.currentTarget)}
      onError={() => setReady(true)}
    />
  )
}

/** Individual player slot */
export function PlayerSlot(props: PlayerSlotProps) {
  const state = () => draftStore.state
  const seat = () => state()?.seats[props.seatIndex]

  const pick = () => {
    const serverPick = state()?.picks.find(p => p.seatIndex === props.seatIndex)
    if (serverPick) return serverPick

    const optimisticCivId = getOptimisticSeatPick(props.seatIndex)
    const visualIndex = getVisualSeatOrder(state()?.seats).indexOf(props.seatIndex)
    const hiddenDraftCivId = visualIndex >= 0 ? hiddenDraftLeaderSelections()[visualIndex] ?? null : null
    const civId = optimisticCivId ?? (isHiddenDraftComplete() ? hiddenDraftCivId : null)
    if (!civId) return null

    return {
      seatIndex: props.seatIndex,
      civId,
    }
  }

  const leader = (): Leader | null => {
    const p = pick()
    if (!p) return null
    try { return getLeader(p.civId, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const filled = () => !!pick()
  const previewLeader = (): Leader | null => {
    if (filled()) return null
    const civId = getPreviewPickForSeat(props.seatIndex)
    if (!civId) return null
    try { return getLeader(civId, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const hasPreview = (): boolean => previewLeader() != null
  const displayLeader = (): Leader | null => leader() ?? previewLeader()
  const leaderKey = () => {
    const l = leader()
    return l ? `${draftStore.leaderDataVersion}:${l.id}` : null
  }
  const previewLeaderKey = () => {
    const l = previewLeader()
    return l ? `${draftStore.leaderDataVersion}:${l.id}` : null
  }
  const displayLeaderKey = () => {
    const l = displayLeader()
    return l ? `${draftStore.leaderDataVersion}:${l.id}` : null
  }
  const shouldAnimatePickedPortrait = () => state()?.status !== 'complete' || seatJustSwapped(props.seatIndex)

  const accent = () => phaseAccent()
  const seatAvatarUrl = () => seat()?.avatarUrl ?? null
  const seatPlayerId = () => seat()?.playerId ?? null
  const isComplete = () => state()?.status === 'complete'
  const isFfa = () => !(state()?.seats.some(s => s.team != null) ?? false)
  const teamCount = () => new Set((state()?.seats ?? []).flatMap(seat => seat.team == null ? [] : [seat.team])).size
  const isParticipant = () => {
    const uid = userId()
    const s = state()
    if (!uid || !s) return false
    return s.seats.some(current => current.playerId === uid)
  }
  const isFfaPlacementMode = () => isComplete() && isFfa() && isParticipant()
  const isTwoTeamResultMode = () => isComplete() && !isFfa() && isParticipant() && teamCount() <= 2
  const isMultiTeamResultMode = () => isComplete() && !isFfa() && isParticipant() && teamCount() > 2
  const isTeamResultMode = () => isTwoTeamResultMode() || isMultiTeamResultMode()
  const canSelectResult = () => !resultSelectionsLocked()
  const isHiddenDraftLeaderAssignmentMode = () => isHiddenDraftComplete() && gridOpen() && isParticipant()
  const isHiddenDraftNextPickSeat = () => {
    if (!isHiddenDraftLeaderAssignmentMode()) return false
    const nextSeatIndex = getVisualSeatOrder(state()?.seats)[hiddenDraftLeaderSelections().length]
    return nextSeatIndex === props.seatIndex
  }
  const isActive = (): boolean => {
    if (isHiddenDraftNextPickSeat()) return true

    const s = state()
    if (!s || s.status !== 'active') return false
    const step = s.steps[s.currentStepIndex]
    if (!step) return false
    const seatIsInStep = step.seats === 'all'
      ? props.seatIndex >= 0 && props.seatIndex < s.seats.length
      : step.seats.includes(props.seatIndex)
    if (!seatIsInStep) return false

    const submittedCount = s.submissions[props.seatIndex]?.length ?? 0
    return submittedCount < step.count
  }
  const activeStepDurationSeconds = () => {
    const s = state()
    if (!s || s.status !== 'active') return 0
    const step = s.steps[s.currentStepIndex]
    return typeof step?.timer === 'number' ? step.timer : 0
  }
  const activeBreatheAnimationStyle = createMemo<StableBreatheAnimationStyle>(
    () => createStableBreatheAnimationStyle({
      active: isActive(),
      endsAt: draftStore.timerEndsAt,
      durationSeconds: activeStepDurationSeconds(),
      nowMs: draftNow(),
    }),
    { key: 'initial', style: {} },
    { equals: (previous, next) => previous.key === next.key },
  )

  const [wasEverActive, setWasEverActive] = createSignal(false)
  createEffect(() => { if (isActive()) setWasEverActive(true) })

  // ── FFA Placement ────────────────────────────────────────
  const placementRank = () => {
    if (!isFfaPlacementMode()) return -1
    return ffaPlacementOrder().indexOf(props.seatIndex)
  }

  const isPlaced = () => placementRank() >= 0
  const anyFfaPlaced = () => ffaPlacementOrder().length > 0

  /** Boosted glow for compact FFA slots (smaller area needs higher intensity) */
  const ffaWinnerGlowStyle = {
    background: [
      'radial-gradient(ellipse farthest-side at 50% 130%, var(--glow-gold) 0%, var(--glow-gold-dim) 40%, transparent 72%)',
      'radial-gradient(ellipse closest-side at 50% 100%, rgba(255,215,100,0.38) 0%, transparent 55%)',
      'linear-gradient(to top, var(--glow-gold-dim) 0%, transparent 40%)',
    ].join(', '),
  }

  const ffaGoldBorderColor = 'var(--accent-muted)'

  const ffaGridLayout = () => createSeatGridLayout(
    state()?.seats.length ?? 0,
    isMobileLayout() ? 2 : Math.ceil((state()?.seats.length ?? 0) / 2),
  )

  const ffaGridPosition = () => {
    return findSeatGridPosition(ffaGridLayout(), props.seatIndex)
  }

  const ffaSeatAt = (row: number, col: number): number | null => {
    return getSeatAtGridPosition(ffaGridLayout(), row, col)
  }

  const ffaHasPlacedLeft = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const leftSeat = ffaSeatAt(row, col - 1)
    return leftSeat != null && ffaPlacementOrder().includes(leftSeat)
  }

  const ffaHasPlacedAbove = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const aboveSeat = ffaSeatAt(row - 1, col)
    return aboveSeat != null && ffaPlacementOrder().includes(aboveSeat)
  }

  const ffaHasPlacedRight = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const rightSeat = ffaSeatAt(row, col + 1)
    return rightSeat != null && ffaPlacementOrder().includes(rightSeat)
  }

  const ffaHasPlacedBelow = () => {
    const position = ffaGridPosition()
    if (!isPlaced() || !position) return false
    const { row, col } = position
    const belowSeat = ffaSeatAt(row + 1, col)
    return belowSeat != null && ffaPlacementOrder().includes(belowSeat)
  }

  const ffaGoldBorderStyle = () => {
    if (!isPlaced()) return ''
    return [
      'box-sizing:border-box',
      `border-top:${ffaHasPlacedAbove() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-left:${ffaHasPlacedLeft() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-right:${ffaHasPlacedRight() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      `border-bottom:${ffaHasPlacedBelow() ? '0 solid transparent' : `2px solid ${ffaGoldBorderColor}`}`,
      'box-shadow:inset 0 0 28px var(--glow-gold-dim)',
    ].join(';')
  }

  const placementNumber = () => {
    const rank = placementRank()
    if (rank < 0) return 0
    return draftStore.permanentAlly ? Math.floor(rank / 2) + 1 : rank + 1
  }
  const seatTeam = () => seat()?.team ?? null

  const showCornerSwapButton = () => !resultSelectionsLocked() && canSwapLeadersWith(props.seatIndex)
  const swapButtonClass = 'rounded-full border-2 bg-transparent text-[#e2c68b] border-[#e8d4ab]/72 shadow-[0_6px_18px_rgba(0,0,0,0.38),0_0_0_1px_rgba(200,170,110,0.08)] transition-[color,border-color,box-shadow,transform] duration-200 hover:text-[#f4dca8] hover:border-[#f4dca8]/92 hover:shadow-[0_8px_24px_rgba(0,0,0,0.46),0_0_18px_rgba(200,170,110,0.24)] active:scale-95'

  const handleSlotClick = () => {
    if (!isFfaPlacementMode() || !canSelectResult()) return
    toggleFfaPlacement(props.seatIndex)
  }

  const handleTeamResultClick = () => {
    if (!isTeamResultMode() || !canSelectResult()) return
    const team = seatTeam()
    if (team == null) return
    if (isMultiTeamResultMode()) {
      toggleTeamPlacement(team)
      return
    }
    if (team !== 0 && team !== 1) return
    selectWinningTeam(team)
  }

  return (
    <div
      class={cn(
        'relative flex flex-col overflow-hidden bg-bg-subtle h-full isolate',
        canSelectResult() && (isFfaPlacementMode() || isTeamResultMode()) && 'cursor-pointer',
      )}
      classList={{
        'slot-accent-gold': isActive() && accent() === 'gold',
        'slot-accent-red': isActive() && accent() === 'red',
      }}
      onClick={() => {
        if (isHiddenDraftLeaderAssignmentMode() && canSelectResult()) return
        handleSlotClick()
        handleTeamResultClick()
      }}
    >
      {/* Side Glows */}
      <div
        class="w-6 pointer-events-none inset-y-0 left-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-r"
        classList={{
          'anim-glow-breathe': isActive(),
          'anim-glow-fade-out': wasEverActive() && !isActive(),
          'opacity-0': !wasEverActive(),
        }}
        style={{
          ...activeBreatheAnimationStyle().style,
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />
      <div
        class="w-6 pointer-events-none inset-y-0 right-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-l"
        classList={{
          'anim-glow-breathe': isActive(),
          'anim-glow-fade-out': wasEverActive() && !isActive(),
          'opacity-0': !wasEverActive(),
        }}
        style={{
          ...activeBreatheAnimationStyle().style,
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />

      {/* Top accent bar */}
      <div
        class="rounded-full bg-[var(--slot-glow)] h-[2px] pointer-events-none left-1/2 top-2 absolute z-10 -translate-x-1/2"
        classList={{
          'anim-bar-breathe': isActive(),
          'anim-bar-fade-out': wasEverActive() && !isActive(),
          'opacity-0 w-0': !wasEverActive(),
        }}
        style={activeBreatheAnimationStyle().style}
      />

      {/* FFA placement overlay */}
      <Show when={isFfaPlacementMode()}>
        {/* Bottom radial glow on selected slots */}
        <Show when={isPlaced()}>
          <div
            class="anim-fade-in pointer-events-none inset-0 absolute z-20"
            style={ffaWinnerGlowStyle}
          />
        </Show>

        {/* Gold border with neighbor-aware collapse */}
        <Show when={isPlaced()}>
          <div class="pointer-events-none inset-0 absolute z-30" style={ffaGoldBorderStyle()} />
        </Show>

        {/* Placement badge */}
        <Show when={isPlaced()}>
          <div class="anim-fade-in left-1/2 top-1/2 absolute z-40 -translate-x-1/2 -translate-y-1/2">
            <div
              class={cn(
                'flex items-center justify-center rounded-full leading-none',
                'border border-[var(--badge-gold-border)] bg-accent font-black shadow-[0_4px_12px_rgba(0,0,0,0.5),0_8px_28px_rgba(0,0,0,0.4),0_16px_48px_rgba(0,0,0,0.25)]',
                props.compact ? 'h-12 w-12 text-xl' : 'h-14 w-14 text-2xl',
              )}
              style={{ 'color': 'var(--badge-gold-text)', 'font-weight': 900 }}
            >
              <span class={cn(placementIconClass(placementNumber()), props.compact ? 'text-[28px]' : 'text-[32px]')} />
            </div>
          </div>
        </Show>

        {/* Dim unselected slots when any placement has been made */}
        <Show when={anyFfaPlaced() && !isPlaced()}>
          <div class="bg-black/50 pointer-events-none inset-0 absolute z-25" />
        </Show>
      </Show>

      {/* Small swap button on teammate portraits */}
      <Show when={showCornerSwapButton()}>
        <div class="right-2 top-2 absolute z-50">
          <button
            type="button"
            class={cn(
              'flex h-12 w-12 items-center justify-center cursor-pointer',
              swapButtonClass,
            )}
            title="Swap leaders"
            aria-label="Swap leaders"
            onClick={(e) => {
              e.stopPropagation()
              sendLeaderSwap(props.seatIndex)
            }}
          >
            <span class="i-ph-arrows-left-right-bold text-[20px] pointer-events-none" />
          </button>
        </div>
      </Show>

      {/* Portrait */}
      <Show when={leaderKey()} keyed>
        {(_key) => {
          const l = leader()
          return l
            ? (
                <SlotPortraitImage
                  src={getLeaderFullPortraitUrl(l)}
                  alt={l.name}
                  class={cn(
                    'absolute inset-0 h-full w-full object-cover',
                    props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
                  )}
                  animate={shouldAnimatePickedPortrait()}
                  waitForDecode={state()?.status !== 'complete'}
                />
              )
            : null
        }}
      </Show>

      <Show when={!filled() && previewLeaderKey()} keyed>
        {(_key) => {
          const l = previewLeader()
          return l
            ? (
                <div class="opacity-50 inset-0 absolute saturate-85">
                  <SlotPortraitImage
                    src={getLeaderFullPortraitUrl(l)}
                    alt={l.name}
                    class={cn(
                      'absolute inset-0 h-full w-full object-cover',
                      props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
                    )}
                    animate
                  />
                </div>
              )
            : null
        }}
      </Show>

      {/* Empty state icon */}
      <Show when={!filled() && !hasPreview()}>
        <div class="flex flex-1 items-center justify-center">
          <div class={cn(
            isHiddenDraftComplete() ? 'i-ph-question-bold text-4xl' : 'i-ph-user-bold text-3xl',
            isActive() ? (accent() === 'red' ? 'text-danger/80' : 'text-accent/80') : 'text-fg-muted/40',
          )}
          />
        </div>
      </Show>

      {/* Bottom gradient overlay */}
      <div class={cn(
        'absolute inset-x-0 bottom-0 px-2 pb-2 pt-8 z-20',
        filled() || hasPreview() ? 'bg-gradient-to-t from-black/80 to-transparent' : 'bg-gradient-to-t from-bg/40 to-transparent',
      )}
      >
        {/* Leader name (when picked) */}
        <Show when={displayLeaderKey()} keyed>
          {(_key) => {
            const l = displayLeader()
            return l
              ? (
                  <div class="mb-1">
                    <div class={cn('text-base leading-tight font-semibold truncate', filled() ? 'text-fg' : 'text-fg/72')}>
                      {l.name}
                    </div>
                    <div class={cn('text-sm leading-tight truncate', filled() ? 'text-fg-muted/80' : 'text-fg-muted/65')}>
                      {l.civilization}
                    </div>
                  </div>
                )
              : null
          }}
        </Show>

        {/* Discord name and avatar */}
        <Show when={seatPlayerId()} keyed>
          {(_playerId) => {
            const s = seat()
            return s
              ? (
                  <div class={cn(
                    'flex items-center gap-2',
                    isActive() ? (accent() === 'red' ? 'text-danger' : 'text-accent') : 'text-fg-muted',
                    filled() && !isActive() && 'text-fg-muted/60',
                  )}
                  >
                    <Show when={seatAvatarUrl()} keyed>
                      {url => (
                        <img
                          src={url}
                          alt=""
                          class="rounded-full shrink-0 h-5 w-5 object-cover"
                        />
                      )}
                    </Show>
                    <span class="text-sm leading-tight truncate">{s.displayName}</span>
                  </div>
                )
              : null
          }}
        </Show>
      </div>

      {/* Pick order label at top-left */}
      <div class="left-1.5 top-1.5 absolute z-20">
        <span class={cn(
          'text-[10px] font-bold tracking-wide uppercase',
          isActive() ? (accent() === 'red' ? 'text-danger' : 'text-accent') : (filled() ? 'text-white/80 drop-shadow-md' : 'text-fg-muted/50'),
        )}
        >
          {props.displayNumber ?? props.seatIndex + 1}
        </span>
      </div>

      {/* Map vote overlay — hides the slot contents during the MAP phase */}
      <Show when={isMapVotePhase()}>
        <MapVoteSlotOverlay seatIndex={props.seatIndex} compact={props.compact} />
      </Show>
    </div>
  )
}

function MapVoteSlotOverlay(props: { seatIndex: number, compact?: boolean }) {
  const state = () => draftStore.state
  const seat = () => state()?.seats[props.seatIndex]
  const seatAvatarUrl = () => seat()?.avatarUrl ?? null
  const seatPlayerId = () => seat()?.playerId ?? null
  const [showWinnerFlash, setShowWinnerFlash] = createSignal(false)
  let lastWinnerFlashRevealEndsAt: number | null = null
  let winnerFlashTimeout: ReturnType<typeof setTimeout> | null = null

  const isVoting = () => mapVotePhase() === 'voting'
  const isRevealing = () => mapVotePhase() === 'reveal'
  const vote = () => isRevealing() ? getSeatMapVote(props.seatIndex) : null
  const mapVoteResult = () => draftStore.mapVote.result
  const winningTypeCandidate = () => mapVoteWinningTypeCandidate()
  const winningScriptCandidate = () => mapVoteWinningScriptCandidate()
  const isWinningType = () => {
    const winningType = winningTypeCandidate()
    return winningType != null && (vote()?.mapTypes ?? []).includes(winningType)
  }
  const isWinningScript = () => {
    const winningScript = winningScriptCandidate()
    return winningScript != null && (vote()?.mapScripts ?? []).includes(winningScript)
  }
  const hasTypeVote = () => (vote()?.mapTypes.length ?? 0) > 0
  const hasScriptVote = () => (vote()?.mapScripts.length ?? 0) > 0
  const isWinningBallot = () => {
    if (!isRevealing()) return false
    if (!hasTypeVote() && !hasScriptVote()) return false
    return (!hasTypeVote() || isWinningType())
      && (!hasScriptVote() || isWinningScript())
  }

  const isConfirmedSeat = () => isVoting() && isSeatMapVoteConfirmed(props.seatIndex)
  const showVotingGlow = () => isVoting() && !isConfirmedSeat()
  const displayedMap = () => {
    const displayedScriptId = isWinningBallot()
      ? mapVoteResult()?.mapScript
      : vote()?.mapScripts[0] ?? mapVoteResult()?.mapScript
    if (!displayedScriptId) return null
    const script = MAP_SCRIPT_BY_ID[displayedScriptId]
    if (!script) return null
    return {
      ...script,
      label: script.hint ? `${script.name} (${script.hint})` : script.name,
      imageSrc: script.imageUrl ? (resolveAssetUrl(script.imageUrl) ?? script.imageUrl) : null,
      isRandom: script.id === 'random',
    }
  }
  const displayedMapTypeLabel = () => {
    const displayedTypeId = isWinningBallot()
      ? mapVoteResult()?.mapType
      : vote()?.mapTypes[0] ?? mapVoteResult()?.mapType
    if (!displayedTypeId) return ''
    return MAP_TYPE_BY_ID[displayedTypeId]?.name ?? displayedTypeId
  }
  const iconClass = () => props.compact ? 'text-3xl' : 'text-5xl'
  const winningBallotBackdropStyle = {
    background: [
      'radial-gradient(120% 88% at 50% 30%, rgba(244,220,168,0.08) 0%, rgba(212,176,103,0.04) 34%, rgba(212,176,103,0.01) 58%, transparent 78%)',
      'radial-gradient(72% 44% at 50% 76%, rgba(244,220,168,0.05) 0%, rgba(244,220,168,0.02) 38%, transparent 72%)',
      'linear-gradient(to bottom, rgba(255,255,255,0.015) 0%, transparent 32%)',
    ].join(', '),
  }
  const breatheAnimationStyle = createMemo<StableBreatheAnimationStyle>(
    () => createStableBreatheAnimationStyle({
      active: showVotingGlow(),
      endsAt: isVoting() ? draftStore.mapVote.endsAt : null,
      durationSeconds: MAP_VOTE_VOTING_DURATION_SECONDS,
      nowMs: draftNow(),
    }),
    { key: 'initial', style: {} },
    { equals: (previous, next) => previous.key === next.key },
  )

  const clearWinnerFlashTimeout = () => {
    if (winnerFlashTimeout == null) return
    clearTimeout(winnerFlashTimeout)
    winnerFlashTimeout = null
  }

  createEffect(() => {
    const revealEndsAt = mapVoteRevealEndsAt()
    const isCurrentWinner = revealEndsAt != null && isRevealing() && isWinningBallot()

    clearWinnerFlashTimeout()
    setShowWinnerFlash(false)
    if (!isCurrentWinner) {
      if (!isRevealing()) lastWinnerFlashRevealEndsAt = null
      return
    }
    if (lastWinnerFlashRevealEndsAt === revealEndsAt) return

    const revealStartedAt = revealEndsAt - (MAP_VOTE_REVEAL_DURATION_SECONDS * 1000)
    const flashRemainingMs = (revealStartedAt + 420) - draftNow()
    lastWinnerFlashRevealEndsAt = revealEndsAt
    if (flashRemainingMs <= 0) return

    setShowWinnerFlash(true)
    winnerFlashTimeout = setTimeout(() => {
      setShowWinnerFlash(false)
      winnerFlashTimeout = null
    }, flashRemainingMs)
  })

  onCleanup(() => clearWinnerFlashTimeout())

  return (
    <div
      class={cn(
        'slot-accent-gold inset-0 absolute z-40 flex flex-col overflow-hidden bg-bg-subtle',
      )}
    >
      <Show when={isRevealing() && isWinningBallot()}>
        <div
          class="pointer-events-none inset-0 absolute z-0"
          style={winningBallotBackdropStyle}
        />
      </Show>

      <div
        class="w-6 pointer-events-none inset-y-0 left-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-r"
        classList={{
          'anim-glow-breathe': showVotingGlow(),
          'opacity-0': !showVotingGlow(),
        }}
        style={{
          ...breatheAnimationStyle().style,
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />
      <div
        class="w-6 pointer-events-none inset-y-0 right-0 absolute z-10 from-[var(--slot-glow)] to-transparent bg-gradient-to-l"
        classList={{
          'anim-glow-breathe': showVotingGlow(),
          'opacity-0': !showVotingGlow(),
        }}
        style={{
          ...breatheAnimationStyle().style,
          '-webkit-mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
          'mask-image': 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
        }}
      />
      <div
        class="rounded-full bg-[var(--slot-glow)] h-[2px] pointer-events-none left-1/2 top-2 absolute z-10 -translate-x-1/2"
        classList={{
          'anim-bar-breathe': showVotingGlow(),
          'opacity-0': !showVotingGlow(),
        }}
        style={breatheAnimationStyle().style}
      />

      <Show when={showWinnerFlash()}>
        <div
          class="anim-swap-focus-flash pointer-events-none inset-0 absolute z-10"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(244,220,168,0.24) 0%, rgba(200,170,110,0.14) 48%, rgba(200,170,110,0.05) 100%)',
          }}
        />
      </Show>

      {/* Dim non-winning ballots a little during reveal */}
      <Show when={isRevealing() && !isWinningBallot()}>
        <div class="bg-black/30 pointer-events-none inset-0 absolute z-10" />
      </Show>

      <div class={cn(
        'relative z-20 flex flex-1 flex-col px-3 text-center',
        isRevealing() ? 'py-3' : 'items-center justify-center py-4',
      )}
      >
        <Show
          when={isRevealing() && vote()}
          fallback={(
            <div class={cn(
              'i-ph-map-trifold-fill drop-shadow-[0_2px_10px_rgba(0,0,0,0.3)]',
              isConfirmedSeat() ? 'text-fg-muted/55' : 'text-accent/90',
              iconClass(),
            )}
            />
          )}
        >
          <div
            data-testid="map-vote-reveal-layout"
            class={cn(
              'flex h-full min-h-0 max-w-full flex-col items-center justify-center',
              isWinningBallot() ? 'text-fg' : 'text-fg-muted',
            )}
          >
            <div class="flex flex-1 min-h-0 items-center justify-center">
              <Show
                when={displayedMap()}
                fallback={(
                  <div class={cn(
                    'i-ph-map-trifold-fill drop-shadow-[0_2px_10px_rgba(0,0,0,0.3)] text-accent/90',
                    iconClass(),
                  )}
                  />
                )}
              >
                {map => (
                  <div class={cn('flex w-full min-w-0 max-w-full flex-col items-center', props.compact ? 'gap-1.5' : 'gap-2')}>
                    <div
                      class={cn('relative aspect-square', props.compact ? 'w-16' : 'w-20')}
                      data-testid={isWinningBallot() ? 'map-vote-reveal-winning-glow' : undefined}
                    >
                      <Show
                        when={map().imageSrc}
                        fallback={(
                          <div class="flex items-center inset-0 justify-center absolute">
                            <span
                              class={cn(
                                map().isRandom ? 'i-ph-dice-five-bold' : 'i-ph-map-trifold-fill',
                                props.compact ? 'h-10 w-10' : 'h-12 w-12',
                                'block text-accent/90',
                              )}
                            />
                          </div>
                        )}
                      >
                        {src => (
                          <img
                            src={src()}
                            alt={map().label}
                            class="h-full w-full inset-0 absolute object-contain"
                            style={isWinningBallot()
                              ? {
                                  filter: 'drop-shadow(0 0 4px rgba(255,233,164,0.16)) drop-shadow(0 0 10px rgba(208,172,98,0.08))',
                                }
                              : undefined}
                          />
                        )}
                      </Show>
                    </div>

                    <span class={cn(
                      'mx-auto max-w-full w-fit font-semibold leading-tight text-center',
                      props.compact ? 'text-[10px]' : 'text-[13px]',
                      isWinningBallot() ? 'text-accent' : 'text-fg/90',
                    )}
                    >
                      {map().label}
                    </span>

                    <Show when={displayedMapTypeLabel()}>
                      {label => (
                        <span class={cn(
                          'mx-auto max-w-full truncate text-center font-semibold leading-none',
                          props.compact ? 'text-[9px]' : 'text-[11px]',
                          isWinningBallot() ? 'text-accent/80' : 'text-fg-muted/70',
                        )}
                        >
                          {label()}
                        </span>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>

      {/* Name row at the bottom */}
      <Show when={seatPlayerId()} keyed>
        {(_playerId) => {
          const s = seat()
          return s
            ? (
                <div class={cn(
                  'relative z-20 flex items-center gap-2 px-2 pb-2 pt-6',
                  'bg-gradient-to-t from-black/70 to-transparent',
                )}
                >
                  <Show when={seatAvatarUrl()} keyed>
                    {url => (
                      <img
                        src={url}
                        alt=""
                        class="rounded-full shrink-0 h-5 w-5 object-cover"
                      />
                    )}
                  </Show>
                  <span class="text-sm text-fg-muted leading-tight truncate">
                    {s.displayName}
                  </span>
                </div>
              )
            : null
        }}
      </Show>
    </div>
  )
}

interface StableBreatheAnimationStyle {
  key: string
  style: { 'animation-delay'?: string }
}

function createStableBreatheAnimationStyle(props: { active: boolean, endsAt: number | null, durationSeconds: number, nowMs: number }): StableBreatheAnimationStyle {
  if (!props.active || props.endsAt == null || props.durationSeconds <= 0) return { key: 'inactive', style: {} }

  const key = `${props.endsAt}:${props.durationSeconds}`
  const phaseStartedAt = props.endsAt - (props.durationSeconds * 1000)
  const phaseElapsedMs = Math.max(0, props.nowMs - phaseStartedAt)
  const animationDelayMs = -(phaseElapsedMs % SLOT_BREATHE_CYCLE_MS)

  return {
    key,
    style: { 'animation-delay': `${animationDelayMs}ms` },
  }
}
