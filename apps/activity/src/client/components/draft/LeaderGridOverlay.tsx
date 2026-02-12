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
  detailLeaderId,
  draftStore,
  gridOpen,
  hasSubmitted,
  isMyTurn,
  isRandomSelected,
  phaseAccent,
  searchQuery,
  selectedLeader,
  sendBan,
  sendPick,
  setBanSelections,
  setDetailLeaderId,
  setGridOpen,
  setIsRandomSelected,
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

/** Collapsible leader grid overlay */
export function LeaderGridOverlay() {
  const state = () => draftStore.state
  const step = currentStep
  const accent = () => phaseAccent()
  const [hoverTooltip, setHoverTooltip] = createSignal<HoverTooltip | null>(null)
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const [tooltipSize, setTooltipSize] = createSignal({ width: 224, height: 96 })
  let tooltipRef: HTMLDivElement | undefined

  const hasDetail = () => detailLeaderId() != null

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

  const ghostCount = createMemo(() => Math.max(0, leaders.length - filteredLeaders().length))

  const isTagActive = (category: LeaderTagCategory, tag: string): boolean => {
    return tagFilters()[category].includes(tag)
  }

  const randomLeaderPool = createMemo(() => {
    const available = new Set(state()?.availableCivIds ?? [])
    return filteredLeaders().filter(leader => available.has(leader.id))
  })

  const canUseRandom = () => {
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

      {/* Centered grid */}
      <div class="flex pointer-events-none items-end inset-x-0 bottom-14 top-6 justify-center absolute z-20">
        <div class="anim-overlay-in flex flex-col max-h-full pointer-events-auto items-center relative z-30">

          {/* Left: Filter panel */}
          <Show when={filtersOpen()}>
            <div class="anim-detail-in grid-panel-glow border border-r-0 border-white/8 rounded-l-lg bg-bg-secondary flex shrink-0 flex-col w-56 shadow-2xl bottom-0 right-full top-0 absolute z-10 overflow-hidden">
              <div class="p-3 flex-1 overflow-y-auto">
                <div class="mb-2 flex shrink-0 items-center justify-between">
                  <span class="text-xs text-text-secondary font-semibold">Filters</span>
                  <button
                    class="text-[10px] text-text-muted px-2 py-0.5 border border-white/10 rounded transition-colors hover:text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={activeTagFilterCount() === 0}
                    onClick={clearTagFilters}
                  >
                    Clear all
                  </button>
                </div>

                <div class="space-y-2">
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
            </div>
          </Show>

          {/* Center: Main grid */}
          <div
            class={cn(
              'flex flex-col w-full max-h-full overflow-hidden rounded-lg bg-bg-secondary shadow-2xl grid-panel-glow relative z-20',
              'w-[min(calc(100vw-36rem),68rem)]',
              'border border-white/8',
              filtersOpen() && 'rounded-r-none',
              hasDetail() && 'rounded-l-none',
            )}
          >
            <div class="px-3 py-2 border-b border-white/5 flex gap-2 items-center">
              {/* Search */}
              <div class="shrink-0 min-w-40 w-52 relative xl:w-64">
                <div class="i-ph-magnifying-glass-bold text-sm text-text-muted left-3 top-1/2 absolute -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery()}
                  onInput={e => setSearchQuery(e.currentTarget.value)}
                  class={cn(
                    'text-sm text-text-primary px-3.5 py-2 pl-8 rounded-lg w-full',
                    'bg-bg-primary/60 border border-white/8',
                    'outline-none transition-all duration-150',
                    'placeholder:text-text-muted/60',
                    'focus:border-accent-gold/50 focus:bg-bg-primary/80 focus:shadow-[0_0_0_3px_rgba(200,170,110,0.08)]',
                  )}
                />
              </div>

              {/* Filter trigger */}
              <button
                class={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-150 cursor-pointer self-stretch',
                  filtersOpen()
                    ? 'border-accent-gold/40 bg-accent-gold/15 text-accent-gold'
                    : 'border-white/8 bg-bg-primary/60 text-text-secondary hover:bg-bg-hover hover:border-white/12',
                )}
                onClick={() => setFiltersOpen(prev => !prev)}
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

              {/* Close grid button */}
              <button
                class="text-text-muted ml-1 cursor-pointer hover:text-text-secondary"
                onClick={() => { setGridOpen(false); setFiltersOpen(false) }}
              >
                <div class="i-ph-x-bold text-sm" />
              </button>
            </div>

            {/* Leader icon grid */}
            <div class="p-1.5 flex-1 min-h-0 overflow-y-auto">
              <div class="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))]">
                <RandomLeaderCard
                  disabled={!canUseRandom()}
                  active={isRandomSelected()}
                  accent={accent()}
                  onClick={handleToggleRandom}
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
                <For each={Array.from({ length: ghostCount() })}>
                  {() => <div class="aspect-square" />}
                </For>
              </div>
            </div>

            {/* Bottom action bar */}
            <Show when={state()?.status === 'active' && isMyTurn() && !hasSubmitted()}>
              <div class="px-4 py-3 border-t border-white/5 flex items-center justify-center">
                {/* Ban action */}
                <Show when={step()?.action === 'ban'}>
                  <button
                    class={cn(
                      'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                      canConfirmBan()
                        ? 'bg-accent-red text-white cursor-pointer hover:bg-accent-red/80'
                        : 'bg-accent-red/20 text-accent-red/50 cursor-not-allowed',
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

                {/* Pick action */}
                <Show when={step()?.action === 'pick'}>
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
                    Confirm Pick
                  </button>
                </Show>
              </div>
            </Show>
          </div>

          {/* Right: Leader detail panel */}
          <Show when={hasDetail()}>
            <div class="anim-detail-in grid-panel-glow border border-white/8 rounded-r-lg bg-bg-secondary max-w-full w-64 shadow-2xl bottom-0 right-0 top-0 absolute z-30 overflow-hidden lg:border-l-0 lg:rounded-l-none xl:w-80 lg:left-full lg:right-auto lg:z-10">
              <LeaderDetailPanel />
            </div>
          </Show>
        </div>
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

function RandomLeaderCard(props: { disabled: boolean, active: boolean, accent: 'gold' | 'red', onClick: () => void }) {
  const accentRing = () => props.accent === 'red' ? 'accent-red' : 'accent-gold'

  return (
    <button
      class={cn(
        'relative aspect-square p-0.5 group',
        'focus:outline-none',
        props.disabled
          ? 'cursor-not-allowed'
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
          props.disabled && 'bg-bg-primary/35 text-text-muted/45 ring-transparent',

          // Default (not active, not disabled)
          !props.disabled && !props.active && 'bg-bg-primary/60 text-text-secondary ring-white/10',
          !props.disabled && !props.active && 'group-hover:ring-white/30 group-hover:brightness-115 group-hover:bg-bg-hover',

          // Active
          !props.disabled && props.active && accentRing() === 'accent-gold' && 'ring-accent-gold bg-accent-gold/10 text-accent-gold shadow-[0_0_10px_rgba(200,170,110,0.3)]',
          !props.disabled && props.active && accentRing() === 'accent-gold' && 'group-hover:brightness-115 group-hover:shadow-[0_0_14px_rgba(200,170,110,0.45)]',

          !props.disabled && props.active && accentRing() === 'accent-red' && 'ring-accent-red bg-accent-red/10 text-accent-red shadow-[0_0_10px_rgba(232,64,87,0.3)]',
          !props.disabled && props.active && accentRing() === 'accent-red' && 'group-hover:brightness-115 group-hover:shadow-[0_0_14px_rgba(232,64,87,0.45)]',
        )}
      >
        <span class="i-ph-dice-five-bold text-base" />
        <span class="text-[10px] tracking-wide font-semibold uppercase">Random</span>
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
