/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@solidjs/testing-library'
import { resetUiMocks, uiMockState } from './ui-mocks'
import { createActiveDraftState, createCancelledDraftState, createCompleteDraftState, createWaitingDraftState } from './ui-fixtures'

const onSwitchTarget = mock(() => {})

const { DraftPage } = await import('../src/client/pages/draft/DraftPage')

describe('DraftPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSwitchTarget.mockClear()
  })

  test('shows the connecting shell', () => {
    uiMockState.connectionStatus = 'connecting'

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Joining draft room...')).toBeTruthy()
  })

  test('shows the reconnecting shell before draft state hydrates', () => {
    uiMockState.connectionStatus = 'reconnecting'

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Reconnecting to draft room...')).toBeTruthy()
  })

  test('shows the auto-start splash for the host waiting branch', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createWaitingDraftState()
    uiMockState.draftHostId = 'host-1'
    uiMockState.userId = 'host-1'

    render(() => <DraftPage matchId="match-1" autoStart steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Starting draft...')).toBeTruthy()
  })

  test('shows the waiting draft setup shell when auto-start is not active', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createWaitingDraftState()

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByRole('heading', { name: 'Draft Setup' })).toBeTruthy()
  })

  test('shows the active draft shell with reconnect banner in the background reconnect case', () => {
    uiMockState.connectionStatus = 'reconnecting'
    uiMockState.timerEndsAt = Date.now() + 30_000
    uiMockState.gridOpen = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByText('Host Player')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand leader grid' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
    expect(screen.getByText('Reconnecting...')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lobby Overview' })).toBeTruthy()
  })

  test('shows the complete draft shell even after a connection error', () => {
    uiMockState.connectionStatus = 'error'
    uiMockState.draftState = createCompleteDraftState()
    uiMockState.draftSeatIndex = 0

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('You can close the activity!')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm Result' })).toBeTruthy()
  })

  test('shows cancelled outcomes for scrubbed and reverted drafts in full and mini layouts', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createCancelledDraftState('scrub')

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByText('Session Closed')).toBeTruthy()
    expect(screen.getByText('Match Scrubbed')).toBeTruthy()

    uiMockState.isMiniView = true
    uiMockState.draftState = createCancelledDraftState('revert')
    document.body.innerHTML = ''
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('Draft Reverted')).toBeTruthy()
  })
})
