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

/** Starting public Elo. */
export const DISPLAY_RATING_BASE = 1000

/** Scale multiplier for the hidden-MMR-derived compatibility score. */
export const DISPLAY_RATING_SCALE = 36

/** The hidden-MMR-derived score intentionally ignores sigma. */
export const Z_MULTIPLIER = 0

/** Public rating transition model persisted with mode rating events. */
export const PUBLIC_RATING_VERSION = 1

/** Conservative uncertainty penalty used for official ranked role placement. */
export const RANKED_ROLE_Z_MULTIPLIER = 0.75

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

function scaleRatingUpdate(update: RatingUpdate, weight: number): RatingUpdate {
  if (weight >= 1) return update

  const afterMu = update.before.mu + ((update.after.mu - update.before.mu) * weight)
  const afterSigma = update.before.sigma + ((update.after.sigma - update.before.sigma) * weight)
  const hiddenScoreAfter = hiddenRatingScore(afterMu, afterSigma)

  return {
    ...update,
    after: { mu: afterMu, sigma: afterSigma },
    hiddenScoreAfter,
    hiddenScoreDelta: hiddenScoreAfter - update.hiddenScoreBefore,
    displayAfter: hiddenScoreAfter,
    displayDelta: hiddenScoreAfter - update.hiddenScoreBefore,
  }
}

function scaleRatingUpdates(updates: RatingUpdate[], weight: number): RatingUpdate[] {
  if (weight >= 1) return updates

  return updates.map(update => scaleRatingUpdate(update, weight))
}

/** Minimum games required to appear on player leaderboards. */
export const LEADERBOARD_MIN_GAMES = 5

/** Only raw top placements are eligible for an activity adjustment. */
export const LEADERBOARD_ACTIVITY_TOP_RANK_LIMIT = 20

/** Inactivity does not affect placement during this grace period. */
export const LEADERBOARD_ACTIVITY_GRACE_MS = 90 * 24 * 60 * 60 * 1_000

/** Each full interval after the grace period adds one placement offset. */
export const LEADERBOARD_ACTIVITY_STEP_MS = 30 * 24 * 60 * 60 * 1_000

/** Activity adjustments cannot move a player more than this many places. */
export const LEADERBOARD_ACTIVITY_MAX_OFFSET = 20

/** Minimum weighted evidence required before ranked roles are managed. */
export const RANKED_ROLE_MIN_EFFECTIVE_GAMES = 8

/** Imported games count as partial qualification evidence. */
export const IMPORTED_GAME_EFFECTIVE_WEIGHT = 0.5

/** Sigma below this is treated as established for provisional loss protection. */
const PROVISIONAL_ESTABLISHED_SIGMA = 5

/** Duel provisional winner upsets can reduce only the loser's loss by up to half. */
const DUEL_PROVISIONAL_LOSS_MIN_WEIGHT = 0.5

/** Duel protection is only for clear underdog upsets by visible rating. */
const DUEL_PROVISIONAL_MIN_DISPLAY_GAP = 100

/** Team provisional winner upsets use a smaller cap because teammates smooth volatility. */
const TEAM_PROVISIONAL_LOSS_MIN_WEIGHT = 0.75

/** Team protection only applies to individual losers taking a large visible hit. */
const TEAM_PROVISIONAL_MIN_RAW_LOSS = 60

export type LeaderboardMode = 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'

export function getLeaderboardMinGames(_mode: LeaderboardMode): number {
  return LEADERBOARD_MIN_GAMES
}

// ── Player Rating ───────────────────────────────────────────

export interface PlayerRating {
  /** Discord user ID */
  playerId: string
  mu: number
  sigma: number
  /** Pre-match games in the current rating scope, when available. */
  gamesPlayed?: number
}

/**
 * Create a fresh rating for a new player.
 */
export function createRating(playerId: string): PlayerRating {
  const r = rating({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA })
  return { playerId, mu: r.mu, sigma: r.sigma }
}

/**
 * Compatibility score derived directly from hidden OpenSkill MMR.
 * This is not the persisted public rating.
 */
export function hiddenRatingScore(mu: number, _sigma?: number): number {
  const anchoredSkill = mu - DEFAULT_MU
  return DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * anchoredSkill
}

