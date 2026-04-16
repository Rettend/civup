/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'
import { createActiveDraftState, createCancelledDraftState, createCompleteDraftState, createWaitingDraftState, TEST_LEADER_IDS } from './ui-fixtures'

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

  test('supports a real active draft pick flow through the page overlay', () => {
    let unmount = () => {}
    const mount = () => {
      unmount()
      ;({ unmount } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />))
    }

    uiMockState.connectionStatus = 'connected'
    uiMockState.gridOpen = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })

    mount()

    expect(screen.getByText('Host Player')).toBeTruthy()
    expect(screen.getByText('Player 2')).toBeTruthy()

    fireEvent.click(screen.getByAltText('Abraham Lincoln').closest('button')!)
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Pick' }))

    expect(storeSpies.sendPick).toHaveBeenCalledWith(TEST_LEADER_IDS.abrahamLincoln)
    expect(uiMockState.gridOpen).toBe(false)
  })

  test('shows the complete draft shell even after a connection error', () => {
    uiMockState.connectionStatus = 'error'
    uiMockState.draftState = createCompleteDraftState()
    uiMockState.draftSeatIndex = 0

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" />)

    expect(screen.getByText('You can close the activity!')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm Result' })).toBeTruthy()
  })

  test('supports selecting the winning team from the completed draft page slot strip', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByText('VS')).toBeTruthy()

    fireEvent.click(screen.getByText('Host Player'))

    expect(uiMockState.selectedWinningTeam).toBe(0)
  })

  test('shows cancelled outcomes for scrubbed and reverted drafts in full and mini layouts', () => {
    let unmount = () => {}
    const mount = (steamLobbyLink: string | null) => {
      unmount()
      ;({ unmount } = render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={steamLobbyLink} lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />))
    }

    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createCancelledDraftState('scrub')

    mount('steam://joinlobby/289070/example')

    expect(screen.getByText('Session Closed')).toBeTruthy()
    expect(screen.getByText('Match Scrubbed')).toBeTruthy()

    uiMockState.isMiniView = true
    uiMockState.draftState = createCancelledDraftState('revert')
    mount(null)

    expect(screen.getByText('Draft Reverted')).toBeTruthy()
  })

  test('transitions from the auto-start splash into the active draft shell', () => {
    let unmount = () => {}
    const mount = () => {
      unmount()
      ;({ unmount } = render(() => <DraftPage matchId="match-1" autoStart steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />))
    }

    uiMockState.connectionStatus = 'connected'
    uiMockState.draftHostId = 'host-1'
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createWaitingDraftState()

    mount()

    expect(screen.getByText('Starting draft...')).toBeTruthy()

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })
    mount()

    expect(screen.queryByText('Starting draft...')).toBeNull()
    expect(screen.getByText('Host Player')).toBeTruthy()
  })

  test('shows spectator gating when the leader grid cannot be opened', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.gridOpen = false
    uiMockState.canOpenLeaderGrid = false
    uiMockState.isSpectator = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0 })

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByText('Spectating')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open leader grid' }).hasAttribute('disabled')).toBe(true)
  })

  test('does not auto-open the leader grid for a teammate proxy-pick turn', async () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.gridOpen = false
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      currentStepIndex: 1,
      steps: [
        { action: 'ban', count: 1, timer: 60, seats: [0] },
        { action: 'pick', count: 1, timer: 90, seats: [2] },
      ],
    })

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="teamers" onSwitchTarget={onSwitchTarget} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open leader grid' })).toBeTruthy())
    expect(uiMockState.gridOpen).toBe(false)
  })

  test('shows cancel cancellation copy in the full cancelled draft screen', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createCancelledDraftState('cancel')

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByText('Draft Cancelled')).toBeTruthy()
    expect(screen.getByText('Host cancelled this draft before lock-in.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Steam link' })).toBeTruthy()
  })

  test('shows timeout cancellation copy in the full cancelled draft screen', () => {
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createCancelledDraftState('timeout')

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByText('Draft Auto-Scrubbed')).toBeTruthy()
    expect(screen.getByText('A player timed out picking a leader.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Steam link' })).toBeTruthy()
  })

  test('lets the user leave a cancelled non-scrub draft back to lobby overview', async () => {
    const user = userEvent.setup()
    uiMockState.connectionStatus = 'connected'
    uiMockState.draftState = createCancelledDraftState('cancel')

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink="steam://joinlobby/289070/example" lobbyId="lobby-1" lobbyMode="ffa" onSwitchTarget={onSwitchTarget} />)

    expect(screen.getByRole('button', { name: 'Open Steam link' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Lobby Overview' }))

    expect(onSwitchTarget).toHaveBeenCalledTimes(1)
  })
})
