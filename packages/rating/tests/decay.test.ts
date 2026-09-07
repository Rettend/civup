import { expect, test } from 'bun:test'
import { calculatePublicRatingTransition, PUBLIC_RATING_FORMULA_VERSION } from '../src/public-rating.ts'
import { recordPublicRatingDecayGame, settlePublicRatingDecay } from '../src/decay.ts'

const DAY = 86_400_000
const policy = { version: 'rp-decay-v1', enabledAt: DAY }
const at = (days: number) => policy.enabledAt + days * DAY

test('decay starts only at 1550, grants 60 days, continues below entry, and stops at Elite', () => {
  expect(settlePublicRatingDecay(1549, null, at(100), policy).rating).toBe(1549)
  const opening = settlePublicRatingDecay(1600, null, at(0), policy)
  expect(settlePublicRatingDecay(1600, opening.state, at(60), policy).rating).toBe(1600)
  const first = settlePublicRatingDecay(1600, opening.state, at(90), policy)
  expect(first.rating).toBe(1540)
  expect(settlePublicRatingDecay(first.rating, first.state, at(100), policy).rating).toBe(1520)
  const floor = settlePublicRatingDecay(first.rating, first.state, at(400), policy)
  expect(floor.rating).toBe(1500)
  expect(floor.state?.active).toBe(false)
})

test('each native game adds 14 days without exceeding 60 or resetting an exhausted reserve', () => {
  const initial = settlePublicRatingDecay(1600, null, at(0), policy)
  const before = settlePublicRatingDecay(1600, initial.state, at(59), policy)
  expect(recordPublicRatingDecayGame(1610, before.state, at(59), policy)?.bankUntil).toBe(at(74))
  expect(recordPublicRatingDecayGame(1610, initial.state, at(0), policy)?.bankUntil).toBe(at(60))
  const exhausted = settlePublicRatingDecay(1600, initial.state, at(70), policy)
  expect(recordPublicRatingDecayGame(1590, exhausted.state, at(70), policy)?.bankUntil).toBe(at(84))
  expect(recordPublicRatingDecayGame(1590, exhausted.state, at(70), policy, false)?.bankUntil).toBe(at(60))
})

test('no retroactive penalty, reads are repeatable, and a genuine loss can go below the decay floor', () => {
  expect(settlePublicRatingDecay(1800, null, policy.enabledAt - 1, policy)).toEqual({ rating: 1800, state: null, delta: 0 })
  const a = settlePublicRatingDecay(1600, null, at(80), policy)
  expect(settlePublicRatingDecay(a.rating, a.state, at(80), policy)).toMatchObject({ rating: a.rating, delta: 0 })
  expect(settlePublicRatingDecay(1480, a.state, at(90), policy).rating).toBe(1480)
  const demoted = recordPublicRatingDecayGame(1480, a.state, at(80), policy)
  expect(demoted?.active).toBe(false)
  expect(recordPublicRatingDecayGame(1520, demoted, at(80), policy)?.active).toBe(false)
  expect(recordPublicRatingDecayGame(1550, demoted, at(80), policy)?.active).toBe(true)
})

test('recovery uses the returning player’s own RP gap, not an opponent-funded transfer', () => {
  const input = { formulaVersion: PUBLIC_RATING_FORMULA_VERSION, hiddenMuBefore: 40, hiddenMuAfterRaw: 40.4, hiddenSigmaBefore: 3, targetRating: 1600, sourceWeight: 1 }
  const normal = calculatePublicRatingTransition({ ...input, priorRating: 1600 })
  const returning = calculatePublicRatingTransition({ ...input, priorRating: 1500 })
  expect(returning.delta).toBeGreaterThan(normal.delta)
  expect(returning.delta).toBeLessThan(35)
})
