import { expect, test } from 'bun:test'
import { calculateTeamRatings } from '../src/index.ts'
import { calculatePublicRatingTransition, PUBLIC_RATING_FORMULA_VERSION } from '../src/public-rating.ts'

test('RP policy removes extra favorite-win discount without changing legacy calculations', () => {
  const teams = [{ players: [{ playerId: 'a', mu: 40, sigma: 3, gamesPlayed: 100 }] }, { players: [{ playerId: 'b', mu: 25, sigma: 3, gamesPlayed: 100 }] }]
  const legacy = calculateTeamRatings(teams)
  const next = calculateTeamRatings(teams, { policy: 'rp-v3' })
  expect(next[0]!.displayDelta).toBeGreaterThan(legacy[0]!.displayDelta)
  expect(calculateTeamRatings(teams)).toEqual(legacy)
})

test('newcomer protection reduces only established losers losses and does not treat reset veterans as newcomers', () => {
  const newcomer = { playerId: 'new', mu: 25, sigma: 8, gamesPlayed: 6 }
  const veteran = { playerId: 'veteran', mu: 30, sigma: 3, gamesPlayed: 100 }
  const result = (winnerGames: number, loserGames = 100) => calculateTeamRatings([
    { players: [{ ...newcomer, gamesPlayed: winnerGames }] }, { players: [{ ...veteran, gamesPlayed: loserGames }] },
  ], { policy: 'rp-v3' })
  const protectedResult = result(6)
  const unprotected = result(100)
  expect(protectedResult[0]!.after).toEqual(unprotected[0]!.after)
  expect(protectedResult[1]!.displayDelta).toBeGreaterThan(unprotected[1]!.displayDelta)
  expect(protectedResult[1]!.displayDelta).toBeLessThan(0)
  expect(result(6, 0)[1]!.after).toEqual(unprotected[1]!.after)
})

test('established RP remains influenced by its target without reversing direction', () => {
  const input = { formulaVersion: PUBLIC_RATING_FORMULA_VERSION, priorRating: 1000, hiddenMuBefore: 25, hiddenMuAfterRaw: 26, hiddenSigmaBefore: 3, sourceWeight: 1 }
  const below = calculatePublicRatingTransition({ ...input, targetRating: 1300 })
  const above = calculatePublicRatingTransition({ ...input, targetRating: 700 })
  expect(below.delta).toBeGreaterThan(above.delta)
  expect(above.delta).toBeGreaterThan(0)
  const loss = calculatePublicRatingTransition({ ...input, hiddenMuAfterRaw: 24, targetRating: 1300 })
  expect(loss.delta).toBeLessThan(0)
  expect(-loss.delta).toBeLessThan(below.delta)
})
