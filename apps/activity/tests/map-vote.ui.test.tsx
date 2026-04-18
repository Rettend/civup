/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
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
    uiMockState.mapVoteSelectedType = 'random'
    uiMockState.mapVoteSelectedScripts = []
    uiMockState.mapVoteVotingEndsAt = Date.now() + 30_000
  })

  test('shows map as the first phase and confirms through the authoritative action', async () => {
    uiMockState.mapVoteSelectedScripts = ['lakes']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByText('MAP VOTING')).toBeTruthy()
    expect(screen.getByText('MAP')).toBeTruthy()
    expect(screen.queryByText(/pick 1-3/i)).toBeNull()
    expect(screen.getAllByText((_, element) => /^\d+s$/.test(element?.textContent ?? '')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /Confirm Vote \(1\/3\)/ }))

    await waitFor(() => expect(storeSpies.sendMapVoteConfirm).toHaveBeenCalledTimes(1))
  })

  test('sends authoritative selection updates when cards are clicked and keeps the overlay open', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(screen.getByRole('button', { name: 'East vs West' }))
    fireEvent.click(mapButton('Lakes'))

    await waitFor(() => expect(storeSpies.sendMapVoteSelection).toHaveBeenCalled())
    expect(uiMockState.gridOpen).toBe(true)
  })

  test('collapses the map vote overlay only after confirm', async () => {
    uiMockState.mapVoteSelectedScripts = ['lakes']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(uiMockState.gridOpen).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /Confirm Vote \(1\/3\)/ }))

    await waitFor(() => expect(uiMockState.gridOpen).toBe(false))
  })

  test('keeps the map vote overlay open on a no-op selection click', async () => {
    uiMockState.mapVoteSelectedType = 'east-vs-west'

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(screen.getByRole('button', { name: 'East vs West' }))

    await waitFor(() => expect(storeSpies.sendMapVoteSelection).toHaveBeenCalledTimes(0))
    expect(uiMockState.gridOpen).toBe(true)
  })

  test('shows progress and allows confirm with fewer than three map approvals', async () => {
    uiMockState.mapVoteSelectedScripts = ['lakes', 'seven-seas']

    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    expect(screen.getByRole('button', { name: /Confirm Vote \(2\/3\)/ })).toHaveProperty('disabled', false)
  })

  test('caps map approvals at three picks', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)

    fireEvent.click(mapButton('Lakes'))
    fireEvent.click(mapButton('Seven Seas'))
    fireEvent.click(mapButton('Rich Highlands'))
    fireEvent.click(mapButton('Tilted Axis'))

    await waitFor(() => expect(uiMockState.mapVoteSelectedScripts).toEqual(['lakes', 'seven-seas', 'rich-highlands']))
    expect(storeSpies.sendMapVoteSelection).toHaveBeenCalledWith({
      mapType: 'random',
      mapScripts: ['lakes', 'seven-seas', 'rich-highlands'],
    })
  })

  test('keeps random as an exclusive toggleable script option', async () => {
    render(() => <DraftPage matchId="match-1" autoStart={false} steamLobbyLink={null} lobbyId="lobby-1" lobbyMode="teamers" />)
    const randomScriptButton = () => screen.getAllByRole('button', { name: /^Random$/ })[1]!

    fireEvent.click(randomScriptButton())
    await waitFor(() => expect(uiMockState.mapVoteSelectedScripts).toEqual(['random']))

    fireEvent.click(mapButton('Lakes'))
    await waitFor(() => expect(uiMockState.mapVoteSelectedScripts).toEqual(['lakes']))

    fireEvent.click(randomScriptButton())
    await waitFor(() => expect(uiMockState.mapVoteSelectedScripts).toEqual(['random']))

    fireEvent.click(randomScriptButton())
    await waitFor(() => expect(uiMockState.mapVoteSelectedScripts).toEqual([]))
  })
})
