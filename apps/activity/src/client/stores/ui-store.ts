import type { TagFilterState } from '~/client/lib/leader-tags'
import { makePersisted } from '@solid-primitives/storage'
import { createMemo, createStore, snapshot } from 'solid-js'
import { countActiveTagFilters, createEmptyTagFilters, getTagCategory } from '~/client/lib/leader-tags'
import { currentStep } from './draft-store'

interface UiMemoryState {
  pickSelections: string[]
  hydratedPickPreviewToken: string | null
  selectedLeader: string | null
  searchQuery: string
  tagFilters: TagFilterState
  banSelections: string[]
  banSelectionStepToken: string | null
  isRandomSelected: boolean
  gridOpen: boolean
  detailLeaderId: string | null
  isMiniView: boolean
  isMobileLayout: boolean
  ffaPlacementOrder: number[]
  teamPlacementOrder: number[]
  resultSelectionsLocked: boolean
  hiddenDraftLeaderSelections: string[]
}

type GridViewMode = 'grid' | 'multi-list' | 'list'

export const UI_SCALE_MIN = 70
export const UI_SCALE_MAX = 140
export const UI_SCALE_STEP = 10
export const UI_SCALE_DEFAULT = 100

interface UiPersistedState {
  gridExpanded: boolean
  gridViewMode: GridViewMode
  favoriteLeaderIds: string[]
  uiScale: number
}

// ── UI State ───────────────────────────────────────────────

const [uiState, setUiState] = createStore<UiMemoryState>({
  pickSelections: [],
  hydratedPickPreviewToken: null,
  selectedLeader: null,
  searchQuery: '',
  tagFilters: createEmptyTagFilters(),
  banSelections: [],
  banSelectionStepToken: null,
  isRandomSelected: false,
  gridOpen: false,
  detailLeaderId: null,
  isMiniView: false,
  isMobileLayout: typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  ffaPlacementOrder: [],
  teamPlacementOrder: [],
  resultSelectionsLocked: false,
  hiddenDraftLeaderSelections: [],
})

const [persistedUiStateBase, setPersistedUiStateBase] = createStore<UiPersistedState>({
  gridExpanded: false,
  gridViewMode: 'grid',
  favoriteLeaderIds: [],
  uiScale: UI_SCALE_DEFAULT,
})

const [persistedUiState, setPersistedUiState] = makePersisted([persistedUiStateBase, setPersistedUiStateBase], {
  name: 'civup:activity:ui',
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  serialize: value => JSON.stringify(snapshot(value)),
  deserialize: value => normalizePersistedUiState(JSON.parse(value)),
})

export const pickSelections = () => uiState.pickSelections
export const hydratedPickPreviewToken = () => uiState.hydratedPickPreviewToken
export const selectedLeader = () => uiState.selectedLeader
export const searchQuery = () => uiState.searchQuery
export const tagFilters = () => uiState.tagFilters
export const activeTagFilterCount = createMemo(() => countActiveTagFilters(tagFilters()), { lazy: true })
export const banSelections = () => uiState.banSelections
export const banSelectionStepToken = () => uiState.banSelectionStepToken
export const isRandomSelected = () => uiState.isRandomSelected
export const gridOpen = () => uiState.gridOpen
export const gridExpanded = () => persistedUiState.gridExpanded
export const gridViewMode = () => persistedUiState.gridViewMode
export const favoriteLeaderIds = () => persistedUiState.favoriteLeaderIds
export const uiScale = () => persistedUiState.uiScale
export const detailLeaderId = () => uiState.detailLeaderId
export const isMiniView = () => uiState.isMiniView
export const isMobileLayout = () => uiState.isMobileLayout
export const ffaPlacementOrder = () => uiState.ffaPlacementOrder
export const teamPlacementOrder = () => uiState.teamPlacementOrder
export const selectedWinningTeam = (): number | null => teamPlacementOrder()[0] ?? null
export const resultSelectionsLocked = () => uiState.resultSelectionsLocked
export const hiddenDraftLeaderSelections = () => uiState.hiddenDraftLeaderSelections

export function setSearchQuery(next: string | ((prev: string) => string)) {
  setUiState(s => {
    s.searchQuery = resolveUpdate(next, s.searchQuery)
  })
}

export function setTagFilters(next: TagFilterState | ((prev: TagFilterState) => TagFilterState)) {
  setUiState(s => {
    s.tagFilters = resolveUpdate(next, s.tagFilters)
  })
}

export function setBanSelections(next: string[] | ((prev: string[]) => string[])) {
  setUiState(s => {
    s.banSelections = resolveUpdate(next, s.banSelections)
  })
}

export function setBanSelectionStepToken(next: string | null | ((prev: string | null) => string | null)) {
  setUiState(s => {
    s.banSelectionStepToken = resolveUpdate(next, s.banSelectionStepToken)
  })
}

