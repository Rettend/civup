/** @jsxImportSource solid-js */

import type { CivBlitzCategoryOptions, DraftStep } from '@civup/game'
import { CIV_BLITZ_CATEGORIES, getCivBlitzRegistry, getLeader } from '@civup/game'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createActiveDraftState, TEST_LEADER_IDS } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'

const { LeaderGridOverlay } = await import('../src/client/components/draft/LeaderGridOverlay')
const { LeaderCard } = await import('../src/client/components/draft/LeaderCard')

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createCivBlitzOptions(): CivBlitzCategoryOptions {
  const pools = getCivBlitzRegistry().componentPools
  return Object.fromEntries(CIV_BLITZ_CATEGORIES.map(category => [category, pools[category].slice(0, 4)])) as CivBlitzCategoryOptions
}

describe('LeaderGridOverlay UI', () => {
  beforeEach(() => {
    cleanup()
    resetUiMocks()
    setViewportWidth(1024)
    uiMockState.draftSeatIndex = 0
    uiMockState.gridOpen = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })
  })

  function createMount() {
    let unmount = () => {}
    return () => {
      unmount()
      ;({ unmount } = render(() => <LeaderGridOverlay />))
    }
  }

  test('supports search, filters, list mode, and list selection flows', async () => {
    setViewportWidth(1440)
    const mount = createMount()

    mount()

    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    mount()
    fireEvent.input(screen.getByPlaceholderText('Search...'), { target: { value: 'Montezuma' } })
    mount()

    expect(uiMockState.searchQuery).toBe('Montezuma')
    expect(screen.getByRole('button', { name: /Montezuma/i })).toBeTruthy()

    fireEvent.input(screen.getByPlaceholderText('Search...'), { target: { value: '' } })
    mount()
    uiMockState.tagFiltersState = {
      econ: ['econ:production'],
      win: [],
      spike: [],
      role: [],
      other: [],
    }
    mount()

    expect(uiMockState.tagFiltersState.econ).toEqual(['econ:production'])
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Abraham Lincoln/i }))
    mount()

    expect(uiMockState.selectedLeaderId).toBe(TEST_LEADER_IDS.abrahamLincoln)
    expect(screen.getByRole('button', { name: 'Confirm Pick' }).hasAttribute('disabled')).toBe(false)
  })

  test('supports random toggle, direct card selection, and pick confirmation', async () => {
    const mount = createMount()

    mount()

    fireEvent.click(screen.getAllByRole('button', { name: 'Random' })[0]!)
    mount()

    expect(uiMockState.isRandomSelected).toBe(true)
    expect(uiMockState.selectedLeaderId).toBeNull()

    fireEvent.click(screen.getByAltText('Abraham Lincoln').closest('button')!)
    mount()

    expect(uiMockState.isRandomSelected).toBe(false)
    expect(uiMockState.selectedLeaderId).toBe(TEST_LEADER_IDS.abrahamLincoln)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Pick' }))

    expect(storeSpies.sendPick).toHaveBeenCalledWith(TEST_LEADER_IDS.abrahamLincoln)
    expect(uiMockState.gridOpen).toBe(false)
    expect(uiMockState.selectedLeaderId).toBeNull()
    expect(uiMockState.pickSelections).toEqual([])
  })

  test('keeps pointer tooltip stable through click focus churn', () => {
    const hoverPoints: Array<{ x: number, y: number }> = []
    let hoverLeaveCount = 0

    render(() => (
      <LeaderCard
        leader={getLeader(TEST_LEADER_IDS.abrahamLincoln)}
        onHoverMove={(_leader, x, y) => hoverPoints.push({ x, y })}
        onHoverLeave={() => { hoverLeaveCount += 1 }}
      />
    ))

    const card = screen.getByAltText('Abraham Lincoln').closest('button')!
    fireEvent.mouseMove(card, { clientX: 120, clientY: 140 })

    fireEvent.focus(card)
    fireEvent.click(card)
    fireEvent.blur(card)
    fireEvent.mouseLeave(card)

    expect(hoverPoints).toEqual([{ x: 120, y: 140 }])
    expect(hoverLeaveCount).toBe(0)

    fireEvent.mouseLeave(card, { relatedTarget: document.body })

    expect(hoverLeaveCount).toBe(1)
  })

  test('confirms a random pick from the stable available pool', () => {
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 1,
      availableCivIds: [TEST_LEADER_IDS.abrahamLincoln],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getAllByRole('button', { name: 'Random' })[0]!)
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Pick' }))

    expect(storeSpies.sendPick).toHaveBeenCalledWith(TEST_LEADER_IDS.abrahamLincoln)
    expect(uiMockState.gridOpen).toBe(false)
    expect(uiMockState.isRandomSelected).toBe(false)
  })

  test('supports ban selections and confirmation through the shared overlay flow', async () => {
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 0,
      steps: [{ action: 'ban', count: 2, timer: 60, seats: 'all' }, { action: 'pick', count: 1, timer: 90, seats: [0] }],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getByAltText('Abraham Lincoln').closest('button')!)
    mount()
    fireEvent.click(screen.getByAltText('John Curtin').closest('button')!)
    mount()

    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.abrahamLincoln, TEST_LEADER_IDS.johnCurtin])
    expect(screen.getByRole('button', { name: 'Confirm Bans (2/2)' })).toBeTruthy()

    storeSpies.sendPreview.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bans (2/2)' }))
    await wait(80)

    expect(storeSpies.sendBan).toHaveBeenCalledWith([TEST_LEADER_IDS.abrahamLincoln, TEST_LEADER_IDS.johnCurtin])
    expect(storeSpies.sendPreview.mock.calls.some(call => call[0] === 'ban' && Array.isArray(call[1]) && call[1].length === 0)).toBe(false)
    expect(uiMockState.gridOpen).toBe(false)
    expect(uiMockState.banSelections).toEqual([])
  })

  test('lets a team captain confirm a pick for a teammate through the shared overlay flow', () => {
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      currentStepIndex: 1,
      steps: [{ action: 'ban', count: 1, timer: 60, seats: [0] }, { action: 'pick', count: 1, timer: 90, seats: [2] }],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getByAltText('Abraham Lincoln').closest('button')!)
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Pick for Player 3' }))

    expect(storeSpies.sendPick).toHaveBeenCalledWith(TEST_LEADER_IDS.abrahamLincoln)
    expect(uiMockState.gridOpen).toBe(false)
  })

  test('hydrates CivBlitz selections from pick previews after remount', async () => {
    const options = createCivBlitzOptions()
    const previewIds = CIV_BLITZ_CATEGORIES.map(category => options[category][0]!)
    uiMockState.isCivBlitzDraft = true
    uiMockState.draftPreviewPicks[0] = previewIds
    uiMockState.draftState = createActiveDraftState({
      formatId: 'civblitz-2v2',
      currentStepIndex: 0,
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, civBlitz: true, civBlitzCategories: [...CIV_BLITZ_CATEGORIES] }],
      civBlitz: {
        optionCount: 4,
        excludeBbgExpanded: true,
        componentPools: getCivBlitzRegistry().componentPools,
        optionsBySeat: { 0: options },
        submissions: {},
        lockedKits: {},
        reveal: null,
        conflictBans: [],
        maxRedrafts: 2,
      },
    })

    render(() => <LeaderGridOverlay />)

    await waitFor(() => {
      const confirmButton = screen.getByRole('button', { name: /Confirm/ })
      expect(confirmButton.textContent?.replace(/\s+/g, '')).toBe('Confirm(4/4)')
      expect(confirmButton.hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }))

    expect(storeSpies.sendCivBlitzSubmit).toHaveBeenCalledWith({
      civilizationAbility: previewIds[0],
      leaderAbility: previewIds[1],
      infrastructure: previewIds[2],
      unit: previewIds[3],
    })
  })

  test('toggles the expanded overlay layout through the shared grid controls', async () => {
    const mount = createMount()

    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Expand leader grid' }))
    mount()
    expect(uiMockState.gridExpanded).toBe(true)
    expect(screen.getByRole('button', { name: 'Restore side panels' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore side panels' }))
    mount()
    expect(uiMockState.gridExpanded).toBe(false)
    expect(screen.getByRole('button', { name: 'Expand leader grid' })).toBeTruthy()
  })

  test('clears active filters from the shared toolbar', () => {
    uiMockState.gridViewMode = 'list'
    uiMockState.tagFiltersState = {
      econ: ['econ:production'],
      win: [],
      spike: [],
      role: [],
      other: [],
    }

    render(() => <LeaderGridOverlay />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(uiMockState.tagFiltersState).toEqual({
      econ: [],
      win: [],
      spike: [],
      role: [],
      other: [],
    })
  })

  test('hides search-only controls for red death drafts', () => {
    uiMockState.isRedDeathDraft = true

    render(() => <LeaderGridOverlay />)

    expect(screen.queryByPlaceholderText('Search...')).toBeNull()
    expect(screen.queryByText('Random')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand leader grid' })).toBeTruthy()
  })

  test('opens leader details from a grid card context menu and supports favorite toggling', () => {
    const mount = createMount()

    mount()

    fireEvent.contextMenu(screen.getByAltText('Abraham Lincoln').closest('button')!)
    mount()

    expect(uiMockState.detailLeaderId).toBe(TEST_LEADER_IDS.abrahamLincoln)
    fireEvent.click(screen.getByRole('button', { name: 'Favorite leader' }))
    mount()

    expect(uiMockState.favoriteLeaderIds).toEqual([TEST_LEADER_IDS.abrahamLincoln])
    expect(screen.getByRole('button', { name: 'Remove favorite' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close leader details' }))
    mount()

    expect(screen.queryByRole('button', { name: 'Remove favorite' })).toBeNull()
  })

  test('supports random ban confirmation through the shared overlay flow', () => {
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 0,
      steps: [{ action: 'ban', count: 2, timer: 60, seats: 'all' }, { action: 'pick', count: 1, timer: 90, seats: [0] }],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getAllByRole('button', { name: 'Random' })[0]!)
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bans (2/2)' }))

    expect(storeSpies.sendBan).toHaveBeenCalledTimes(1)
    const [randomBans] = storeSpies.sendBan.mock.calls[0]!
    expect(randomBans).toHaveLength(2)
    expect(new Set(randomBans).size).toBe(2)
    expect(uiMockState.gridOpen).toBe(false)
  })

  test('keeps already-picked leaders available when duplicate factions are enabled', () => {
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 1,
      duplicateFactions: true,
      picks: [{ seatIndex: 1, civId: TEST_LEADER_IDS.abrahamLincoln, stepIndex: 1 }],
      availableCivIds: [TEST_LEADER_IDS.johnCurtin],
    })

    render(() => <LeaderGridOverlay />)

    const abrahamCard = screen.getByAltText('Abraham Lincoln').closest('button') as HTMLButtonElement
    const abrahamImage = screen.getByAltText('Abraham Lincoln')

    expect(abrahamCard.hasAttribute('disabled')).toBe(false)
    expect(abrahamImage.className.includes('opacity-25')).toBe(false)

    fireEvent.click(abrahamCard)

    expect(uiMockState.selectedLeaderId).toBe(TEST_LEADER_IDS.abrahamLincoln)
  })

  test('allows random pick to reuse an already-picked leader when duplicate factions are enabled', () => {
    uiMockState.searchQuery = 'Abraham'
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 1,
      duplicateFactions: true,
      picks: [{ seatIndex: 1, civId: TEST_LEADER_IDS.abrahamLincoln, stepIndex: 1 }],
      availableCivIds: [TEST_LEADER_IDS.johnCurtin],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getAllByRole('button', { name: 'Random' })[0]!)
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Pick' }))

    expect(storeSpies.sendPick).toHaveBeenCalledWith(TEST_LEADER_IDS.abrahamLincoln)
  })

  test('keeps the overlay open on your turn but lets spectators close it from the backdrop', () => {
    render(() => <LeaderGridOverlay />)

    const backdrop = document.querySelector('[class*="bg-black/40"]') as HTMLElement

    fireEvent.click(backdrop)

    expect(uiMockState.gridOpen).toBe(true)

    uiMockState.draftSeatIndex = 1
    fireEvent.click(backdrop)

    expect(uiMockState.gridOpen).toBe(false)
  })

  test('keeps local bans when the overlay remounts during the same ban step', () => {
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 0,
      steps: [{ action: 'ban', count: 1, timer: 60, seats: [0] }, { action: 'pick', count: 1, timer: 90, seats: [0] }],
    })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getByAltText('John Curtin').closest('button')!)
    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.johnCurtin])

    mount()

    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.johnCurtin])
  })

  test('clears stale local bans when advancing to a new ban step without a preview', () => {
    const steps: DraftStep[] = [
      { action: 'ban', count: 1, timer: 60, seats: [0] },
      { action: 'ban', count: 1, timer: 60, seats: [0] },
      { action: 'pick', count: 1, timer: 90, seats: [0] },
    ]

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0, steps: [...steps] })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getByAltText('John Curtin').closest('button')!)
    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.johnCurtin])

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, steps: [...steps] })
    uiMockState.draftPreviewBans = {}

    mount()

    expect(uiMockState.banSelections).toEqual([])
  })

  test('hydrates the next ban step preview instead of keeping the previous local selection', () => {
    const steps: DraftStep[] = [
      { action: 'ban', count: 1, timer: 60, seats: [0] },
      { action: 'ban', count: 1, timer: 60, seats: [0] },
      { action: 'pick', count: 1, timer: 90, seats: [0] },
    ]

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0, steps: [...steps] })

    const mount = createMount()

    mount()

    fireEvent.click(screen.getByAltText('John Curtin').closest('button')!)
    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.johnCurtin])

    uiMockState.draftPreviewBans = { 0: [TEST_LEADER_IDS.hammurabi] }
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, steps: [...steps] })

    mount()

    expect(uiMockState.banSelections).toEqual([TEST_LEADER_IDS.hammurabi])
  })
})
