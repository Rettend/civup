/** @jsxImportSource solid-js */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@solidjs/testing-library'
import { resetUiMocks, uiMockState } from './ui-mocks'
import { createActivityTargetOption } from './ui-fixtures'

const onSelect = mock(() => {})
const onResume = mock(() => {})

const { LobbyOverviewPage, activityTargetOptionKey } = await import('../src/client/pages/lobby-overview/LobbyOverviewPage')

describe('LobbyOverviewPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSelect.mockClear()
    onResume.mockClear()
  })

  test('shows the empty overview state and return affordance', () => {
    render(() => <LobbyOverviewPage options={[]} onSelect={onSelect} onResume={onResume} />)

    expect(screen.getByRole('heading', { name: 'Lobby Overview' })).toBeTruthy()
    expect(screen.getByText('No active lobbies right now')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Return' })).toBeTruthy()
  })

  test('shows populated full overview with selected target, busy state, errors, and host or joined indicators', () => {
    const hostLobby = createActivityTargetOption({ kind: 'lobby', id: 'lobby-host', lobbyId: 'lobby-host', isHost: true, participantCount: 4, targetSize: 6, mode: '2v2', updatedAt: 10 })
    const joinedDraft = createActivityTargetOption({ kind: 'match', id: 'match-joined', lobbyId: 'lobby-joined', matchId: 'match-joined', status: 'drafting', isMember: true, participantCount: 8, targetSize: 8, updatedAt: 9 })
    const activeMatch = createActivityTargetOption({ kind: 'match', id: 'match-live', lobbyId: 'lobby-live', matchId: 'match-live', status: 'active', participantCount: 6, targetSize: 6, redDeath: true, updatedAt: 8 })

    render(() => (
      <LobbyOverviewPage
        options={[hostLobby, joinedDraft, activeMatch]}
        busy
        selectedKey={activityTargetOptionKey(joinedDraft)}
        error="Could not refresh lobby list"
        onSelect={onSelect}
      />
    ))

    expect(screen.getByRole('button', { name: /Lobby/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Draft/i }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Host')).toBeTruthy()
    expect(screen.getByText('Joined')).toBeTruthy()
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Could not refresh lobby list')).toBeTruthy()
  })

  test('shows the mini overview with hidden-count, host or joined tags, and mini empty fallback', () => {
    uiMockState.isMiniView = true

    render(() => (
      <LobbyOverviewPage
        options={[
          createActivityTargetOption({ id: '1', isHost: true }),
          createActivityTargetOption({ id: '2', kind: 'match', matchId: 'm2', status: 'drafting', isMember: true }),
          createActivityTargetOption({ id: '3', kind: 'match', matchId: 'm3', status: 'active' }),
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