export function setIsRandomSelected(next: boolean | ((prev: boolean) => boolean)) {
  setUiState(s => {
    s.isRandomSelected = resolveUpdate(next, s.isRandomSelected)
  })
}

export function setGridOpen(next: boolean | ((prev: boolean) => boolean)) {
  setUiState(s => {
    s.gridOpen = resolveUpdate(next, s.gridOpen)
  })
}

export function setGridExpanded(next: boolean | ((prev: boolean) => boolean)) {
  setPersistedUiState(s => {
    s.gridExpanded = resolveUpdate(next, s.gridExpanded)
  })
}

export function setGridViewMode(next: GridViewMode | ((prev: GridViewMode) => GridViewMode)) {
  setPersistedUiState(s => {
    s.gridViewMode = resolveUpdate(next, s.gridViewMode)
  })
}

export function setUiScale(next: number | ((prev: number) => number)) {
  setPersistedUiState(s => {
    s.uiScale = normalizeUiScale(resolveUpdate(next, s.uiScale))
  })
}

export function increaseUiScale() {
  setUiScale(prev => prev + UI_SCALE_STEP)
}

export function decreaseUiScale() {
  setUiScale(prev => prev - UI_SCALE_STEP)
}

export function resetUiScale() {
  setUiScale(UI_SCALE_DEFAULT)
}

export function setDetailLeaderId(next: string | null | ((prev: string | null) => string | null)) {
  setUiState(s => {
    s.detailLeaderId = resolveUpdate(next, s.detailLeaderId)
  })
}

export function setIsMiniView(next: boolean | ((prev: boolean) => boolean)) {
  setUiState(s => {
    s.isMiniView = resolveUpdate(next, s.isMiniView)
  })
}

export function setIsMobileLayout(next: boolean | ((prev: boolean) => boolean)) {
  setUiState(s => {
    s.isMobileLayout = resolveUpdate(next, s.isMobileLayout)
  })
}

export function setFfaPlacementOrder(next: number[] | ((prev: number[]) => number[])) {
  setUiState(s => {
    s.ffaPlacementOrder = resolveUpdate(next, s.ffaPlacementOrder)
  })
}

export function setTeamPlacementOrder(next: number[] | ((prev: number[]) => number[])) {
  setUiState(s => {
    s.teamPlacementOrder = resolveUpdate(next, s.teamPlacementOrder)
  })
}

export function setResultSelectionsLocked(next: boolean | ((prev: boolean) => boolean)) {
  setUiState(s => {
    s.resultSelectionsLocked = resolveUpdate(next, s.resultSelectionsLocked)
  })
}

export function toggleHiddenDraftLeaderSelection(civId: string, maxSelections: number) {
  if (civId.length === 0 || maxSelections <= 0) return
  setUiState(s => {
    const prev = s.hiddenDraftLeaderSelections
    if (prev.includes(civId)) s.hiddenDraftLeaderSelections = prev.filter(id => id !== civId)
    else if (prev.length < maxSelections) s.hiddenDraftLeaderSelections = [...prev, civId]
  })
}

export function clearHiddenDraftLeaderSelections() {
  setUiState(s => {
    s.hiddenDraftLeaderSelections = []
  })
}

// ── Phase Accent ───────────────────────────────────────────

/** Current phase accent color class based on draft step */
export const phaseAccent = createMemo(
  () => {
    const step = currentStep()
    if (!step) return 'gold' as const
    return step.action === 'ban' ? ('red' as const) : ('gold' as const)
  },
  { lazy: true },
)

/** CSS color value for the current phase accent */
export const phaseAccentColor = createMemo(
  () => {
    return phaseAccent() === 'red' ? 'var(--danger)' : 'var(--accent)'
  },
  { lazy: true },
)

/** Header tint class for phase mood */
export const phaseHeaderBg = createMemo(
  () => {
    const step = currentStep()
    if (!step) return 'bg-bg-subtle'
    return step.action === 'ban' ? 'bg-[var(--phase-ban-bg)]' : 'bg-bg-subtle'
  },
  { lazy: true },
)

// ── Actions ────────────────────────────────────────────────

/** Toggle a civ in the ban selection list */
export function toggleBanSelection(civId: string, maxBans: number) {
  setBanSelections(prev => {
    if (prev.includes(civId)) {
      return prev.filter(id => id !== civId)
    }
    if (prev.length >= maxBans) return prev
    return [...prev, civId]
  })
}

/** Clear all UI selection state (called on step advance) */
export function clearSelections() {
  setUiState(s => {
    s.pickSelections = []
    s.hydratedPickPreviewToken = null
    s.selectedLeader = null
    s.banSelections = []
    s.banSelectionStepToken = null
    s.isRandomSelected = false
    s.searchQuery = ''
    s.tagFilters = createEmptyTagFilters()
    s.detailLeaderId = null
    s.ffaPlacementOrder = []
    s.teamPlacementOrder = []
    s.resultSelectionsLocked = false
  })
}

