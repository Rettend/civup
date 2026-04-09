import type { Rating as OSRating } from 'openskill'
import { predictWin, rate, rating } from 'openskill'
import { bradleyTerryFull } from 'openskill/models'

// ── Constants ───────────────────────────────────────────────

/** Default mu for new players (how good the system thinks you are) */
export const DEFAULT_MU = 25.0

/** Default sigma for new players (how unsure the system is about your skill) */
export const DEFAULT_SIGMA = 25 / 3 // ~8.333

/** Default share of uncertainty restored between seasons */
export const DEFAULT_SEASON_RESET_FACTOR = 0.5

/** Starting elo for display */
export const DISPLAY_RATING_BASE = 1000

/** Scale multiplier for display rating deltas and spread */
export const DISPLAY_RATING_SCALE = 36

/** Visible Elo intentionally ignores sigma; uncertainty stays internal. */
export const Z_MULTIPLIER = 0

/** Two-team favorites keep full value until this win probability. */
const EXPECTED_WIN_DISCOUNT_START = 0.70

/** Even the most lopsided wins still move rating a tiny bit. */
const MIN_EXPECTED_WIN_WEIGHT = 0.05

/** Steeper taper that quickly flattens obvious farm wins. */
const EXPECTED_WIN_WEIGHT_EXPONENT = 1.5

/** Core openskill parameters tweaked for Civ 6 */
export const RATING_OPTIONS = {
  beta: 3.0, // Trust game outcomes more (less luck)
  tau: 0.3, // Adds back some uncertainty to prevent stagnation
}

/** All 3+ side placement modes */
function getPlacementRatingOptions(sides: number) {
  return {
    ...RATING_OPTIONS,
    model: bradleyTerryFull,
    beta: Math.max(3, sides - 2),
  }
}

/** Placement games contain more variance, so 3+ side outcomes are scaled down uniformly. */
const PLACEMENT_UPDATE_WEIGHT = 0.1

function getExpectedWinWeight(winnerProbability: number): number {
  const boundedProbability = Math.max(0, Math.min(1, winnerProbability))
  if (boundedProbability <= EXPECTED_WIN_DISCOUNT_START) return 1

  const normalizedTail = (1 - boundedProbability) / (1 - EXPECTED_WIN_DISCOUNT_START)
  return Math.max(MIN_EXPECTED_WIN_WEIGHT, normalizedTail ** EXPECTED_WIN_WEIGHT_EXPONENT)
}

function scaleRatingUpdates(updates: RatingUpdate[], weight: number): RatingUpdate[] {
  if (weight >= 1) return updates

  return updates.map((update) => {
    const afterMu = update.before.mu + ((update.after.mu - update.before.mu) * weight)
    const afterSigma = update.before.sigma + ((update.after.sigma - update.before.sigma) * weight)
    const displayAfter = displayRating(afterMu, afterSigma)

    return {
      ...update,
      after: { mu: afterMu, sigma: afterSigma },
      displayAfter,
      displayDelta: displayAfter - update.displayBefore,
    }
  })
}

/** Minimum games required to appear on solo leaderboards. */
export const LEADERBOARD_MIN_GAMES = 10

/** Minimum games required to appear on duo/squad player leaderboards. */
export const TEAM_LEADERBOARD_MIN_GAMES = 5

/** Minimum total ranked games required before non-fallback ranked roles apply. */
export const RANKED_ROLE_MIN_GAMES = 10

export type LeaderboardMode = 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'

export function getLeaderboardMinGames(mode: LeaderboardMode): number {
  return mode === 'duo' || mode === 'squad' ? TEAM_LEADERBOARD_MIN_GAMES : LEADERBOARD_MIN_GAMES
}

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
 * Visible Elo derived from skill.
 */
export function displayRating(mu: number, sigma: number): number {
  const anchoredSkill = (mu - (Z_MULTIPLIER * sigma)) - (DEFAULT_MU - (Z_MULTIPLIER * DEFAULT_SIGMA))
  return DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * anchoredSkill
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
 * Calculate rating updates for team-based games (duel, 2v2, 3v3, 4v4, multi-team e.g. RD 2v2v2v2).
 *
 * Teams are ordered by placement: index 0 = 1st place (winner), index 1 = 2nd place, etc.
 * For a duel, each "team" has exactly 1 player.
 * For 2v2, each team has 2 players; for 3v3, each team has 3; for 4v4, each team has 4.
 *
 * Two-team matchups use low beta (duel tuning). They also taper extremely expected wins so
 * stacked teams in open lobbies cannot farm much rating from obviously weaker opponents.
 * Three or more sides use one shared placement curve, whether those sides are solo FFA players or teams.
 *
 * OpenSkill's `rate()` takes teams in placement order by default.
 *
 * @param teams - Teams ordered by placement (winner first).
 * @returns Rating updates for every player across all teams.
 */
export function calculateTeamRatings(teams: TeamInput[]): RatingUpdate[] {
  const osTeams: OSRating[][] = teams.map(t =>
    t.players.map(p => ({ mu: p.mu, sigma: p.sigma })),
  )

  // rank = [1, 2] means first team won, second lost
  // For multi-team (e.g. 3+ teams), rank corresponds to placement
  const rank = teams.map((_, i) => i + 1)

  const ratingOptions = teams.length > 2
    ? getPlacementRatingOptions(teams.length)
    : RATING_OPTIONS
  const winnerProbability = teams.length === 2
    ? (predictWin(osTeams, ratingOptions)[0] ?? 0.5)
    : null

  const updatedTeams = rate(osTeams, { rank, ...ratingOptions })

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

  if (winnerProbability == null) return scaleRatingUpdates(updates, PLACEMENT_UPDATE_WEIGHT)
  return scaleRatingUpdates(updates, getExpectedWinWeight(winnerProbability))
}

// ── FFA Ratings ─────────────────────────────────────────────

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
 * @param entries - All FFA players with their placements (1 = winner).
 * @returns Rating updates for every player.
 */
export function calculateFfaRatings(entries: FfaEntry[]): RatingUpdate[] {
  const sorted = [...entries].sort((a, b) => a.placement - b.placement)

  // Each player is a "team" of 1
  const osTeams: OSRating[][] = sorted.map(e => [{ mu: e.player.mu, sigma: e.player.sigma }])
  const rank = sorted.map(e => e.placement)

  const updatedTeams = rate(osTeams, { rank, ...getPlacementRatingOptions(sorted.length) })

  const updates = sorted.map((entry, i) => {
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

  return scaleRatingUpdates(updates, PLACEMENT_UPDATE_WEIGHT)
}

// ── Unified Calculation ────────────────────────────────────

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
  const options = teams.length > 2
    ? getPlacementRatingOptions(teams.length)
    : RATING_OPTIONS
  return predictWin(osTeams, options)
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
  resetFactor: number = DEFAULT_SEASON_RESET_FACTOR,
): { mu: number, sigma: number } {
  const newSigma = sigma + (DEFAULT_SIGMA - sigma) * resetFactor
  return { mu, sigma: newSigma }
}
