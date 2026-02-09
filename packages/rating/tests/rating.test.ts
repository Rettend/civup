import type { PlayerRating } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import {
  buildLeaderboard,
  calculateFfaRatings,
  calculateRatings,
  calculateTeamRatings,
  createRating,
  DISPLAY_RATING_BASE,
  DISPLAY_RATING_SCALE,
  DEFAULT_MU,
  DEFAULT_SIGMA,
  displayRating,

  predictWinProbabilities,
  seasonReset,
} from '../src/index.ts'

// ── createRating ────────────────────────────────────────────

describe('createRating', () => {
  test('creates a new player rating with defaults', () => {
    const r = createRating('player1')
    expect(r.playerId).toBe('player1')
    expect(r.mu).toBe(DEFAULT_MU)
    expect(r.sigma).toBeCloseTo(DEFAULT_SIGMA, 2)
  })
})

// ── displayRating ───────────────────────────────────────────

describe('displayRating', () => {
  test('returns base + scale*(mu - 3*sigma) for default rating', () => {
    const dr = displayRating(DEFAULT_MU, DEFAULT_SIGMA)
    expect(dr).toBeCloseTo(DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * (DEFAULT_MU - 3 * DEFAULT_SIGMA), 2)
    // ~600 + (25 - 25) = 600
    expect(dr).toBeCloseTo(DISPLAY_RATING_BASE, 0)
  })

  test('returns positive value for skilled player', () => {
    // After many games, sigma shrinks and mu grows
    const dr = displayRating(30, 3)
    expect(dr).toBeCloseTo(DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * 21, 0)
  })

  test('returns below base for very uncertain player', () => {
    const dr = displayRating(20, 10)
    expect(dr).toBeLessThan(DISPLAY_RATING_BASE)
  })
})

// ── calculateTeamRatings (Duel) ─────────────────────────────

describe('calculateTeamRatings — duel', () => {
  test('winner gains rating, loser loses rating', () => {
    const winner: PlayerRating = { playerId: 'p1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const loser: PlayerRating = { playerId: 'p2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }

    const updates = calculateTeamRatings([
      { players: [winner] }, // 1st place
      { players: [loser] }, // 2nd place
    ])

    expect(updates).toHaveLength(2)

    const winnerUpdate = updates.find(u => u.playerId === 'p1')!
    const loserUpdate = updates.find(u => u.playerId === 'p2')!

    // Winner's mu should increase
    expect(winnerUpdate.after.mu).toBeGreaterThan(winnerUpdate.before.mu)
    // Loser's mu should decrease
    expect(loserUpdate.after.mu).toBeLessThan(loserUpdate.before.mu)
    // Both sigmas should decrease (more certainty after a game)
    expect(winnerUpdate.after.sigma).toBeLessThan(winnerUpdate.before.sigma)
    expect(loserUpdate.after.sigma).toBeLessThan(loserUpdate.before.sigma)
    // Display deltas should be opposite signs
    expect(winnerUpdate.displayDelta).toBeGreaterThan(0)
    expect(loserUpdate.displayDelta).toBeLessThan(0)
  })

  test('higher-rated player beating lower-rated gains less', () => {
    const strong: PlayerRating = { playerId: 'strong', mu: 35, sigma: 4 }
    const weak: PlayerRating = { playerId: 'weak', mu: 15, sigma: 4 }

    const updates = calculateTeamRatings([
      { players: [strong] }, // strong wins (expected)
      { players: [weak] },
    ])

    const strongUpdate = updates.find(u => u.playerId === 'strong')!
    const _weakUpdate = updates.find(u => u.playerId === 'weak')!

    // Strong player should gain very little from beating a weak player
    expect(strongUpdate.after.mu - strongUpdate.before.mu).toBeLessThan(2)
  })
})

// ── calculateTeamRatings (2v2) ──────────────────────────────

