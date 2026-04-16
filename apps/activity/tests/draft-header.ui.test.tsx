/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
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
