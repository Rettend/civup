import { beforeEach, describe, expect, test } from 'bun:test'
import {
  banSelections,
  clearFfaPlacements,
  clearLeaderFavorites,
  clearResultSelections,
  clearSelections,
  clearTagFilters,
  detailLeaderId,
  favoriteLeaderIds,
  ffaPlacementOrder,
  gridExpanded,
  gridViewMode,
  pickSelections,
  searchQuery,
  selectedLeader,
  selectedWinningTeam,
  setGridExpanded,
  setGridViewMode,
  selectWinningTeam,
  setBanSelections,
  setDetailLeaderId,
  setPickSelections,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
  toggleBanSelection,
  toggleFfaPlacement,
  toggleLeaderFavorite,
  togglePickSelection,
  toggleTagFilter,
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
  })

  test('toggleBanSelection enforces max selection count', () => {
    toggleBanSelection('civ-1', 2)
    toggleBanSelection('civ-2', 2)
    toggleBanSelection('civ-3', 2)

    expect(banSelections()).toEqual(['civ-1', 'civ-2'])

    toggleBanSelection('civ-1', 2)
    expect(banSelections()).toEqual(['civ-2'])
  })

  test('clearSelections resets all transient selection state', () => {
    setSelectedLeader('civ-9')
    setPickSelections(['civ-9', 'civ-10'])
    setBanSelections(['civ-1', 'civ-2'])
    setSearchQuery('rome')
    setDetailLeaderId('civ-9')
    toggleTagFilter('econ:gold')
    toggleFfaPlacement(0)
    toggleFfaPlacement(1)
    selectWinningTeam(1)

    clearSelections()

    expect(selectedLeader()).toBeNull()
    expect(pickSelections()).toEqual([])
    expect(banSelections()).toEqual([])
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
    expect(tagFilters().econ).toContain('econ:gold')

    toggleTagFilter('win:science')
    expect(tagFilters().win).toContain('win:science')

    toggleTagFilter('econ:gold')
    expect(tagFilters().econ).not.toContain('econ:gold')

    clearTagFilters()
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
    expect(ffaPlacementOrder()).toEqual([0, 3, 5])

    toggleFfaPlacement(3)
    expect(ffaPlacementOrder()).toEqual([0, 5])
  })

  test('selectWinningTeam toggles the selected team', () => {
    expect(selectedWinningTeam()).toBeNull()

    selectWinningTeam(0)
    expect(selectedWinningTeam()).toBe(0)

    selectWinningTeam(0)
    expect(selectedWinningTeam()).toBeNull()

    selectWinningTeam(1)
    expect(selectedWinningTeam()).toBe(1)
  })

  test('clearResultSelections clears both team and ffa result state', () => {
    toggleFfaPlacement(1)
    toggleFfaPlacement(4)
    selectWinningTeam(0)

    clearResultSelections()

    expect(ffaPlacementOrder()).toEqual([])
    expect(selectedWinningTeam()).toBeNull()
  })

  test('togglePickSelection keeps only one selected pick', () => {
    togglePickSelection('civ-9')
    expect(selectedLeader()).toBe('civ-9')
    expect(pickSelections()).toEqual(['civ-9'])

    togglePickSelection('civ-10')
    expect(pickSelections()).toEqual(['civ-10'])
    expect(selectedLeader()).toBe('civ-10')

    togglePickSelection('civ-10')
    expect(pickSelections()).toEqual([])
    expect(selectedLeader()).toBeNull()
  })

  test('setPickSelections normalizes preview state down to one pick', () => {
    setPickSelections(['civ-9', 'civ-10'])

    expect(pickSelections()).toEqual(['civ-9'])
    expect(selectedLeader()).toBe('civ-9')
  })

  test('persisted ui preferences keep grid layout choices', () => {
    expect(gridExpanded()).toBe(false)
    expect(gridViewMode()).toBe('grid')

    setGridExpanded(true)
    setGridViewMode('list')

    expect(gridExpanded()).toBe(true)
    expect(gridViewMode()).toBe('list')
  })

  test('toggleLeaderFavorite keeps a unique persisted favorites list', () => {
    toggleLeaderFavorite('civ-7')
    toggleLeaderFavorite('civ-9')
    toggleLeaderFavorite('civ-7')

    expect(favoriteLeaderIds()).toEqual(['civ-9'])

    toggleLeaderFavorite('civ-9')
    expect(favoriteLeaderIds()).toEqual([])
  })
})
