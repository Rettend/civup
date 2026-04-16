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
})
