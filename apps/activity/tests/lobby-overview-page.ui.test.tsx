/** @jsxImportSource solid-js */

import { fireEvent, render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createActivityTargetOption } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const onSelect = mock(() => {})
const onResume = mock(() => {})
const onPractice = mock(() => {})
const onExportData = mock(() => {})

const { LobbyOverviewPage, activityTargetOptionKey } = await import('../src/client/pages/lobby-overview')

describe('LobbyOverviewPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSelect.mockClear()
    onResume.mockClear()
    onPractice.mockClear()
    onExportData.mockClear()
  })

  test('shows the empty overview state and return affordance', () => {
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} onResume={onResume} />)

    expect(screen.getByRole('heading', { name: 'Lobby Overview' })).toBeTruthy()
    expect(screen.getByText('No active lobbies')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Return' })).toBeTruthy()
  })

  test('shows populated full overview with selected target, busy state, errors, and host or joined indicators', () => {
    const hostLobby = createActivityTargetOption({
      kind: 'lobby',
      id: 'lobby-host',
      lobbyId: 'lobby-host',
      isHost: true,
      participantCount: 4,
      targetSize: 6,
      mode: '2v2',
      players: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
        { playerId: 'p2', displayName: 'Cyrus', avatarUrl: null },
        { playerId: 'p3', displayName: 'Dido', avatarUrl: null },
        { playerId: 'p4', displayName: 'Hojo', avatarUrl: null },
      ],
      updatedAt: 10,
    })
    const joinedDraft = createActivityTargetOption({ kind: 'match', id: 'match-joined', lobbyId: 'lobby-joined', matchId: 'match-joined', status: 'drafting', isMember: true, participantCount: 8, targetSize: 8, updatedAt: 9 })
    const activeMatch = createActivityTargetOption({ kind: 'match', id: 'match-live', lobbyId: 'lobby-live', matchId: 'match-live', status: 'completed', participantCount: 6, targetSize: 6, redDeath: true, updatedAt: 8 })

    render(() => (
      <LobbyOverviewPage
        options={[hostLobby, joinedDraft, activeMatch]}
        busy
        selectedKey={activityTargetOptionKey(joinedDraft)}
        error="Could not refresh lobby list"
        onSelect={onSelect}
      />
    ))

    expect(screen.getByRole('button', { name: /Open 4\/6/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Drafting 8\/8/i }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Host')).toBeTruthy()
    expect(screen.getByText('Joined')).toBeTruthy()
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Cyrus')).toBeTruthy()
    expect(screen.getByText('Could not refresh lobby list')).toBeTruthy()
  })

  test('shows the practice action only in the full overview', () => {
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} onPractice={onPractice} />)

    fireEvent.click(screen.getByRole('button', { name: 'Practice' }))
    expect(onPractice).toHaveBeenCalledTimes(1)

    document.body.innerHTML = ''
    uiMockState.isMiniView = true
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} onPractice={onPractice} />)

    expect(screen.queryByRole('button', { name: 'Practice' })).toBeNull()
  })

  test('shows the responsive Player Data action only with an export capability handler', () => {
    const rendered = render(() => (
      <LobbyOverviewPage
        options={[]}
        onSelect={onSelect}
        onExportData={onExportData}
        playerDataExportState={{ status: 'idle' }}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Export player data' }))
    expect(onExportData).toHaveBeenCalledTimes(1)
    expect(rendered.container.querySelector('[data-overview-actions]')?.className).toContain('flex-wrap')

    document.body.innerHTML = ''
    render(() => (
      <LobbyOverviewPage
        options={[]}
        onSelect={onSelect}
        onExportData={onExportData}
        playerDataExportState={{ status: 'loading', phase: 'matches', players: 53, ratings: 53, matches: 12, participants: 12, bans: 3 }}
      />
    ))
    expect(screen.getByText('Loading matches: 12')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export player data' }).hasAttribute('disabled')).toBe(true)

    document.body.innerHTML = ''
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} />)
    expect(screen.queryByRole('button', { name: 'Export player data' })).toBeNull()

    document.body.innerHTML = ''
    uiMockState.isMiniView = true
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} onExportData={onExportData} />)
    expect(screen.queryByRole('button', { name: 'Export player data' })).toBeNull()
  })

  test('shows closed lobby cards under the open filter', () => {
    const openLobby = createActivityTargetOption({ id: 'open-lobby', status: 'open' })
    const closedLobby = createActivityTargetOption({ id: 'closed-lobby', status: 'closed', players: [{ playerId: 'host-closed', displayName: 'Closed Host', avatarUrl: null }] })

    render(() => <LobbyOverviewPage options={[openLobby, closedLobby]} onSelect={onSelect} />)

    expect(screen.getByText('Closed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByText('Closed Host')).toBeTruthy()
  })

  test('labels CivBlitz lobby cards like other mode variants', () => {
    render(() => (
      <LobbyOverviewPage
        options={[createActivityTargetOption({ mode: '2v2', civBlitz: true })]}
        onSelect={onSelect}
      />
    ))

    expect(screen.getByText('CivBlitz 2v2')).toBeTruthy()
    expect(screen.getByRole('button', { name: /CivBlitz 2v2 Open 2\/4/i })).toBeTruthy()
  })

  test('shows six player names before switching larger lobbies to avatar-only columns', () => {
    const sixPlayers = Array.from({ length: 6 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `Player ${index + 1}`,
      avatarUrl: null,
      team: index < 3 ? 0 : 1,
    }))

    let rendered = render(() => <LobbyOverviewPage options={[createActivityTargetOption({ mode: '3v3', participantCount: 6, targetSize: 6, players: sixPlayers })]} onSelect={onSelect} />)

    expect(screen.getByText('Player 6')).toBeTruthy()
    expect(rendered.container.querySelector('[data-overview-name-grid]')?.className).toContain('grid-cols-3')
    expect(rendered.container.querySelector('[data-overview-avatar-grid]')).toBeNull()

    document.body.innerHTML = ''
    const eightPlayers = Array.from({ length: 8 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `Player ${index + 1}`,
      avatarUrl: null,
      team: index < 4 ? 0 : 1,
    }))
    rendered = render(() => <LobbyOverviewPage options={[createActivityTargetOption({ mode: '4v4', participantCount: 8, targetSize: 8, players: eightPlayers })]} onSelect={onSelect} />)

    expect(rendered.container.querySelector('[data-overview-avatar-grid]')).toBeTruthy()
    expect(rendered.container.querySelectorAll('[data-overview-player-avatar]')).toHaveLength(8)
    expect(screen.getByRole('img', { name: 'Player 8' })).toBeTruthy()
    expect(rendered.container.querySelector('[data-overview-name-grid]')).toBeNull()
  })

  test('orders 2v2 card players left to right across teams', () => {
    const players = [
      { playerId: 'a1', displayName: 'Team A 1', avatarUrl: null, team: 0 },
      { playerId: 'a2', displayName: 'Team A 2', avatarUrl: null, team: 0 },
      { playerId: 'b1', displayName: 'Team B 1', avatarUrl: null, team: 1 },
      { playerId: 'b2', displayName: 'Team B 2', avatarUrl: null, team: 1 },
    ]

    const rendered = render(() => (
      <LobbyOverviewPage
        options={[createActivityTargetOption({ mode: '2v2', participantCount: 4, targetSize: 4, players })]}
        onSelect={onSelect}
      />
    ))

    const names = [...rendered.container.querySelectorAll('[data-overview-name-grid] > div > span:last-child')]
      .map(element => element.textContent)
    expect(names).toEqual(['Team A 1', 'Team B 1', 'Team A 2', 'Team B 2'])
  })

  test('shows the mini overview with hidden-count, host or joined tags, and mini empty fallback', () => {
    uiMockState.isMiniView = true

    render(() => (
      <LobbyOverviewPage
        options={[
          createActivityTargetOption({ id: '1', isHost: true }),
          createActivityTargetOption({ id: '2', kind: 'match', matchId: 'm2', status: 'drafting', isMember: true }),
          createActivityTargetOption({ id: '3', kind: 'match', matchId: 'm3', status: 'completed' }),
          createActivityTargetOption({ id: '4', mode: '2v2' }),
          createActivityTargetOption({ id: '5', mode: '6v6' }),
        ]}
        error="Sync lag"
        onSelect={onSelect}
      />
    ))

    expect(screen.getByText('Lobby Overview')).toBeTruthy()
    expect(screen.getByText('+1 more')).toBeTruthy()
    expect(screen.getByText('Host')).toBeTruthy()
    expect(screen.getByText('Joined')).toBeTruthy()
    expect(screen.getByText('Sync lag')).toBeTruthy()

    document.body.innerHTML = ''
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} />)
    expect(screen.getByText('No active lobbies')).toBeTruthy()
  })
})
