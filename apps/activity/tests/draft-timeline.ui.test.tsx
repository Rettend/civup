/** @jsxImportSource solid-js */

import { render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createActiveDraftState } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { DraftTimeline } = await import('../src/client/components/draft/DraftTimeline')

const teamSeats = [
  { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, team: 0 },
  { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, team: 1 },
  { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null, team: 0 },
  { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null, team: 1 },
]

describe('DraftTimeline UI', () => {
  beforeEach(() => {
    resetUiMocks()
  })

  test('labels the initial blind pick as a normal pick phase', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: 'default-ffa-blind-pick',
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, fallbackPickOrder: [0, 1, 2, 3] }],
    })

    render(() => <DraftTimeline />)

    expect(screen.getByText('PICK')).toBeTruthy()
    expect(screen.queryByText('BLIND PICK')).toBeNull()
  })

  test('omits repeated action text in fused team pick phases', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: 'default-2v2',
      seats: teamSeats,
      steps: [{ action: 'pick', seats: [0, 2], count: 1, timer: 120 }],
    })

    render(() => <DraftTimeline />)

    expect(screen.getAllByText('PICK T1')).toHaveLength(1)
    expect(screen.getByText('T1')).toBeTruthy()
    expect(screen.queryByText('PICK T1 | PICK T1')).toBeNull()
  })

  test('keeps simultaneous blind team ban phases generic', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: 'default-2v2',
      seats: teamSeats,
      steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
    })

    render(() => <DraftTimeline />)

    expect(screen.getByText('BAN')).toBeTruthy()
    expect(screen.queryByText('BAN T1')).toBeNull()
    expect(screen.queryByText('T2')).toBeNull()
  })

  test('shows repeated visible team ban phases with one action label', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: 'default-2v2-visible-bans',
      seats: teamSeats,
      steps: [{ action: 'ban', seats: [1], count: 2, timer: 45 }],
    })

    render(() => <DraftTimeline />)

    expect(screen.getAllByText('BAN T2')).toHaveLength(1)
    expect(screen.getByText('T2')).toBeTruthy()
  })
})
