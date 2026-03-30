import type { TagFilterState } from '~/client/lib/leader-tags'
import { createMemo, createSignal } from 'solid-js'
import { countActiveTagFilters, createEmptyTagFilters, getTagCategory } from '~/client/lib/leader-tags'
import { currentStep } from './draft-store'

// ── UI State ───────────────────────────────────────────────

const [pickSelectionsSignal, setPickSelectionsSignal] = createSignal<string[]>([])
const [selectedLeaderSignal, setSelectedLeaderSignal] = createSignal<string | null>(null)
export const pickSelections = pickSelectionsSignal
export const selectedLeader = selectedLeaderSignal
export const [searchQuery, setSearchQuery] = createSignal('')
export const [tagFilters, setTagFilters] = createSignal<TagFilterState>(createEmptyTagFilters())
export const activeTagFilterCount = createMemo(() => countActiveTagFilters(tagFilters()))
export const [banSelections, setBanSelections] = createSignal<string[]>([])
export const [isRandomSelected, setIsRandomSelected] = createSignal(false)
export const [gridOpen, setGridOpen] = createSignal(false)
export const [detailLeaderId, setDetailLeaderId] = createSignal<string | null>(null)
export const [isMiniView, setIsMiniView] = createSignal(false)
export const [isMobileLayout, setIsMobileLayout] = createSignal(typeof window !== 'undefined' ? window.innerWidth < 640 : false)
export const [ffaPlacementOrder, setFfaPlacementOrder] = createSignal<number[]>([])
export const [teamPlacementOrder, setTeamPlacementOrder] = createSignal<number[]>([])
export const selectedWinningTeam = (): number | null => teamPlacementOrder()[0] ?? null
export const [resultSelectionsLocked, setResultSelectionsLocked] = createSignal(false)

// ── Mock Swap State (UI testing only) ──────────────────────
export const [swapPendingSeat, setSwapPendingSeat] = createSignal<number | null>(null)

/** Toggle a swap request on a teammate's seat (mock) */
export function toggleSwapRequest(targetSeat: number) {
  if (swapPendingSeat() === targetSeat) {
    setSwapPendingSeat(null)
    return
  }
  setSwapPendingSeat(targetSeat)
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
  return phaseAccent() === 'red' ? 'var(--danger)' : 'var(--accent)'
})

/** Header tint class for phase mood */
export const phaseHeaderBg = createMemo(() => {
  const step = currentStep()
  if (!step) return 'bg-bg-subtle'
  return step.action === 'ban' ? 'bg-[var(--phase-ban-bg)]' : 'bg-bg-subtle'
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
  setPickSelections([])
  setBanSelections([])
  setIsRandomSelected(false)
  setSearchQuery('')
  setTagFilters(createEmptyTagFilters())
  setDetailLeaderId(null)
  clearResultSelections()
}

/** Replace the primary pick and clear any queued fallback picks. */
export function setSelectedLeader(next: string | null | ((prev: string | null) => string | null)) {
  const resolved = typeof next === 'function' ? next(selectedLeader()) : next
  setPickSelections(resolved ? [resolved] : [])
}

/** Replace the full ordered pick queue and keep the primary pick signal in sync. */
export function setPickSelections(next: string[] | ((prev: string[]) => string[])) {
  const resolved = typeof next === 'function' ? next(pickSelections()) : next
  const normalized = normalizePickSelections(resolved)
  setPickSelectionsSignal(normalized)
  setSelectedLeaderSignal(normalized[0] ?? null)
}

/** Shift/long-press toggles an ordered fallback pick queue. */
export function togglePickSelection(civId: string, extendQueue: boolean) {
  setPickSelections((prev) => {
    if (!extendQueue) {
      if (prev.length === 1 && prev[0] === civId) return []
      if (prev[0] === civId) return [civId]
      return [civId]
    }

    const index = prev.indexOf(civId)
    if (index >= 0) return prev.filter(id => id !== civId)
    return [...prev, civId]
  })
}

/** Position of a queued pick, or -1 if absent. */
export function pickSelectionIndex(civId: string): number {
  return pickSelections().indexOf(civId)
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

/** Toggle the detail panel for a leader */
export function toggleDetail(leaderId: string) {
  setDetailLeaderId(prev => prev === leaderId ? null : leaderId)
}

/** Toggle a seat in the FFA placement order */
export function toggleFfaPlacement(seatIndex: number) {
  setFfaPlacementOrder((prev) => {
    const idx = prev.indexOf(seatIndex)
    if (idx >= 0) return prev.filter(idx => idx !== seatIndex)
    return [...prev, seatIndex]
  })
}

/** Clear FFA placement order */
export function clearFfaPlacements() {
  setFfaPlacementOrder([])
}

/** Select or clear the winning team for team-mode result reporting. */
export function selectWinningTeam(team: 0 | 1) {
  setTeamPlacementOrder(prev => (prev[0] === team && prev.length === 1 ? [] : [team]))
}

/** Toggle a team in the ordered result placement list. */
export function toggleTeamPlacement(team: number) {
  setTeamPlacementOrder((prev) => {
    const index = prev.indexOf(team)
    if (index >= 0) return prev.filter(value => value !== team)
    return [...prev, team]
  })
}

/** Clear the selected winning team. */
export function clearWinningTeam() {
  setTeamPlacementOrder([])
}

/** Clear all post-draft result selection state. */
export function clearResultSelections() {
  setFfaPlacementOrder([])
  setTeamPlacementOrder([])
  setResultSelectionsLocked(false)
  setSwapPendingSeat(null)
}

function normalizePickSelections(civIds: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const civId of civIds) {
    if (typeof civId !== 'string' || seen.has(civId)) continue
    normalized.push(civId)
    seen.add(civId)
  }

  return normalized
}
