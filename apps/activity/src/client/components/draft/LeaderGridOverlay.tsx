import type { Leader } from '@civup/game'
import type { LeaderTagCategory } from '~/client/lib/leader-tags'
import { leaders, searchLeaders } from '@civup/game'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
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
  clearSelections,
  clearTagFilters,
  currentStep,
  draftStore,
  gridOpen,
  hasSubmitted,
  isMyTurn,
  phaseAccent,
  searchQuery,
  selectedLeader,
  sendBan,
  sendPick,
  setDetailLeaderId,
  setGridOpen,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
  toggleTagFilter,
} from '~/client/stores'
import { LeaderCard } from './LeaderCard'
import { LeaderDetailPanel } from './LeaderDetailPanel'

const FILTER_TAG_OPTIONS = getFilterTagOptions(leaders)

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

/** Collapsible leader grid overlay with search, filter, icon grid, detail panel, and confirm button */
export function LeaderGridOverlay() {
  const state = () => draftStore.state
  const step = currentStep
  const accent = () => phaseAccent()
  const [hoverTooltip, setHoverTooltip] = createSignal<HoverTooltip | null>(null)
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const [randomPickArmed, setRandomPickArmed] = createSignal(false)
  const [tooltipSize, setTooltipSize] = createSignal({ width: 224, height: 96 })
  let tooltipRef: HTMLDivElement | undefined

  const tooltipPosition = createMemo<TooltipPosition>(() => {
    const tooltip = hoverTooltip()
    if (!tooltip) return { left: 0, top: 0 }
    const size = tooltipSize()
    return resolveTooltipPosition(tooltip.x, tooltip.y, size.width, size.height)
  })

  // Auto-open grid when it's your turn
  createEffect(() => {
    if (isMyTurn() && !hasSubmitted()) setGridOpen(true)
  })

  const filteredLeaders = createMemo(() => {
    const query = searchQuery().trim()
    const filters = tagFilters()
    let result = query ? searchLeaders(query) : [...leaders]
    result = result.filter(leader => leaderMatchesTagFilters(leader.tags, filters))
    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  const isTagActive = (category: LeaderTagCategory, tag: string): boolean => {
    return tagFilters()[category].includes(tag)
  }

  const randomLeaderPool = createMemo(() => {
    const available = new Set(state()?.availableCivIds ?? [])
    return filteredLeaders().filter(leader => available.has(leader.id))
  })

  const canPickRandom = () => {
    if (state()?.status !== 'active') return false
    if (step()?.action !== 'pick') return false
    if (!isMyTurn() || hasSubmitted()) return false
    return randomLeaderPool().length > 0
  }

  const canConfirmPick = () => {
    if (step()?.action !== 'pick') return false
    if (selectedLeader()) return true
    return randomPickArmed()
  }

  createEffect(() => {
    if (selectedLeader()) setRandomPickArmed(false)
  })

  createEffect(() => {
    if (step()?.action !== 'pick') setRandomPickArmed(false)
  })

  createEffect(() => {
    if (randomPickArmed() && randomLeaderPool().length === 0) setRandomPickArmed(false)
  })

  const handleRandomLeader = () => {
    if (!canPickRandom()) return
    setSelectedLeader(null)
    setDetailLeaderId(null)
    setRandomPickArmed(true)
    setHoverTooltip(null)
  }

  const handleConfirmPick = () => {
    let civId = selectedLeader()
    if (!civId && randomPickArmed()) {
      const pool = randomLeaderPool()
      if (pool.length === 0) return
      civId = pool[Math.floor(Math.random() * pool.length)]!.id
    }
    if (!civId) return
    sendPick(civId)
    setRandomPickArmed(false)
    clearSelections()
    setHoverTooltip(null)
    setFiltersOpen(false)
    setGridOpen(false)
  }

  const handleConfirmBan = () => {
    const civIds = banSelections()
    if (civIds.length === 0) return
    sendBan(civIds)
    setRandomPickArmed(false)
    clearSelections()
    setHoverTooltip(null)
    setFiltersOpen(false)
    setGridOpen(false)
  }

  /** Close overlay when clicking backdrop (only if not your active turn) */
  const handleBackdropClick = () => {
    if (isMyTurn() && !hasSubmitted()) return
    setHoverTooltip(null)
    setRandomPickArmed(false)
    setFiltersOpen(false)
    setGridOpen(false)
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

  return (
    <Show when={gridOpen()}>
      {/* Backdrop */}
      <div class="bg-black/40 inset-0 absolute z-10" onClick={handleBackdropClick} />

      {/* Grid panel */}
      <div class={cn(
        'absolute inset-x-4 top-2 bottom-4 z-20 flex overflow-hidden rounded-lg',
        'bg-bg-secondary border-t-2',
        accent() === 'red' ? 'border-accent-red' : 'border-accent-gold',
        'anim-overlay-in',
      )}
      >
        {/* Main grid area */}
        <div class="flex flex-1 flex-col min-w-0" onClick={() => setFiltersOpen(false)}>
          {/* Toolbar: search + filters */}
          <div class="px-3 py-2 border-b border-white/5 flex gap-2 items-center relative">
            {/* Search */}
            <div class="shrink-0 min-w-52 w-64 relative xl:w-80">
              <div class="i-ph-magnifying-glass-bold text-sm text-text-muted left-2 top-1/2 absolute -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={e => setSearchQuery(e.currentTarget.value)}
                class="text-sm text-text-primary py-1.5 pl-7 pr-3 outline-none rounded bg-bg-primary w-full focus:ring-1 focus:ring-accent-gold/30 placeholder-text-muted"
              />
            </div>

            {/* Filter trigger */}
            <button
              class={cn(
                'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors cursor-pointer',
                filtersOpen()
                  ? 'border-accent-gold/40 bg-accent-gold/15 text-accent-gold'
                  : 'border-white/10 bg-bg-primary text-text-secondary hover:bg-bg-hover',
              )}
              onClick={(event) => {
                event.stopPropagation()
                setFiltersOpen(prev => !prev)
              }}
            >
              <div class="i-ph-funnel-bold text-sm" />
              <span>Filters</span>
              <Show when={activeTagFilterCount() > 0}>
                <span class="text-[10px] text-accent-gold font-semibold px-1.5 py-0.5 rounded-full bg-accent-gold/15">
                  {activeTagFilterCount()}
                </span>
              </Show>
            </button>

            <Show when={activeTagFilterCount() > 0}>
              <button
                class="text-[11px] text-text-muted px-2 py-1 border border-white/10 rounded cursor-pointer transition-colors hover:text-text-secondary hover:bg-bg-hover"
                onClick={clearTagFilters}
              >
                Clear
              </button>
            </Show>

            <div class="text-[11px] text-text-muted ml-auto">
              {filteredLeaders().length}
              /
              {leaders.length}
              {' '}
              shown
            </div>

            {/* Filter dropdown */}
            <Show when={filtersOpen()}>
              <div class="p-3 border border-white/10 rounded bg-bg-primary/95 flex flex-col max-h-[min(20rem,calc(100dvh-11rem))] max-w-[calc(100%-1.5rem)] w-[34rem] shadow-black/40 shadow-lg right-3 top-[calc(100%+0.35rem)] absolute z-30" onClick={event => event.stopPropagation()}>
                <div class="mb-2 flex shrink-0 items-center justify-between">
                  <span class="text-xs text-text-secondary font-semibold">Leader Filters</span>
                  <button
                    class="text-[10px] text-text-muted px-2 py-0.5 border border-white/10 rounded transition-colors hover:text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={activeTagFilterCount() === 0}
                    onClick={clearTagFilters}
                  >
                    Clear all
                  </button>
                </div>

                <div class="pb-1 pr-1 min-h-0 overflow-y-auto space-y-2">
                  <For each={TAG_CATEGORY_ORDER}>
                    {category => (
                      <Show when={FILTER_TAG_OPTIONS[category].length > 0}>
                        <div>
                          <div class="text-[10px] text-text-muted tracking-widest font-semibold mb-1 uppercase">{TAG_CATEGORY_LABELS[category]}</div>
                          <div class="flex flex-wrap gap-1.5">
                            <For each={FILTER_TAG_OPTIONS[category]}>
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
            </Show>
          </div>

          {/* Leader icon grid */}
          <div class="p-3 flex-1 overflow-y-auto">
            <div class="gap-1.5 grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))]">
              <RandomLeaderCard
                disabled={!canPickRandom()}
                armed={randomPickArmed()}
                onClick={handleRandomLeader}
              />
              <For each={filteredLeaders()}>
                {leader => (
                  <LeaderCard
                    leader={leader}
                    onHoverMove={handleLeaderHoverMove}
                    onHoverLeave={handleLeaderHoverLeave}
                  />
                )}
              </For>
            </div>
          </div>

          {/* Bottom action bar */}
          <Show when={state()?.status === 'active' && isMyTurn() && !hasSubmitted()}>
            <div class="px-4 py-3 border-t border-white/5 flex items-center justify-center">
              {/* Ban action */}
              <Show when={step()?.action === 'ban'}>
                <div class="flex gap-3 items-center">
                  <span class="text-xs text-text-secondary">
                    Select
                    {' '}
                    {step()!.count}
                    {' '}
                    to ban
                  </span>
                  <button
                    class={cn(
                      'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                      banSelections().length === step()!.count
                        ? 'bg-accent-red text-white cursor-pointer hover:bg-accent-red/80'
                        : 'bg-accent-red/20 text-accent-red/50 cursor-not-allowed',
                    )}
                    disabled={banSelections().length !== step()!.count}
                    onClick={handleConfirmBan}
                  >
                    Confirm Bans (
                    {banSelections().length}
                    /
                    {step()!.count}
                    )
                  </button>
                </div>
              </Show>

              {/* Pick action */}
              <Show when={step()?.action === 'pick'}>
                <div class="flex gap-3 items-center">
                  <span class="text-xs text-text-secondary">Pick your leader</span>
                  <button
                    class={cn(
                      'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                      canConfirmPick()
                        ? 'bg-accent-gold text-black cursor-pointer hover:bg-accent-gold/80'
                        : 'bg-accent-gold/20 text-accent-gold/50 cursor-not-allowed',
                    )}
                    disabled={!canConfirmPick()}
                    onClick={handleConfirmPick}
                  >
                    {randomPickArmed() ? 'Confirm Random Pick' : 'Confirm Pick'}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Detail panel (right side, click-to-open) */}
        <LeaderDetailPanel />
      </div>

      {/* Hover tooltip */}
      <Show when={hoverTooltip()}>
        {tooltip => (
          <div
            ref={(el) => {
              tooltipRef = el
            }}
            class="px-2 py-1 border border-white/10 rounded bg-bg-primary/95 max-w-56 pointer-events-none shadow-black/40 shadow-lg fixed z-30"
            style={{
              left: `${tooltipPosition().left}px`,
              top: `${tooltipPosition().top}px`,
            }}
          >
            <div class="text-xs text-text-primary font-semibold truncate">{tooltip().name}</div>
            <div class="text-[11px] text-text-secondary truncate">{tooltip().civ}</div>
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

function RandomLeaderCard(props: { disabled: boolean, armed: boolean, onClick: () => void }) {
  return (
    <button
      class={cn(
        'aspect-square rounded border transition-colors flex flex-col items-center justify-center gap-1',
        props.disabled
          ? 'border-white/8 bg-bg-primary/35 text-text-muted/45 cursor-not-allowed'
          : props.armed
            ? 'border-accent-gold/60 bg-accent-gold/20 text-accent-gold cursor-pointer'
            : 'border-accent-gold/35 bg-accent-gold/10 text-accent-gold cursor-pointer hover:border-accent-gold/55 hover:bg-accent-gold/15',
      )}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <span class="i-ph-dice-five-bold text-base" />
      <span class="text-[10px] tracking-wide font-semibold uppercase">Random</span>
    </button>
  )
}

function TagPill(props: { tag: string, compact?: boolean, active?: boolean }) {
  const meta = () => getLeaderTagMeta(props.tag)

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
          src={meta().iconUrl ?? `/assets/bbg/icons/ICON_${meta().iconToken!.toUpperCase()}.webp`}
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

  return (
    <button
      class="group text-[11px] leading-none font-semibold px-2.5 py-1 border rounded inline-flex gap-1.5 cursor-pointer items-center relative overflow-hidden"
      style={{
        'color': props.active ? meta().textColor : '#8f98a8',
        'background-color': props.active ? meta().bgColor : 'rgba(143, 152, 168, 0.12)',
        'border-color': props.active ? meta().borderColor : 'rgba(143, 152, 168, 0.26)',
        'box-shadow': props.active ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.12)' : 'none',
      }}
      onClick={() => props.onClick()}
    >
      <div class="bg-white/0 transition-colors inset-0 absolute group-hover:bg-white/8" />
      <Show when={meta().showIcon}>
        <img
          src={meta().iconUrl ?? `/assets/bbg/icons/ICON_${meta().iconToken!.toUpperCase()}.webp`}
          alt={meta().label}
          class="h-3.5 w-3.5 relative"
        />
      </Show>
      <span class="relative">{meta().label}</span>
    </button>
  )
}