/** Replace the single selected pick. */
export function setSelectedLeader(next: string | null | ((prev: string | null) => string | null)) {
  setUiState(s => {
    const resolved = resolveUpdate(next, s.selectedLeader)
    s.pickSelections = resolved ? [resolved] : []
    s.selectedLeader = resolved || null
  })
}

/** Replace the current pick selection and keep the primary pick signal in sync. */
export function setPickSelections(next: string[] | ((prev: string[]) => string[])) {
  setUiState(s => {
    const normalized = normalizePickSelections(resolveUpdate(next, s.pickSelections))
    s.pickSelections = normalized
    s.selectedLeader = normalized[0] ?? null
  })
}

/** Marks the draft init, step, and seat whose local pick selection was hydrated. */
export function setHydratedPickPreviewToken(token: string | null) {
  setUiState(s => {
    s.hydratedPickPreviewToken = token
  })
}

/** Toggle the single selected pick. */
export function togglePickSelection(civId: string) {
  setPickSelections(prev => {
    if (prev[0] === civId) return []
    return [civId]
  })
}

/** Toggle a single leader tag within its category filter set */
export function toggleTagFilter(tag: string) {
  const category = getTagCategory(tag)
  if (!category) return

  setUiState(s => {
    const current = s.tagFilters[category]
    s.tagFilters[category] = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag]
  })
}

/** Clear all selected tag filters */
export function clearTagFilters() {
  setTagFilters(createEmptyTagFilters())
}

/** Toggle the detail panel for a leader */
export function toggleDetail(leaderId: string) {
  setDetailLeaderId(prev => (prev === leaderId ? null : leaderId))
}

/** Return whether this leader is persisted as a favorite. */
export function isLeaderFavorited(leaderId: string): boolean {
  return favoriteLeaderIds().includes(leaderId)
}

/** Toggle a leader in the persisted favorites list. */
export function toggleLeaderFavorite(leaderId: string) {
  setPersistedUiState(s => {
    const prev = s.favoriteLeaderIds
    s.favoriteLeaderIds = prev.includes(leaderId)
      ? prev.filter(id => id !== leaderId)
      : normalizeIdList([...prev, leaderId])
  })
}

/** Clear all persisted favorite leaders. */
export function clearLeaderFavorites() {
  setPersistedUiState(s => {
    s.favoriteLeaderIds = []
  })
}

/** Toggle a seat in the FFA placement order */
export function toggleFfaPlacement(seatIndex: number) {
  setUiState(s => {
    if (s.resultSelectionsLocked) return
    const prev = s.ffaPlacementOrder
    s.ffaPlacementOrder = prev.includes(seatIndex) ? prev.filter(value => value !== seatIndex) : [...prev, seatIndex]
  })
}

/** Clear FFA placement order */
export function clearFfaPlacements() {
  setFfaPlacementOrder([])
}

/** Select or clear the winning team for team-mode result reporting. */
export function selectWinningTeam(team: 0 | 1) {
  setUiState(s => {
    if (s.resultSelectionsLocked) return
    s.teamPlacementOrder = s.teamPlacementOrder[0] === team && s.teamPlacementOrder.length === 1 ? [] : [team]
  })
}

/** Toggle a team in the ordered result placement list. */
export function toggleTeamPlacement(team: number) {
  setUiState(s => {
    if (s.resultSelectionsLocked) return
    const prev = s.teamPlacementOrder
    const index = prev.indexOf(team)
    s.teamPlacementOrder = index >= 0 ? prev.filter(value => value !== team) : [...prev, team]
  })
}

/** Clear the selected winning team. */
export function clearWinningTeam() {
  setTeamPlacementOrder([])
}

/** Clear all post-draft result selection state. */
export function clearResultSelections() {
  setUiState(s => {
    s.ffaPlacementOrder = []
    s.teamPlacementOrder = []
    s.resultSelectionsLocked = false
  })
}

function resolveUpdate<T>(next: T | ((prev: T) => T), prev: T): T {
  return typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
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

export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_SCALE_DEFAULT
  const stepped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped))
}

function normalizePersistedUiState(value: unknown): UiPersistedState {
  if (!value || typeof value !== 'object') {
    return { gridExpanded: false, gridViewMode: 'grid', favoriteLeaderIds: [], uiScale: UI_SCALE_DEFAULT }
  }

  const record = value as Record<string, unknown>
  const gridExpanded = record.gridExpanded === true
  const gridViewMode: GridViewMode =
    record.gridViewMode === 'list' ? 'list' : record.gridViewMode === 'multi-list' ? 'multi-list' : 'grid'
  const favoriteLeaderIds = Array.isArray(record.favoriteLeaderIds) ? normalizeIdList(record.favoriteLeaderIds) : []
  const uiScale = normalizeUiScale(record.uiScale)

  return {
    gridExpanded,
    gridViewMode,
    favoriteLeaderIds,
    uiScale,
  }
}
