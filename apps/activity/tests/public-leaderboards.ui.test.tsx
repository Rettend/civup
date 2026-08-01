/** @jsxImportSource solid-js */

import type { PublicLeaderboardResponse } from '@civup/utils'
import { PUBLIC_CIV_LEADERBOARD_SCOPES, PUBLIC_PLAYER_LEADERBOARD_MODES } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'

const { fireEvent, render, screen, waitFor } = await import('@solidjs/testing-library')
const { default: LeaderboardsPage } = await import('../src/client/public/LeaderboardsPage')

const PRIMARY = '1234044388733095946'
const PARTNER = '2234044388733095946'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('public leaderboard UI', () => {
  test('loads one server payload then switches categories, modes, scopes, and metrics locally', async () => {
    const requests: string[] = []
    const interactions: Array<[string, string]> = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      const serverId = new URL(url).searchParams.get('server') ?? PRIMARY
      return jsonResponse(publicPayload(serverId))
    }

    const view = render(() => <LeaderboardsPage
      fetchImpl={fetchImpl}
      initialPayload={publicPayload(PRIMARY)}
      skipInitialRequest
      onInteraction={(kind, value) => interactions.push([kind, value])}
    />)
    expect(screen.getByText('Active Player')).toBeTruthy()
    expect(screen.getByText(/There is no fabricated cross-server aggregate/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Civilizations' }))
    fireEvent.click(screen.getByRole('button', { name: 'FFA' }))
    expect(interactions).toContainEqual(['tab', 'civilizations'])
    expect(interactions).toContainEqual(['player-mode', 'ffa'])

    const serverSelect = screen.getByRole('combobox', { name: 'Supported server' })
    fireEvent.change(serverSelect, { target: { value: PARTNER } })
    await waitFor(() => expect(requests).toHaveLength(1))
    fireEvent.change(serverSelect, { target: { value: PRIMARY } })
    expect(requests).toHaveLength(1)
    expect(interactions).toContainEqual(['server', PARTNER])
    expect(interactions).toContainEqual(['server', PRIMARY])
    view.unmount()

    const civView = render(() => <LeaderboardsPage
      initialPayload={publicPayload(PRIMARY)}
      initialTab="civilizations"
      initialCivMetric="banned"
      skipInitialRequest
      onInteraction={(kind, value) => interactions.push([kind, value])}
    />)
    expect(civView.container.textContent!.indexOf('Pericles')).toBeLessThan(civView.container.textContent!.indexOf('Trajan'))
    fireEvent.click(screen.getByRole('button', { name: 'Win rate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duo' }))
    expect(interactions).toContainEqual(['civ-metric', 'winrate'])
    expect(interactions).toContainEqual(['civ-scope', 'duo'])
  })

  test('renders unavailable, empty, and upstream error states', async () => {
    const emptyView = render(() => <LeaderboardsPage initialPayload={publicPayload(PRIMARY, { emptyPlayers: true })} skipInitialRequest />)
    expect(screen.getByText('No ranked players yet')).toBeTruthy()
    emptyView.unmount()

    const missingView = render(() => <LeaderboardsPage initialPayload={publicPayload(PRIMARY, { missingPlayers: true })} skipInitialRequest />)
    expect(screen.getByText('Snapshot unavailable')).toBeTruthy()
    missingView.unmount()

    render(() => <LeaderboardsPage initialLoadState="error" skipInitialRequest />)
    expect(screen.getByText('Leaderboards unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

function publicPayload(serverId: string, options: { emptyPlayers?: boolean, missingPlayers?: boolean } = {}): PublicLeaderboardResponse {
  const players = Object.fromEntries(PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => [mode, {
    available: mode === 'duel' ? !options.missingPlayers : false,
    rows: mode === 'duel' && !options.emptyPlayers && !options.missingPlayers
      ? [{ rank: 1, displayName: serverId === PRIMARY ? 'Active Player' : 'Partner Player', rating: 1300, games: 10, wins: 6, winRatePct: 60 }]
      : [],
  }])) as PublicLeaderboardResponse['players']
  const civilizations = Object.fromEntries(PUBLIC_CIV_LEADERBOARD_SCOPES.map(scope => [scope, {
    available: true,
    historyInitialized: true,
    label: 'BBG Test',
    completedGames: 12,
    rows: [
      { civId: 'rome', name: 'Trajan', picks: 8, bans: 3, wins: 5, games: 12, pickRatePct: 66.7, winRatePct: 62.5, banRatePct: 25 },
      { civId: 'greece', name: 'Pericles', picks: 3, bans: 6, wins: 1, games: 12, pickRatePct: 25, winRatePct: 33.3, banRatePct: 50 },
    ],
  }])) as PublicLeaderboardResponse['civilizations']

  return {
    version: 1,
    generatedAt: 1_700_000_000_000,
    server: { id: serverId, ...(serverId === PRIMARY ? { displayName: 'PPL' } : { displayName: 'Partner' }) },
    servers: [{ id: PRIMARY, displayName: 'PPL' }, { id: PARTNER, displayName: 'Partner' }],
    seasonPolicy: serverId === PRIMARY ? 'ppl-seasons' : 'all-time',
    sourceSnapshots: {
      players: Object.fromEntries(PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => [mode, mode === 'duel' ? 1_700_000_000_000 : null])) as PublicLeaderboardResponse['sourceSnapshots']['players'],
      civilizations: Object.fromEntries(PUBLIC_CIV_LEADERBOARD_SCOPES.map(scope => [scope, 1_700_000_000_000])) as PublicLeaderboardResponse['sourceSnapshots']['civilizations'],
    },
    players,
    civilizations,
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
