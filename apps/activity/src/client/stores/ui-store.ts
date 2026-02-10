import type { TagFilterState } from '~/client/lib/leader-tags'
import { createMemo, createSignal } from 'solid-js'
import {
  countActiveTagFilters,
  createEmptyTagFilters,
  getTagCategory,

} from '~/client/lib/leader-tags'
import { currentStep } from './draft-store'

// ── UI State ───────────────────────────────────────────────

/** Currently selected leader ID (clicked in grid, pending confirm) */
const [selectedLeader, setSelectedLeader] = createSignal<string | null>(null)

/** Search query for leader grid filter */
const [searchQuery, setSearchQuery] = createSignal('')

/** Active leader tag filters grouped by category */
const [tagFilters, setTagFilters] = createSignal<TagFilterState>(createEmptyTagFilters())

/** Number of selected tag filters across all categories */
const activeTagFilterCount = createMemo(() => countActiveTagFilters(tagFilters()))

/** Selected civ IDs for blind ban (multi-select) */
const [banSelections, setBanSelections] = createSignal<string[]>([])

/** Whether the leader grid overlay is open */
const [gridOpen, setGridOpen] = createSignal(false)

/** Leader ID shown in the detail panel (click-to-open) */
const [detailLeaderId, setDetailLeaderId] = createSignal<string | null>(null)

/** Whether we're in minimized (PiP) mode */
const [isMiniView, setIsMiniView] = createSignal(false)

export {
  activeTagFilterCount,
  banSelections,
  detailLeaderId,
  gridOpen,
  isMiniView,
  searchQuery,
  selectedLeader,
  setBanSelections,
  setDetailLeaderId,
  setGridOpen,
  setIsMiniView,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
}

// ── Phase Accent ───────────────────────────────────────────

/** Current phase accent color class based on draft step */
export const phaseAccent = createMemo(() => {
  const step = currentStep()
  if (!step) return 'gold' as const
  return step.action === 'ban' ? ('red' as const) : ('gold' as const)
})

/** CSS color value for the current phase accent */
export const phaseAccentColor = createMemo(() => {
  return phaseAccent() === 'red' ? '#e84057' : '#c8aa6e'
})

/** Header tint class for phase mood */
export const phaseHeaderBg = createMemo(() => {
  const step = currentStep()
  if (!step) return 'bg-bg-secondary'
  return step.action === 'ban' ? 'bg-[#1a0a0e]' : 'bg-bg-secondary'
})

// ── Actions ────────────────────────────────────────────────

/** Toggle a civ in the ban selection list */
export function toggleBanSelection(civId: string, maxBans: number) {
  setBanSelections((prev) => {
    if (prev.includes(civId)) {
      return prev.filter(id => id !== civId)
    }
    if (prev.length >= maxBans) return prev
    return [...prev, civId]
  })
}

/** Clear all UI selection state (called on step advance) */
export function clearSelections() {
  setSelectedLeader(null)
  setBanSelections([])
  setSearchQuery('')
  setTagFilters(createEmptyTagFilters())
  setDetailLeaderId(null)
}

/** Toggle a single leader tag within its category filter set */
export function toggleTagFilter(tag: string) {
  const category = getTagCategory(tag)
  if (!category) return

  setTagFilters((prev) => {
    const current = prev[category]
    const hasTag = current.includes(tag)
    return {
      ...prev,
      [category]: hasTag ? current.filter(t => t !== tag) : [...current, tag],
    }
  })
}

/** Clear all selected tag filters */
export function clearTagFilters() {
  setTagFilters(createEmptyTagFilters())
}

/** Toggle the detail panel for a leader (click-to-open/close) */
export function toggleDetail(leaderId: string) {
  setDetailLeaderId(prev => prev === leaderId ? null : leaderId)
}
