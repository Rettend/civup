import type { TagFilterState } from '~/client/lib/leader-tags'
import { makePersisted } from '@solid-primitives/storage'
import { createMemo } from 'solid-js'
import { createStore, unwrap } from 'solid-js/store'
import { countActiveTagFilters, createEmptyTagFilters, getTagCategory } from '~/client/lib/leader-tags'
import { currentStep } from './draft-store'

interface UiMemoryState {
  pickSelections: string[]
  selectedLeader: string | null
  searchQuery: string
  tagFilters: TagFilterState
  banSelections: string[]
  isRandomSelected: boolean
  gridOpen: boolean
  detailLeaderId: string | null
  isMiniView: boolean
  isMobileLayout: boolean
  ffaPlacementOrder: number[]
  teamPlacementOrder: number[]
  resultSelectionsLocked: boolean
}

type GridViewMode = 'grid' | 'multi-list' | 'list'

interface UiPersistedState {
  gridExpanded: boolean
  gridViewMode: GridViewMode
  favoriteLeaderIds: string[]
}

// ── UI State ───────────────────────────────────────────────

const [uiState, setUiState] = createStore<UiMemoryState>({
  pickSelections: [],
  selectedLeader: null,
  searchQuery: '',
  tagFilters: createEmptyTagFilters(),
  banSelections: [],
  isRandomSelected: false,
  gridOpen: false,
  detailLeaderId: null,
  isMiniView: false,
  isMobileLayout: typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  ffaPlacementOrder: [],
  teamPlacementOrder: [],
  resultSelectionsLocked: false,
})

const [persistedUiState, setPersistedUiState] = makePersisted(createStore<UiPersistedState>({
  gridExpanded: false,
  gridViewMode: 'grid',
  favoriteLeaderIds: [],
}), {
  name: 'civup:activity:ui',
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  serialize: value => JSON.stringify(unwrap(value)),
  deserialize: value => normalizePersistedUiState(JSON.parse(value)),
})

export const pickSelections = () => uiState.pickSelections
export const selectedLeader = () => uiState.selectedLeader
export const searchQuery = () => uiState.searchQuery
export const tagFilters = () => uiState.tagFilters
export const activeTagFilterCount = createMemo(() => countActiveTagFilters(tagFilters()))
export const banSelections = () => uiState.banSelections
export const isRandomSelected = () => uiState.isRandomSelected
export const gridOpen = () => uiState.gridOpen
export const gridExpanded = () => persistedUiState.gridExpanded
export const gridViewMode = () => persistedUiState.gridViewMode
export const favoriteLeaderIds = () => persistedUiState.favoriteLeaderIds
export const detailLeaderId = () => uiState.detailLeaderId
export const isMiniView = () => uiState.isMiniView
export const isMobileLayout = () => uiState.isMobileLayout
export const ffaPlacementOrder = () => uiState.ffaPlacementOrder
export const teamPlacementOrder = () => uiState.teamPlacementOrder
export const selectedWinningTeam = (): number | null => teamPlacementOrder()[0] ?? null
export const resultSelectionsLocked = () => uiState.resultSelectionsLocked

export function setSearchQuery(next: string | ((prev: string) => string)) {
  setUiState('searchQuery', next)
}

export function setTagFilters(next: TagFilterState | ((prev: TagFilterState) => TagFilterState)) {
  setUiState('tagFilters', next)
}

export function setBanSelections(next: string[] | ((prev: string[]) => string[])) {
  setUiState('banSelections', next)
}

export function setIsRandomSelected(next: boolean | ((prev: boolean) => boolean)) {
  setUiState('isRandomSelected', next)
}

export function setGridOpen(next: boolean | ((prev: boolean) => boolean)) {
  setUiState('gridOpen', next)
}

export function setGridExpanded(next: boolean | ((prev: boolean) => boolean)) {
  setPersistedUiState('gridExpanded', next)
}

export function setGridViewMode(next: GridViewMode | ((prev: GridViewMode) => GridViewMode)) {
  setPersistedUiState('gridViewMode', next)
}

export function setDetailLeaderId(next: string | null | ((prev: string | null) => string | null)) {
  setUiState('detailLeaderId', next)
}

