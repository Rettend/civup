import { createEffect, createRoot, flush } from 'solid-js'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  banSelections,
  banSelectionStepToken,
  clearFfaPlacements,
  clearLeaderFavorites,
  clearResultSelections,
  clearSelections,
  clearTagFilters,
  detailLeaderId,
  decreaseUiScale,
  favoriteLeaderIds,
  ffaPlacementOrder,
  gridExpanded,
  gridViewMode,
  increaseUiScale,
  normalizeUiScale,
  pickSelections,
  resetUiScale,
  searchQuery,
  selectedLeader,
  selectedWinningTeam,
  selectWinningTeam,
  setBanSelections,
  setBanSelectionStepToken,
  setDetailLeaderId,
  setGridExpanded,
  setGridViewMode,
  setPickSelections,
  setSearchQuery,
  setSelectedLeader,
  setResultSelectionsLocked,
  setUiScale,
  tagFilters,
  toggleBanSelection,
  toggleFfaPlacement,
  toggleLeaderFavorite,
  togglePickSelection,
  toggleTagFilter,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  uiScale,
} from '../src/client/stores/ui-store'

describe('ui-store helpers', () => {
  beforeEach(() => {
    clearSelections()
    clearFfaPlacements()
    clearResultSelections()
    clearTagFilters()
    clearLeaderFavorites()
    setGridExpanded(false)
    setGridViewMode('grid')
    resetUiScale()
    flush()
  })

  test('toggleBanSelection enforces max selection count', () => {
    toggleBanSelection('civ-1', 2)
    toggleBanSelection('civ-2', 2)
    toggleBanSelection('civ-3', 2)

    flush()
    expect(banSelections()).toEqual(['civ-1', 'civ-2'])

    toggleBanSelection('civ-1', 2)
    flush()
    expect(banSelections()).toEqual(['civ-2'])
  })

  test('clearSelections resets all transient selection state', () => {
    setSelectedLeader('civ-9')
    setPickSelections(['civ-9', 'civ-10'])
    setBanSelections(['civ-1', 'civ-2'])
    setBanSelectionStepToken('draft:0:0')
    setSearchQuery('rome')
    setDetailLeaderId('civ-9')
    toggleTagFilter('econ:gold')
    toggleFfaPlacement(0)
    toggleFfaPlacement(1)
    selectWinningTeam(1)

    clearSelections()

    flush()
    expect(selectedLeader()).toBeNull()
    expect(pickSelections()).toEqual([])
    expect(banSelections()).toEqual([])
    expect(banSelectionStepToken()).toBeNull()
    expect(searchQuery()).toBe('')
    expect(detailLeaderId()).toBeNull()
    expect(tagFilters().econ).toEqual([])
    expect(tagFilters().win).toEqual([])
    expect(tagFilters().spike).toEqual([])
    expect(tagFilters().role).toEqual([])
    expect(tagFilters().other).toEqual([])
    expect(ffaPlacementOrder()).toEqual([])
    expect(selectedWinningTeam()).toBeNull()
  })

  test('toggleTagFilter updates category buckets and active count', () => {
    toggleTagFilter('econ:gold')
    flush()
    expect(tagFilters().econ).toContain('econ:gold')

    toggleTagFilter('win:science')
    flush()
    expect(tagFilters().win).toContain('win:science')

    toggleTagFilter('econ:gold')
    flush()
    expect(tagFilters().econ).not.toContain('econ:gold')

    clearTagFilters()
    flush()
    expect(tagFilters().econ).toEqual([])
    expect(tagFilters().win).toEqual([])
    expect(tagFilters().spike).toEqual([])
    expect(tagFilters().role).toEqual([])
    expect(tagFilters().other).toEqual([])
  })

  test('toggleFfaPlacement appends seats and removes only the clicked seat when toggled off', () => {
    toggleFfaPlacement(0)
    toggleFfaPlacement(3)
    toggleFfaPlacement(5)
    flush()
    expect(ffaPlacementOrder()).toEqual([0, 3, 5])

    toggleFfaPlacement(3)
    flush()
    expect(ffaPlacementOrder()).toEqual([0, 5])
  })

  test('selectWinningTeam toggles the selected team', () => {
    expect(selectedWinningTeam()).toBeNull()

    selectWinningTeam(0)
    flush()
    expect(selectedWinningTeam()).toBe(0)

    selectWinningTeam(0)
    flush()
    expect(selectedWinningTeam()).toBeNull()

    selectWinningTeam(1)
    flush()
    expect(selectedWinningTeam()).toBe(1)
  })

  test('clearResultSelections clears both team and ffa result state', () => {
    toggleFfaPlacement(1)
    toggleFfaPlacement(4)
    selectWinningTeam(0)

    clearResultSelections()

    flush()
    expect(ffaPlacementOrder()).toEqual([])
    expect(selectedWinningTeam()).toBeNull()
  })

  test('togglePickSelection keeps only one selected pick', () => {
    togglePickSelection('civ-9')
    flush()
    expect(selectedLeader()).toBe('civ-9')
    expect(pickSelections()).toEqual(['civ-9'])

    togglePickSelection('civ-10')
    flush()
    expect(pickSelections()).toEqual(['civ-10'])
    expect(selectedLeader()).toBe('civ-10')

    togglePickSelection('civ-10')
    flush()
    expect(pickSelections()).toEqual([])
    expect(selectedLeader()).toBeNull()
  })

  test('setPickSelections normalizes preview state down to one pick', () => {
    setPickSelections(['civ-9', 'civ-10'])

    flush()
    expect(pickSelections()).toEqual(['civ-9'])
    expect(selectedLeader()).toBe('civ-9')
  })

  test('persisted ui preferences keep grid layout choices', () => {
    expect(gridExpanded()).toBe(false)
    expect(gridViewMode()).toBe('grid')

    setGridExpanded(true)
    setGridViewMode('list')

    flush()
    expect(gridExpanded()).toBe(true)
    expect(gridViewMode()).toBe('list')
  })

  test('toggleLeaderFavorite keeps a unique persisted favorites list', () => {
    toggleLeaderFavorite('civ-7')
    toggleLeaderFavorite('civ-9')
    toggleLeaderFavorite('civ-7')

    flush()
    expect(favoriteLeaderIds()).toEqual(['civ-9'])

    toggleLeaderFavorite('civ-9')
    flush()
    expect(favoriteLeaderIds()).toEqual([])
  })

  test('ui scale normalizes to persisted 10% steps', () => {
    expect(uiScale()).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale(UI_SCALE_MIN - 1)).toBe(UI_SCALE_MIN)
    expect(normalizeUiScale(UI_SCALE_MAX + 1)).toBe(UI_SCALE_MAX)
    expect(normalizeUiScale(UI_SCALE_DEFAULT + UI_SCALE_STEP / 2)).toBe(UI_SCALE_DEFAULT + UI_SCALE_STEP)

    setUiScale(83)
    flush()
    expect(uiScale()).toBe(80)

    increaseUiScale()
    flush()
    expect(uiScale()).toBe(90)

    decreaseUiScale()
    decreaseUiScale()
    flush()
    expect(uiScale()).toBe(UI_SCALE_MIN)

    resetUiScale()
    flush()
    expect(uiScale()).toBe(UI_SCALE_DEFAULT)
  })

  test('updaters use staged values and synchronize the selected leader atomically', () => {
    const seen: { selected: string | null; picks: string[] }[] = []
    const dispose = createRoot(stop => {
      createEffect(
        () => ({ selected: selectedLeader(), picks: [...pickSelections()] }),
        value => {
          seen.push(value)
        },
      )
      return stop
    })
    try {
      flush()
      seen.length = 0
      setSearchQuery('a')
      setSearchQuery(prev => `${prev}b`)
      setSearchQuery(prev => `${prev}c`)
      setSelectedLeader('civ-1')
      setSelectedLeader(prev => `${prev}-updated`)
      setPickSelections(prev => [`${prev[0]}-pick`, 'ignored'])
      setGridExpanded(prev => !prev)
      setGridExpanded(prev => !prev)
      setUiScale(80)
      increaseUiScale()
      increaseUiScale()
      flush()
      expect(searchQuery()).toBe('abc')
      expect(seen).toEqual([{ selected: 'civ-1-updated-pick', picks: ['civ-1-updated-pick'] }])
      expect(gridExpanded()).toBe(false)
      expect(uiScale()).toBe(100)
    } finally {
      dispose()
    }
  })

  test('a staged result lock blocks subsequent placements and reset unlocks them', () => {
    setResultSelectionsLocked(true)
    toggleFfaPlacement(1)
    selectWinningTeam(1)
    flush()
    expect(ffaPlacementOrder()).toEqual([])
    expect(selectedWinningTeam()).toBeNull()
    clearResultSelections()
    toggleFfaPlacement(2)
    selectWinningTeam(0)
    flush()
    expect(ffaPlacementOrder()).toEqual([2])
    expect(selectedWinningTeam()).toBe(0)
  })

  test('resetting transient selections retains the saved preference shape and key', () => {
    setGridExpanded(true)
    setGridViewMode('multi-list')
    setUiScale(120)
    toggleLeaderFavorite('civ-9')
    setSelectedLeader('civ-9')
    setSearchQuery('Lincoln')
    clearSelections()
    flush()
    expect(selectedLeader()).toBeNull()
    expect(searchQuery()).toBe('')
    expect(JSON.parse(localStorage.getItem('civup:activity:ui')!)).toEqual({
      gridExpanded: true,
      gridViewMode: 'multi-list',
      favoriteLeaderIds: ['civ-9'],
      uiScale: 120,
    })
    expect(gridViewMode()).toBe('multi-list')
    expect(favoriteLeaderIds()).toEqual(['civ-9'])
  })
})
