import type { PlayerRating, RatingUpdate } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import {
  calculateFfaRatings,
  calculatePublicRatingUpdate,
  calculatePublicRatingUpdateFromStoredEvent,
  calculateTeamRatings,
  createRating,
  DISPLAY_RATING_BASE,
  hiddenRatingScore,
  IMPORTED_GAME_EFFECTIVE_WEIGHT,
  resolvePublicRating,
} from '../src/index.ts'

function byId(updates: RatingUpdate[], playerId: string): RatingUpdate {
  const update = updates.find(candidate => candidate.playerId === playerId)
  if (!update) throw new Error(`Missing update for ${playerId}`)
  return update
}

function publicFromHidden(update: RatingUpdate, prior = DISPLAY_RATING_BASE, sourceWeight = 1) {
  return calculatePublicRatingUpdate({
    priorPublicRating: prior,
    hiddenMuBefore: update.before.mu,
    hiddenMuAfterRaw: update.after.mu,
    sourceWeight,
  })
}

describe('public rating v1 formula', () => {
  test('starts equal duel players near plus/minus 25 instead of the hidden score swing', () => {
    const updates = calculateTeamRatings([
      { players: [createRating('winner')] },
      { players: [createRating('loser')] },
    ])
    const winnerHidden = byId(updates, 'winner')
    const loserHidden = byId(updates, 'loser')
    const winner = publicFromHidden(winnerHidden)
    const loser = publicFromHidden(loserHidden)

    expect(winnerHidden.hiddenScoreDelta).toBeCloseTo(99.87, 2)
    expect(winner.delta).toBeCloseTo(24.98, 2)
    expect(loser.delta).toBeCloseTo(-24.98, 2)
    expect(winner.after).toBeCloseTo(1024.98, 2)
    expect(loser.after).toBeCloseTo(975.02, 2)
  })

  test('applies aligned catch-up but never catch-up away from hidden MMR', () => {
    const towardHidden = calculatePublicRatingUpdate({
      priorPublicRating: 1000,
      hiddenMuBefore: 25 + (200 / 36),
      hiddenMuAfterRaw: 25 + (250 / 36),
    })
    const awayFromHidden = calculatePublicRatingUpdate({
      priorPublicRating: 1000,
      hiddenMuBefore: 25 + (200 / 36),
      hiddenMuAfterRaw: 25 + (150 / 36),
    })

    expect(towardHidden.delta).toBeCloseTo((25 * Math.tanh(2)) + 10, 10)
    expect(awayFromHidden.delta).toBeCloseTo(-(25 * Math.tanh(2)), 10)
    expect(Math.abs(towardHidden.delta)).toBeGreaterThan(Math.abs(awayFromHidden.delta))
  })

  test('caps movement, floors public rating, and preserves zero changes', () => {
    const capped = calculatePublicRatingUpdate({ priorPublicRating: 1000, hiddenMuBefore: 50, hiddenMuAfterRaw: 100 })
    const floored = calculatePublicRatingUpdate({ priorPublicRating: 5, hiddenMuBefore: 25, hiddenMuAfterRaw: -25 })
    const unchanged = calculatePublicRatingUpdate({ priorPublicRating: 1234.5, hiddenMuBefore: 30, hiddenMuAfterRaw: 30 })
    const zeroWeight = calculatePublicRatingUpdate({ priorPublicRating: 1234.5, hiddenMuBefore: 30, hiddenMuAfterRaw: 40, sourceWeight: 0 })

    expect(capped.delta).toBe(35)
    expect(floored).toMatchObject({ before: 5, after: 0, delta: -5 })
    expect(unchanged).toMatchObject({ before: 1234.5, after: 1234.5, delta: 0 })
    expect(zeroWeight).toMatchObject({ before: 1234.5, after: 1234.5, delta: 0 })
  })

  test('weights imported movement exactly once and reconstructs its raw hidden result', () => {
    const live = calculatePublicRatingUpdate({ priorPublicRating: 1000, hiddenMuBefore: 25, hiddenMuAfterRaw: 28 })
    const imported = calculatePublicRatingUpdate({
      priorPublicRating: 1000,
      hiddenMuBefore: 25,
      hiddenMuAfterRaw: 28,
      sourceWeight: IMPORTED_GAME_EFFECTIVE_WEIGHT,
    })
    const replayed = calculatePublicRatingUpdateFromStoredEvent({
      priorPublicRating: 1000,
      hiddenMuBefore: 25,
      hiddenMuAfter: 26.5,
      importedGamesDelta: 1,
      effectiveGamesDelta: IMPORTED_GAME_EFFECTIVE_WEIGHT,
    })

    expect(imported.delta).toBeCloseTo(live.delta / 2, 12)
    expect(replayed).toEqual(imported)
  })

  test('keeps expected-win farming tiny', () => {
    const updates = calculateTeamRatings([
      { players: [{ playerId: 'favorite', mu: 25 + (400 / 36), sigma: 4, gamesPlayed: 30 }] },
      { players: [{ playerId: 'underdog', mu: 25 - (200 / 36), sigma: 4, gamesPlayed: 30 }] },
    ])
    const hidden = byId(updates, 'favorite')
    const publicUpdate = publicFromHidden(hidden, hiddenRatingScore(hidden.before.mu))

    expect(hidden.hiddenScoreDelta).toBeLessThan(1)
    expect(publicUpdate.delta).toBeGreaterThan(0)
    expect(publicUpdate.delta).toBeLessThan(1)
  })

  test('resolves persisted values first and only uses hidden score during transition', () => {
    expect(resolvePublicRating(1111.25, 40)).toBe(1111.25)
    expect(resolvePublicRating(null, 30)).toBe(hiddenRatingScore(30))
    expect(resolvePublicRating(undefined, Number.NaN)).toBe(DISPLAY_RATING_BASE)
  })
})

