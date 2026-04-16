/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'
import { createJoinEligibility, createLobbySnapshot, createWaitingDraftState } from './ui-fixtures'

const { DraftSetupPage } = await import('../src/client/pages/draft-setup/DraftSetupPage')

const onLobbyStarted = mock(() => {})

describe('DraftSetupPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    uiMockState.draftState = createWaitingDraftState()
    onLobbyStarted.mockClear()
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

    cleanup()
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

  test('lets the host update real config toggles and numeric fields in a 2v2 lobby', async () => {
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

    fireEvent.click(screen.getByRole('switch', { name: 'Blind Bans' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Random draft' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Duplicate leaders' }))

    const leadersInput = screen.getByRole('spinbutton', { name: 'Leaders' })
    fireEvent.input(leadersInput, { target: { value: '12' } })
    fireEvent.blur(leadersInput)

    const banInput = screen.getByRole('spinbutton', { name: 'Ban Timer (minutes)' })
    fireEvent.input(banInput, { target: { value: '2' } })
    fireEvent.blur(banInput)

    const pickInput = screen.getByRole('spinbutton', { name: 'Pick Timer (minutes)' })
    fireEvent.input(pickInput, { target: { value: '3' } })
    fireEvent.blur(pickInput)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.length).toBeGreaterThanOrEqual(6))

    const patches = storeSpies.updateLobbyConfig.mock.calls.map(call => call[3] as Record<string, unknown>)
    expect(patches.some(patch => patch.blindBans === false)).toBe(true)
    expect(patches.some(patch => patch.randomDraft === true)).toBe(true)
    expect(patches.some(patch => patch.duplicateFactions === true)).toBe(true)
    expect(patches.some(patch => patch.leaderPoolSize === 12)).toBe(true)
    expect(patches.some(patch => patch.banTimerSeconds === 120)).toBe(true)
    expect(patches.some(patch => patch.pickTimerSeconds === 180)).toBe(true)

    cleanup()
    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Red Death' }))

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => (patch as Record<string, unknown>).redDeath === true && patch.targetSize === 10)).toBe(true))
  })

  test('covers the host 2v2 extra-team toggle flow', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Add two extra teams' }))

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => patch.targetSize === 8)).toBe(true))
  })

  test('covers host lobby actions and non-host read-only config states through the page shell', async () => {
    render(() => <DraftSetupPage
      lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      onLobbyStarted={onLobbyStarted}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Randomize teams' }))
    await waitFor(() => expect(storeSpies.arrangeLobbySlots).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1', 'randomize'))

    fireEvent.click(screen.getByRole('button', { name: 'Auto-balance teams' }))
    await waitFor(() => expect(storeSpies.arrangeLobbySlots).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1', 'balance'))

    fireEvent.click(screen.getByRole('button', { name: 'Start Draft' }))
    await waitFor(() => expect(storeSpies.startLobbyDraft).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1'))
    expect(onLobbyStarted).toHaveBeenCalledWith('match-1', 'steam://joinlobby/289070/example', 'room-token')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Lobby' }))
    await waitFor(() => expect(storeSpies.cancelLobby).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1'))

    cleanup()
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'

    render(() => <DraftSetupPage lobby={createLobbySnapshot({ mode: '2v2' })} />)

    expect(screen.getByText('Waiting for host')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Blind Bans' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start Draft' })).toBeNull()
    expect(screen.getByText('Blind bans')).toBeTruthy()
    expect(screen.getByText('Random draft')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave Lobby' })).toBeTruthy()
  })
})