/** @deprecated Use hiddenRatingScore for hidden-MMR logic or resolvePublicRating for visible mode Elo. */
export const displayRating = hiddenRatingScore

export interface PublicRatingUpdateInput {
  priorPublicRating: number
  hiddenMuBefore: number
  hiddenMuAfterRaw: number
  sourceWeight?: number
}

export interface PublicRatingUpdate {
  version: typeof PUBLIC_RATING_VERSION
  before: number
  after: number
  delta: number
}

/** Resolve a persisted public rating, falling back to the legacy hidden score during backfill. */
export function resolvePublicRating(publicRating: number | null | undefined, hiddenMu: number): number {
  if (typeof publicRating === 'number' && Number.isFinite(publicRating)) return Math.max(0, publicRating)
  const fallback = hiddenRatingScore(hiddenMu)
  return Number.isFinite(fallback) ? Math.max(0, fallback) : DISPLAY_RATING_BASE
}

/** Calculate one full-precision v1 public rating transition without mutating hidden MMR. */
export function calculatePublicRatingUpdate(input: PublicRatingUpdateInput): PublicRatingUpdate {
  const before = Number.isFinite(input.priorPublicRating) ? Math.max(0, input.priorPublicRating) : DISPLAY_RATING_BASE
  const weight = normalizeRatingSourceWeight(input.sourceWeight)
  if (!Number.isFinite(input.hiddenMuBefore) || !Number.isFinite(input.hiddenMuAfterRaw) || weight === 0) {
    return { version: PUBLIC_RATING_VERSION, before, after: before, delta: 0 }
  }

  const hiddenBefore = hiddenRatingScore(input.hiddenMuBefore)
  const hiddenAfterRaw = hiddenRatingScore(input.hiddenMuAfterRaw)
  const hiddenDelta = hiddenAfterRaw - hiddenBefore
  if (!Number.isFinite(hiddenDelta) || hiddenDelta === 0) {
    return { version: PUBLIC_RATING_VERSION, before, after: before, delta: 0 }
  }

  const direction = Math.sign(hiddenDelta)
  const gapTowardHidden = Math.max(0, direction * (hiddenBefore - before))
  const core = 25 * Math.tanh(Math.abs(hiddenDelta) / 25)
  const catchup = Math.min(10, 0.05 * gapTowardHidden, 0.05 * hiddenDelta * hiddenDelta)
  const deltaBeforeFloor = weight * direction * Math.min(35, core + catchup)
  const after = Math.max(0, before + deltaBeforeFloor)
  return {
    version: PUBLIC_RATING_VERSION,
    before,
    after,
    delta: after - before,
  }
}

/** Clamp live or stored source evidence to the rating transition weight. */
export function resolveRatingSourceWeight(effectiveGamesDelta?: number | null, importedGamesDelta = 0): number {
  const evidenceWeight = normalizeRatingSourceWeight(effectiveGamesDelta)
  return importedGamesDelta > 0 ? Math.min(IMPORTED_GAME_EFFECTIVE_WEIGHT, evidenceWeight) : evidenceWeight
}

/** Rebuild a public transition from a source-weighted hidden event snapshot. */
export function calculatePublicRatingUpdateFromStoredEvent(input: {
  priorPublicRating: number
  hiddenMuBefore: number
  hiddenMuAfter: number
  effectiveGamesDelta?: number | null
  importedGamesDelta?: number
}): PublicRatingUpdate {
  const sourceWeight = resolveRatingSourceWeight(input.effectiveGamesDelta, input.importedGamesDelta)
  const hiddenMuAfterRaw = sourceWeight === 0
    ? input.hiddenMuBefore
    : input.hiddenMuBefore + ((input.hiddenMuAfter - input.hiddenMuBefore) / sourceWeight)
  return calculatePublicRatingUpdate({
    priorPublicRating: input.priorPublicRating,
    hiddenMuBefore: input.hiddenMuBefore,
    hiddenMuAfterRaw,
    sourceWeight,
  })
}

function normalizeRatingSourceWeight(value: number | null | undefined): number {
  if (value == null) return 1
  if (!Number.isFinite(value)) return 1
  return clamp(value, 0, 1)
}

