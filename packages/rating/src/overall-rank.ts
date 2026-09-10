import { PUBLIC_RANK_REQUIREMENTS, PUBLIC_RATING_BANDS, publicRatingBadgeRank } from './public-rating.ts'

export const OVERALL_RANK_POLICY_VERSION = 'best-mode-one-division-v2'
export const ONE_DIVISION_RANK_POLICY_VERSION = OVERALL_RANK_POLICY_VERSION
export type OverallRankPolicyVersion = typeof OVERALL_RANK_POLICY_VERSION | 'best-mode-quality-v1'
export function isOverallRankPolicyVersion(value: unknown): value is OverallRankPolicyVersion {
  return value === OVERALL_RANK_POLICY_VERSION || value === 'best-mode-quality-v1'
}
export const QUALITY_HALF_LIFE_MS = 90 * 86_400_000
const RETENTION_RATIO = 0.8
const QUALITY_DESTINATION_LOOKAHEAD = 2

type RankBand = typeof PUBLIC_RATING_BANDS[number]
type Mode = 'duel' | 'duo' | 'squad' | 'ffa'

export interface OverallModeStanding {
  mode: Mode
  rating: number
  effectiveGames: number
  heldMinimum?: number | null
}

export interface RecentQualityEvidence {
  effectiveGames: number
  highRankWins: number
  eliteWins: number
  at: number
}

/** Credits must be deduplicated by match and player before entering the policy. */
export interface QualityResultCredit {
  at: number
  effectiveGames: number
  highRankWins: number
  eliteWins: number
}

export const QUALITY_DIVISION_REQUIREMENTS: Readonly<Record<number, { effectiveGames: number, highRankWins: number, eliteWins: number }>> = {
  900: { effectiveGames: 8, highRankWins: 2, eliteWins: 0 },
  1000: { effectiveGames: 8, highRankWins: 3, eliteWins: 0 },
  1100: { effectiveGames: 8, highRankWins: 4, eliteWins: 0 },
  1200: { effectiveGames: 12, highRankWins: 6, eliteWins: 1 },
  1300: { effectiveGames: 12, highRankWins: 8, eliteWins: 2 },
  1400: { effectiveGames: 12, highRankWins: 10, eliteWins: 3 },
  1500: { effectiveGames: 16, highRankWins: 14, eliteWins: 4 },
}

export function ageQualityEvidence(evidence: RecentQualityEvidence, at: number): RecentQualityEvidence {
  validateTime(at)
  validateTime(evidence.at)
  if (at < evidence.at) throw new Error('Quality evidence cannot move backwards in time.')
  for (const value of [evidence.effectiveGames, evidence.highRankWins, evidence.eliteWins]) validateCredit(value)
  if (evidence.eliteWins > evidence.highRankWins || evidence.highRankWins > evidence.effectiveGames) throw new Error('Inconsistent quality evidence.')
  const weight = 2 ** (-(at - evidence.at) / QUALITY_HALF_LIFE_MS)
  return { at, effectiveGames: evidence.effectiveGames * weight, highRankWins: evidence.highRankWins * weight, eliteWins: evidence.eliteWins * weight }
}

export function addQualityResult(evidence: RecentQualityEvidence, result: QualityResultCredit): RecentQualityEvidence {
  const aged = ageQualityEvidence(evidence, result.at)
  for (const value of [result.effectiveGames, result.highRankWins, result.eliteWins]) validateCredit(value)
  if (result.effectiveGames > 1 || result.eliteWins > result.highRankWins) throw new Error('Invalid per-match quality credit.')
  // One result contributes at most one source-weighted win, including multi-opponent FFA.
  return { at: result.at, effectiveGames: aged.effectiveGames + result.effectiveGames,
    highRankWins: aged.highRankWins + Math.min(result.effectiveGames, result.highRankWins),
    eliteWins: aged.eliteWins + Math.min(result.effectiveGames, result.eliteWins) }
}

