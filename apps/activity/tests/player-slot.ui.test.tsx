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
      uiMockState.mapVoteSelectedType = 'random'
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

  test('shows every approved map during reveal and keeps zero-pick ballots truthful', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, mapType: 'east-vs-west', mapScripts: ['lakes', 'seven-seas'] },
      { seatIndex: 1, confirmed: false, mapType: 'east-vs-west', mapScripts: [] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'seven-seas'

    const { container } = render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('East vs West')).toBeTruthy()
    expect(screen.getByText('Lakes')).toBeTruthy()
    expect(screen.getByText('Seven Seas')).toBeTruthy()
    expect(screen.getByAltText('Lakes')).toBeTruthy()
    expect(screen.getByAltText('Seven Seas')).toBeTruthy()
    expect(container.querySelector('.items-start.justify-center.gap-2')?.className).toContain('flex-col')
  })

  test('lays out revealed approved maps horizontally on compact/mobile slots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.isMobileLayout = true
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, mapType: 'east-vs-west', mapScripts: ['lakes', 'seven-seas'] },
    ]

    const { container } = render(() => <PlayerSlot seatIndex={0} compact />)

    expect(container.querySelector('.items-start.justify-center.gap-2')?.className).toContain('flex-row')
  })

  test('does not show a concrete map type for zero-pick reveal ballots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: false, mapType: 'east-vs-west', mapScripts: [] },
    ]

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('No map approved')).toBeTruthy()
    expect(screen.queryByText('East vs West')).toBeNull()
  })
})
