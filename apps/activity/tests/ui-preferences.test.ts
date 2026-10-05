import { flush } from 'solid-js'
import { expect, test } from 'vitest'

// Load a real saved Solid 1 payload before the singleton store is imported.
localStorage.setItem(
  'civup:activity:ui',
  JSON.stringify({
    gridExpanded: true,
    gridViewMode: 'multi-list',
    favoriteLeaderIds: ['civ-9', 'civ-9', 42, 'civ-7'],
    uiScale: 83,
    searchQuery: 'must not be restored',
  }),
)

const ui = await import('../src/client/stores/ui-store')

test('loads existing preferences, normalizes them, and saves the same public shape', () => {
  flush()
  expect(ui.gridExpanded()).toBe(true)
  expect(ui.gridViewMode()).toBe('multi-list')
  expect(ui.favoriteLeaderIds()).toEqual(['civ-9', 'civ-7'])
  expect(ui.uiScale()).toBe(80)
  expect(ui.searchQuery()).toBe('')

  ui.increaseUiScale()
  ui.increaseUiScale()
  ui.setGridViewMode(prev => (prev === 'multi-list' ? 'list' : 'grid'))
  ui.toggleLeaderFavorite('civ-9')
  ui.toggleLeaderFavorite('civ-1')
  flush()
  expect(ui.uiScale()).toBe(100)
  expect(JSON.parse(localStorage.getItem('civup:activity:ui')!)).toEqual({
    gridExpanded: true,
    gridViewMode: 'list',
    favoriteLeaderIds: ['civ-7', 'civ-1'],
    uiScale: 100,
  })
})
