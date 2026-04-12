import { describe, expect, test } from 'bun:test'
import type { LobbySnapshot } from '../src/client/stores'
import { buildLobbyBalanceSummary, formatLeaderPoolValue, leaderPoolSizePlaceholder } from '../src/client/lib/config-screen/helpers'

describe('leader pool helper defaults', () => {
  test('uses full FFA target size for open-lobby placeholder defaults', () => {
    expect(leaderPoolSizePlaceholder('ffa', 6, 8)).toBe('48')
  })

  test('uses full FFA target size for open-lobby formatted defaults', () => {
    expect(formatLeaderPoolValue(null, 'ffa', 6, 8)).toBe('48')
  })

  test('preserves explicit leader pool overrides', () => {
    expect(formatLeaderPoolValue(20, 'ffa', 6, 8)).toBe('20')
  })
})

describe('lobby balance summary', () => {
  test('calculates expected team winrates and uncertainty from balance ratings', () => {
    const summary = buildLobbyBalanceSummary(createLobbySnapshot([
      { playerId: 'a1', displayName: 'A1', avatarUrl: null, partyIds: [], balanceRating: { mu: 36, sigma: 2, gamesPlayed: 20 } },
      { playerId: 'b1', displayName: 'B1', avatarUrl: null, partyIds: [], balanceRating: { mu: 22, sigma: 2, gamesPlayed: 18 } },
      { playerId: 'a2', displayName: 'A2', avatarUrl: null, partyIds: [], balanceRating: { mu: 34, sigma: 2, gamesPlayed: 16 } },
      { playerId: 'b2', displayName: 'B2', avatarUrl: null, partyIds: [], balanceRating: { mu: 21, sigma: 2, gamesPlayed: 14 } },
    ]))

    expect(summary).not.toBeNull()
    expect(summary?.teams).toHaveLength(2)
    expect(summary?.teams[0]?.probability ?? 0).toBeGreaterThan(summary?.teams[1]?.probability ?? 1)
    expect(summary?.teams[0]?.uncertainty ?? 0).toBeGreaterThan(0)
    expect(summary?.lowConfidence).toBe(false)
    expect(summary?.lowConfidencePlayerCount).toBe(0)
  })

  test('flags low confidence when a slotted player has fewer than 10 games', () => {
    const summary = buildLobbyBalanceSummary(createLobbySnapshot([
      { playerId: 'a1', displayName: 'A1', avatarUrl: null, partyIds: [], balanceRating: { mu: 30, sigma: 3, gamesPlayed: 9 } },
      { playerId: 'b1', displayName: 'B1', avatarUrl: null, partyIds: [], balanceRating: { mu: 29, sigma: 3, gamesPlayed: 12 } },
      { playerId: 'a2', displayName: 'A2', avatarUrl: null, partyIds: [], balanceRating: { mu: 28, sigma: 3, gamesPlayed: 15 } },
      { playerId: 'b2', displayName: 'B2', avatarUrl: null, partyIds: [], balanceRating: { mu: 27, sigma: 3, gamesPlayed: 13 } },
    ]))

    expect(summary).not.toBeNull()
    expect(summary?.lowConfidence).toBe(true)
    expect(summary?.lowConfidencePlayerCount).toBe(1)
    expect(summary?.averageSigma).toBeCloseTo(3, 5)
  })

  test('falls back to default ratings when balance data is missing', () => {
    const summary = buildLobbyBalanceSummary(createLobbySnapshot([
      { playerId: 'a1', displayName: 'A1', avatarUrl: null, partyIds: [] },
      { playerId: 'b1', displayName: 'B1', avatarUrl: null, partyIds: [], balanceRating: { mu: 30, sigma: 4, gamesPlayed: 12 } },
    ], {
      mode: '1v1',
      targetSize: 2,
    }))

    expect(summary).not.toBeNull()
    expect(summary?.teams).toHaveLength(2)
    expect(summary?.lowConfidence).toBe(true)
    expect(summary?.lowConfidencePlayerCount).toBe(1)
  })
})

function createLobbySnapshot(
  entries: LobbySnapshot['entries'],
  overrides: Partial<Pick<LobbySnapshot, 'mode' | 'targetSize'>> = {},
): LobbySnapshot {
  return {
    id: 'lobby-1',
    revision: 1,
    mode: overrides.mode ?? '2v2',
    hostId: 'a1',
    status: 'open',
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    entries,
    minPlayers: 2,
    targetSize: overrides.targetSize ?? entries.length,
    draftConfig: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    serverDefaults: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
    },
  }
}