describe('calculateTeamRatings — 2v2', () => {
  test('winning team players gain rating', () => {
    const p1: PlayerRating = { playerId: 'a1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p2: PlayerRating = { playerId: 'a2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p3: PlayerRating = { playerId: 'b1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p4: PlayerRating = { playerId: 'b2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }

    const updates = calculateTeamRatings([
      { players: [p1, p2] }, // Team A wins
      { players: [p3, p4] }, // Team B loses
    ])

    expect(updates).toHaveLength(4)

    const winners = updates.filter(u => ['a1', 'a2'].includes(u.playerId))
    const losers = updates.filter(u => ['b1', 'b2'].includes(u.playerId))

    for (const w of winners) {
      expect(w.displayDelta).toBeGreaterThan(0)
    }
    for (const l of losers) {
      expect(l.displayDelta).toBeLessThan(0)
    }
  })
})

// ── calculateFfaRatings ─────────────────────────────────────

describe('calculateFfaRatings', () => {
  test('first place gains the most, last place loses the most', () => {
    const players: PlayerRating[] = Array.from({ length: 8 }, (_, i) => ({
      playerId: `p${i + 1}`,
      mu: DEFAULT_MU,
      sigma: DEFAULT_SIGMA,
    }))

    const entries = players.map((player, i) => ({
      player,
      placement: i + 1, // p1=1st, p2=2nd, ..., p8=8th
    }))

    const updates = calculateFfaRatings(entries)

    expect(updates).toHaveLength(8)

    const first = updates.find(u => u.playerId === 'p1')!
    const last = updates.find(u => u.playerId === 'p8')!

    // First place should gain the most
    expect(first.displayDelta).toBeGreaterThan(0)
    // Last place should lose the most
    expect(last.displayDelta).toBeLessThan(0)
    // First place gain > middle player gain
    const middle = updates.find(u => u.playerId === 'p4')!
    expect(first.displayDelta).toBeGreaterThan(middle.displayDelta)
  })

  test('handles ties (same placement)', () => {
    const p1: PlayerRating = { playerId: 'p1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p2: PlayerRating = { playerId: 'p2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p3: PlayerRating = { playerId: 'p3', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }

    const updates = calculateFfaRatings([
      { player: p1, placement: 1 },
      { player: p2, placement: 2 },
      { player: p3, placement: 2 }, // tied for 2nd
    ])

    expect(updates).toHaveLength(3)

    const u2 = updates.find(u => u.playerId === 'p2')!
    const u3 = updates.find(u => u.playerId === 'p3')!

    // Players tied for 2nd should get the same rating change
    expect(u2.displayDelta).toBeCloseTo(u3.displayDelta, 5)
  })
})

// ── calculateRatings (unified) ──────────────────────────────

describe('calculateRatings', () => {
  test('dispatches team matches correctly', () => {
    const updates = calculateRatings({
      type: 'team',
      teams: [
        { players: [{ playerId: 'p1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }] },
        { players: [{ playerId: 'p2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }] },
      ],
    })
    expect(updates).toHaveLength(2)
  })

  test('dispatches FFA matches correctly', () => {
    const updates = calculateRatings({
      type: 'ffa',
      entries: [
        { player: { playerId: 'p1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }, placement: 1 },
        { player: { playerId: 'p2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }, placement: 2 },
        { player: { playerId: 'p3', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }, placement: 3 },
      ],
    })
    expect(updates).toHaveLength(3)
  })
})

// ── predictWinProbabilities ─────────────────────────────────

describe('predictWinProbabilities', () => {
  test('equal players have ~equal win probability', () => {
    const p1: PlayerRating = { playerId: 'p1', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }
    const p2: PlayerRating = { playerId: 'p2', mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }

    const probs = predictWinProbabilities([[p1], [p2]])

    expect(probs).toHaveLength(2)
    expect(probs[0]).toBeCloseTo(0.5, 1)
    expect(probs[1]).toBeCloseTo(0.5, 1)
    // Should sum to ~1
    expect(probs[0]! + probs[1]!).toBeCloseTo(1, 2)
  })

  test('stronger player has higher win probability', () => {
    const strong: PlayerRating = { playerId: 'strong', mu: 35, sigma: 4 }
    const weak: PlayerRating = { playerId: 'weak', mu: 15, sigma: 4 }

    const probs = predictWinProbabilities([[strong], [weak]])

    expect(probs[0]).toBeGreaterThan(0.5)
    expect(probs[1]).toBeLessThan(0.5)
  })
})

// ── buildLeaderboard ────────────────────────────────────────

describe('buildLeaderboard', () => {
  test('filters out players with too few games', () => {
    const players = [
      { playerId: 'veteran', mu: 30, sigma: 4, gamesPlayed: 20, wins: 12 },
      { playerId: 'newbie', mu: 28, sigma: 7, gamesPlayed: 2, wins: 1 },
    ]

    const lb = buildLeaderboard(players)

    expect(lb).toHaveLength(1)
    expect(lb[0]!.playerId).toBe('veteran')
  })

  test('sorts by display rating descending', () => {
    const players = [
      { playerId: 'low', mu: 20, sigma: 3, gamesPlayed: 10, wins: 3 },
      { playerId: 'high', mu: 35, sigma: 3, gamesPlayed: 10, wins: 8 },
      { playerId: 'mid', mu: 28, sigma: 3, gamesPlayed: 10, wins: 5 },
    ]

    const lb = buildLeaderboard(players)

    expect(lb).toHaveLength(3)
    expect(lb[0]!.playerId).toBe('high')
    expect(lb[1]!.playerId).toBe('mid')
    expect(lb[2]!.playerId).toBe('low')
  })

  test('computes displayRating and winRate', () => {
    const players = [
      { playerId: 'p1', mu: 30, sigma: 4, gamesPlayed: 10, wins: 6 },
    ]

    const lb = buildLeaderboard(players)

    expect(lb[0]!.displayRating).toBeCloseTo(DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * (30 - 3 * 4), 0) // 690
    expect(lb[0]!.winRate).toBeCloseTo(0.6, 2)
  })

  test('respects custom minGames', () => {
    const players = [
      { playerId: 'p1', mu: 30, sigma: 4, gamesPlayed: 3, wins: 2 },
    ]

    expect(buildLeaderboard(players, 3)).toHaveLength(1)
    expect(buildLeaderboard(players, 5)).toHaveLength(0)
  })
})

// ── seasonReset ─────────────────────────────────────────────

describe('seasonReset', () => {
  test('preserves mu, increases sigma', () => {
    const result = seasonReset(30, 4, 0.5)

    expect(result.mu).toBe(30)
    // sigma should increase toward DEFAULT_SIGMA
    expect(result.sigma).toBeGreaterThan(4)
    expect(result.sigma).toBeLessThan(DEFAULT_SIGMA)
    // sigma = 4 + (8.333 - 4) * 0.5 ≈ 6.167
    expect(result.sigma).toBeCloseTo(4 + (DEFAULT_SIGMA - 4) * 0.5, 2)
  })

  test('resetFactor 0 = no change', () => {
    const result = seasonReset(30, 4, 0)

    expect(result.mu).toBe(30)
    expect(result.sigma).toBe(4)
  })

  test('resetFactor 1 = full reset to default sigma', () => {
    const result = seasonReset(30, 4, 1)

    expect(result.mu).toBe(30)
    expect(result.sigma).toBeCloseTo(DEFAULT_SIGMA, 2)
  })
})
