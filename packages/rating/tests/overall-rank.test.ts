import { expect, test } from 'bun:test'
import { addQualityResult, ageQualityEvidence, nextOverallRankChangeAt, ONE_DIVISION_RANK_POLICY_VERSION, OVERALL_RANK_POLICY_VERSION, QUALITY_HALF_LIFE_MS, resolveOverallRank } from '../src/overall-rank.ts'

const empty = { at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
const base = { recent: empty, lifetimeEliteWins: 5, lifetimeHighRankWins: 20, now: 0 }

test('v2 caps earned bonuses at one step including missing intermediate gates, and reserves the top tier for a qualifying mode', () => {
  const rich = { at: 0, effectiveGames: 100, highRankWins: 50, eliteWins: 20 }
  for (const [rating, expected] of [[700, 800], [800, 900], [1000, 1100], [1100, 1200], [1200, 1300], [1300, 1400], [1400, 1400], [1600, 1500]]) {
    const result = resolveOverallRank({ ...base, policyVersion: ONE_DIVISION_RANK_POLICY_VERSION, recent: rich,
      modes: [{ mode: 'duel', rating: rating!, effectiveGames: 50 }, { mode: 'squad', rating: 500, effectiveGames: 50 }] })
    expect(result.band?.minimum).toBe(expected!)
    expect(result.qualityUplift).toBeLessThanOrEqual(1)
    expect(result.overallRating).toBe(rating === 1600 ? 1600 : null)
  }
  const elite = resolveOverallRank({ ...base, policyVersion: ONE_DIVISION_RANK_POLICY_VERSION, modes: [
    { mode: 'duel', rating: 1600, effectiveGames: 50 }, { mode: 'squad', rating: 1640, effectiveGames: 50 }, { mode: 'ffa', rating: 1800, effectiveGames: 3 } ] })
  expect(elite.band?.minimum).toBe(1500)
  expect(elite.overallRating).toBe(1640)
  expect(elite.sourceMode).toBe('squad')
})

test('v2 remembers the evidence destination behind a capped award and expires only its bonus', () => {
  const input = { ...base, policyVersion: ONE_DIVISION_RANK_POLICY_VERSION, modes: [{ mode: 'duel' as const, rating: 700, effectiveGames: 50 }],
    recent: { at: 0, effectiveGames: 10, highRankWins: 2, eliteWins: 0 } }
  const first = resolveOverallRank(input)
  expect(first.band?.minimum).toBe(800)
  expect(first.qualityMinimum).toBe(900)
  const previous = { policyVersion: ONE_DIVISION_RANK_POLICY_VERSION, minimum: 800, qualityMinimum: first.qualityMinimum }
  expect(resolveOverallRank({ ...input, previous, recent: { ...input.recent, highRankWins: 1.8 } }).band?.minimum).toBe(800)
  const deadline = nextOverallRankChangeAt(first)!
  expect(resolveOverallRank({ ...input, previous, now: deadline }).band?.minimum).toBe(700)
})

test('quality deadlines cross the numerical tolerance and do not grant retention to staged candidates', () => {
  const input = { ...base, modes: [{ mode: 'duel' as const, rating: 1100, effectiveGames: 50 }],
    recent: { at: 0, effectiveGames: 12, highRankWins: 6, eliteWins: 1 } }
  const result = resolveOverallRank(input)
  expect(result.band?.minimum).toBe(1200)
  const stagedDeadline = nextOverallRankChangeAt(result, false)!
  const retainedDeadline = nextOverallRankChangeAt(result)!
  expect(stagedDeadline).toBeLessThan(retainedDeadline)
  expect(resolveOverallRank({ ...input, now: stagedDeadline }).band?.minimum).toBe(1100)
  expect(resolveOverallRank({ ...input, now: retainedDeadline, previous: { policyVersion: OVERALL_RANK_POLICY_VERSION, minimum: 1200 } }).band?.minimum).toBe(1100)
  expect(nextOverallRankChangeAt(resolveOverallRank({ ...input, recent: empty }))).toBeNull()
})

test('quality evidence ages independently of ordinary activity and caps a result to one source-weighted win', () => {
  const first = addQualityResult(empty, { at: 0, effectiveGames: 0.5, highRankWins: 4, eliteWins: 2 })
  expect(first).toEqual({ at: 0, effectiveGames: 0.5, highRankWins: 0.5, eliteWins: 0.5 })
  const aged = ageQualityEvidence(first, QUALITY_HALF_LIFE_MS)
  expect(aged.highRankWins).toBe(0.25)
  const played = addQualityResult(aged, { at: QUALITY_HALF_LIFE_MS, effectiveGames: 1, highRankWins: 0, eliteWins: 0 })
  expect(played.effectiveGames).toBe(1.25)
  expect(played.highRankWins).toBe(0.25)
  expect(() => ageQualityEvidence(played, 0)).toThrow('backwards')
})

test('weak modes cannot lower a specialist, and unqualified modes cannot supply the base', () => {
  const modes = [{ mode: 'squad' as const, rating: 1437, effectiveGames: 150 }]
  const specialist = resolveOverallRank({ ...base, modes })
  const mixed = resolveOverallRank({ ...base, modes: [...modes, { mode: 'duo', rating: 700, effectiveGames: 20 }, { mode: 'ffa', rating: 1600, effectiveGames: 3 }] })
  expect(mixed.band).toEqual(specialist.band)
  expect(mixed.sourceMode).toBe('squad')
  expect(resolveOverallRank({ ...base, modes: [{ mode: 'duel', rating: 1500, effectiveGames: 3 }] }).band).toBeNull()
})

test('additional evidence cannot increase the one-division award', () => {
  const modes = [{ mode: 'duel' as const, rating: 1102, effectiveGames: 64 }]
  expect(resolveOverallRank({ ...base, modes }).band?.minimum).toBe(1100)
  const evidence = { at: 0, effectiveGames: 20, highRankWins: 6, eliteWins: 1 }
  expect(resolveOverallRank({ ...base, modes, recent: evidence }).band?.minimum).toBe(1200)
  expect(resolveOverallRank({ ...base, modes, recent: { ...evidence, highRankWins: 8, eliteWins: 2 } }).band?.minimum).toBe(1200)
  expect(resolveOverallRank({ ...base, modes, recent: { ...evidence, highRankWins: 20, eliteWins: 20 } }).band?.minimum).toBe(1200)
})

test('quality retention has a buffer but old evidence eventually loses only the uplift', () => {
  const input = { ...base, modes: [{ mode: 'squad' as const, rating: 1100, effectiveGames: 100 }], recent: { at: 0, effectiveGames: 12, highRankWins: 5, eliteWins: 1 },
    previous: { policyVersion: OVERALL_RANK_POLICY_VERSION, minimum: 1200 } }
  expect(resolveOverallRank(input).band?.minimum).toBe(1200)
  expect(resolveOverallRank({ ...input, previous: null }).band?.minimum).toBe(1100)
  expect(resolveOverallRank({ ...input, now: QUALITY_HALF_LIFE_MS * 4 }).band?.minimum).toBe(1100)
})

test('the highest tier needs a natural qualifying mode even with abundant recent evidence', () => {
  const modes = [{ mode: 'duel' as const, rating: 1400, effectiveGames: 17 }]
  const recent = { at: 0, effectiveGames: 30, highRankWins: 20, eliteWins: 5 }
  expect(resolveOverallRank({ ...base, modes, recent }).band?.minimum).toBe(1400)
  expect(resolveOverallRank({ ...base, modes: [{ ...modes[0]!, effectiveGames: 18 }], recent }).band?.minimum).toBe(1400)
  expect(resolveOverallRank({ ...base, modes: [{ ...modes[0]!, rating: 1500, effectiveGames: 18 }], recent }).band?.minimum).toBe(1500)
  expect(resolveOverallRank({ ...base, modes: [{ ...modes[0]!, effectiveGames: 18 }], recent: { ...recent, eliteWins: 0 } }).band?.minimum).toBe(1400)
})
