export const PUBLIC_RATING_START = 750
export const PUBLIC_RATING_FORMULA_VERSION = 'rp-v3-candidate'
export const PUBLIC_RATING_SEED_VERSION = 'opening-compression-v1'
export const PUBLIC_RANK_REQUIREMENTS = {
  qualification: 4,
  tier3Games: 6,
  tier2Games: 16,
  tier1Games: 18,
  tier1Wins: 1,
  tier2PlusWins: 4,
} as const

export interface PublicRatingSnapshot {
  ratingSystem?: 'legacy' | 'rp'
  publicRatingBefore?: number | null
  publicRatingAfter?: number | null
  publicRatingReady?: boolean
}

export type PublicTier = 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5'

export function rankDivisionLayout(tierCount: number): Array<{ tier: `tier${number}`, division: 0 | 1 | 2 | 3 }> {
  if (!Number.isSafeInteger(tierCount) || tierCount < 2) throw new Error('A rank ladder needs at least two tiers.')
  return Array.from({ length: tierCount }, (_, index) => tierCount - index).flatMap(rank =>
    (rank === 1 || rank === tierCount ? [0] as const : [3, 2, 1] as const).map(division => ({ tier: `tier${rank}` as const, division })))
}

export function rankDivisionSuffix(division: number): string {
  return division === 3 ? ' III' : division === 2 ? ' II' : division === 1 ? ' I' : ''
}

// This rating policy has five tiers; display names belong to guild configuration.
export const PUBLIC_RATING_BANDS = rankDivisionLayout(5).map((band, index) => ({
  ...band,
  tier: band.tier as PublicTier,
  minimum: index === 0 ? 0 : 500 + index * 100,
  label: `Role ${band.tier.slice(4)}${rankDivisionSuffix(band.division)}`,
}))

export interface PublicRatingCalibration {
  version: string
  scope: string
  sourceDigest: string
  population: number
  anchors: readonly { hiddenScore: number, target: number }[]
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`)
  return value
}

function fraction(value: number, name: string): number {
  finite(value, name)
  if (value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`)
  return value
}

export function visiblePublicRating(value: number): number {
  if (finite(value, 'RP') < 0) throw new Error('RP cannot be negative.')
  return Math.round(value)
}

export function publicRatingRank(value: number): typeof PUBLIC_RATING_BANDS[number] {
  const visible = visiblePublicRating(value)
  return PUBLIC_RATING_BANDS.findLast(band => visible >= band.minimum)!
}

/** Rank-labelled views show surplus above the top band; stored RP stays absolute. */
export function formatPublicRankRating(value: number, displayedTier: string | null): string {
  const visible = visiblePublicRating(value)
  const top = PUBLIC_RATING_BANDS.at(-1)!
  return displayedTier === top.tier && visible >= top.minimum ? `+${visible - top.minimum}` : String(visible)
}

/** A non-null badge holds the previous division until this scope's next rated game. */
export function advancePublicRatingBadge(before: number, after: number, heldMinimum: number | null = null): number | null {
  const previous = publicRatingRank(before)
  const current = publicRatingRank(after)
  if (heldMinimum != null) {
    publicRatingBadgeRank(before, heldMinimum)
    return null
  }
  return after < before && current.minimum < previous.minimum ? previous.minimum : null
}

export function publicRatingBadgeRank(rating: number, heldMinimum?: number | null): typeof PUBLIC_RATING_BANDS[number] {
  const natural = publicRatingRank(rating)
  if (heldMinimum == null) return natural
  const held = PUBLIC_RATING_BANDS.find(band => band.minimum === heldMinimum)
  if (!held || held.minimum <= natural.minimum) throw new Error('Invalid retained public division.')
  return held
}

export function publicRatingPresentation(before: number, after: number) {
  const visibleBefore = visiblePublicRating(before)
  const visibleAfter = visiblePublicRating(after)
  const delta = visibleAfter - visibleBefore
  return {
    before: visibleBefore,
    after: visibleAfter,
    delta,
    rank: publicRatingRank(after),
    text: delta === 0 ? `${visibleAfter} RP` : `${delta > 0 ? '+' : ''}${delta} RP → ${visibleAfter} RP`,
  }
}

