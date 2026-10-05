/** @jsxImportSource @solidjs/web */

import { screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createActiveDraftState, createCompleteDraftState, renderUi as render, TEST_LEADER_IDS } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState, updateUiMocks } from './ui-mocks'

const onSwitchTarget = vi.fn(() => {})

const { DraftHeader } = await import('../src/client/components/draft/DraftHeader')

describe('DraftHeader UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSwitchTarget.mockClear()
  })

  test('flashes on an active phase change and clears the timeout on disposal', async () => {
    vi.useFakeTimers()
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0 })
    const { container, unmount } = render(() => <DraftHeader />)
    expect(container.querySelector('.anim-phase-flash')).toBeNull()

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1 })
    expect(container.querySelector('.anim-phase-flash')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(220)
    expect(container.querySelector('.anim-phase-flash')).toBeNull()

    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 0 })
    expect(container.querySelector('.anim-phase-flash')).toBeTruthy()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('keeps active revert pending after confirmation', async () => {
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

    const revertButton = screen.getByRole('button', { name: 'Revert' }) as HTMLButtonElement
    await user.click(revertButton)
    expect(storeSpies.sendRevert).toHaveBeenCalledTimes(0)

    await user.click(revertButton)
    await waitFor(() => expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1))

    expect(revertButton.disabled).toBe(true)
    expect(revertButton.getAttribute('aria-label')).toBe('Reverting')
    await user.click(revertButton)
    await user.click(screen.getByRole('button', { name: 'Scrub' }))
    expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1)
    expect(storeSpies.sendScrub).toHaveBeenCalledTimes(0)
  })

  test('keeps active scrub pending after confirmation', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.timerEndsAt = Date.now() + 30_000
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    const scrubButton = screen.getByRole('button', { name: 'Scrub' }) as HTMLButtonElement
    await user.click(scrubButton)
    expect(storeSpies.sendScrub).toHaveBeenCalledTimes(0)

    await user.click(scrubButton)
    await waitFor(() => expect(storeSpies.sendScrub).toHaveBeenCalledTimes(1))

    expect(scrubButton.disabled).toBe(true)
    expect(scrubButton.getAttribute('aria-label')).toBe('Scrubbing')
    await user.click(scrubButton)
    await user.click(screen.getByRole('button', { name: 'Revert' }))
    expect(storeSpies.sendScrub).toHaveBeenCalledTimes(1)
    expect(storeSpies.sendRevert).toHaveBeenCalledTimes(0)
  })

  test('keeps mobile active host action pending after confirmation', async () => {
    const user = userEvent.setup()
    uiMockState.isMobileLayout = true
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.timerEndsAt = Date.now() + 30_000
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" onSwitchTarget={onSwitchTarget} />)

    const revertButton = screen.getByRole('button', { name: 'Revert' })
    await user.click(revertButton)
    await user.click(revertButton)

    await waitFor(() => expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1))
    await user.click(revertButton)
    expect(storeSpies.sendRevert).toHaveBeenCalledTimes(1)
  })

  test('shows host controls during map voting while the draft is still waiting', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })
    updateUiMocks(draft => {
      draft.draftState!.status = 'waiting'
    })
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteVotingEndsAt = Date.now() + 90_000

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
    const grid = cluster.parentElement as HTMLElement
    const leftCluster = cluster.querySelector('[data-testid="draft-header-desktop-phase-cluster-left"]') as HTMLElement
    const rightCluster = cluster.querySelector(
      '[data-testid="draft-header-desktop-phase-cluster-right"]',
    ) as HTMLElement

    expect(grid.className).toContain('pl-12')
    expect(grid.className).toContain('pr-12')
    expect(grid.className).not.toContain('px-24')
    expect(cluster.className).toContain('items-stretch')
    expect(leftCluster.className).toContain('items-center')
    expect(rightCluster.className).toContain('items-center')
    expect(leftCluster.textContent).toContain('Lakes EvW')
    expect(rightCluster.textContent).toContain('Revert')
    expect(cluster.textContent).toContain('Pick Phase')
  })

  test('shows visible pending blind bans in the team header', () => {
    uiMockState.userId = 'player-3'
    uiMockState.draftSeatIndex = 2
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
      pendingBlindBans: [
        { seatIndex: 0, civId: TEST_LEADER_IDS.abrahamLincoln, stepIndex: 0 },
        { seatIndex: 0, civId: TEST_LEADER_IDS.johnCurtin, stepIndex: 0 },
      ],
    })

    render(() => <DraftHeader steamLobbyLink="steam://joinlobby/289070/example" />)

    expect(screen.getByAltText('Abraham Lincoln')).toBeTruthy()
    expect(screen.getByAltText('John Curtin')).toBeTruthy()
  })

  test('keeps host controls available during map-vote reveal', async () => {
    const user = userEvent.setup()
    uiMockState.userId = 'host-1'
    uiMockState.draftHostId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ currentStepIndex: 1, formatId: '2v2' })
    updateUiMocks(draft => {
      draft.draftState!.status = 'waiting'
    })
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteRevealEndsAt = Date.now() + 10_000

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

    await waitFor(() => expect(storeSpies.reportMatchResult).toHaveBeenCalledTimes(1))
    expect(storeSpies.reportMatchResult.mock.calls[0]?.slice(0, 3)).toEqual(['match-1', 'player-2', 'B'])
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
    expect(storeSpies.scrubMatchResult).toHaveBeenCalledTimes(0)

    await user.click(screen.getByRole('button', { name: 'Confirm Scrub' }))

    await waitFor(() => expect(storeSpies.scrubMatchResult).toHaveBeenCalledWith('match-1', 'host-1'))
  })
})
