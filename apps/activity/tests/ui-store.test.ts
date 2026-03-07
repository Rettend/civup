import { beforeEach, describe, expect, test } from 'bun:test'
import {
  banSelections,
  clearFfaPlacements,
  clearResultSelections,
  clearSelections,
  clearTagFilters,
  detailLeaderId,
  ffaPlacementOrder,
  searchQuery,
  selectedLeader,
  selectedWinningTeam,
  selectWinningTeam,
  setBanSelections,
  setDetailLeaderId,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
  toggleBanSelection,
  toggleFfaPlacement,
  toggleTagFilter,
} from '../src/client/stores/ui-store'

describe('ui-store helpers', () => {
  beforeEach(() => {
    clearSelections()
    clearFfaPlacements()
    clearResultSelections()
    clearTagFilters()
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
    setBanSelections(['civ-1', 'civ-2'])
    setSearchQuery('rome')
    setDetailLeaderId('civ-9')
    toggleTagFilter('econ:gold')
    toggleFfaPlacement(0)
    toggleFfaPlacement(1)
    selectWinningTeam(1)

    clearSelections()

    expect(selectedLeader()).toBeNull()
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

  test('toggleFfaPlacement appends seats and truncates when re-clicking a placed seat', () => {
    toggleFfaPlacement(0)
    toggleFfaPlacement(3)
    toggleFfaPlacement(5)
    expect(ffaPlacementOrder()).toEqual([0, 3, 5])

    toggleFfaPlacement(3)
    expect(ffaPlacementOrder()).toEqual([0])
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
})