export function validatePublicRatingCalibration(calibration: PublicRatingCalibration): void {
  if (!calibration.version || !calibration.scope || !calibration.sourceDigest) throw new Error('Calibration provenance is required.')
  if (!Number.isSafeInteger(calibration.population) || calibration.population < 2) throw new Error('Calibration needs at least two qualified players.')
  if (calibration.anchors.length < 2) throw new Error('Calibration needs at least two distinct anchors.')
  for (let index = 0; index < calibration.anchors.length; index++) {
    const anchor = calibration.anchors[index]!
    finite(anchor.hiddenScore, 'Hidden anchor')
    if (finite(anchor.target, 'Target anchor') < 0) throw new Error('Target RP cannot be negative.')
    const previous = calibration.anchors[index - 1]
    if (previous && (anchor.hiddenScore <= previous.hiddenScore || anchor.target <= previous.target)) {
      throw new Error('Calibration anchors must increase strictly; review tied percentile anchors offline.')
    }
  }
}

export function calibratePublicRatings(input: {
  version: string
  scope: string
  sourceDigest: string
  qualifiedHiddenScores: readonly number[]
}): PublicRatingCalibration {
  const scores = input.qualifiedHiddenScores.map(score => finite(score, 'Hidden score')).sort((a, b) => a - b)
  const quantiles = [[0, 300], [0.1, 600], [0.6, 900], [0.8, 1200], [0.95, 1500], [1, 1599]] as const
  const calibration: PublicRatingCalibration = {
    version: input.version,
    scope: input.scope,
    sourceDigest: input.sourceDigest,
    population: scores.length,
    anchors: quantiles.map(([quantile, target]) => {
      const offset = quantile * (scores.length - 1)
      const lower = scores[Math.floor(offset)]!
      const upper = scores[Math.ceil(offset)]!
      return { hiddenScore: lower + (upper - lower) * (offset - Math.floor(offset)), target }
    }),
  }
  validatePublicRatingCalibration(calibration)
  return calibration
}

export function publicRatingTarget(hiddenScore: number, calibration: PublicRatingCalibration): number {
  finite(hiddenScore, 'Hidden score')
  validatePublicRatingCalibration(calibration)
  const anchors = calibration.anchors
  const upperIndex = anchors.findIndex(anchor => anchor.hiddenScore >= hiddenScore)
  const index = upperIndex < 0 ? anchors.length - 1 : Math.max(1, upperIndex)
  const lower = anchors[index - 1]!
  const upper = anchors[index]!
  const progress = (hiddenScore - lower.hiddenScore) / (upper.hiddenScore - lower.hiddenScore)
  return Math.max(0, finite(lower.target + progress * (upper.target - lower.target), 'Interpolated target'))
}

export interface PublicOpeningSeed {
  rating: number
  target: number | null
  guard: 'unqualified' | 'closing-elite' | 'one-rank' | null
  seedVersion: typeof PUBLIC_RATING_SEED_VERSION
}

export function publicOpeningSeed(input: {
  qualified: boolean
  hiddenScore: number
  calibration: PublicRatingCalibration
  closingTier?: PublicTier | null
  /** Position among players with the same closing managed tier; ties share a position. */
  closingTierPosition?: number
}): PublicOpeningSeed {
  finite(input.hiddenScore, 'Hidden score')
  validatePublicRatingCalibration(input.calibration)
  const position = fraction(input.closingTierPosition ?? 0.5, 'Closing tier position')
  if (input.closingTier != null && !['tier1', 'tier2', 'tier3', 'tier4', 'tier5'].includes(input.closingTier)) throw new Error('Unknown closing managed tier.')
  if (input.closingTier != null && !input.qualified) throw new Error('A managed closing role without qualification needs owner review before seeding.')
  const result = (rating: number, target: number | null, guard: PublicOpeningSeed['guard']): PublicOpeningSeed => ({
    rating, target, guard, seedVersion: PUBLIC_RATING_SEED_VERSION,
  })
  if (!input.qualified) return result(PUBLIC_RATING_START, null, 'unqualified')
  const target = publicRatingTarget(input.hiddenScore, input.calibration)
  if (input.closingTier === 'tier1') return result(1400 + 49 * position, target, 'closing-elite')
  const seed = PUBLIC_RATING_START + 0.85 * (target - PUBLIC_RATING_START)
  const previousTopDivision = input.closingTier === 'tier2' ? 1100 : input.closingTier === 'tier3' ? 800 : 0
  const minimumTierRating = input.closingTier === 'tier2' ? 900 : input.closingTier === 'tier3' ? 600 : 0
  if (visiblePublicRating(seed) < minimumTierRating) return result(previousTopDivision + 99 * position, target, 'one-rank')
  return result(seed, target, null)
}

