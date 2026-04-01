import type { Leader } from '@civup/game'
import type { LeaderTagCategory } from '~/client/lib/leader-tags'
import { factions, getLeaders, searchFactions, searchLeaders } from '@civup/game'
import { throttle } from '@solid-primitives/scheduled'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { resolveAssetUrl } from '~/client/lib/asset-url'
import { cn } from '~/client/lib/css'
import {
  getFilterTagOptions,
  getLeaderTagMeta,
  leaderMatchesTagFilters,
  TAG_CATEGORY_LABELS,
  TAG_CATEGORY_ORDER,
} from '~/client/lib/leader-tags'
import {
  activeTagFilterCount,
  banSelections,
  canOpenLeaderGrid,
  canSendPickPreview,
  clearSelections,
  clearTagFilters,
  currentStep,
  dealtCivIds,
  detailLeaderId,
  draftStore,
  gridExpanded,
  gridOpen,
  gridViewMode,
  hasSubmitted,
  isMyTurn,
  isRandomSelected,
  isRedDeathDraft,
  phaseAccent,
  pickSelections,
  searchQuery,
  selectedLeader,
  sendBan,
  sendPick,
  sendPreview,
  setBanSelections,
  setDetailLeaderId,
  setGridExpanded,
  setGridOpen,
  setGridViewMode,
  setIsRandomSelected,
  setPickSelections,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
  toggleTagFilter,
} from '~/client/stores'
import { LeaderCard, LeaderListItem } from './LeaderCard'
import { LeaderDetailPanel } from './LeaderDetailPanel'

const DOCKED_PANEL_MIN_WIDTH = 1280
const PREVIEW_THROTTLE_MS = 60

interface HoverTooltip {
  name: string
  civ: string
  tags: string[]
  x: number
  y: number
}

interface TooltipPosition {
  left: number
  top: number
}

function resolveTooltipPosition(x: number, y: number, width: number, height: number): TooltipPosition {
  const gap = 14
  const edge = 8

  if (typeof window === 'undefined') return { left: x + gap, top: y + gap }

  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = x + gap
  if (left + width + edge > vw) left = x - gap - width
  left = Math.max(edge, Math.min(left, vw - width - edge))

  let top = y + gap
  if (top + height + edge > vh) top = y - gap - height
  top = Math.max(edge, Math.min(top, vh - height - edge))

  return { left, top }
}

