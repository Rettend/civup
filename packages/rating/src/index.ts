import type { Rating as OSRating } from 'openskill'
import { ordinal, predictWin, rate, rating } from 'openskill'

// ── Constants ───────────────────────────────────────────────

/** Default mu for new players */
export const DEFAULT_MU = 25.0

/** Default sigma for new players */
export const DEFAULT_SIGMA = 25 / 3 // ~8.333

/** Minimum games required to appear on leaderboard */
export const LEADERBOARD_MIN_GAMES = 5

/** Leaderboard modes */
export type LeaderboardMode = 'ffa' | 'duel' | 'teamers'

// ── Player Rating ───────────────────────────────────────────

export interface PlayerRating {
  /** Discord user ID */
  playerId: string
  mu: number
  sigma: number
}

/**
 * Create a fresh rating for a new player.
 */
export function createRating(playerId: string): PlayerRating {
  const r = rating({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA })
  return { playerId, mu: r.mu, sigma: r.sigma }
}

/**
 * Conservative display rating: mu - 3*sigma.
 * This is the value shown on leaderboards and player cards.
 * Will be negative for uncalibrated players — clamp to 0 for display if needed.
 */
export function displayRating(mu: number, sigma: number): number {
  return ordinal({ mu, sigma })
}

// ── Rating Calculation ──────────────────────────────────────

/**
 * Result of a rating calculation for a single player.
 */
export interface RatingUpdate {
  playerId: string
  before: { mu: number, sigma: number }
  after: { mu: number, sigma: number }
  displayBefore: number
  displayAfter: number
  displayDelta: number
}

// ── Team / Duel Ratings ─────────────────────────────────────

/**
 * A team of players with their current ratings, used for team and duel modes.
 */
export interface TeamInput {
  players: PlayerRating[]
}

/**
 * Calculate rating updates for team-based games (duel, 2v2, 3v3).
 *
 * Teams are ordered by placement: index 0 = 1st place (winner), index 1 = 2nd place (loser).
 * For a duel, each "team" has exactly 1 player.
 * For 2v2, each team has 2 players; for 3v3, each team has 3.
 *
 * OpenSkill's `rate()` takes teams in placement order by default.
 *
 * @param teams - Teams ordered by placement (winner first).
 * @returns Rating updates for every player across all teams.
 */
export function calculateTeamRatings(teams: TeamInput[]): RatingUpdate[] {
  // Build OpenSkill team arrays
  const osTeams: OSRating[][] = teams.map(t =>
    t.players.map(p => ({ mu: p.mu, sigma: p.sigma })),
  )

  // rank = [1, 2] means first team won, second lost
  // For multi-team (e.g. 3+ teams), rank corresponds to placement
  const rank = teams.map((_, i) => i + 1)

  const updatedTeams = rate(osTeams, { rank })

  const updates: RatingUpdate[] = []

  for (let teamIdx = 0; teamIdx < teams.length; teamIdx++) {
    const team = teams[teamIdx]!
    const updatedRatings = updatedTeams[teamIdx]!

    for (let playerIdx = 0; playerIdx < team.players.length; playerIdx++) {
      const player = team.players[playerIdx]!
      const updated = updatedRatings[playerIdx]!
      const displayBefore = displayRating(player.mu, player.sigma)
      const displayAfter = displayRating(updated.mu, updated.sigma)

      updates.push({
        playerId: player.playerId,
        before: { mu: player.mu, sigma: player.sigma },
        after: { mu: updated.mu, sigma: updated.sigma },
        displayBefore,
        displayAfter,
        displayDelta: displayAfter - displayBefore,
      })
    }
  }

  return updates
}

// ── FFA Ratings ─────────────────────────────────────────────

/**
 * A single FFA player entry with placement.
 */
export interface FfaEntry {
  player: PlayerRating
  /** 1-based placement (1 = winner). Players can share placement (tie). */
  placement: number
}

/**
 * Calculate rating updates for FFA games.
 *
 * OpenSkill natively supports N-player rankings. Each player is treated as
 * their own "team" of 1. The `rank` option specifies the placement order.
 *
 * Ties are supported: players with the same placement value will be ranked equally.
 *
 * @param entries - All FFA players with their placements (1 = winner).
 * @returns Rating updates for every player.
 */
