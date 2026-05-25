/** @jsxImportSource solid-js */

import { fireEvent, render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createActiveDraftState, createCompleteDraftState, TEST_LEADER_IDS } from './ui-fixtures'
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

  test('shows Permanent Ally FFA placement badges as pair numbers', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.permanentAlly = true
    uiMockState.ffaPlacementOrder = [0, 1, 2]
    uiMockState.draftState = createCompleteDraftState({ formatId: 'ffa' })

    const first = render(() => <PlayerSlot seatIndex={0} />)
    const second = render(() => <PlayerSlot seatIndex={1} />)
    const third = render(() => <PlayerSlot seatIndex={2} />)

    expect(first.container.innerHTML).toContain('i-ph:number-one-bold')
    expect(second.container.innerHTML).toContain('i-ph:number-one-bold')
    expect(third.container.innerHTML).toContain('i-ph:number-two-bold')
  })

  test('selects the winning team in completed team drafts', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })

    render(() => <PlayerSlot seatIndex={0} />)

    fireEvent.click(screen.getByText('Host Player'))

    expect(uiMockState.selectedWinningTeam).toBe(0)
  })

  test('swaps leaders immediately for eligible teammate slots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftSeatIndex = 0
    uiMockState.canSwapLeaderSeatIndices = [1]
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2', currentStepIndex: 1 })

    render(() => <PlayerSlot seatIndex={1} />)

    fireEvent.click(screen.getByRole('button', { name: 'Swap leaders' }))

    expect(storeSpies.sendLeaderSwap).toHaveBeenCalledWith(1)
  })

  test('only animates completed portraits for seats that just swapped', () => {
    uiMockState.draftState = createCompleteDraftState({ formatId: '2v2' })
    uiMockState.swapFlashSeatIndices = [2]

    const firstRender = render(() => <PlayerSlot seatIndex={0} />)
    const secondRender = render(() => <PlayerSlot seatIndex={2} />)

    expect(firstRender.container.querySelector('img[alt="Abraham Lincoln"]')?.className).not.toContain('anim-portrait-in')
    expect(secondRender.container.querySelector('img[alt="John Curtin"]')?.className).toContain('anim-portrait-in')
  })

  test('animates preview portraits when shown', async () => {
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.previewPicks[1] = TEST_LEADER_IDS.johnCurtin

    render(() => <PlayerSlot seatIndex={1} />)
    const image = await screen.findByAltText('John Curtin')

    expect(image.className).toContain('anim-portrait-in')
  })

  test('stacks ban preview portraits vertically in captain slots on desktop', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
    })
    uiMockState.draftPreviewBans[0] = [
      TEST_LEADER_IDS.abrahamLincoln,
      TEST_LEADER_IDS.johnCurtin,
      TEST_LEADER_IDS.montezuma,
    ]

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getAllByTestId('slot-ban-preview')).toHaveLength(3)
    expect(screen.getByAltText('Ban preview: Abraham Lincoln')).toBeTruthy()
    expect(screen.getByAltText('Ban preview: John Curtin')).toBeTruthy()
    expect(screen.getByAltText('Ban preview: Montezuma')).toBeTruthy()
    expect(screen.getByTestId('slot-ban-preview-stack').className).toContain('flex-col')
    expect(screen.queryByText('BAN 1')).toBeNull()
    expect(screen.queryByText('Abraham Lincoln')).toBeNull()
  })

  test('lays out ban preview portraits horizontally on mobile slots', () => {
    uiMockState.isMobileLayout = true
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
    })
    uiMockState.draftPreviewBans[0] = [
      TEST_LEADER_IDS.abrahamLincoln,
      TEST_LEADER_IDS.johnCurtin,
    ]

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getAllByTestId('slot-ban-preview')).toHaveLength(2)
    expect(screen.getByTestId('slot-ban-preview-stack').className).toContain('flex-row')
  })

  test('keeps ban preview images mounted when another seat submits bans', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'ban', seats: [0, 1], count: 3, timer: 120 }],
    })
    uiMockState.draftPreviewBans[0] = [
      TEST_LEADER_IDS.abrahamLincoln,
      TEST_LEADER_IDS.johnCurtin,
    ]

    render(() => <PlayerSlot seatIndex={0} />)
    const firstImage = screen.getByAltText('Ban preview: Abraham Lincoln')

    uiMockState.draftState = {
      ...uiMockState.draftState!,
      submissions: {
        ...uiMockState.draftState!.submissions,
        1: [TEST_LEADER_IDS.montezuma, TEST_LEADER_IDS.hammurabi, TEST_LEADER_IDS.saladinVizier],
      },
    }

    expect(screen.getByAltText('Ban preview: Abraham Lincoln')).toBe(firstImage)
  })

  test('keeps the map-vote breathing nodes mounted and grays out a confirmed seat during voting', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteHasConfirmed = true
    uiMockState.mapVoteConfirmedSeatIndices = [0]

    const { container } = render(() => <PlayerSlot seatIndex={0} />)
    const mapIcon = container.querySelector('.i-ph-map-trifold-fill')

    expect(container.querySelectorAll('.anim-glow-breathe')).toHaveLength(0)
    expect(mapIcon?.className).toContain('text-fg-muted/55')
    expect(container.querySelector('.i-ph-lock-simple-fill')).toBeNull()
  })

  test('stops the gold breathing glow for other confirmed seats too', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteConfirmedSeatIndices = [1]

    const { container } = render(() => <PlayerSlot seatIndex={1} />)
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
      uiMockState.mapVoteVotingEndsAt = Date.now() + 90_000
      uiMockState.mapVoteSelectedMaps = []

      const firstRender = render(() => <PlayerSlot seatIndex={0} />)
      const firstDelay = firstRender.container.querySelector('.anim-glow-breathe')?.getAttribute('style') ?? ''

      firstRender.unmount()
      uiMockState.mapVoteSelectedMaps = ['lakes']

      const secondRender = render(() => <PlayerSlot seatIndex={0} />)
      const secondDelay = secondRender.container.querySelector('.anim-glow-breathe')?.getAttribute('style') ?? ''

      expect(firstDelay).toContain('animation-delay')
      expect(secondDelay).toBe(firstDelay)
    }
    finally {
      Date.now = realDateNow
    }
  })

  test('syncs the map-vote breathing phase across seats', () => {
    const now = Date.now()
    const realDateNow = Date.now
    Date.now = () => now

    try {
      uiMockState.userId = 'host-1'
      uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
      uiMockState.draftState.status = 'waiting'
      uiMockState.mapVotePhase = 'voting'
      uiMockState.mapVoteVotingEndsAt = Date.now() + 90_000

      const firstRender = render(() => <PlayerSlot seatIndex={0} />)
      const secondRender = render(() => <PlayerSlot seatIndex={1} />)
      const firstDelay = firstRender.container.querySelector('.anim-glow-breathe')?.getAttribute('style') ?? ''
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
      { seatIndex: 0, confirmed: true, maps: ['lakes', 'inland-sea-east-vs-west'] },
      { seatIndex: 1, confirmed: false, maps: [] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'inland-sea'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'inland-sea'

    const { container } = render(() => <PlayerSlot seatIndex={0} />)
    const revealLayout = screen.getByTestId('map-vote-reveal-layout')

    expect(screen.getByText('Inland Sea')).toBeTruthy()
    expect(screen.getByText('EvW')).toBeTruthy()
    expect(screen.getByAltText('Inland Sea EvW')).toBeTruthy()
    expect(screen.queryByText('Lakes')).toBeNull()
    expect(screen.getByText('Inland Sea').className).toContain('text-accent')
    expect(screen.getByText('EvW').className).toContain('text-accent/80')
    expect(screen.getAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(1)
    expect(revealLayout.className).toContain('justify-center')
    expect(container.querySelectorAll('.i-ph-map-trifold-fill')).toHaveLength(0)
  })

  test('highlights a supporting ballot that ranked the winning map', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, maps: ['seven-seas'] },
    ]
    uiMockState.mapVoteWinningType = 'standard'
    uiMockState.mapVoteWinningScript = 'seven-seas'
    uiMockState.mapVoteWinningTypeCandidate = 'standard'
    uiMockState.mapVoteWinningScriptCandidate = 'seven-seas'

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('Seven Seas').className).toContain('text-accent')
    expect(screen.getAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(1)
  })

  test('shows the same final winning map on compact/mobile reveal slots', () => {
    uiMockState.userId = 'host-1'
    uiMockState.isMobileLayout = true
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, maps: ['lakes', 'inland-sea-east-vs-west'] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'inland-sea'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'inland-sea'

    render(() => <PlayerSlot seatIndex={0} compact />)

    expect(screen.getByText('Inland Sea')).toBeTruthy()
    expect(screen.getByText('EvW')).toBeTruthy()
    expect(screen.getByAltText('Inland Sea EvW')).toBeTruthy()
  })

  test('shows a non-supporting ballot\'s first-ranked map instead of the final winner', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: true, maps: ['lakes'] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'inland-sea'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'inland-sea'

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('Lakes')).toBeTruthy()
    expect(screen.getByAltText('Lakes')).toBeTruthy()
    expect(screen.queryByText('Inland Sea')).toBeNull()
    expect(screen.queryByText('EvW')).toBeNull()
    expect(screen.queryAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(0)
  })

  test('shows the final winner even for seats that did not cast a ballot', () => {
    uiMockState.userId = 'host-1'
    uiMockState.draftState = createActiveDraftState({ formatId: '2v2' })
    uiMockState.draftState.status = 'waiting'
    uiMockState.mapVotePhase = 'reveal'
    uiMockState.mapVoteSeatVotes = [
      { seatIndex: 0, confirmed: false, maps: [] },
    ]
    uiMockState.mapVoteWinningType = 'east-vs-west'
    uiMockState.mapVoteWinningScript = 'inland-sea'
    uiMockState.mapVoteWinningTypeCandidate = 'east-vs-west'
    uiMockState.mapVoteWinningScriptCandidate = 'inland-sea'

    render(() => <PlayerSlot seatIndex={0} />)

    expect(screen.getByText('Inland Sea')).toBeTruthy()
    expect(screen.getByText('EvW')).toBeTruthy()
    expect(screen.getByAltText('Inland Sea EvW')).toBeTruthy()
    expect(screen.queryAllByTestId('map-vote-reveal-winning-glow')).toHaveLength(0)
  })
})