/** Collapsible leader grid overlay */
export function LeaderGridOverlay() {
  const state = () => draftStore.state
  const leaderDataVersion = () => draftStore.leaderDataVersion
  const step = currentStep
  const accent = () => phaseAccent()
  const ownSeatIndex = () => draftStore.seatIndex
  const currentHydrationToken = () => {
    const current = state()
    const seatIndex = ownSeatIndex()
    return current && seatIndex != null ? `${draftStore.initVersion}:${current.currentStepIndex}:${seatIndex}` : null
  }
  const [hoverTooltip, setHoverTooltip] = createSignal<HoverTooltip | null>(null)
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const [panelsDocked, setPanelsDocked] = createSignal(false)
  const [tooltipSize, setTooltipSize] = createSignal({ width: 224, height: 96 })
  const [hydratedPickPreviewToken, setHydratedPickPreviewToken] = createSignal<string | null>(null)
  const [hydratedBanPreviewToken, setHydratedBanPreviewToken] = createSignal<string | null>(null)
  const sendThrottledBanPreview = throttle((civIds: string[]) => sendPreview('ban', civIds), PREVIEW_THROTTLE_MS)
  const sendThrottledPickPreview = throttle((civIds: string[]) => sendPreview('pick', civIds), PREVIEW_THROTTLE_MS)
  let tooltipRef: HTMLDivElement | undefined

  onCleanup(() => {
    sendThrottledBanPreview.clear()
    sendThrottledPickPreview.clear()
  })
  let restoreFiltersAfterCollapse = false
  let restoreDetailLeaderId: string | null = null
  let restoreSelectedLeaderId: string | null = null
  let skipNextOverlayAnimation = false

  const hasDetail = () => detailLeaderId() != null
  const showDockedPanels = () => panelsDocked()
  const showStackedShelf = () => !panelsDocked() && !gridExpanded()
  const showFocusPanelStrip = () => !panelsDocked() && gridExpanded() && (filtersOpen() || hasDetail())
  const singleClickShowsDetail = () => panelsDocked()
  const overlayEntranceClass = () => skipNextOverlayAnimation ? '' : 'anim-overlay-in'

  onMount(() => {
    const viewport = window.visualViewport
    const syncPanelLayout = () => {
      const width = viewport?.width ?? window.innerWidth
      setPanelsDocked(width >= DOCKED_PANEL_MIN_WIDTH)
    }

    syncPanelLayout()
    window.addEventListener('resize', syncPanelLayout)
    viewport?.addEventListener('resize', syncPanelLayout)

    onCleanup(() => {
      window.removeEventListener('resize', syncPanelLayout)
      viewport?.removeEventListener('resize', syncPanelLayout)
    })
  })

  const tooltipPosition = createMemo<TooltipPosition>(() => {
    const tooltip = hoverTooltip()
    if (!tooltip) return { left: 0, top: 0 }
    const size = tooltipSize()
    return resolveTooltipPosition(tooltip.x, tooltip.y, size.width, size.height)
  })

  const allLeaders = createMemo(() => getLeaders(leaderDataVersion()))
  const allEntries = createMemo(() => isRedDeathDraft() ? factions : allLeaders())
  const filterTagOptions = createMemo(() => getFilterTagOptions(allLeaders()))

  // Auto-open grid when it's your turn
  createEffect(() => {
    if (isMyTurn() && !hasSubmitted()) setGridOpen(true)
  })

  createEffect(() => {
    if (canOpenLeaderGrid()) return
    if (gridOpen()) setGridOpen(false)
  })

  createEffect(() => {
    const current = state()
    const seatIndex = ownSeatIndex()
    const currentStep = step()
    const hydrationToken = current && seatIndex != null ? `${draftStore.initVersion}:${current.currentStepIndex}:${seatIndex}` : null

    if (!current || current.status !== 'active' || seatIndex == null) {
      if (banSelections().length > 0) setBanSelections([])
      if (pickSelections().length > 0) setPickSelections([])
      return
    }

    if (currentStep?.action === 'ban') {
      const serverBanPreview = draftStore.previews.bans[seatIndex] ?? []
      if (banSelections().length === 0 && serverBanPreview.length > 0 && hydratedBanPreviewToken() !== hydrationToken) {
        setBanSelections([...serverBanPreview])
        setHydratedBanPreviewToken(hydrationToken)
      }
    }
    else if (banSelections().length > 0) {
      setBanSelections([])
    }

    if (currentStep?.action !== 'pick') {
      if (pickSelections().length > 0) setPickSelections([])
      return
    }

    if (current.picks.some(pick => pick.seatIndex === seatIndex)) {
      if (pickSelections().length > 0) setPickSelections([])
      return
    }

    const available = new Set(current.availableCivIds)
    const localPickSelections = pickSelections()
    const prunedLocalSelections = localPickSelections.filter(civId => available.has(civId))
    if (!sameCivIdList(localPickSelections, prunedLocalSelections)) {
      setPickSelections(prunedLocalSelections)
      return
    }

    const serverPickPreview = (draftStore.previews.picks[seatIndex] ?? []).filter(civId => available.has(civId))
    if (localPickSelections.length === 0 && serverPickPreview.length > 0 && hydratedPickPreviewToken() !== hydrationToken) {
      setPickSelections([...serverPickPreview])
      setHydratedPickPreviewToken(hydrationToken)
    }
  })

  createEffect(() => {
    const current = state()
    const currentStep = step()
    const seatIndex = ownSeatIndex()
    if (!current || current.status !== 'active' || seatIndex == null || !currentStep) {
      sendThrottledBanPreview.clear()
      sendThrottledPickPreview.clear()
      return
    }

    if (currentStep.action === 'ban') {
      sendThrottledPickPreview.clear()
      sendThrottledBanPreview(isMyTurn() && !hasSubmitted() ? banSelections() : [])
      return
    }

    sendThrottledBanPreview.clear()
    sendThrottledPickPreview(canSendPickPreview() ? pickSelections() : [])
  })

  const draftLeaderPoolIds = createMemo(() => {
    if (isRedDeathDraft()) return new Set(dealtCivIds() ?? [])

    const draftState = state()
    if (!draftState) return new Set(allLeaders().map(leader => leader.id))

    return new Set([
      ...draftState.availableCivIds,
      ...draftState.bans.map(selection => selection.civId),
      ...draftState.picks.map(selection => selection.civId),
    ])
  })

  const filteredLeaders = createMemo(() => {
    const query = isRedDeathDraft() ? '' : searchQuery().trim()
    const filters = tagFilters()
    const leaderPoolIds = draftLeaderPoolIds()
    let result = query
      ? (isRedDeathDraft() ? searchFactions(query) : searchLeaders(query, leaderDataVersion()))
      : [...allEntries()]
    result = result.filter(leader => leaderPoolIds.has(leader.id) && (isRedDeathDraft() || leaderMatchesTagFilters(leader.tags, filters)))
    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  const ghostCount = createMemo(() => Math.max(0, draftLeaderPoolIds().size - filteredLeaders().length))

  const isTagActive = (category: LeaderTagCategory, tag: string): boolean => {
    return tagFilters()[category].includes(tag)
  }

  const randomLeaderPool = createMemo(() => {
    if (isRedDeathDraft()) return []
    const available = new Set(state()?.availableCivIds ?? [])
    return filteredLeaders().filter(leader => available.has(leader.id))
  })

  const canUseRandom = () => {
    if (isRedDeathDraft()) return false
    if (state()?.status !== 'active') return false
    if (!isMyTurn() || hasSubmitted()) return false
    const s = step()
    if (!s) return false
    const needed = s.action === 'ban' ? s.count : 1
    return randomLeaderPool().length >= needed
  }

  const canConfirmPick = () => {
    if (step()?.action !== 'pick') return false
    if (isRandomSelected()) return true
    const id = selectedLeader()
    if (!id) return false
    return !state()?.picks.some(p => p.civId === id)
  }

  const canConfirmBan = () => {
    if (step()?.action !== 'ban') return false
    if (isRandomSelected()) return true
    return banSelections().length === step()!.count
  }

  const handleToggleRandom = () => {
    if (!canUseRandom()) return

    setDetailLeaderId(null)
    setHoverTooltip(null)

    if (isRandomSelected()) {
      setIsRandomSelected(false)
      return
    }

    const hydrationToken = currentHydrationToken()
    if (step()?.action === 'ban' && hydrationToken) {
      setHydratedBanPreviewToken(hydrationToken)
    }
    if (step()?.action === 'pick' && hydrationToken) {
      setHydratedPickPreviewToken(hydrationToken)
    }

    setSelectedLeader(null)
    setBanSelections([])
    setIsRandomSelected(true)
  }

  const handleConfirmPick = () => {
    if (isRandomSelected()) {
      const pool = randomLeaderPool()
      if (pool.length === 0) return
      const randomLeader = pool[Math.floor(Math.random() * pool.length)]
      if (!randomLeader) return
      sendPick(randomLeader.id)
    }
    else {
      const civId = selectedLeader()
      if (!civId) return
      sendPick(civId)
    }
    clearSelections()
    setHoverTooltip(null)
    setFiltersOpen(false)
    setGridOpen(false)
  }

  const handleConfirmBan = () => {
    if (isRandomSelected()) {
      const s = step()
      if (!s) return
      const pool = randomLeaderPool()
      if (pool.length < s.count) return
      const randomIds = pickRandomLeaderIds(pool, s.count)
      sendBan(randomIds)
    }
    else {
      const civIds = banSelections()
      if (civIds.length === 0) return
      sendBan(civIds)
    }
    clearSelections()
    setHoverTooltip(null)
    setFiltersOpen(false)
    setGridOpen(false)
  }

  const handleBackdropClick = () => {
    if (isMyTurn() && !hasSubmitted()) return
    setHoverTooltip(null)
    setFiltersOpen(false)
    setGridOpen(false)
  }

  const handleToggleFilters = () => {
    if (isRedDeathDraft()) return
    if (!panelsDocked() && gridExpanded() && !filtersOpen()) setDetailLeaderId(null)
    setFiltersOpen(prev => !prev)
  }

  const handleToggleGridExpanded = () => {
    setHoverTooltip(null)
    const next = !gridExpanded()
    skipNextOverlayAnimation = true

    if (!panelsDocked()) {
      if (next) {
        restoreFiltersAfterCollapse = filtersOpen()
        restoreDetailLeaderId = detailLeaderId()
        restoreSelectedLeaderId = selectedLeader()
        setFiltersOpen(false)
        setDetailLeaderId(null)
      }
      else {
        if (!filtersOpen() && restoreFiltersAfterCollapse) setFiltersOpen(true)
        if (!detailLeaderId() && restoreDetailLeaderId && selectedLeader() === restoreSelectedLeaderId) {
          setDetailLeaderId(restoreDetailLeaderId)
        }

        restoreFiltersAfterCollapse = false
        restoreDetailLeaderId = null
        restoreSelectedLeaderId = null
      }
    }

    setGridExpanded(next)
    queueMicrotask(() => {
      skipNextOverlayAnimation = false
    })
  }

  const handleLeaderHoverMove = (leader: Leader, x: number, y: number) => {
    setHoverTooltip({
      name: leader.name,
      civ: leader.civilization,
      tags: leader.tags,
      x,
      y,
    })
  }

  const handleLeaderHoverLeave = () => {
    setHoverTooltip(null)
  }

  createEffect(() => {
    const tooltip = hoverTooltip()
    if (!tooltip) return

    const raf = requestAnimationFrame(() => {
      const rect = tooltipRef?.getBoundingClientRect()
      if (!rect) return
      const width = Math.ceil(rect.width)
      const height = Math.ceil(rect.height)
      setTooltipSize(prev => prev.width === width && prev.height === height ? prev : { width, height })
    })

    onCleanup(() => cancelAnimationFrame(raf))
  })

  createEffect(() => {
    if (panelsDocked() || !gridExpanded()) return
    if (!filtersOpen() || !hasDetail()) return
    setFiltersOpen(false)
  })

  const renderFilterPanel = (className: string) => (
    <div class={cn('grid-panel-glow border border-border rounded-lg bg-bg-subtle flex min-h-0 flex-col shadow-2xl overflow-hidden', className)}>
      <div class="p-3 flex-1 overflow-y-auto">
        <div class="mb-2 flex shrink-0 gap-2 items-center justify-between">
          <span class="text-xs text-fg-muted font-semibold">Filters</span>
          <div class="flex gap-2 items-center">
            <button
              class="text-[10px] text-fg px-2.5 py-1 border border-border-hover rounded bg-bg-muted/70 transition-colors hover:border-fg-subtle hover:bg-bg disabled:opacity-40 disabled:cursor-default"
              disabled={activeTagFilterCount() === 0}
              onClick={clearTagFilters}
            >
              Clear all
            </button>
            <button
              class="text-fg-subtle cursor-pointer hover:text-fg-muted"
              onClick={() => setFiltersOpen(false)}
            >
              <div class="i-ph-x-bold text-sm" />
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <For each={TAG_CATEGORY_ORDER}>
            {category => (
              <Show when={filterTagOptions()[category].length > 0}>
                <div>
                  <div class="text-[10px] text-fg-subtle tracking-widest font-semibold mb-1 uppercase">{TAG_CATEGORY_LABELS[category]}</div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={filterTagOptions()[category]}>
                      {(option) => {
                        const active = () => isTagActive(category, option.id)
                        return (
                          <FilterTagButton
                            tag={option.id}
                            active={active()}
                            onClick={() => toggleTagFilter(option.id)}
                          />
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>
            )}
          </For>
        </div>
      </div>
    </div>
  )

  const renderGridPanel = (className: string) => (
    <div
      class={cn(
        'flex flex-col max-h-full overflow-hidden rounded-lg bg-bg-subtle shadow-2xl grid-panel-glow relative z-20 border border-border',
        showDockedPanels()
          ? 'w-[min(calc(100vw-32rem),68rem)] xl:w-[min(calc(100vw-36rem),68rem)] 2xl:w-[min(calc(100vw-40rem),68rem)]'
          : 'w-full',
        showDockedPanels() && filtersOpen() && 'rounded-l-none',
        showDockedPanels() && hasDetail() && 'rounded-r-none',
        className,
      )}
    >
      <div class="px-3 py-2 border-b border-border-subtle flex gap-2 min-w-0 items-center">
        <button
          class="text-fg-subtle shrink-0 cursor-pointer hover:text-fg-muted"
          title={gridExpanded() ? 'Restore side panels' : 'Expand leader grid'}
          aria-label={gridExpanded() ? 'Restore side panels' : 'Expand leader grid'}
          onClick={handleToggleGridExpanded}
        >
          <Show when={gridExpanded()} fallback={<div class="i-ph-caret-line-up-bold text-sm" />}>
            <div class="i-ph-caret-line-down-bold text-sm" />
          </Show>
        </button>

        <Show when={!isRedDeathDraft()} fallback={<div class="flex-1" />}>
          <>
            <div class="flex-1 max-w-72 min-w-0 relative">
              <div class="i-ph-magnifying-glass-bold text-sm text-fg-subtle left-3 top-1/2 absolute -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={e => setSearchQuery(e.currentTarget.value)}
                class={cn(
                  'text-sm text-fg px-3.5 py-2 pl-8 rounded-lg w-full',
                  'bg-bg/60 border border-border',
                  'outline-none transition-all duration-150',
                  'placeholder:text-fg-subtle/60',
                  'focus:border-accent/50 focus:bg-bg/80 focus:shadow-[0_0_0_3px_var(--accent-subtle)]',
                )}
              />
            </div>

            <button
              class={cn(
                'relative inline-flex items-center justify-center rounded-lg border h-9 w-9 shrink-0 transition-all duration-150 cursor-pointer',
                filtersOpen()
                  ? 'border-accent/40 bg-accent/15 text-accent'
                  : 'border-border bg-bg/60 text-fg-muted hover:bg-bg-muted hover:border-border-hover',
              )}
              title="Filters"
              aria-label="Filters"
              onClick={handleToggleFilters}
            >
              <div class="i-ph-funnel-bold text-sm" />
              <Show when={activeTagFilterCount() > 0}>
                <span class="text-[10px] text-accent font-semibold px-1 py-0.5 rounded-full bg-bg-subtle min-w-4 translate-x-1/4 right-0 top-0 absolute -translate-y-1/4">
                  {activeTagFilterCount()}
                </span>
              </Show>
            </button>

            <Show when={activeTagFilterCount() > 0}>
              <button
                class="text-[11px] text-fg-subtle px-2 py-1 border border-border rounded cursor-pointer transition-colors hover:text-fg-muted hover:bg-bg-muted"
                onClick={clearTagFilters}
              >
                Clear
              </button>
            </Show>
          </>
        </Show>

        <div class="ml-auto flex shrink-0 gap-2 items-center">
          <div class="flex border border-border rounded overflow-hidden">
            <button
              class={cn(
                'px-1 py-0 transition-all duration-150 cursor-pointer',
                gridViewMode() === 'grid'
                  ? 'bg-bg-muted text-fg'
                  : 'bg-bg/60 text-fg-muted hover:text-fg-muted hover:bg-bg-muted',
              )}
              title="Grid view"
              aria-label="Grid view"
              onClick={() => setGridViewMode('grid')}
            >
              <div class="i-ph-grid-four-bold text-xs" />
            </button>
            <button
              class={cn(
                'px-1 py-0 transition-all duration-150 cursor-pointer border-l border-border',
                gridViewMode() === 'list'
                  ? 'bg-bg-muted text-fg'
                  : 'bg-bg/60 text-fg-muted hover:text-fg-muted hover:bg-bg-muted',
              )}
              title="List view"
              aria-label="List view"
              onClick={() => setGridViewMode('list')}
            >
              <div class="i-ph-list-bullets-bold text-xs" />
            </button>
          </div>

          <div class="text-[11px] text-fg-subtle">
            {filteredLeaders().length}
            /
            {draftLeaderPoolIds().size}
          </div>

          <button
            class="text-fg-subtle cursor-pointer hover:text-fg-muted"
            onClick={() => { setGridOpen(false); setFiltersOpen(false) }}
          >
            <div class="i-ph-x-bold text-sm" />
          </button>
        </div>
      </div>

      <div class={cn('p-1.5 flex-1 overflow-y-auto', showDockedPanels() ? 'min-h-[calc(3*4.5rem)]' : 'min-h-0')}>
        <Show
          when={gridViewMode() === 'list'}
          fallback={(
            <div class="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))]">
              <Show when={!isRedDeathDraft()}>
                <RandomLeaderCard
                  disabled={!canUseRandom()}
                  active={isRandomSelected()}
                  accent={accent()}
                  onClick={handleToggleRandom}
                />
              </Show>
              <For each={filteredLeaders()}>
                {leader => (
                  <LeaderCard
                    leader={leader}
                    singleClickShowsDetail={singleClickShowsDetail()}
                    onHoverMove={handleLeaderHoverMove}
                    onHoverLeave={handleLeaderHoverLeave}
                  />
                )}
              </For>
              <For each={Array.from({ length: ghostCount() })}>
                {() => <div class="aspect-square" />}
              </For>
            </div>
          )}
        >
          <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
            <Show when={!isRedDeathDraft()}>
              <RandomLeaderListItem
                disabled={!canUseRandom()}
                active={isRandomSelected()}
                accent={accent()}
                onClick={handleToggleRandom}
              />
            </Show>
            <For each={filteredLeaders()}>
              {leader => (
                <LeaderListItem
                  leader={leader}
                  singleClickShowsDetail={singleClickShowsDetail()}
                  onHoverMove={handleLeaderHoverMove}
                  onHoverLeave={handleLeaderHoverLeave}
                />
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={state()?.status === 'active' && isMyTurn() && !hasSubmitted()}>
        <div class="px-4 py-3 border-t border-border-subtle flex items-center justify-center">
          <Show when={step()?.action === 'ban'}>
            <button
              class={cn(
                'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                canConfirmBan()
                  ? 'bg-danger text-white cursor-pointer hover:bg-danger/80'
                  : 'bg-danger/20 text-danger/50 cursor-default',
              )}
              disabled={!canConfirmBan()}
              onClick={handleConfirmBan}
            >
              Confirm Bans (
              {isRandomSelected() ? step()!.count : banSelections().length}
              /
              {step()!.count}
              )
            </button>
          </Show>

          <Show when={step()?.action === 'pick'}>
            <button
              class={cn(
                'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                canConfirmPick()
                  ? 'bg-accent text-black cursor-pointer hover:bg-accent/80'
                  : 'bg-accent/20 text-accent/50 cursor-default',
              )}
              disabled={!canConfirmPick()}
              onClick={handleConfirmPick}
            >
              Confirm Pick
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )

  return (
    <Show when={gridOpen()}>
      {/* Backdrop */}
      <div class="bg-black/40 inset-0 absolute z-10" onClick={handleBackdropClick} />

      {/* Centered grid */}
      <div class={cn('flex pointer-events-none inset-x-0 bottom-14 justify-center absolute z-20', gridExpanded() || showStackedShelf() ? 'items-stretch top-3' : 'items-end top-6')}>
        <Show
          when={showStackedShelf()}
          fallback={(
            <div
              class={cn(
                overlayEntranceClass(),
                'pointer-events-auto relative z-30',
                panelsDocked()
                  ? 'flex flex-col max-h-full items-center'
                  : 'h-full w-[min(calc(100vw-1rem),90rem)] sm:w-[min(calc(100vw-1.5rem),90rem)]',
                panelsDocked() && gridExpanded() && 'h-full',
              )}
            >
              <Show when={showDockedPanels() && filtersOpen()}>
                <div class="anim-detail-in w-56 bottom-0 right-full top-0 absolute z-10">
                  {renderFilterPanel('h-full rounded-l-lg rounded-r-none border-r-0')}
                </div>
              </Show>

              <Show when={showDockedPanels() && hasDetail()}>
                <div class="anim-detail-in-right w-64 bottom-0 left-full top-0 absolute z-10 2xl:w-80 xl:w-72">
                  <div class="grid-panel-glow border border-l-0 border-border rounded-r-lg bg-bg-subtle h-full shadow-2xl overflow-hidden">
                    <LeaderDetailPanel />
                  </div>
                </div>
              </Show>

              <Show when={showFocusPanelStrip()}>
                <div class="pointer-events-none inset-0 absolute z-30 overflow-hidden">
                  <Show when={filtersOpen()}>
                    <div class="h-full min-h-0 w-full pointer-events-auto overflow-hidden">
                      {renderFilterPanel('h-full')}
                    </div>
                  </Show>
                  <Show when={!filtersOpen() && hasDetail()}>
                    <div class="h-full min-h-0 w-full pointer-events-auto overflow-hidden">
                      <div class="grid-panel-glow border border-border rounded-lg bg-bg-subtle h-full shadow-2xl overflow-hidden">
                        <LeaderDetailPanel />
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>

              {renderGridPanel(gridExpanded() ? 'h-full' : '')}
            </div>
          )}
        >
          <div class={cn(overlayEntranceClass(), 'pointer-events-auto relative z-30 h-full w-[min(calc(100vw-1rem),90rem)] sm:w-[min(calc(100vw-1.5rem),90rem)]')}>
            <Show when={filtersOpen() || hasDetail()}>
              <div class="gap-2 grid grid-cols-2 pointer-events-none inset-x-0 top-0 absolute z-30 overflow-hidden" style={{ height: '35%' }}>
                <div class={cn('h-full min-h-0 overflow-hidden', filtersOpen() ? 'pointer-events-auto' : 'pointer-events-none')}>
                  <Show when={filtersOpen()}>
                    {renderFilterPanel('h-full')}
                  </Show>
                </div>

                <div class={cn('h-full min-h-0 overflow-hidden', hasDetail() ? 'pointer-events-auto' : 'pointer-events-none')}>
                  <Show when={hasDetail()}>
                    <div class="grid-panel-glow border border-border rounded-lg bg-bg-subtle h-full shadow-2xl overflow-hidden">
                      <LeaderDetailPanel />
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            <div class="flex flex-col gap-2 h-full">
              <div class="shrink-0 gap-2 grid grid-cols-2" style={{ height: '35%' }}>
                <div />
                <div />
              </div>

              <div class="flex-1 min-h-0">
                {renderGridPanel('h-full')}
              </div>
            </div>
          </div>
        </Show>
      </div>

      {/* Hover tooltip */}
      <Show when={hoverTooltip()}>
        {tooltip => (
          <div
            ref={(el) => {
              tooltipRef = el
            }}
            class="px-2 py-1 border border-border rounded bg-bg/95 max-w-56 pointer-events-none shadow-black/40 shadow-lg fixed z-30"
            style={{
              left: `${tooltipPosition().left}px`,
              top: `${tooltipPosition().top}px`,
            }}
          >
            <div class="text-xs text-fg font-semibold truncate">{tooltip().name}</div>
            <div class="text-[11px] text-fg-muted truncate">{tooltip().civ}</div>
            <Show when={tooltip().tags.length > 0}>
              <div class="mt-1 flex flex-wrap gap-1 max-w-56">
                <For each={tooltip().tags}>
                  {tag => <TagPill tag={tag} compact />}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}

function RandomLeaderListItem(props: { disabled: boolean, active: boolean, accent: 'gold' | 'red', onClick: () => void }) {
  const accentColor = () => props.accent === 'red' ? 'danger' : 'accent'

  return (
    <button
      class={cn(
        'relative flex items-center gap-2 rounded-md px-1.5 py-1 group min-w-0 transition-all duration-150',
        'outline outline-2 outline-transparent',
        props.disabled ? 'cursor-default' : 'cursor-pointer',

        !props.active && !props.disabled && 'hover:bg-white/6',

        !props.disabled && props.active && accentColor() === 'accent' && 'outline-accent/50 bg-accent/8 hover:bg-accent/14 hover:outline-accent/65',
        !props.disabled && props.active && accentColor() === 'danger' && 'outline-danger/50 bg-danger/8 hover:bg-danger/14 hover:outline-danger/65',
      )}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <div
        class={cn(
          'h-7 w-7 shrink-0 rounded-full flex items-center justify-center',
          props.disabled && 'bg-bg/35 text-fg-subtle/45',
          !props.disabled && !props.active && 'bg-bg/60 text-fg-muted',
          !props.disabled && props.active && accentColor() === 'accent' && 'bg-accent/15 text-accent',
          !props.disabled && props.active && accentColor() === 'danger' && 'bg-danger/15 text-danger',
        )}
      >
        <span class="i-ph-dice-five-bold text-xs" />
      </div>
      <span class={cn(
        'text-xs font-semibold tracking-wide transition-colors',
        props.disabled && 'text-fg-subtle/45',
        !props.disabled && !props.active && 'text-fg-muted group-hover:text-fg',
        !props.disabled && props.active && accentColor() === 'accent' && 'text-accent group-hover:text-accent group-hover:drop-shadow-[0_0_4px_var(--accent)]',
        !props.disabled && props.active && accentColor() === 'danger' && 'text-danger group-hover:text-danger group-hover:drop-shadow-[0_0_4px_var(--danger)]',
      )}>
        Random
      </span>
    </button>
  )
}

function RandomLeaderCard(props: { disabled: boolean, active: boolean, accent: 'gold' | 'red', onClick: () => void }) {
  const accentRing = () => props.accent === 'red' ? 'danger' : 'accent'

  return (
    <button
      class={cn(
        'relative aspect-square p-0.5 group',
        'focus:outline-none',
        props.disabled
          ? 'cursor-default'
          : 'cursor-pointer',
      )}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <div
        class={cn(
          'w-full h-full rounded-full flex flex-col items-center justify-center gap-1 transition-all duration-150',
          'ring-2 ring-inset',

          // Disabled
          props.disabled && 'bg-bg/35 text-fg-subtle/45 ring-transparent',

          // Default (not active, not disabled)
          !props.disabled && !props.active && 'bg-bg/60 text-fg-muted ring-border',
          !props.disabled && !props.active && 'group-hover:ring-white/30 group-hover:brightness-115 group-hover:bg-bg-muted',

          // Active
          !props.disabled && props.active && accentRing() === 'accent' && 'ring-accent bg-accent/10 text-accent shadow-[0_0_10px_var(--accent-muted)]',
          !props.disabled && props.active && accentRing() === 'accent' && 'group-hover:brightness-115 group-hover:shadow-[0_0_14px_var(--accent-muted)]',

          !props.disabled && props.active && accentRing() === 'danger' && 'ring-danger bg-danger/10 text-danger shadow-[0_0_10px_var(--danger-muted)]',
          !props.disabled && props.active && accentRing() === 'danger' && 'group-hover:brightness-115 group-hover:shadow-[0_0_14px_var(--danger-muted)]',
        )}
      >
        <span class="i-ph-dice-five-bold text-base" />
        <span class="text-[10px] tracking-wide font-semibold">Random</span>
      </div>
    </button>
  )
}

function pickRandomLeaderIds(pool: Leader[], count: number): string[] {
  const mutablePool = [...pool]
  const selectedIds: string[] = []

  while (selectedIds.length < count && mutablePool.length > 0) {
    const index = Math.floor(Math.random() * mutablePool.length)
    const leader = mutablePool[index]
    if (!leader) break
    selectedIds.push(leader.id)
    mutablePool.splice(index, 1)
  }

  return selectedIds
}

function sameCivIdList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function TagPill(props: { tag: string, compact?: boolean, active?: boolean }) {
  const meta = () => getLeaderTagMeta(props.tag)
  const iconUrl = () => resolveAssetUrl(meta().iconUrl ?? `/assets/bbg/icons/ICON_${meta().iconToken!.toUpperCase()}.webp`)

  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full border font-semibold leading-none',
        props.compact ? 'gap-1 px-1.5 py-0.5 text-[11px]' : 'gap-1.5 px-2 py-1 text-[12px]',
      )}
      style={{
        'color': meta().textColor,
        'background-color': meta().bgColor,
        'border-color': meta().borderColor,
        'box-shadow': props.active ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)' : 'none',
      }}
    >
      <Show when={meta().showIcon}>
        <img
          src={iconUrl()}
          alt={meta().label}
          class={cn(props.compact ? 'h-3 w-3' : 'h-3.5 w-3.5')}
        />
      </Show>
      <span>{meta().label}</span>
    </span>
  )
}

function FilterTagButton(props: { tag: string, active: boolean, onClick: () => void }) {
  const meta = () => getLeaderTagMeta(props.tag)
  const iconUrl = () => resolveAssetUrl(meta().iconUrl ?? `/assets/bbg/icons/ICON_${meta().iconToken!.toUpperCase()}.webp`)

  return (
    <button
      class="group text-[11px] leading-none font-semibold px-2.5 py-1 border rounded inline-flex gap-1.5 cursor-pointer items-center relative overflow-hidden"
      style={{
        'color': props.active ? meta().textColor : 'var(--fg-muted)',
        'background-color': props.active ? meta().bgColor : 'rgba(143, 152, 168, 0.12)',
        'border-color': props.active ? meta().borderColor : 'rgba(143, 152, 168, 0.26)',
        'box-shadow': props.active ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.12)' : 'none',
      }}
      onClick={() => props.onClick()}
    >
      <div class="bg-white/0 transition-colors inset-0 absolute group-hover:bg-white/8" />
      <Show when={meta().showIcon}>
        <img
          src={iconUrl()}
          alt={meta().label}
          class="h-3.5 w-3.5 relative"
        />
      </Show>
      <span class="relative">{meta().label}</span>
    </button>
  )
}
