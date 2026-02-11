import { beforeEach, describe, expect, test } from 'bun:test'
import {
  banSelections,
  clearSelections,
  clearTagFilters,
  detailLeaderId,
  searchQuery,
  selectedLeader,
  setBanSelections,
  setDetailLeaderId,
  setSearchQuery,
  setSelectedLeader,
  tagFilters,
  toggleBanSelection,
  toggleTagFilter,
} from '../src/client/stores/ui-store'

describe('ui-store helpers', () => {
  beforeEach(() => {
    clearSelections()
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
})
