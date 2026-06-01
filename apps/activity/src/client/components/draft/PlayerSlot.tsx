import type { CivBlitzComponent, CivBlitzComponentCategory, CivBlitzPartialKit, Leader, MapVoteMapOption } from '@civup/game'
import { CIV_BLITZ_CATEGORIES, getCivBlitzRegistry, getLeader, getMapVoteMapIdForResult, MAP_VOTE_MAP_BY_ID, normalizeMapVoteSelection } from '@civup/game'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import { getLeaderFullPortraitUrl } from '~/client/lib/leader-full-portrait'
import { placementIconClass } from '~/client/lib/placement-icons'
import { createSeatGridLayout, findSeatGridPosition, getSeatAtGridPosition } from '~/client/lib/seat-grid'
import { getVisualSeatOrder } from '~/client/lib/seat-order'
import { BLIND_PICK_SUBMISSION_PLACEHOLDER, canSwapLeadersWith, draftNow, draftStore, ffaPlacementOrder, getOptimisticSeatPick, getPreviewPickForSeat, getPreviewPicksForSeat, getSeatMapVote, gridOpen, hiddenDraftLeaderSelections, isHiddenDraftComplete, isMapVotePhase, isMobileLayout, isSeatMapVoteConfirmed, MAP_VOTE_REVEAL_DURATION_SECONDS, MAP_VOTE_VOTING_DURATION_SECONDS, mapVotePhase, mapVoteRevealEndsAt, mapVoteWinningScriptCandidate, mapVoteWinningTypeCandidate, phaseAccent, resultSelectionsLocked, seatJustSwapped, selectWinningTeam, sendLeaderSwap, toggleFfaPlacement, toggleTeamPlacement, userId } from '~/client/stores'
import { getLeaderPortraitScaleClass } from './LeaderCard'

interface PlayerSlotProps {
  /** Seat index in the draft */
  seatIndex: number
  /** Whether this is a half-height FFA slot */
  compact?: boolean
  /** One-based visual slot number shown in the slot corner. */
  displayNumber?: number
}

const SLOT_BREATHE_CYCLE_MS = 3000
const BAN_PREVIEW_HORIZONTAL_RATIO = 0.92
const CIV_BLITZ_SLOT_ICONS: Record<CivBlitzComponentCategory, string> = {
  civilizationAbility: 'i-ph:flag-duotone',
  leaderAbility: 'i-ph:user-duotone',
  infrastructure: 'i-ph:factory-duotone',
  unit: 'i-ph:horse-duotone',
}