export function resolveOverallRank(input: {
  policyVersion?: OverallRankPolicyVersion
  modes: readonly OverallModeStanding[]
  recent: RecentQualityEvidence
  lifetimeEliteWins: number
  lifetimeHighRankWins: number
  previous?: { policyVersion: OverallRankPolicyVersion, minimum: number, qualityMinimum?: number | null } | null
  now: number
}): { policyVersion: OverallRankPolicyVersion, band: RankBand | null, base: RankBand | null, sourceMode: Mode | null, qualityUplift: number, recent: RecentQualityEvidence, qualityMinimum?: number | null, overallRating?: number | null, ratingChangeAt?: number | null } {
  const policyVersion = OVERALL_RANK_POLICY_VERSION
  validateCredit(input.lifetimeEliteWins)
  validateCredit(input.lifetimeHighRankWins)
  const recent = ageQualityEvidence(input.recent, input.now)
  if (new Set(input.modes.map(row => row.mode)).size !== input.modes.length) throw new Error('Duplicate overall mode standing.')
  if (input.previous && (!isOverallRankPolicyVersion(input.previous.policyVersion) || !PUBLIC_RATING_BANDS.some(band => band.minimum === input.previous!.minimum)
    || input.previous.qualityMinimum != null && !QUALITY_DIVISION_REQUIREMENTS[input.previous.qualityMinimum])) throw new Error('Unknown previous overall rank policy or division.')
  const lifetimeEliteQualified = input.lifetimeEliteWins >= PUBLIC_RANK_REQUIREMENTS.tier1Wins && input.lifetimeHighRankWins >= PUBLIC_RANK_REQUIREMENTS.tier2PlusWins
  const candidates = input.modes.map((row) => {
    validateCredit(row.effectiveGames)
    const natural = publicRatingBadgeRank(row.rating, row.heldMinimum)
    const index = PUBLIC_RATING_BANDS.findLastIndex(band => band.minimum <= natural.minimum && row.effectiveGames >= minimumGames(band)
      && (band.tier !== 'tier1' || lifetimeEliteQualified))
    return { row, index }
  }).filter(candidate => candidate.index >= 0).sort((a, b) => b.index - a.index || b.row.rating - a.row.rating || a.row.mode.localeCompare(b.row.mode))
  const best = candidates[0]
  if (!best) return { policyVersion, band: null, base: null, sourceMode: null, qualityUplift: 0, recent }
  let target = best.index
  for (let index = best.index + 1; index <= Math.min(best.index + QUALITY_DESTINATION_LOOKAHEAD, PUBLIC_RATING_BANDS.length - 1); index++) {
    const band = PUBLIC_RATING_BANDS[index]!
    const requirement = QUALITY_DIVISION_REQUIREMENTS[band.minimum]
    if (!requirement || best.row.effectiveGames < minimumGames(band)) continue
    const ratio = input.previous && (input.previous.qualityMinimum ?? input.previous.minimum) >= band.minimum ? RETENTION_RATIO : 1
    if (recent.effectiveGames + 1e-9 >= requirement.effectiveGames * ratio
      && recent.highRankWins + 1e-9 >= requirement.highRankWins * ratio
      && recent.eliteWins + 1e-9 >= requirement.eliteWins * ratio) target = index
  }
  const qualifyingMinimum = target > best.index ? PUBLIC_RATING_BANDS[target]!.minimum : null
  const top = PUBLIC_RATING_BANDS.length - 1
  target = best.index === top ? top : Math.min(target, best.index + 1, top - 1)
  return { policyVersion, band: PUBLIC_RATING_BANDS[target]!, base: PUBLIC_RATING_BANDS[best.index]!, sourceMode: best.row.mode,
    qualityUplift: target - best.index, recent, qualityMinimum: target > best.index ? qualifyingMinimum : null,
    overallRating: best.index === top ? best.row.rating : null }
}

export function nextOverallRankChangeAt(result: ReturnType<typeof resolveOverallRank>, retention = true): number | null {
  if (!result.band || !result.qualityUplift) return result.ratingChangeAt ?? null
  const requirement = QUALITY_DIVISION_REQUIREMENTS[result.qualityMinimum ?? result.band.minimum]!
  const remaining = (['effectiveGames', 'highRankWins', 'eliteWins'] as const)
    .filter(key => requirement[key] > 0)
    .map(key => QUALITY_HALF_LIFE_MS * Math.log2(result.recent[key] / (requirement[key] * (retention ? RETENTION_RATIO : 1) - 1e-9)))
  const qualityAt = result.recent.at + Math.max(1, Math.ceil(Math.min(...remaining)) + 1)
  return result.ratingChangeAt != null ? Math.min(result.ratingChangeAt, qualityAt) : qualityAt
}

function minimumGames(band: RankBand): number {
  return band.tier === 'tier1' ? PUBLIC_RANK_REQUIREMENTS.tier1Games : band.tier === 'tier2' ? PUBLIC_RANK_REQUIREMENTS.tier2Games
    : band.tier === 'tier3' ? PUBLIC_RANK_REQUIREMENTS.tier3Games : PUBLIC_RANK_REQUIREMENTS.qualification
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid quality evidence time.')
}

function validateCredit(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid quality evidence credit.')
}
