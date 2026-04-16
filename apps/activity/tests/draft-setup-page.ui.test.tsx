/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { render, screen } from '@solidjs/testing-library'
import { resetUiMocks, uiMockState } from './ui-mocks'
import { createJoinEligibility, createLobbySnapshot, createWaitingDraftState } from './ui-fixtures'

const { DraftSetupPage } = await import('../src/client/pages/draft-setup/DraftSetupPage')

describe('DraftSetupPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    uiMockState.draftState = createWaitingDraftState()
  })

  test('shows the host open-lobby flow with start and cancel affordances', () => {
    render(() => <DraftSetupPage lobby={createLobbySnapshot({
      mode: '2v2',
      targetSize: 4,
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
        { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
        { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
      ],
    })} />)

    expect(screen.getByRole('heading', { name: 'Draft Setup' })).toBeTruthy()
    expect(screen.getByText('Players')).toBeTruthy()
    expect(screen.getByText('Config')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start Draft' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel Lobby' }).hasAttribute('disabled')).toBe(false)
  })

  test('shows host not-ready team lobby state when more players are required', () => {
    render(() => <DraftSetupPage lobby={createLobbySnapshot({
      mode: '2v2',
      minPlayers: 4,
      targetSize: 4,
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
        null,
        null,
        null,
      ],
    })} />)

    expect(screen.getByText('Team A')).toBeTruthy()
    expect(screen.getByText('Team B')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start Draft' }).hasAttribute('disabled')).toBe(true)
  })

  test('shows a joined player waiting for the host and able to leave the lobby', () => {
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'
    uiMockState.draftHostId = 'host-1'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    expect(screen.getByText('Waiting for host')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave Lobby' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Join Lobby' })).toBeNull()
  })

  test('shows spectator join-pending and blocked-join states', () => {
    uiMockState.userId = 'spectator-1'
    uiMockState.displayName = 'Spectator'

    render(() => (
      <DraftSetupPage
        lobby={createLobbySnapshot()}
        showJoinPending
        joinEligibility={createJoinEligibility({ pendingSlot: 2 })}
      />
    ))

    const pendingJoinButton = screen.getByRole('button', { name: 'Join Lobby' })
    expect(pendingJoinButton.hasAttribute('disabled')).toBe(true)
    expect(pendingJoinButton.getAttribute('title')).toBe('Joining lobby...')

    document.body.innerHTML = ''
    render(() => (
      <DraftSetupPage
        lobby={createLobbySnapshot()}
        joinEligibility={createJoinEligibility({ canJoin: false, blockedReason: 'You are already in another open lobby.', pendingSlot: null })}
      />
    ))

    const blockedJoinButton = screen.getByRole('button', { name: 'Join Lobby' })
    expect(blockedJoinButton.hasAttribute('disabled')).toBe(true)
    expect(blockedJoinButton.getAttribute('title')).toBe('You are already in another open lobby.')
    expect(screen.getByText('Spectating')).toBeTruthy()
  })

  test('shows a spectator who can join or leave through lobby affordances', () => {
    uiMockState.userId = 'spectator-1'
    uiMockState.displayName = 'Spectator'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} joinEligibility={createJoinEligibility()} />)

    expect(screen.getByRole('button', { name: 'Join Lobby' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Spectating')).toBeTruthy()
  })

  test('renders the mini setup shell for compact future page flows', () => {
    uiMockState.isMiniView = true

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    expect(screen.getByText('Draft Setup')).toBeTruthy()
    expect(screen.getByText('2/4')).toBeTruthy()
  })
})
