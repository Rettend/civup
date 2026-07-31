import type { LeaderboardModeSnapshot } from '../../src/services/leaderboard/snapshot.ts'
import { describe, expect, test } from 'bun:test'
import { getLeaderboardRankByPlayer } from '../../src/services/activity/session-state.ts'
import { buildRankByPlayer, buildSimulatedReportedRankContext } from '../../src/services/match/ratings.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW = 200 * DAY_MS

describe('activity-adjusted rank maps', () => {
  test('uses the shared placement policy for current match ranks', () => {
    const ranks = buildRankByPlayer([
      { playerId: 'stale', mu: 40, sigma: 5, gamesPlayed: 10, lastPlayedAt: NOW - (120 * DAY_MS) },
      { playerId: 'active', mu: 39, sigma: 5, gamesPlayed: 10, lastPlayedAt: NOW },
    ], 'duel', NOW)

    expect([...ranks]).toEqual([
      ['active', 1],
      ['stale', 2],
    ])
  })

  test('simulated current reports reset participant activity but imported reports do not', () => {
    const rows = [
      row('participant', 40, NOW - (120 * DAY_MS)),
      row('challenger', 39, NOW),
    ]
    const participants = [{ playerId: 'participant', ratingAfterMu: 40, ratingAfterSigma: 5 }]

    const current = buildSimulatedReportedRankContext(rows, 'duel', participants, NOW, false)
    const imported = buildSimulatedReportedRankContext(rows, 'duel', participants, NOW, true)

    expect(current.beforeRankByPlayer.get('participant')).toBe(2)
    expect(current.afterRankByPlayer.get('participant')).toBe(1)
    expect(imported.afterRankByPlayer.get('participant')).toBe(2)
  })

  test('isolates cached ranks by snapshot identity even when metadata collides', () => {
    const staleFirst = snapshot([
      row('same-high', 40, NOW - (120 * DAY_MS)),
      row('same-low', 39, NOW),
    ])
    const activeFirst = snapshot([
      row('same-high', 40, NOW),
      row('same-low', 39, null),
    ])

    expect(getLeaderboardRankByPlayer(staleFirst, 'duel', NOW).get('same-high')).toBe(2)
    expect(getLeaderboardRankByPlayer(activeFirst, 'duel', NOW).get('same-high')).toBe(1)
  })

  test('refreshes a cached rank map at an inactivity boundary within the same UTC day', () => {
    const firstAdjustmentAt = NOW + (2 * 60 * 60 * 1_000)
    const leaderboard = snapshot([
      row('high', 40, firstAdjustmentAt - (120 * DAY_MS)),
      row('low', 39, NOW),
    ])

    expect(getLeaderboardRankByPlayer(leaderboard, 'duel', firstAdjustmentAt - 1).get('high')).toBe(1)
    expect(getLeaderboardRankByPlayer(leaderboard, 'duel', firstAdjustmentAt).get('high')).toBe(2)
  })
})

function snapshot(rows: LeaderboardModeSnapshot['rows']): LeaderboardModeSnapshot {
  return { mode: 'duel', updatedAt: 1, rows }
}

function row(playerId: string, mu: number, lastPlayedAt: number | null): LeaderboardModeSnapshot['rows'][number] {
  return {
    playerId,
    mode: 'duel',
    mu,
    sigma: 5,
    gamesPlayed: 10,
    wins: 5,
    lastPlayedAt,
  }
}
