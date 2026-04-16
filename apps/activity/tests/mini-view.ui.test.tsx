/** @jsxImportSource solid-js */

import type { DraftState } from '@civup/game'
import { beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@solidjs/testing-library'
import { createActiveDraftState, createCancelledDraftState, createCompleteDraftState, createWaitingDraftState, TEST_LEADER_IDS } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { DraftPage } = await import('../src/client/pages/draft/DraftPage')

describe('MiniView UI', () => {
  beforeEach(() => {
    cleanup()
    resetUiMocks()
    uiMockState.connectionStatus = 'connected'
    uiMockState.isMiniView = true
  })

  test('shows minimized waiting, complete, and cancelled titles', () => {
    let unmount = () => {}
    const mount = (draftState: DraftState) => {
      uiMockState.draftState = draftState
      unmount()
      ;({ unmount } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />))
    }

    mount(createWaitingDraftState())
    expect(screen.getByText('Draft Setup')).toBeTruthy()

    mount(createCompleteDraftState())
    expect(screen.getByText('Draft Complete')).toBeTruthy()

    mount(createCancelledDraftState('cancel'))
    expect(screen.getByText('Draft Cancelled')).toBeTruthy()

    mount(createCancelledDraftState('timeout'))
    expect(screen.getByText('Auto-Scrubbed')).toBeTruthy()
  })

  test('shows the active timer in the minimized pick view', () => {
    uiMockState.timerEndsAt = Date.now() + 61_000
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 1,
      steps: [
        { action: 'ban', count: 1, timer: 60, seats: [0] },
        { action: 'pick', count: 1, timer: 90, seats: 'all' },
      ],
      submissions: {
        1: [TEST_LEADER_IDS.abrahamLincoln],
      },
    })

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Pick Phase')).toBeTruthy()
    expect(screen.getByText(/\d+:\d{2}/)).toBeTruthy()
  })

  test('renders locked picks and preview picks through the minimized draft view', () => {
    uiMockState.draftState = createWaitingDraftState({
      picks: [
        { seatIndex: 0, civId: TEST_LEADER_IDS.abrahamLincoln, stepIndex: 1 },
      ],
    })
    uiMockState.draftPreviewPicks = {
      1: [TEST_LEADER_IDS.saladinVizier],
    }

    const { container } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Host Player')).toBeTruthy()
    expect(screen.getByText('Player 2')).toBeTruthy()
    expect(container.querySelectorAll('img')).toHaveLength(2)
  })

  test('splits free-for-all seats into balanced minimized columns', () => {
    uiMockState.draftState = createWaitingDraftState({
      seats: createSeats([
        ['alpha', 'Alpha'],
        ['bravo', 'Bravo'],
        ['charlie', 'Charlie'],
        ['delta', 'Delta'],
        ['echo', 'Echo'],
      ]),
    })

    const { container } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(readColumnNames(container, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])).toEqual([
      ['Alpha', 'Bravo', 'Charlie'],
      ['Delta', 'Echo'],
    ])
  })

  test('keeps two-team drafts in separate minimized columns', () => {
    uiMockState.draftState = createWaitingDraftState({
      formatId: '2v2',
      seats: createSeats([
        ['alpha', 'Alpha', 0],
        ['bravo', 'Bravo', 1],
        ['charlie', 'Charlie', 0],
        ['delta', 'Delta', 1],
      ]),
    })

    const { container } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(readColumnNames(container, ['Alpha', 'Bravo', 'Charlie', 'Delta'])).toEqual([
      ['Alpha', 'Charlie'],
      ['Bravo', 'Delta'],
    ])
  })

  test('collapses three-team drafts into two minimized columns', () => {
    uiMockState.draftState = createWaitingDraftState({
      formatId: '3v3v3',
      seats: createSeats([
        ['alpha', 'Alpha', 0],
        ['bravo', 'Bravo', 1],
        ['charlie', 'Charlie', 2],
        ['delta', 'Delta', 0],
        ['echo', 'Echo', 1],
        ['foxtrot', 'Foxtrot', 2],
      ]),
    })

    const { container } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(readColumnNames(container, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'])).toEqual([
      ['Alpha', 'Delta', 'Bravo', 'Echo'],
      ['Charlie', 'Foxtrot'],
    ])
  })
})

function createSeats(definitions: Array<[playerId: string, displayName: string, team?: number]>) {
  return definitions.map(([playerId, displayName, team]) => ({
    playerId,
    displayName,
    avatarUrl: null,
    ...(team == null ? {} : { team }),
  }))
}

function readColumnNames(container: HTMLElement, expectedNames: string[]) {
  const grid = Array.from(container.querySelectorAll<HTMLElement>('div')).reverse().find((element) => {
    const childElements = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
    if (childElements.length < 2) return false

    return expectedNames.every(name => element.textContent?.includes(name))
      && childElements.every(child => expectedNames.some(name => child.textContent?.includes(name)))
  })

  if (!grid) throw new Error('Missing minimized seat grid')

  return Array.from(grid.children).map((column) => {
    const names: string[] = []
    const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT)

    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim()
      if (!text || !expectedNames.includes(text) || names.includes(text)) continue
      names.push(text)
    }

    return names
  })
}