export interface PublicRatingTransitionInput {
  formulaVersion: string
  priorRating: number
  hiddenMuBefore: number
  /** Protected/tapered OpenSkill result, before applying the import source weight. */
  hiddenMuAfterRaw: number
  hiddenSigmaBefore: number
  targetRating: number
  sourceWeight: number
}

export function calculatePublicRatingTransition(input: PublicRatingTransitionInput) {
  if (input.formulaVersion !== PUBLIC_RATING_FORMULA_VERSION) throw new Error(`Unknown RP formula version: ${input.formulaVersion}`)
  visiblePublicRating(input.priorRating)
  visiblePublicRating(input.targetRating)
  finite(input.hiddenMuBefore, 'Hidden mu before')
  finite(input.hiddenMuAfterRaw, 'Hidden mu after')
  if (finite(input.hiddenSigmaBefore, 'Hidden sigma') <= 0) throw new Error('Hidden sigma must be positive.')
  const sourceWeight = fraction(input.sourceWeight, 'Source weight')
  const hiddenDelta = finite(input.hiddenMuAfterRaw - input.hiddenMuBefore, 'Hidden delta')
  const uncertainty = Math.min(1, Math.max(0, (input.hiddenSigmaBefore - 3) / (25 / 3 - 3)))
  const maximum = 35 + 40 * uncertainty
  const gap = Math.max(-1, Math.min(1, (input.targetRating - input.priorRating) / 300))
  const catchup = Math.exp(Math.sign(hiddenDelta) * gap * (0.25 + uncertainty * 0.35))
  const movement = maximum * Math.tanh(hiddenDelta * 36 * catchup / maximum) * sourceWeight
  const after = Math.max(0, input.priorRating + movement)
  return {
    before: input.priorRating,
    after,
    delta: after - input.priorRating,
    formulaVersion: input.formulaVersion,
  }
}

export interface PublicReplayEvent {
  id: string
  sequence: number
  formulaVersion: string
  calibrationVersion: string
  hiddenMuBefore: number
  hiddenMuAfterRaw: number
  hiddenSigmaBefore: number
  hiddenTargetScore: number
  sourceWeight: number
}

export function replayPublicRating(input: {
  openingRating: number
  events: readonly PublicReplayEvent[]
  calibrations: ReadonlyMap<string, PublicRatingCalibration>
}) {
  visiblePublicRating(input.openingRating)
  const ordered = [...input.events].sort((a, b) => a.sequence - b.sequence)
  const identities = new Set<string>()
  let rating = input.openingRating
  let previousSequence = 0
  const events = ordered.map((event) => {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence || identities.has(event.id)) {
      throw new Error('Public replay requires unique event identities and positive, unique recorded sequences.')
    }
    const calibration = input.calibrations.get(event.calibrationVersion)
    if (!calibration || calibration.version !== event.calibrationVersion) throw new Error(`Missing calibration: ${event.calibrationVersion}`)
    const transition = calculatePublicRatingTransition({
      ...event,
      priorRating: rating,
      targetRating: publicRatingTarget(event.hiddenTargetScore, calibration),
    })
    rating = transition.after
    previousSequence = event.sequence
    identities.add(event.id)
    return { ...event, ...transition }
  })
  return { rating, events }
}
