/** @jsxImportSource solid-js */

import { render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createActiveDraftState, createCompleteDraftState } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'

const onSwitchTarget = mock(() => {})

const { DraftHeader } = await import('../src/client/components/draft/DraftHeader')

describe('DraftHeader UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSwitchTarget.mockClear()
  })

  test('shows active host controls, overview navigation, and confirmation-gated revert or scrub actions', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.timerEndsAt = Date.now() + 30_000
    uiMockState.draftState = createActiveDraftState({
      currentStepIndex: 1,
      bans: [
        { seatIndex: 0, civId: 'america', stepIndex: 0 },
        { seatIndex: 1, civId: 'rome', stepIndex: 0 },
      ],
      formatId: '2v2',
    })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    await user.click(screen.getByRole('button', { name: 'Lobby Overview' }))
    expect(onSwitchTarget).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Revert' }))
    expect(storeSpies.sendRevert).toHaveBeenCalledTimes(0)

    await user.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Scrub' }))
    expect(storeSpies.sendScrub).toHaveBeenCalledTimes(0)

    await user.click(screen.getByRole('button', { name: 'Scrub' }))
    await waitFor(() => expect(storeSpies.sendScrub).toHaveBeenCalledTimes(1))
  })

  test('shows host controls during map voting while the draft is still waiting', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteVotingEndsAt = Date.now() + 30_000

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    await user.click(screen.getByRole('button', { name: 'Revert' }))
    await user.click(screen.getByRole('button', { name: 'Revert' }))

    await waitFor(() => expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Scrub' })).toBeTruthy()
  })

  test('uses a shared desktop center cluster for the active phase badge and host actions', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })
    uiMockState.timerEndsAt = Date.now() + 30_000
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'lakes'

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    const cluster = screen.getByTestId('draft-header-desktop-phase-cluster')
    const leftCluster = cluster.querySelector('[data-testid="draft-header-desktop-phase-cluster-left"]') as HTMLElement
    const rightCluster = cluster.querySelector('[data-testid="draft-header-desktop-phase-cluster-right"]') as HTMLElement

    expect(cluster.className).toContain('items-stretch')
    expect(leftCluster.className).toContain('items-center')
    expect(rightCluster.className).toContain('items-center')
    expect(leftCluster.textContent).toContain('Lakes EvW')
    expect(rightCluster.textContent).toContain('Revert')
    expect(cluster.textContent).toContain('Pick Phase')
  })

  test('keeps host controls available during map-vote reveal', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteRevealEndsAt = Date.now() + 5_000

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    await user.click(screen.getByRole('button', { name: 'Revert' }))
    await user.click(screen.getByRole('button', { name: 'Revert' }))

    await waitFor(() => expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Scrub' })).toBeTruthy()
  })

  test('shows the winning map badge on the completed result header', () => {
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'lakes'
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" />)

    expect(screen.getAllByText('Lakes EvW').length).toBeGreaterThan(0)
  })

  test('submits a completed team result for participants and reports success', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'player-2'
    uiMockState.draftHostId = 'host-1'
    uiMockState.selectedWinningTeam = 1
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" />)

    const confirmResultButton = screen.getByRole('button', { name: 'Confirm Result' })
    expect(confirmResultButton.hasAttribute('disabled')).toBe(false)

    await user.click(confirmResultButton)

    await waitFor(() => expect(storeSpies.reportMatchResult).toHaveBeenCalledWith('match-1', 'player-2', 'B'))
  })

  test('shows mobile complete controls for the host and scrubs the reported match result', async () => {
    const user = userEvent.setup()
    uiMockState.isMobileLayout = true
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.selectedWinningTeam = 0
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" />)

    await user.click(screen.getByRole('button', { name: 'Scrub' }))

    await waitFor(() => expect(storeSpies.scrubMatchResult).toHaveBeenCalledWith('match-1', 'host-1'))
  })
})