function SlotPortraitImage(props: {
  src: string
  alt: string
  title?: string
  'data-testid'?: string
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
      title={props.title}
      data-testid={props['data-testid']}
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
  let slotElement: HTMLDivElement | undefined
  const state = () => draftStore.state
  const seat = () => state()?.seats[props.seatIndex]
  const civBlitzComponentMap = createMemo(() => getCivBlitzRegistry(draftStore.leaderDataVersion, { excludeBbgExpanded: state()?.civBlitz?.excludeBbgExpanded !== false }).componentMap)

  const pick = () => {
    const serverPick = state()?.picks.find(p => p.seatIndex === props.seatIndex)
    if (serverPick) return serverPick

    const currentSubmissionPick = visibleBlindPickSubmission()
    if (currentSubmissionPick) return currentSubmissionPick

    const optimisticCivId = getOptimisticSeatPick(props.seatIndex)
    const visibleOptimisticCivId = optimisticCivId === BLIND_PICK_SUBMISSION_PLACEHOLDER ? null : optimisticCivId
    const visualIndex = getVisualSeatOrder(state()?.seats).indexOf(props.seatIndex)
    const hiddenDraftCivId = visualIndex >= 0 ? hiddenDraftLeaderSelections()[visualIndex] ?? null : null
    const civId = visibleOptimisticCivId ?? (isHiddenDraftComplete() ? hiddenDraftCivId : null)
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

  const visibleBlindPickSubmission = () => {
    const s = state()
    if (!s || s.status !== 'active') return null
    const step = s.steps[s.currentStepIndex]
    if (!step || step.action !== 'pick' || !step.blind || step.reveal || step.civBlitz) return null

    const civId = s.submissions[props.seatIndex]?.[0]
    if (!civId || civId === BLIND_PICK_SUBMISSION_PLACEHOLDER) return null
    return {
      seatIndex: props.seatIndex,
      civId,
    }
  }

  const filled = () => !!pick()
  const revealPick = () => state()?.blindPickReveal?.picks.find(p => p.seatIndex === props.seatIndex) ?? null
  const revealLeader = (): Leader | null => {
    const p = revealPick()
    if (!p) return null
    try { return getLeader(p.civId, draftStore.leaderDataVersion) }
    catch { return null }
  }
  const hasReveal = (): boolean => revealLeader() != null
  const civBlitzLockedKit = (): CivBlitzPartialKit | null => state()?.civBlitz?.lockedKits[props.seatIndex] ?? null
  const civBlitzRevealedKit = (): CivBlitzPartialKit | null => {
    const blitz = state()?.civBlitz
    if (!blitz) return null
    return blitz.reveal?.submissions.find(submission => submission.seatIndex === props.seatIndex)?.kit ?? null
  }
  const civBlitzPreviewKit = (): CivBlitzPartialKit | null => {
    const blitz = state()?.civBlitz
    if (!blitz) return null
    const options = blitz.optionsBySeat[props.seatIndex]
    if (!options) return null

    const kit: CivBlitzPartialKit = {}
    for (const componentId of getPreviewPicksForSeat(props.seatIndex)) {
      for (const category of CIV_BLITZ_CATEGORIES) {
        if (kit[category] || !options[category].includes(componentId)) continue
        kit[category] = componentId
        break
      }
    }
    return Object.keys(kit).length > 0 ? kit : null
  }
  const hasCivBlitzDisplay = () => state()?.civBlitz != null
  const civBlitzConflictIds = () => new Set(state()?.civBlitz?.reveal?.conflictComponentIds ?? [])
  const revealIsConflict = (): boolean => {
    const p = revealPick()
    const reveal = state()?.blindPickReveal
    return !!p && !!reveal && reveal.conflictCivIds.includes(p.civId)
  }
  const previewLeader = (): Leader | null => {
    if (filled()) return null
    const civId = getPreviewPickForSeat(props.seatIndex)
    if (!civId) return null
    try { return getLeader(civId, draftStore.leaderDataVersion) }
    catch { return null }
  }

  const hasPreview = (): boolean => previewLeader() != null
  const displayLeader = (): Leader | null => leader() ?? revealLeader() ?? previewLeader()
  const leaderKey = () => {
    const l = leader()
    return l ? `${draftStore.leaderDataVersion}:${l.id}` : null
  }
  const previewLeaderKey = () => {
    const l = previewLeader()
    return l ? `${draftStore.leaderDataVersion}:${l.id}` : null
  }
  const revealLeaderKey = () => {
    const l = revealLeader()
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
  const seatTeam = () => seat()?.team ?? null
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

    const submittedCount = Math.max(s.submissions[props.seatIndex]?.length ?? 0, getOptimisticSeatPick(props.seatIndex) ? 1 : 0)
    return submittedCount < step.count
  }
  const banPreviewLeaders = createMemo<Leader[]>(() => {
    const s = state()
    if (!s || s.status !== 'active' || filled() || seatTeam() == null) return []

    const step = s.steps[s.currentStepIndex]
    if (!step || step.action !== 'ban') return []
    if (step.seats !== 'all' && !step.seats.includes(props.seatIndex)) return []
    if ((s.submissions[props.seatIndex]?.length ?? 0) >= step.count) return []

    const leaders: Leader[] = []
    for (const civId of (draftStore.previews.bans[props.seatIndex] ?? []).slice(0, 3)) {
      try { leaders.push(getLeader(civId, draftStore.leaderDataVersion)) }
      catch { }
    }
    return leaders
  })
  const hasBanPreview = (): boolean => banPreviewLeaders().length > 0
  const [banPreviewHorizontal, setBanPreviewHorizontal] = createSignal(isMobileLayout())
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

  createEffect(() => {
    if (!hasBanPreview()) {
      setBanPreviewHorizontal(isMobileLayout())
      return
    }

    const element = slotElement
    if (!element) return

    const updateOrientation = (width: number, height: number) => {
      if (width <= 0 || height <= 0) {
        setBanPreviewHorizontal(isMobileLayout())
        return
      }
      setBanPreviewHorizontal(width >= height * BAN_PREVIEW_HORIZONTAL_RATIO)
    }

    const rect = element.getBoundingClientRect()
    updateOrientation(rect.width, rect.height)

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      updateOrientation(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

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
      ref={slotElement}
      class={cn(
        'relative flex flex-col overflow-hidden bg-bg-subtle h-full isolate',
        canSelectResult() && (isFfaPlacementMode() || isTeamResultMode()) && 'cursor-pointer',
      )}
      classList={{
        'slot-accent-gold': isActive() && accent() === 'gold',
        'slot-accent-red': (isActive() && accent() === 'red') || revealIsConflict(),
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
      <Show when={hasCivBlitzDisplay()}>
        <div class="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-black/20">
          <For each={CIV_BLITZ_CATEGORIES}>
            {category => {
              const lockedComponentId = () => civBlitzLockedKit()?.[category] ?? null
              const revealedComponentId = () => civBlitzRevealedKit()?.[category] ?? null
              const previewComponentId = () => lockedComponentId() ? null : civBlitzPreviewKit()?.[category] ?? null
              const componentId = () => lockedComponentId() ?? previewComponentId() ?? revealedComponentId()
              const component = () => componentId() ? civBlitzComponentMap().get(componentId()!) ?? null : null
              return (
                <CivBlitzSlotTile
                  category={category}
                  component={component()}
                  sourceLeaderName={getCivBlitzSourceLeaderName(component())}
                  conflict={!previewComponentId() && revealedComponentId() ? civBlitzConflictIds().has(revealedComponentId()!) : false}
                  preview={previewComponentId() != null}
                  compact={props.compact}
                />
              )
            }}
          </For>
        </div>
      </Show>

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

      <Show when={!filled() && revealLeaderKey()} keyed>
        {(_key) => {
          const l = revealLeader()
          return l
            ? (
                <div class={cn('inset-0 absolute', revealIsConflict() ? 'saturate-110' : 'opacity-80 saturate-90')}>
                  <SlotPortraitImage
                    src={getLeaderFullPortraitUrl(l)}
                    alt={l.name}
                    class={cn(
                      'absolute inset-0 h-full w-full object-cover',
                      props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
                    )}
                    animate
                    waitForDecode
                  />
                  <Show when={revealIsConflict()}>
                    <div class="pointer-events-none inset-0 absolute bg-danger/18 ring-2 ring-inset ring-danger/70" />
                    <div class="right-2 top-2 absolute rounded bg-danger px-2 py-0.5 text-[10px] font-black tracking-wider text-white shadow-lg">
                      CONFLICT
                    </div>
                  </Show>
                </div>
              )
            : null
        }}
      </Show>

      <Show when={!filled() && !hasReveal() && previewLeaderKey()} keyed>
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

      <Show when={!filled() && hasBanPreview()}>
        <div
          data-testid="slot-ban-preview-stack"
          class={cn(
            'pointer-events-none absolute inset-0 flex opacity-50 saturate-85',
            banPreviewHorizontal() ? 'flex-row' : 'flex-col',
          )}
        >
          <For each={banPreviewLeaders()}>
            {entry => (
              <SlotPortraitImage
                data-testid="slot-ban-preview"
                src={getLeaderFullPortraitUrl(entry)}
                alt={`Ban preview: ${entry.name}`}
                title={`${entry.name} - ${entry.civilization}`}
                class={cn(
                  'h-full min-h-0 min-w-0 flex-1 object-cover',
                  props.compact ? 'object-[center_20%]' : 'object-[center_15%]',
                )}
                animate
              />
            )}
          </For>
        </div>
      </Show>

      {/* Empty state icon */}
      <Show when={!hasCivBlitzDisplay() && !filled() && !hasReveal() && !hasPreview() && !hasBanPreview()}>
        <div class="flex flex-1 flex-col items-center justify-center">
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
        filled() || hasCivBlitzDisplay() || hasReveal() || hasPreview() || hasBanPreview() ? 'bg-gradient-to-t from-black/80 to-transparent' : 'bg-gradient-to-t from-bg/40 to-transparent',
      )}
      >
        {/* Leader name (when picked) */}
        <Show when={displayLeaderKey()} keyed>
          {(_key) => {
            const l = displayLeader()
            return l
              ? (
                  <div class="mb-1">
                    <div class={cn('text-base leading-tight font-semibold truncate', filled() || hasReveal() ? 'text-fg' : 'text-fg/72')}>
                      {l.name}
                    </div>
                    <div class={cn('text-sm leading-tight truncate', filled() || hasReveal() ? 'text-fg-muted/80' : 'text-fg-muted/65')}>
                      {l.civilization}
                    </div>
                    <Show when={revealIsConflict()}>
                      <div class="mt-1 text-[10px] font-black tracking-widest text-danger">REDRAFT REQUIRED</div>
                    </Show>
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

function CivBlitzSlotTile(props: {
  category: CivBlitzComponentCategory
  component: CivBlitzComponent | null
  sourceLeaderName?: string | null
  conflict: boolean
  preview: boolean
  compact?: boolean
}) {
  const imageUrl = () => props.component?.iconUrl ?? props.component?.portraitUrl ?? null
  const hasIcon = () => props.component?.iconUrl != null
  const isCivilizationIcon = () => props.category === 'civilizationAbility' && hasIcon()
  const imageFrameClass = () => hasIcon()
    ? cn(props.compact ? 'h-[58%] w-[58%]' : 'h-[66%] w-[66%]', isCivilizationIcon() ? 'rounded-full' : 'rounded-md')
    : (props.compact ? 'h-[48%] w-[48%] rounded-full' : 'h-[56%] w-[56%] rounded-full')
  const imageClass = () => hasIcon()
    ? cn('object-contain', isCivilizationIcon() && 'rounded-full')
    : cn('object-cover', getLeaderPortraitScaleClass(props.sourceLeaderName))
  return (
    <div class={cn('relative min-h-0 min-w-0 bg-bg overflow-hidden', props.conflict && 'saturate-110', props.preview && 'opacity-50 saturate-85')}>
      <div class="absolute inset-0 flex flex-col items-center justify-center px-2 pb-2 pt-4">
        <Show when={props.component}>
          {component => (
            <div class="mb-1.5 max-w-full text-center text-sm leading-tight text-white/90 font-semibold truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
              {component().name}
            </div>
          )}
        </Show>
        <div class={cn('relative shrink-0 overflow-hidden bg-bg-subtle/45', imageFrameClass())}>
          <Show
            when={imageUrl()}
            keyed
            fallback={(
              <div class="absolute inset-0 flex items-center justify-center">
                <span class={cn('text-3xl text-fg-muted/45', CIV_BLITZ_SLOT_ICONS[props.category])} />
              </div>
            )}
          >
            {url => (
              <SlotPortraitImage
                src={resolveAssetUrl(url) ?? url}
                alt={props.component?.name ?? ''}
                class={cn('absolute inset-0 h-full w-full object-center', imageClass())}
                animate={props.preview}
              />
            )}
          </Show>
        </div>
      </div>
      <Show when={props.conflict}>
        <div class="pointer-events-none inset-0 absolute ring-2 ring-inset ring-danger/75 bg-danger/16" />
      </Show>
    </div>
  )
}

function getCivBlitzSourceLeaderName(component: CivBlitzComponent | null): string | null {
  if (!component) return null
  try { return getLeader(component.sourceLeaderId, draftStore.leaderDataVersion).name }
  catch { return null }
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
  const winningMapCandidate = () => getMapVoteMapIdForResult(mapVoteWinningTypeCandidate(), mapVoteWinningScriptCandidate())
  const selectedMaps = () => normalizeMapVoteSelection(vote()).maps
  const isWinningMap = () => {
    const winningMap = winningMapCandidate()
    return winningMap != null && selectedMaps().includes(winningMap)
  }
  const hasMapVote = () => selectedMaps().length > 0
  const isWinningBallot = () => {
    if (!isRevealing()) return false
    if (!hasMapVote()) return false
    return isWinningMap()
  }

  const isConfirmedSeat = () => isVoting() && isSeatMapVoteConfirmed(props.seatIndex)
  const showVotingGlow = () => isVoting() && !isConfirmedSeat()
  const displayedMap = () => {
    const result = mapVoteResult()
    const displayedMapId = isWinningBallot()
      ? getMapVoteMapIdForResult(result?.mapType, result?.mapScript)
      : selectedMaps()[0] ?? getMapVoteMapIdForResult(result?.mapType, result?.mapScript)
    if (!displayedMapId) return null
    const map = MAP_VOTE_MAP_BY_ID[displayedMapId]
    if (!map) return null
    return {
      ...map,
      label: formatSlotMapLabel(map),
      subLabel: formatSlotMapSubLabel(map),
      imageAlt: formatSlotMapImageAlt(map),
      imageSrc: map.imageUrl ? (resolveAssetUrl(map.imageUrl) ?? map.imageUrl) : null,
      isRandom: map.id === 'random',
    }
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
                            alt={map().imageAlt}
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

                    <Show when={map().subLabel}>
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

function formatSlotMapLabel(map: MapVoteMapOption): string {
  return map.name
}

function formatSlotMapSubLabel(map: MapVoteMapOption): string {
  return [map.badgeLeft, map.badgeRight].filter(Boolean).join(' ')
}

function formatSlotMapImageAlt(map: MapVoteMapOption): string {
  const subLabel = formatSlotMapSubLabel(map)
  return subLabel ? `${map.name} ${subLabel}` : map.name
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