describe('public rating match mechanics and trajectories', () => {
  test('preserves final hidden direction for established upsets, teams, and FFA placements', () => {
    const upset = calculateTeamRatings([
      { players: [{ playerId: 'dog', mu: 20, sigma: 4, gamesPlayed: 20 }] },
      { players: [{ playerId: 'favorite', mu: 32, sigma: 4, gamesPlayed: 20 }] },
    ])
    const team = calculateTeamRatings([
      { players: [rated('a1'), rated('a2')] },
      { players: [rated('b1'), rated('b2')] },
    ])
    const ffa = calculateFfaRatings(Array.from({ length: 8 }, (_, index) => ({
      player: rated(`f${index + 1}`),
      placement: index + 1,
    })))

    for (const update of [...upset, ...team, ...ffa]) {
      const publicUpdate = publicFromHidden(update, hiddenRatingScore(update.before.mu))
      expect(Math.sign(publicUpdate.delta)).toBe(Math.sign(update.after.mu - update.before.mu))
      expect(Math.abs(publicUpdate.delta)).toBeLessThanOrEqual(35)
    }
    expect(publicFromHidden(byId(upset, 'dog'), hiddenRatingScore(20)).delta).toBeGreaterThan(0)
    expect(publicFromHidden(byId(upset, 'favorite'), hiddenRatingScore(32)).delta).toBeLessThan(0)
    expect(publicFromHidden(byId(ffa, 'f1')).delta).toBeGreaterThan(0)
    expect(publicFromHidden(byId(ffa, 'f8')).delta).toBeLessThan(0)
  })

  test('long win/loss streaks stay finite, nonnegative, and move monotonically', () => {
    let hidden: PlayerRating = createRating('hero')
    let publicRating = DISPLAY_RATING_BASE
    const opponent = rated('opponent')
    const wins: number[] = []
    const losses: number[] = []

    for (let game = 0; game < 40; game++) {
      const update = byId(calculateTeamRatings([{ players: [hidden] }, { players: [opponent] }]), 'hero')
      const publicUpdate = publicFromHidden(update, publicRating)
      hidden = { playerId: 'hero', mu: update.after.mu, sigma: update.after.sigma, gamesPlayed: game + 1 }
      publicRating = publicUpdate.after
      wins.push(publicRating)
    }
    for (let game = 0; game < 60; game++) {
      const update = byId(calculateTeamRatings([{ players: [opponent] }, { players: [hidden] }]), 'hero')
      const publicUpdate = publicFromHidden(update, publicRating)
      hidden = { playerId: 'hero', mu: update.after.mu, sigma: update.after.sigma, gamesPlayed: 40 + game + 1 }
      publicRating = publicUpdate.after
      losses.push(publicRating)
    }

    expect(wins.every((value, index) => Number.isFinite(value) && value >= (wins[index - 1] ?? 0))).toBe(true)
    expect(losses.every((value, index) => Number.isFinite(value) && value <= (losses[index - 1] ?? wins.at(-1)!))).toBe(true)
    expect(publicRating).toBeGreaterThanOrEqual(0)
  })

  test('random finite inputs always produce finite bounded directional movement', () => {
    let seed = 123456789
    const random = () => {
      seed = ((seed * 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }

    for (let index = 0; index < 5_000; index++) {
      const before = random() * 2500
      const muBefore = -10 + (random() * 80)
      const muAfterRaw = -10 + (random() * 80)
      const weight = random()
      const update = calculatePublicRatingUpdate({ priorPublicRating: before, hiddenMuBefore: muBefore, hiddenMuAfterRaw: muAfterRaw, sourceWeight: weight })
      const hiddenDirection = Math.sign(muAfterRaw - muBefore)

      expect(Number.isFinite(update.before)).toBe(true)
      expect(Number.isFinite(update.after)).toBe(true)
      expect(Number.isFinite(update.delta)).toBe(true)
      expect(update.after).toBeGreaterThanOrEqual(0)
      expect(Math.abs(update.delta)).toBeLessThanOrEqual(35)
      if (update.delta !== 0) expect(Math.sign(update.delta)).toBe(hiddenDirection)
    }
  })
})

function rated(playerId: string): PlayerRating {
  return { playerId, mu: 25, sigma: 5, gamesPlayed: 20 }
}
