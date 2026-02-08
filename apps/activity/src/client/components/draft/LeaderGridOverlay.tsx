import { leaders, searchLeaders, type Leader } from '@civup/game'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import {
  banSelections,
  clearSelections,
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
  setGridOpen,
  setSearchQuery,
  setTagFilter,
  tagFilter,
} from '~/client/stores'
import { LeaderCard } from './LeaderCard'
import { LeaderDetailPanel } from './LeaderDetailPanel'

/** All unique tags across leaders */
const ALL_TAGS = [...new Set(leaders.flatMap(l => l.tags))].sort()

interface HoverTooltip {
  name: string
  civ: string
  x: number
  y: number
}

/** Collapsible leader grid overlay with search, filter, icon grid, detail panel, and confirm button */
export function LeaderGridOverlay() {
  const state = () => draftStore.state
  const step = currentStep
  const accent = () => phaseAccent()
  const [hoverTooltip, setHoverTooltip] = createSignal<HoverTooltip | null>(null)

  // Auto-open grid when it's your turn
  createEffect(() => {
    if (isMyTurn() && !hasSubmitted()) setGridOpen(true)
  })

  const filteredLeaders = createMemo(() => {
    const query = searchQuery()
    const tag = tagFilter()
    let result = query ? searchLeaders(query) : [...leaders]
    if (tag) result = result.filter(l => l.tags.includes(tag))
    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  const handleConfirmPick = () => {
    const civId = selectedLeader()
    if (!civId) return
    sendPick(civId)
    clearSelections()
    setHoverTooltip(null)
    setGridOpen(false)
  }

  const handleConfirmBan = () => {
    const civIds = banSelections()
    if (civIds.length === 0) return
    sendBan(civIds)
    clearSelections()
    setHoverTooltip(null)
    setGridOpen(false)
  }

  /** Close overlay when clicking backdrop (only if not your active turn) */
  const handleBackdropClick = () => {
    if (isMyTurn() && !hasSubmitted()) return
    setHoverTooltip(null)
    setGridOpen(false)
  }

  const handleLeaderHoverMove = (leader: Leader, x: number, y: number) => {
    setHoverTooltip({
      name: leader.name,
      civ: leader.civilization,
      x,
      y,
    })
  }

  const handleLeaderHoverLeave = () => {
    setHoverTooltip(null)
  }

  return (
    <Show when={gridOpen()}>
      {/* Backdrop */}
      <div class="absolute inset-0 z-10 bg-black/40" onClick={handleBackdropClick} />

      {/* Grid panel */}
        <div class={cn(
          'absolute inset-x-4 top-2 bottom-4 z-20 flex overflow-hidden rounded-lg',
          'bg-bg-secondary border-t-2',
          accent() === 'red' ? 'border-accent-red' : 'border-accent-gold',
          'anim-overlay-in',
        )}
        >
        {/* Main grid area */}
        <div class="flex min-w-0 flex-1 flex-col">
          {/* Toolbar: search + filters */}
          <div class="flex items-center gap-2 border-b border-white/5 px-3 py-2">
            {/* Search */}
            <div class="relative flex-1">
              <div class="i-ph-magnifying-glass-bold absolute left-2 top-1/2 -translate-y-1/2 text-sm text-text-muted" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={e => setSearchQuery(e.currentTarget.value)}
                class="w-full rounded bg-bg-primary py-1.5 pl-7 pr-3 text-sm text-text-primary placeholder-text-muted outline-none focus:ring-1 focus:ring-accent-gold/30"
              />
            </div>

            {/* Tag filters */}
            <div class="flex gap-1">
              <For each={ALL_TAGS}>
                {tag => (
                  <button
                    class={cn(
                      'rounded px-2 py-1 text-xs font-medium capitalize transition-colors cursor-pointer',
                      tagFilter() === tag
                        ? 'bg-accent-gold/20 text-accent-gold'
                        : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
                    )}
                    onClick={() => setTagFilter(prev => prev === tag ? null : tag)}
                  >
                    {tag}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Leader icon grid */}
          <div class="flex-1 overflow-y-auto p-3">
            <div class="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5">
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
            <div class="flex items-center justify-center border-t border-white/5 px-4 py-3">
              {/* Ban action */}
              <Show when={step()?.action === 'ban'}>
                <div class="flex items-center gap-3">
                  <span class="text-xs text-text-secondary">
                    Select {step()!.count} to ban
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
                    Confirm Bans ({banSelections().length}/{step()!.count})
                  </button>
                </div>
              </Show>

              {/* Pick action */}
              <Show when={step()?.action === 'pick'}>
                <div class="flex items-center gap-3">
                  <span class="text-xs text-text-secondary">Pick your leader</span>
                  <button
                    class={cn(
                      'rounded px-4 py-1.5 text-sm font-semibold transition-colors',
                      selectedLeader()
                        ? 'bg-accent-gold text-black cursor-pointer hover:bg-accent-gold/80'
                        : 'bg-accent-gold/20 text-accent-gold/50 cursor-not-allowed',
                    )}
                    disabled={!selectedLeader()}
                    onClick={handleConfirmPick}
                  >
                    Confirm Pick
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
            class="pointer-events-none fixed z-30 max-w-56 rounded border border-white/10 bg-bg-primary/95 px-2 py-1 shadow-lg shadow-black/40"
            style={{
              'left': `${tooltip().x + 14}px`,
              'top': `${tooltip().y + 14}px`,
            }}
          >
            <div class="truncate text-xs text-text-primary font-semibold">{tooltip().name}</div>
            <div class="truncate text-[11px] text-text-secondary">{tooltip().civ}</div>
          </div>
        )}
      </Show>
    </Show>
  )
}
