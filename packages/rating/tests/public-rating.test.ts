import { describe, expect, test } from 'bun:test'
import { advancePublicRatingBadge, publicRatingBadgeRank, calculatePublicRatingTransition, calibratePublicRatings, publicOpeningSeed, publicRatingPresentation, publicRatingRank, publicRatingTarget, PUBLIC_RATING_FORMULA_VERSION, replayPublicRating } from '../src/public-rating.ts'

const calibration = calibratePublicRatings({
  version: 'fixture-global-v1', scope: 'global', sourceDigest: 'fixture',
  qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => index),
})

const transition = {
  formulaVersion: PUBLIC_RATING_FORMULA_VERSION,
  priorRating: 750, hiddenMuBefore: 25, hiddenMuAfterRaw: 26,
  hiddenSigmaBefore: 25 / 3, targetRating: 1000, sourceWeight: 1,
}

describe('public rating', () => {
  test('rounded boundaries agree with labels and visible change arithmetic', () => {
    expect(publicRatingRank(599.49)).toMatchObject({ tier: 'tier5', division: 0, minimum: 0 })
    expect(publicRatingRank(599.5)).toMatchObject({ tier: 'tier4', division: 3, minimum: 600 })
    expect(publicRatingRank(1499.5)).toMatchObject({ tier: 'tier1', division: 0, minimum: 1500 })
    expect(publicRatingRank(9000)).toMatchObject({ tier: 'tier1', division: 0, minimum: 1500 })
    expect(publicRatingPresentation(750.49, 750.51)).toMatchObject({ before: 750, after: 751, delta: 1 })
    expect(publicRatingPresentation(750.49, 750.48).text).toBe('750 RP')
    expect(() => publicRatingRank(Number.NaN)).toThrow()
    expect(() => publicRatingRank(-1)).toThrow()
  })

  test('frozen percentile anchors preserve order, extrapolate Elite, and reject unusable populations', () => {
    expect(publicRatingTarget(10, calibration)).toBe(600)
    expect(publicRatingTarget(60, calibration)).toBe(900)
    expect(publicRatingTarget(80, calibration)).toBe(1200)
    expect(publicRatingTarget(95, calibration)).toBe(1500)
    expect(publicRatingTarget(110, calibration)).toBeGreaterThan(1599)
    expect(publicRatingTarget(-1000, calibration)).toBe(0)
    expect(() => calibratePublicRatings({ version: 'tied', scope: 'global', sourceDigest: 'fixture', qualifiedHiddenScores: [1, 1, 1] })).toThrow('anchors')
  })

  test('opening compression, Elite ordering, eligibility, and managed-role guard are deterministic', () => {
    const seed = (hiddenScore: number, extra = {}) => publicOpeningSeed({ qualified: true, hiddenScore, calibration, ...extra })
    expect(seed(0).rating).toBe(367.5)
    expect(seed(100, { closingTier: 'tier1', closingTierPosition: 1 }).rating).toBe(1449)
    expect(seed(95, { closingTier: 'tier1', closingTierPosition: 0 }).rating).toBe(1400)
    expect(seed(0, { closingTier: 'tier2', closingTierPosition: 0.25 })).toMatchObject({ rating: 1124.75, guard: 'one-rank' })
    expect(seed(0, { closingTier: 'tier3', closingTierPosition: 0.25 })).toMatchObject({ rating: 824.75, guard: 'one-rank' })
    expect(seed(100, { qualified: false })).toMatchObject({ rating: 750, guard: 'unqualified' })
    expect(() => seed(100, { closingTierPosition: 2 })).toThrow()
  })

  test('source weight is applied exactly once and tiny expected-win deltas remain tiny', () => {
    const live = calculatePublicRatingTransition(transition)
    const imported = calculatePublicRatingTransition({ ...transition, sourceWeight: 0.5 })
    expect(imported.delta).toBeCloseTo(live.delta * 0.5, 10)
    expect(calculatePublicRatingTransition({ ...transition, sourceWeight: 0 }).delta).toBe(0)
    expect(calculatePublicRatingTransition({ ...transition, hiddenMuAfterRaw: 25.000001, targetRating: 9000 }).delta).toBeLessThan(0.001)
  })

  test('uncertain players converge faster, established updates are symmetric, and movement is bounded', () => {
    const toward = calculatePublicRatingTransition(transition)
    const away = calculatePublicRatingTransition({ ...transition, targetRating: 0 })
    expect(toward.delta).toBeGreaterThan(away.delta)
    const established = { ...transition, hiddenSigmaBefore: 3, priorRating: 1050, targetRating: 1050 }
    const win = calculatePublicRatingTransition(established)
    const loss = calculatePublicRatingTransition({ ...established, hiddenMuAfterRaw: 24 })
    expect(win.delta).toBeCloseTo(-loss.delta, 10)
    for (const sigma of [1, 3, 5, 25 / 3]) {
      for (const delta of [-1000, -2, 0, 2, 1000]) {
        const result = calculatePublicRatingTransition({ ...transition, hiddenSigmaBefore: sigma, hiddenMuAfterRaw: 25 + delta })
        expect(Number.isFinite(result.after)).toBe(true)
        expect(result.after).toBeGreaterThanOrEqual(0)
        expect(Math.abs(result.delta)).toBeLessThanOrEqual(sigma <= 3 ? 35 : 75)
        expect(result.delta * delta).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('losses cross boundaries in full; only the badge lasts until the next rated game', () => {
    const first = calculatePublicRatingTransition({ ...transition, priorRating: 605, hiddenMuAfterRaw: 22 })
    expect(first.after).toBeLessThan(600)
    const badge = advancePublicRatingBadge(705, 685)
    expect(badge).toBe(700)
    expect(publicRatingBadgeRank(685, badge)).toMatchObject({ tier: 'tier4', division: 2 })
    for (const after of [670, 695, 705]) {
      expect(advancePublicRatingBadge(685, after, badge)).toBeNull()
    }
    expect(publicRatingBadgeRank(695)).toMatchObject({ tier: 'tier4', division: 3 })
    expect(advancePublicRatingBadge(700, 699.5)).toBeNull()
    expect(advancePublicRatingBadge(700, 699.49)).toBe(700)
    const second = calculatePublicRatingTransition({ ...transition, priorRating: first.after, hiddenMuAfterRaw: 22 })
    expect(second.after).toBeLessThan(600)
    expect(calculatePublicRatingTransition({ ...transition, priorRating: 1, hiddenMuAfterRaw: 0 }).after).toBe(0)
  })

  test('replay uses seeds, saved versions, and recorded order rather than input order', () => {
    const events = [2, 1].map(sequence => ({
      ...transition, id: `match-${sequence}`, sequence,
      hiddenTargetScore: 75, calibrationVersion: calibration.version,
    }))
    const calibrations = new Map([[calibration.version, calibration]])
    const result = replayPublicRating({ openingRating: 1400, events, calibrations })
    expect(result.events.map(event => event.id)).toEqual(['match-1', 'match-2'])
    expect(result.events[0]!.before).toBe(1400)
    expect(result.rating).toBe(result.events[1]!.after)
    expect(replayPublicRating({ openingRating: 1400, events: events.toReversed(), calibrations })).toEqual(result)
    expect(replayPublicRating({ openingRating: 1400, events: [], calibrations }).rating).toBe(1400)
    expect(() => replayPublicRating({ openingRating: 1400, events: [events[0]!, events[0]!], calibrations })).toThrow('unique')
    expect(() => replayPublicRating({ openingRating: 1400, events, calibrations: new Map() })).toThrow('Missing calibration')
    expect(() => calculatePublicRatingTransition({ ...transition, formulaVersion: 'future' })).toThrow('Unknown RP formula')
  })
})
