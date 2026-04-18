/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createActiveDraftState } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { DraftPage } = await import('../src/client/pages/draft')

describe('Map vote UI', () => {
  beforeEach(() => {
    cleanup()
    resetUiMocks()
    uiMockState.connectionStatus = 'connected'
    uiMockState.gridOpen = true
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0 })
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteSelectedType = 'random'
    uiMockState.mapVoteSelectedScript = 'random'
    uiMockState.mapVoteVotingEndsAt = Date.now() + 30_000
  })

  test('shows map as the first phase and survives confirm into reveal', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByText('MAP VOTING')).toBeTruthy()
    expect(screen.getByText('MAP')).toBeTruthy()
    expect(screen.getByText((_, element) => /^\d+s$/.test(element?.textContent ?? ''))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Vote' }))

    await waitFor(() => expect(uiMockState.mapVotePhase).toBe('reveal'))
    expect(screen.getByText('MAP VOTING')).toBeTruthy()
  })
})