export function setIsMiniView(next: boolean | ((prev: boolean) => boolean)) {
  setUiState('isMiniView', next)
}

export function setIsMobileLayout(next: boolean | ((prev: boolean) => boolean)) {
  setUiState('isMobileLayout', next)
}

export function setFfaPlacementOrder(next: number[] | ((prev: number[]) => number[])) {
  setUiState('ffaPlacementOrder', next)
}

export function setTeamPlacementOrder(next: number[] | ((prev: number[]) => number[])) {
  setUiState('teamPlacementOrder', next)
}

export function setResultSelectionsLocked(next: boolean | ((prev: boolean) => boolean)) {
  setUiState('resultSelectionsLocked', next)
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

/** Replace the single selected pick. */
export function setSelectedLeader(next: string | null | ((prev: string | null) => string | null)) {
  const resolved = typeof next === 'function' ? next(selectedLeader()) : next
  setPickSelections(resolved ? [resolved] : [])
}

/** Replace the current pick selection and keep the primary pick signal in sync. */
export function setPickSelections(next: string[] | ((prev: string[]) => string[])) {
  const resolved = typeof next === 'function' ? next(pickSelections()) : next
  const normalized = normalizePickSelections(resolved)
  setUiState('pickSelections', normalized)
  setUiState('selectedLeader', normalized[0] ?? null)
}

/** Toggle the single selected pick. */
export function togglePickSelection(civId: string) {
  setPickSelections((prev) => {
    if (prev[0] === civId) return []
    return [civId]
  })
}

/** Toggle a single leader tag within its category filter set */
export function toggleTagFilter(tag: string) {
  const category = getTagCategory(tag)
  if (!category) return

  const current = tagFilters()[category]
  const hasTag = current.includes(tag)
  setUiState('tagFilters', category, hasTag ? current.filter(t => t !== tag) : [...current, tag])
}

/** Clear all selected tag filters */
export function clearTagFilters() {
  setTagFilters(createEmptyTagFilters())
}

/** Toggle the detail panel for a leader */
export function toggleDetail(leaderId: string) {
  setDetailLeaderId(prev => prev === leaderId ? null : leaderId)
}

/** Return whether this leader is persisted as a favorite. */
export function isLeaderFavorited(leaderId: string): boolean {
  return favoriteLeaderIds().includes(leaderId)
}

/** Toggle a leader in the persisted favorites list. */
export function toggleLeaderFavorite(leaderId: string) {
  setPersistedUiState('favoriteLeaderIds', (prev) => {
    if (prev.includes(leaderId)) return prev.filter(id => id !== leaderId)
    return normalizeIdList([...prev, leaderId])
  })
}

/** Clear all persisted favorite leaders. */
export function clearLeaderFavorites() {
  setPersistedUiState('favoriteLeaderIds', [])
}

/** Toggle a seat in the FFA placement order */
export function toggleFfaPlacement(seatIndex: number) {
  if (resultSelectionsLocked()) return
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
  if (resultSelectionsLocked()) return
  setTeamPlacementOrder(prev => (prev[0] === team && prev.length === 1 ? [] : [team]))
}

/** Toggle a team in the ordered result placement list. */
export function toggleTeamPlacement(team: number) {
  if (resultSelectionsLocked()) return
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
}

function normalizePickSelections(civIds: string[]): string[] {
  return normalizeIdList(civIds).slice(0, 1)
}

function normalizeIdList(ids: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    normalized.push(id)
    seen.add(id)
  }

  return normalized
}

function normalizePersistedUiState(value: unknown): UiPersistedState {
  if (!value || typeof value !== 'object') {
    return { gridExpanded: false, gridViewMode: 'grid', favoriteLeaderIds: [] }
  }

  const record = value as Record<string, unknown>
  const gridExpanded = record.gridExpanded === true
  const gridViewMode: GridViewMode = record.gridViewMode === 'list' ? 'list' : record.gridViewMode === 'multi-list' ? 'multi-list' : 'grid'
  const favoriteLeaderIds = Array.isArray(record.favoriteLeaderIds)
    ? normalizeIdList(record.favoriteLeaderIds)
    : []

  return {
    gridExpanded,
    gridViewMode,
    favoriteLeaderIds,
  }
}
