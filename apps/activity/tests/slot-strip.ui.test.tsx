/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { render, screen } from '@solidjs/testing-library'
import { createActiveDraftState, createCompleteDraftState } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { SlotStrip } = await import('../src/client/components/draft/SlotStrip')

describe('SlotStrip UI', () => {
  beforeEach(() => {
    resetUiMocks()
    uiMockState.isMobileLayout = false
  })

  test('renders the standard two-team layout with the VS divider', () => {
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })

    render(() => <SlotStrip />)

    expect(screen.getByText('VS')).toBeTruthy()
    expect(screen.getByText('Host Player')).toBeTruthy()
    expect(screen.getByText('Player 2')).toBeTruthy()
  })

  test('renders the multi-team layout with team labels', () => {
    uiMockState.draftState = createCompleteDraftState({
      seats: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, team: 0 },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, team: 1 },
        { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null, team: 2 },
        { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null, team: 0 },
        { playerId: 'player-5', displayName: 'Player 5', avatarUrl: null, team: 1 },
        { playerId: 'player-6', displayName: 'Player 6', avatarUrl: null, team: 2 },
      ],
    })

    render(() => <SlotStrip />)

    expect(screen.getByText('Team A')).toBeTruthy()
    expect(screen.getByText('Team B')).toBeTruthy()
    expect(screen.getByText('Team C')).toBeTruthy()
  })

  test('renders the mobile FFA grid layout', () => {
    uiMockState.isMobileLayout = true
    uiMockState.draftState = createActiveDraftState({
      seats: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
        { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
        { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
      ],
    })

    render(() => <SlotStrip />)

    expect(document.querySelectorAll('.slot-cell-ffa')).toHaveLength(4)
  })

  test('shows the trophy overlay for completed two-team result mode', () => {
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })
    uiMockState.teamPlacementOrder = [0]

    render(() => <SlotStrip />)

    expect(document.querySelector('.i-ph-trophy-fill')).toBeTruthy()
  })
})