/** Conservative Elo-like score used for global ranked role bands. */
export function roleRating(mu: number, sigma: number): number {
  const conservativeSkill = mu - (RANKED_ROLE_Z_MULTIPLIER * sigma)
  return DISPLAY_RATING_BASE + DISPLAY_RATING_SCALE * (conservativeSkill - DEFAULT_MU)
}

// ── Rating Calculation ──────────────────────────────────────

/**
 * Result of a rating calculation for a single player.
 */
export interface RatingUpdate {
  playerId: string
  before: { mu: number, sigma: number }
  after: { mu: number, sigma: number }
  hiddenScoreBefore: number
  hiddenScoreAfter: number
  hiddenScoreDelta: number
  /** @deprecated Hidden score compatibility alias. */
  displayBefore: number
  /** @deprecated Hidden score compatibility alias. */
  displayAfter: number
  /** @deprecated Hidden score compatibility alias. */
  displayDelta: number
}

export interface RatingCalculationOptions {
  /** Weight later applied to this match's rating update, e.g. imported games use 0.5. */
  sourceWeight?: number
}

// ── Team / Duel Ratings ─────────────────────────────────────

/**
 * A team of players with their current ratings, used for team and duel modes.
 */
export interface TeamInput {
  players: PlayerRating[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getSourceWeight(options?: RatingCalculationOptions): number {
  const sourceWeight = options?.sourceWeight ?? 1
  if (!Number.isFinite(sourceWeight)) return 1
  return clamp(sourceWeight, 0, 1)
}

function knownGamesPlayed(player: PlayerRating): number | null {
  if (typeof player.gamesPlayed !== 'number' || !Number.isFinite(player.gamesPlayed)) return null
  return Math.max(0, player.gamesPlayed)
}

function playerEstablishedness(player: PlayerRating): number | null {
  const gamesPlayed = knownGamesPlayed(player)
  if (gamesPlayed == null) return null

  const sigmaDenominator = DEFAULT_SIGMA - PROVISIONAL_ESTABLISHED_SIGMA
  const sigmaFactor = sigmaDenominator <= 0
    ? 1
    : clamp((DEFAULT_SIGMA - player.sigma) / sigmaDenominator, 0, 1)
  const gamesFactor = clamp(gamesPlayed / LEADERBOARD_MIN_GAMES, 0, 1)
  return Math.max(sigmaFactor, gamesFactor)
}

function averageWinnerTeamEstablishedness(team: TeamInput): number | null {
  if (team.players.length === 0) return null

  const values: number[] = []
  for (const player of team.players) {
    const establishedness = playerEstablishedness(player)
    if (establishedness == null) return null
    values.push(establishedness)
  }

  return values.reduce((total, value) => total + value, 0) / values.length
}

function sourceWeightedHiddenScoreDelta(update: RatingUpdate, sourceWeight: number): number {
  if (sourceWeight >= 1) return update.hiddenScoreDelta

  const afterMu = update.before.mu + ((update.after.mu - update.before.mu) * sourceWeight)
  const afterSigma = update.before.sigma + ((update.after.sigma - update.before.sigma) * sourceWeight)
  return hiddenRatingScore(afterMu, afterSigma) - update.hiddenScoreBefore
}

function applyProvisionalLossProtection(
  teams: TeamInput[],
  updates: RatingUpdate[],
  options?: RatingCalculationOptions,
): RatingUpdate[] {
  if (teams.length !== 2) return updates

  const winnerTeam = teams[0]
  const loserTeam = teams[1]
  if (!winnerTeam || !loserTeam) return updates
  if (winnerTeam.players.length === 1 && loserTeam.players.length === 1) {
    return applyDuelProvisionalLossProtection(winnerTeam.players[0]!, loserTeam.players[0]!, updates)
  }

  return applyTeamProvisionalLossProtection(winnerTeam, loserTeam, updates, getSourceWeight(options))
}

function applyDuelProvisionalLossProtection(
  winner: PlayerRating,
  loser: PlayerRating,
  updates: RatingUpdate[],
): RatingUpdate[] {
  const loserGames = knownGamesPlayed(loser)
  const winnerEstablishedness = playerEstablishedness(winner)
  if (loserGames == null || winnerEstablishedness == null) return updates
  if (loserGames < LEADERBOARD_MIN_GAMES) return updates
  if (winnerEstablishedness >= 0.999) return updates

  const winnerDisplay = hiddenRatingScore(winner.mu, winner.sigma)
  const loserDisplay = hiddenRatingScore(loser.mu, loser.sigma)
  if (loserDisplay - winnerDisplay < DUEL_PROVISIONAL_MIN_DISPLAY_GAP) return updates

  const lossWeight = Math.max(DUEL_PROVISIONAL_LOSS_MIN_WEIGHT, winnerEstablishedness)
  if (lossWeight >= 0.999) return updates

  return updates.map((update) => {
    if (update.playerId !== loser.playerId || update.hiddenScoreDelta >= 0) return update
    return scaleRatingUpdate(update, lossWeight)
  })
}

function applyTeamProvisionalLossProtection(
  winnerTeam: TeamInput,
  loserTeam: TeamInput,
  updates: RatingUpdate[],
  sourceWeight: number,
): RatingUpdate[] {
  const winnerEstablishedness = averageWinnerTeamEstablishedness(winnerTeam)
  if (winnerEstablishedness == null || winnerEstablishedness >= 0.999) return updates

  const lossWeight = Math.max(TEAM_PROVISIONAL_LOSS_MIN_WEIGHT, winnerEstablishedness)
  if (lossWeight >= 0.999) return updates

  const losingPlayerById = new Map(loserTeam.players.map(player => [player.playerId, player]))
  return updates.map((update) => {
    const loser = losingPlayerById.get(update.playerId)
    if (!loser) return update

    const loserGames = knownGamesPlayed(loser)
    if (loserGames == null || loserGames < LEADERBOARD_MIN_GAMES) return update
    if (sourceWeightedHiddenScoreDelta(update, sourceWeight) > -TEAM_PROVISIONAL_MIN_RAW_LOSS) return update

    return scaleRatingUpdate(update, lossWeight)
  })
}

/**
 * Calculate rating updates for team-based games (duel, 2v2, 3v3, 4v4, 5v5, 6v6, multi-team e.g. RD 2v2v2v2).
 *
 * Teams are ordered by placement: index 0 = 1st place (winner), index 1 = 2nd place, etc.
 * For a duel, each "team" has exactly 1 player.
 * For 2v2, each team has 2 players; for 3v3, each team has 3; for 4v4, each team has 4; and so on.
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
export function calculateTeamRatings(teams: TeamInput[], options?: RatingCalculationOptions): RatingUpdate[] {
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
      const hiddenScoreBefore = hiddenRatingScore(player.mu, player.sigma)
      const hiddenScoreAfter = hiddenRatingScore(updated.mu, updated.sigma)

      updates.push({
        playerId: player.playerId,
        before: { mu: player.mu, sigma: player.sigma },
        after: { mu: updated.mu, sigma: updated.sigma },
        hiddenScoreBefore,
        hiddenScoreAfter,
        hiddenScoreDelta: hiddenScoreAfter - hiddenScoreBefore,
        displayBefore: hiddenScoreBefore,
        displayAfter: hiddenScoreAfter,
        displayDelta: hiddenScoreAfter - hiddenScoreBefore,
      })
    }
  }

  if (winnerProbability == null) return scaleRatingUpdates(updates, PLACEMENT_UPDATE_WEIGHT)

  const scaledUpdates = scaleRatingUpdates(updates, getExpectedWinWeight(winnerProbability))
  return applyProvisionalLossProtection(teams, scaledUpdates, options)
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
    const hiddenScoreBefore = hiddenRatingScore(entry.player.mu, entry.player.sigma)
    const hiddenScoreAfter = hiddenRatingScore(updated.mu, updated.sigma)

    return {
      playerId: entry.player.playerId,
      before: { mu: entry.player.mu, sigma: entry.player.sigma },
      after: { mu: updated.mu, sigma: updated.sigma },
      hiddenScoreBefore,
      hiddenScoreAfter,
      hiddenScoreDelta: hiddenScoreAfter - hiddenScoreBefore,
      displayBefore: hiddenScoreBefore,
      displayAfter: hiddenScoreAfter,
      displayDelta: hiddenScoreAfter - hiddenScoreBefore,
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
export function calculateRatings(result: MatchResult, options?: RatingCalculationOptions): RatingUpdate[] {
  if (result.type === 'team') {
    return calculateTeamRatings(result.teams, options)
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
  publicRating: number
  winRate: number
}

export interface ActivityLeaderboardPlayer {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins?: number
  lastPlayedAt: number | null
  publicRating?: number | null
}

export type ActivityAdjustedLeaderboardEntry<T extends ActivityLeaderboardPlayer = ActivityLeaderboardPlayer> = T & {
  publicRating: number
  winRate: number
  rawRank: number
  rank: number
  inactivityOffset: number
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
    publicRating?: number | null
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
      publicRating: resolvePublicRating(p.publicRating, p.mu),
      winRate: p.gamesPlayed > 0 ? p.wins / p.gamesPlayed : 0,
    }))
    .sort((a, b) => b.publicRating - a.publicRating || a.playerId.localeCompare(b.playerId))
}

/** Calculate the placement-only inactivity offset for a recorded activity timestamp. */
export function getLeaderboardInactivityOffset(lastPlayedAt: number | null, now: number): number {
  if (lastPlayedAt == null) return LEADERBOARD_ACTIVITY_MAX_OFFSET

  const inactivityAfterGrace = Math.max(0, now - lastPlayedAt - LEADERBOARD_ACTIVITY_GRACE_MS)
  return Math.min(LEADERBOARD_ACTIVITY_MAX_OFFSET, Math.floor(inactivityAfterGrace / LEADERBOARD_ACTIVITY_STEP_MS))
}

/** Return the next instant when a recorded activity timestamp gains an offset. */
export function getNextLeaderboardInactivityAdjustmentAt(lastPlayedAt: number | null, now: number): number | null {
  if (lastPlayedAt == null) return null

  const currentOffset = getLeaderboardInactivityOffset(lastPlayedAt, now)
  if (currentOffset >= LEADERBOARD_ACTIVITY_MAX_OFFSET) return null

  return lastPlayedAt
    + LEADERBOARD_ACTIVITY_GRACE_MS
    + ((currentOffset + 1) * LEADERBOARD_ACTIVITY_STEP_MS)
}

/**
 * Build per-mode leaderboard placements with an in-memory activity adjustment.
 * Rating values are copied unchanged; only the returned order and rank metadata differ.
 */
export function buildActivityAdjustedLeaderboard<T extends ActivityLeaderboardPlayer>(
  players: readonly T[],
  minGames: number,
  now: number,
): ActivityAdjustedLeaderboardEntry<T>[] {
  const raw = players
    .filter(player => player.gamesPlayed >= minGames)
    .map(player => ({
      ...player,
      publicRating: resolvePublicRating(player.publicRating, player.mu),
      winRate: player.gamesPlayed > 0 ? (player.wins ?? 0) / player.gamesPlayed : 0,
    }))
    .sort(compareActivityLeaderboardRawEntry)
    .map((entry, index) => {
      const rawRank = index + 1
      return {
        ...entry,
        rawRank,
        rank: rawRank,
        inactivityOffset: rawRank <= LEADERBOARD_ACTIVITY_TOP_RANK_LIMIT
          ? getLeaderboardInactivityOffset(entry.lastPlayedAt, now)
          : 0,
      }
    })

  raw.sort((left, right) => {
    return (left.rawRank + left.inactivityOffset) - (right.rawRank + right.inactivityOffset)
      || left.inactivityOffset - right.inactivityOffset
      || left.rawRank - right.rawRank
      || left.playerId.localeCompare(right.playerId)
  })

  return raw.map((entry, index) => ({ ...entry, rank: index + 1 }))
}

function compareActivityLeaderboardRawEntry(
  left: ActivityLeaderboardPlayer & { publicRating: number },
  right: ActivityLeaderboardPlayer & { publicRating: number },
): number {
  return right.publicRating - left.publicRating
    || (right.lastPlayedAt ?? Number.NEGATIVE_INFINITY) - (left.lastPlayedAt ?? Number.NEGATIVE_INFINITY)
    || left.playerId.localeCompare(right.playerId)
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
