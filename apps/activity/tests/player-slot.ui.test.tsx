/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createActiveDraftState, createCompleteDraftState } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'

const { PlayerSlot } = await import('../src/client/components/draft/PlayerSlot')

describe('PlayerSlot UI', () => {
  beforeEach(() => {
    resetUiMocks()
  })

  test('toggles FFA placement selection when a completed slot is clicked', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createCompleteDraftState({ formatId: 'ffa' })

    render(() => <PlayerSlot seatIndex={0} />)

    fireEvent.click(screen.getByText('Host Player'))

    expect(storeSpies.toggleFfaPlacement).toHaveBeenCalledWith(0)
  })

  test('selects the winning team in completed team drafts', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <PlayerSlot seatIndex={0} />)

    fireEvent.click(screen.getByText('Host Player'))

    expect(uiMockState.selectedWinningTeam).toBe(0)
  })

  test('shows a swap request affordance for eligible teammate slots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.canRequestSwapSeatIndices = [1]
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2', currentStepIndex: 1 })

    render(() => <PlayerSlot seatIndex={1} />)

    fireEvent.click(screen.getByRole('button', { name: 'Request swap' }))

    expect(storeSpies.sendSwapRequest).toHaveBeenCalledWith(1)
  })

  test('shows an incoming swap acceptance affordance on the focused seat', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.swapWindowOpen = true
    uiMockState.incomingSwapSeatIndices = [0]
    uiMockState.previewPicks = { 0: 'america' }
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2', currentStepIndex: 1 })

    render(() => <PlayerSlot seatIndex={0} />)

    fireEvent.click(screen.getByRole('button', { name: 'Accept swap' }))

    expect(storeSpies.sendSwapAccept).toHaveBeenCalledTimes(1)
  })

  test('keeps the map-vote breathing nodes mounted and grays out a submitted self vote', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteHasConfirmed = true

    const { container } = render(() => <PlayerSlot seatIndex={0} />)
    const mapIcon = container.querySelector('.i-ph-map-trifold-fill')

    expect(container.querySelectorAll('.anim-glow-breathe')).toHaveLength(0)
    expect(mapIcon?.className).toContain('text-fg-muted/55')
    expect(container.querySelector('.i-ph-lock-simple-fill')).toBeNull()
  })

  test('keeps the map-vote breathing phase stable across authoritative refresh remounts', () => {
    const now = Date.now()
    const realDateNow = Date.now
    Date.now = () => now

    try {
      uiMockState.userId = 'host-1'
      uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
      uiMockState.draftState.status = 'waiting'
      uiMockState.mapVotePhase = 'voting'
      uiMockState.mapVoteVotingEndsAt = Date.now() + 30_000
      uiMockState.mapVoteSelectedTypes = []
      uiMockState.mapVoteSelectedScripts = []

      const firstRender = render(() => <PlayerSlot seatIndex={0} />)
      const firstDelay = firstRender.container.querySelector('.anim-glow-breathe')?.getAttribute('style') ?? ''

      firstRender.unmount()
      uiMockState.mapVoteSelectedScripts = ['lakes']

      const secondRender = render(() => <PlayerSlot seatIndex={0} />)
      const secondDelay = secondRender.container.querySelector('.anim-glow-breathe')?.getAttribute('style') ?? ''

      expect(firstDelay).toContain('animation-delay')
      expect(secondDelay).toBe(firstDelay)
    }
    finally {
      Date.now = realDateNow
    }
  })

  test('shows only the final winning map during reveal and highlights supporting ballots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, mapTypes: ['east-vs-west'], mapScripts: ['lakes', 'seven-seas'] },
      { seatIndex: 1, confirmed: false, mapTypes: ['east-vs-west'], mapScripts: [] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'seven-seas'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'seven-seas'

    const { container } = render(() => <PlayerSlot seatIndex={0} />)
    const revealLayout = screen.getByTestId('map-vote-reveal-layout')

    expect(screen.getByText('Seven Seas')).toBeTruthy()
    expect(screen.getByAltText('Seven Seas')).toBeTruthy()
    expect(screen.getByText('East vs West')).toBeTruthy()
    expect(screen.queryByText('Lakes')).toBeNull()
    expect(screen.getByText('Seven Seas').className).toContain('text-accent')
    expect(screen.getAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(1)
    expect(revealLayout.className).toContain('justify-center')
    expect(container.querySelectorAll('.i-ph-map-trifold-fill')).toHaveLength(0)
  })

  test('shows the same final winning map on compact/mobile reveal slots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.isMobileLayout = true
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, mapTypes: ['east-vs-west'], mapScripts: ['lakes', 'seven-seas'] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'seven-seas'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'seven-seas'

    render(() => <PlayerSlot seatIndex={0} compact />)

    expect(screen.getByText('Seven Seas')).toBeTruthy()
    expect(screen.getByAltText('Seven Seas')).toBeTruthy()
    expect(screen.getByText('East vs West')).toBeTruthy()
  })

  test('shows a non-supporting ballot\'s first-ranked map instead of the final winner', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, mapTypes: ['east-vs-west'], mapScripts: ['lakes'] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'seven-seas'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'seven-seas'

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('Lakes')).toBeTruthy()
    expect(screen.getByAltText('Lakes')).toBeTruthy()
    expect(screen.getByText('East vs West')).toBeTruthy()
    expect(screen.queryByText('Seven Seas')).toBeNull()
    expect(screen.queryAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(0)
  })

  test('shows the final winner even for seats that did not cast a ballot', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: false, mapTypes: ['east-vs-west'], mapScripts: [] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'seven-seas'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'seven-seas'

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('Seven Seas')).toBeTruthy()
    expect(screen.getByAltText('Seven Seas')).toBeTruthy()
    expect(screen.getByText('East vs West')).toBeTruthy()
    expect(screen.queryAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(0)
  })
})
