import type { PublicRatingCalibration, PublicTier } from '@civup/rating'
import { publicOpeningSeed, PUBLIC_RATING_FORMULA_VERSION, seasonReset, validatePublicRatingCalibration } from '@civup/rating'
import { SEASON_REPORTING_WINDOW_MS } from './policy.ts'

export interface SeasonOpeningPlayer {
  playerId: string
  mode: string
  mu: number
  sigma: number
  hiddenScore: number
  qualified: boolean
  closingTier: PublicTier | null
  evidence: Record<string, number>
  seasonGames: number
  seasonWins: number
  lastPlayedAt: number | null
}

export interface SeasonOpeningInput {
  sourceSeasonId: string
  seasonId: string
  cutoff: number
  resetFactor: number
  sourceDigest: string
  calibrations: readonly PublicRatingCalibration[]
  players: readonly SeasonOpeningPlayer[]
}

export function prepareSeasonOpening(input: SeasonOpeningInput) {
  if (!input.sourceSeasonId || !input.seasonId || input.sourceSeasonId === input.seasonId || !input.sourceDigest) throw new Error('Distinct source/target seasons and snapshot provenance are required.')
  if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0 || !Number.isSafeInteger(input.cutoff + SEASON_REPORTING_WINDOW_MS)) throw new Error('Invalid season cutoff.')
  if (!Number.isFinite(input.resetFactor) || input.resetFactor < 0 || input.resetFactor > 1) throw new Error('Reset factor must be between 0 and 1.')
  const calibrationByScope = new Map<string, PublicRatingCalibration>()
  for (const calibration of input.calibrations) {
    validatePublicRatingCalibration(calibration)
    if (calibration.sourceDigest !== input.sourceDigest || calibrationByScope.has(calibration.scope)) throw new Error('Calibrations must come from one snapshot with one version per scope.')
    calibrationByScope.set(calibration.scope, calibration)
  }
  const identities = new Set<string>()
  for (const player of input.players) {
    const identity = `${player.playerId}:${player.mode}`
    if (!player.playerId || !['global', 'duel', 'duo', 'squad', 'ffa', 'red-death'].includes(player.mode) || identities.has(identity)) throw new Error('Invalid or duplicate opening player/scope.')
    identities.add(identity)
    if (![player.mu, player.sigma, player.hiddenScore].every(Number.isFinite) || player.sigma <= 0) throw new Error(`Invalid hidden rating for ${identity}.`)
    if (!Number.isSafeInteger(player.seasonGames) || !Number.isSafeInteger(player.seasonWins) || player.seasonGames < 0 || player.seasonWins < 0 || player.seasonWins > player.seasonGames) throw new Error(`Invalid season counts for ${identity}.`)
    if (Object.values(player.evidence).some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Invalid qualification evidence for ${identity}.`)
    if (player.lastPlayedAt != null && (!Number.isSafeInteger(player.lastPlayedAt) || player.lastPlayedAt >= input.cutoff)) throw new Error(`Snapshot includes a game at or after the cutoff for ${identity}.`)
    if (player.mode !== 'global' && player.closingTier != null) throw new Error('Mode seeds must not inherit overall managed roles.')
  }
  const closingCohorts = new Map<PublicTier, number[]>()
  for (const player of input.players) {
    if (player.mode !== 'global' || !player.closingTier || !player.qualified) continue
    const cohort = closingCohorts.get(player.closingTier) ?? []
    cohort.push(player.hiddenScore)
    closingCohorts.set(player.closingTier, cohort)
  }
  for (const cohort of closingCohorts.values()) cohort.sort((a, b) => a - b)

  const seeds = input.players.map((player) => {
    const calibration = calibrationByScope.get(player.mode)
    if (!calibration) throw new Error(`Missing ${player.mode} calibration.`)
    const cohort = player.closingTier ? closingCohorts.get(player.closingTier) ?? [] : []
    const first = cohort.indexOf(player.hiddenScore)
    const last = cohort.lastIndexOf(player.hiddenScore)
    const position = cohort.length > 1 ? (first + last) / 2 / (cohort.length - 1) : 0.5
    const opening = publicOpeningSeed({
      qualified: player.qualified,
      hiddenScore: player.hiddenScore,
      calibration,
      closingTier: player.closingTier,
      closingTierPosition: position,
    })
    const hidden = seasonReset(player.mu, player.sigma, input.resetFactor)
    return {
      seasonId: input.seasonId,
      sourceSeasonId: input.sourceSeasonId,
      playerId: player.playerId,
      mode: player.mode,
      rating: opening.rating,
      hiddenMu: hidden.mu,
      hiddenSigma: hidden.sigma,
      sourceMu: player.mu,
      sourceSigma: player.sigma,
      sourceHiddenScore: player.hiddenScore,
      effectiveAt: input.cutoff,
      formulaVersion: PUBLIC_RATING_FORMULA_VERSION,
      calibrationVersion: calibration.version,
      seedVersion: opening.seedVersion,
      closingTier: player.closingTier,
      guardReason: opening.guard,
      evidence: { ...player.evidence },
      target: opening.target,
    }
  })
  const closingStates = input.players.map(player => ({
    seasonId: input.sourceSeasonId,
    playerId: player.playerId,
    mode: player.mode,
    mu: player.mu,
    sigma: player.sigma,
    publicRating: null,
    seasonGames: player.seasonGames,
    seasonWins: player.seasonWins,
    evidence: { ...player.evidence },
    lastPlayedAt: player.lastPlayedAt,
    revision: 0,
    updatedAt: input.cutoff,
  }))
  const openingStates = seeds.map(seed => ({
    seasonId: input.seasonId,
    playerId: seed.playerId,
    mode: seed.mode,
    mu: seed.hiddenMu,
    sigma: seed.hiddenSigma,
    publicRating: seed.rating,
    seasonGames: 0,
    seasonWins: 0,
    evidence: { ...seed.evidence },
    lastPlayedAt: null,
    revision: 0,
    updatedAt: input.cutoff,
  }))
  return {
    sourceDigest: input.sourceDigest,
    cutoff: input.cutoff,
    reportingDeadline: input.cutoff + SEASON_REPORTING_WINDOW_MS,
    seeds,
    closingStates,
    openingStates,
    directRowWrites: seeds.length + closingStates.length + openingStates.length + seeds.length + input.calibrations.length + 2,
    productionEstimateValidated: false,
  }
}

/** Updating a closed season never returns live summary writes or a replacement opening seed. */
export function advanceSeasonRatingState<T extends {
  seasonId: string
  mu: number
  sigma: number
  publicRating: number | null
  seasonGames: number
  seasonWins: number
  evidence: Record<string, number>
  lastPlayedAt: number | null
  revision: number
  updatedAt: number
}>(state: T, input: {
  seasonId: string
  mu: number
  sigma: number
  publicRating: number | null
  win: boolean
  imported: boolean
  evidenceDelta: Record<string, number>
  acceptedAt: number
}): T {
  if (state.seasonId !== input.seasonId) throw new Error('A result cannot update another season.')
  if (![input.mu, input.sigma, input.acceptedAt].every(Number.isFinite) || input.sigma <= 0) throw new Error('Invalid season rating transition.')
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < state.updatedAt || !Number.isSafeInteger(state.revision + 1)) throw new Error('Invalid season transition order.')
  if (input.publicRating != null && (!Number.isFinite(input.publicRating) || input.publicRating < 0)) throw new Error('Invalid public rating transition.')
  if ((state.publicRating == null) !== (input.publicRating == null)) throw new Error('A result cannot change the season rating system.')
  const evidence = { ...state.evidence }
  for (const [key, delta] of Object.entries(input.evidenceDelta)) {
    if (!Number.isFinite(delta) || delta < 0) throw new Error('Invalid evidence delta.')
    evidence[key] = (evidence[key] ?? 0) + delta
    if (!Number.isFinite(evidence[key])) throw new Error('Evidence overflow.')
  }
  return {
    ...state,
    mu: input.mu,
    sigma: input.sigma,
    publicRating: input.publicRating,
    seasonGames: state.seasonGames + 1,
    seasonWins: state.seasonWins + (input.win ? 1 : 0),
    evidence,
    lastPlayedAt: input.imported ? state.lastPlayedAt : input.acceptedAt,
    revision: state.revision + 1,
    updatedAt: input.acceptedAt,
  }
}