export function calculateFfaRatings(entries: FfaEntry[]): RatingUpdate[] {
  // Sort by placement for consistent ordering
  const sorted = [...entries].sort((a, b) => a.placement - b.placement)

  // Each player is a "team" of 1
  const osTeams: OSRating[][] = sorted.map(e => [{ mu: e.player.mu, sigma: e.player.sigma }])

  // Rank array — OpenSkill uses 1-based ranks, ties are same rank value
  const rank = sorted.map(e => e.placement)

  const updatedTeams = rate(osTeams, { rank })

  return sorted.map((entry, i) => {
    const updated = updatedTeams[i]![0]!
    const displayBefore = displayRating(entry.player.mu, entry.player.sigma)
    const displayAfter = displayRating(updated.mu, updated.sigma)

    return {
      playerId: entry.player.playerId,
      before: { mu: entry.player.mu, sigma: entry.player.sigma },
      after: { mu: updated.mu, sigma: updated.sigma },
      displayBefore,
      displayAfter,
      displayDelta: displayAfter - displayBefore,
    }
  })
}

// ── Unified Calculate ───────────────────────────────────────

export type MatchResult
  = | { type: 'team', teams: TeamInput[] }
    | { type: 'ffa', entries: FfaEntry[] }

/**
 * Calculate rating updates for any match type.
 *
 * For team/duel: `teams` ordered by placement (winner first).
 * For FFA: `entries` with placement values.
 */
export function calculateRatings(result: MatchResult): RatingUpdate[] {
  if (result.type === 'team') {
    return calculateTeamRatings(result.teams)
  }
  return calculateFfaRatings(result.entries)
}

// ── Win Probability ─────────────────────────────────────────

/**
 * Predict win probabilities for teams (or individual players in FFA/duel).
 *
 * @param teams - Array of teams (each team is an array of PlayerRatings).
 * @returns Array of win probabilities (one per team, sums to ~1.0).
 */
export function predictWinProbabilities(teams: PlayerRating[][]): number[] {
  const osTeams: OSRating[][] = teams.map(t =>
    t.map(p => ({ mu: p.mu, sigma: p.sigma })),
  )
  return predictWin(osTeams)
}

// ── Leaderboard Helpers ─────────────────────────────────────

export interface LeaderboardEntry {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  displayRating: number
  winRate: number
}

/**
 * Build a sorted leaderboard from player rating rows.
 * Filters out players with fewer than the minimum games.
 * Sorted by display rating descending.
 */
export function buildLeaderboard(
  players: Array<{
    playerId: string
    mu: number
    sigma: number
    gamesPlayed: number
    wins: number
  }>,
  minGames: number = LEADERBOARD_MIN_GAMES,
): LeaderboardEntry[] {
  return players
    .filter(p => p.gamesPlayed >= minGames)
    .map(p => ({
      playerId: p.playerId,
      mu: p.mu,
      sigma: p.sigma,
      gamesPlayed: p.gamesPlayed,
      wins: p.wins,
      displayRating: displayRating(p.mu, p.sigma),
      winRate: p.gamesPlayed > 0 ? p.wins / p.gamesPlayed : 0,
    }))
    .sort((a, b) => b.displayRating - a.displayRating)
}

// ── Season Reset ────────────────────────────────────────────

/**
 * Reset a player's rating for a new season.
 * Keeps mu as-is (preserve skill estimate) but increases sigma
 * to reintroduce uncertainty. Returning players recalibrate faster
 * than brand new players since their mu is already reasonable.
 *
 * @param mu - Current mu
 * @param sigma - Current sigma
 * @param resetFactor - How much to increase sigma (0-1, default 0.5).
 *   0 = no reset, 1 = full reset to default sigma.
 */
export function seasonReset(
  mu: number,
  sigma: number,
  resetFactor: number = 0.5,
): { mu: number, sigma: number } {
  const newSigma = sigma + (DEFAULT_SIGMA - sigma) * resetFactor
  return { mu, sigma: newSigma }
}
