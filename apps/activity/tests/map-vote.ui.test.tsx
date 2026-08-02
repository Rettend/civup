/** @jsxImportSource solid-js */

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createWaitingDraftState } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'

const { DraftPage } = await import('../src/client/pages/draft')

describe('Map vote UI', () => {
  const mapButton = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

  beforeEach(() => {
    cleanup()
    resetUiMocks()
    uiMockState.connectionStatus = 'connected'
    uiMockState.gridOpen = true
    uiMockState.draftState = createWaitingDraftState({ formatId: '3v3' })
    uiMockState.mapVotePhase = 'voting'
    uiMockState.mapVoteSelectedMaps = []
    uiMockState.mapVoteVotingEndsAt = Date.now() + 90_000
  })

  test('shows map as the first phase and confirms through the authoritative action', async () => {
    uiMockState.mapVoteSelectedMaps = ['lakes']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByText('MAP VOTING')).toBeTruthy()
    expect(screen.getByText('MAP')).toBeTruthy()
    expect(screen.queryByText('Start Position')).toBeNull()
    expect(screen.queryByText(/pick 1-3/i)).toBeNull()
    expect(screen.getAllByText((_, element) => /^\d+s$/.test(element?.textContent ?? '')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Vote' }))

    await waitFor(() => expect(storeSpies.sendMapVoteConfirm).toHaveBeenCalledTimes(1))
  })

  test('sends authoritative selection updates when cards are clicked and keeps the overlay open', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(mapButton('Lakes'))

    await waitFor(() => expect(storeSpies.sendMapVoteSelection).toHaveBeenCalled())
    expect(uiMockState.gridOpen).toBe(true)
  })

  test('offers Rich Riverlands as a standard map option', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(mapButton('Rich Riverlands'))

    await waitFor(() => expect(uiMockState.mapVoteSelectedMaps).toEqual(['rich-riverlands']))
    expect(storeSpies.sendMapVoteSelection).toHaveBeenCalledWith({ maps: ['rich-riverlands'] })
  })

  test('collapses the map vote overlay only after confirm', async () => {
    uiMockState.mapVoteSelectedMaps = ['lakes']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(uiMockState.gridOpen).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Vote' }))

    await waitFor(() => expect(uiMockState.gridOpen).toBe(false))
  })

  test('deselecting a ranked map shifts later picks up instead of resetting the chain', async () => {
    uiMockState.mapVoteSelectedMaps = ['lakes', 'seven-seas', 'rich-highlands']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(mapButton('Seven Seas'))

    await waitFor(() => expect(uiMockState.mapVoteSelectedMaps).toEqual(['lakes', 'rich-highlands']))
  })

  test('allows confirm with fewer than three ranked maps', async () => {
    uiMockState.mapVoteSelectedMaps = ['lakes', 'seven-seas']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByRole('button', { name: 'Confirm Vote' })).toHaveProperty('disabled', false)
  })

  test('caps map rankings at three picks and keeps their order stable', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(mapButton('Lakes'))
    fireEvent.click(mapButton('Seven Seas'))
    fireEvent.click(mapButton('Rich Highlands'))
    fireEvent.click(mapButton('Tilted Axis'))

    await waitFor(() => expect(uiMockState.mapVoteSelectedMaps).toEqual(['lakes', 'seven-seas', 'rich-highlands']))
    expect(storeSpies.sendMapVoteSelection).toHaveBeenCalledWith({
      maps: ['lakes', 'seven-seas', 'rich-highlands'],
    })
  })

  test('offers evw only as concrete supported map variants', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.queryByRole('button', { name: 'East vs West' })).toBeNull()
    expect(screen.getAllByText('EvW')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: /Inland Sea.*EvW|EvW.*Inland Sea/ }))

    await waitFor(() => expect(uiMockState.mapVoteSelectedMaps).toEqual(['inland-sea-east-vs-west']))
  })
})
