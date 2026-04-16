/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { render, screen } from '@solidjs/testing-library'
import { createActiveDraftState } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { LeaderGridOverlay } = await import('../src/client/components/draft/LeaderGridOverlay')

describe('LeaderGridOverlay UI', () => {
  beforeEach(() => {
    resetUiMocks()
    uiMockState.draftSeatIndex = 0
    uiMockState.gridOpen = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })
  })

  test('shows the default grid shell with search, filters, view toggles, and random selection', () => {
    render(() => <LeaderGridOverlay />)

    expect(screen.getByPlaceholderText('Search...')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand leader grid' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Grid view' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Multi-column list' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'List view' })).toBeTruthy()
    expect(screen.getAllByText('Random').length).toBeGreaterThan(0)
  })

  test('shows the expanded list-view shell when the grid is docked open', () => {
    uiMockState.gridExpanded = true
    uiMockState.gridViewMode = 'list'

    render(() => <LeaderGridOverlay />)

    expect(screen.getByRole('button', { name: 'Restore side panels' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'List view' })).toBeTruthy()
  })

  test('hides search-only controls for red death drafts', () => {
    uiMockState.isRedDeathDraft = true

    render(() => <LeaderGridOverlay />)

    expect(screen.queryByPlaceholderText('Search...')).toBeNull()
    expect(screen.queryByText('Random')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand leader grid' })).toBeTruthy()
  })
})
