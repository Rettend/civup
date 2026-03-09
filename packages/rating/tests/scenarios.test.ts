import type { FfaEntry, PlayerRating, RatingUpdate } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import {
  DISPLAY_RATING_BASE,
  DISPLAY_RATING_SCALE,
  Z_MULTIPLIER,
  calculateFfaRatings,
  calculateTeamRatings,
  createRating,
  displayRating,
  predictWinProbabilities,
} from '../src/index.ts'

function playerFromDisplay(playerId: string, targetDisplay: number, sigma: number = 5): PlayerRating {
  return {
    playerId,
    mu: ((targetDisplay - DISPLAY_RATING_BASE) / DISPLAY_RATING_SCALE) + (Z_MULTIPLIER * sigma),
    sigma,
  }
}

function playerById(updates: RatingUpdate[], playerId: string): RatingUpdate {
  const update = updates.find(candidate => candidate.playerId === playerId)
  expect(update).toBeDefined()
  return update!
}

function countWinsToReachDisplay(
  targetDisplay: number,
  opponentDisplay: number,
  keepOpponentFresh: boolean,
  maxGames: number = 500,
): number | null {
  let hero = createRating('hero')
  const initialOpponent = playerFromDisplay('opponent', opponentDisplay)
  let opponent = initialOpponent

  for (let game = 1; game <= maxGames; game++) {
    const updates = calculateTeamRatings([
      { players: [hero] },
      { players: [opponent] },
    ])

    hero = {
      playerId: 'hero',
      mu: playerById(updates, 'hero').after.mu,
      sigma: playerById(updates, 'hero').after.sigma,
    }

    const opponentUpdate = playerById(updates, 'opponent')
    opponent = keepOpponentFresh
      ? initialOpponent
      : { playerId: 'opponent', mu: opponentUpdate.after.mu, sigma: opponentUpdate.after.sigma }

    if (displayRating(hero.mu, hero.sigma) >= targetDisplay) return game
  }

  return null
}

function buildEqualFfaEntries(playerCount: number): FfaEntry[] {
  return Array.from({ length: playerCount }, (_, index) => ({
    player: createRating(`p${index + 1}`),
    placement: index + 1,
  }))
}

describe('calculateFfaRatings realistic distributions', () => {
  test.each([
    [6, [37.9, 23.57, 9.25, -5.08, -19.4, -33.72]],
    [7, [38.78, 26.39, 14.0, 1.6, -10.79, -23.18, -35.57]],
    [8, [39.33, 28.45, 17.57, 6.69, -4.19, -15.07, -25.95, -36.83]],
    [9, [39.7, 30.02, 20.35, 10.67, 0.99, -8.68, -18.36, -28.03, -37.71]],
    [10, [39.95, 31.25, 22.55, 13.85, 5.15, -3.55, -12.25, -20.95, -29.65, -38.35]],
  ])('equal-skill %i-player FFAs produce stable placement spreads', (playerCount, expectedDeltas) => {
    const updates = calculateFfaRatings(buildEqualFfaEntries(playerCount))

    expect(updates).toHaveLength(playerCount)

    updates.forEach((update, index) => {
      expect(update.displayDelta).toBeCloseTo(expectedDeltas[index]!, 2)
      if (index > 0) expect(update.displayDelta).toBeLessThan(updates[index - 1]!.displayDelta)
    })
  })

  test('FFA updates are invariant to input order', () => {
    const ordered: FfaEntry[] = [
      { player: playerFromDisplay('p1', 800, 4), placement: 1 },
      { player: playerFromDisplay('p2', 750), placement: 2 },
      { player: playerFromDisplay('p3', 720), placement: 3 },
      { player: playerFromDisplay('p4', 690), placement: 4 },
      { player: playerFromDisplay('p5', 670), placement: 5 },
      { player: playerFromDisplay('p6', 650), placement: 6 },
      { player: playerFromDisplay('p7', 650), placement: 7 },
      { player: playerFromDisplay('p8', 650), placement: 8 },
    ]

    const shuffled = [ordered[5]!, ordered[2]!, ordered[7]!, ordered[0]!, ordered[6]!, ordered[3]!, ordered[1]!, ordered[4]!]
    const orderedByPlayer = new Map(calculateFfaRatings(ordered).map(update => [update.playerId, update]))
    const shuffledByPlayer = new Map(calculateFfaRatings(shuffled).map(update => [update.playerId, update]))

    for (const player of ordered) {
      const left = orderedByPlayer.get(player.player.playerId)
      const right = shuffledByPlayer.get(player.player.playerId)
      expect(left).toBeDefined()
      expect(right).toBeDefined()
      expect(left!.after.mu).toBeCloseTo(right!.after.mu, 8)
      expect(left!.after.sigma).toBeCloseTo(right!.after.sigma, 8)
      expect(left!.displayDelta).toBeCloseTo(right!.displayDelta, 8)
    }
  })

  test('elite players cannot farm huge gains from average 10-player FFA lobbies', () => {
    const heroWinField: FfaEntry[] = [
      { player: playerFromDisplay('hero', 800, 4), placement: 1 },
      ...Array.from({ length: 9 }, (_, index) => ({
        player: playerFromDisplay(`avg${index + 1}`, 650),
        placement: index + 2,
      })),
    ]
    const heroMidField: FfaEntry[] = [
      ...Array.from({ length: 4 }, (_, index) => ({
        player: playerFromDisplay(`avg-top${index + 1}`, 650),
        placement: index + 1,
      })),
      { player: playerFromDisplay('hero', 800, 4), placement: 5 },
      ...Array.from({ length: 5 }, (_, index) => ({
        player: playerFromDisplay(`avg-bot${index + 1}`, 650),
        placement: index + 6,
      })),
    ]

    const winDelta = playerById(calculateFfaRatings(heroWinField), 'hero').displayDelta
    const midDelta = playerById(calculateFfaRatings(heroMidField), 'hero').displayDelta

    expect(winDelta).toBeGreaterThan(5)
    expect(winDelta).toBeLessThan(7)
    expect(midDelta).toBeLessThan(-1)
    expect(midDelta).toBeGreaterThan(-3)
  })
})

describe('duel progression simulations', () => {
  test('new players need sustained wins over average opponents to reach 800', () => {
    const gamesVs650 = countWinsToReachDisplay(800, 650, true)
    const gamesVs700 = countWinsToReachDisplay(800, 700, true)

    expect(gamesVs650).not.toBeNull()
    expect(gamesVs700).not.toBeNull()
    expect(gamesVs650!).toBeGreaterThanOrEqual(80)
    expect(gamesVs650!).toBeLessThanOrEqual(100)
    expect(gamesVs700!).toBeGreaterThanOrEqual(20)
    expect(gamesVs700!).toBeLessThanOrEqual(35)
    expect(gamesVs650!).toBeGreaterThan(gamesVs700!)
  })

  test('farming average duel opponents does not let new players sprint to 1000', () => {
    expect(countWinsToReachDisplay(1000, 700, true)).toBeNull()
    expect(countWinsToReachDisplay(1000, 800, true)).toBeGreaterThan(400)
  })

  test('repeated wins against the same adapting opponent slow progression dramatically', () => {
    const fresh700 = countWinsToReachDisplay(800, 700, true)
    const same700 = countWinsToReachDisplay(800, 700, false)
    const same650 = countWinsToReachDisplay(800, 650, false)

    expect(fresh700).not.toBeNull()
    expect(same700).not.toBeNull()
    expect(same650).not.toBeNull()
    expect(same700!).toBeGreaterThanOrEqual(90)
    expect(same700!).toBeLessThanOrEqual(120)
    expect(same700!).toBeGreaterThan(fresh700! * 3)
    expect(same650!).toBeGreaterThan(350)
    expect(countWinsToReachDisplay(1000, 800, false)).toBeNull()
  })
})

describe('teamer rating scenarios', () => {
  test('mixed 2v2 teams can be near 50-50 while learner gains more than the carry', () => {
    const carry = playerFromDisplay('carry', 800, 4)
    const learner = playerFromDisplay('learner', 650)
    const solid1 = playerFromDisplay('solid1', 720)
    const solid2 = playerFromDisplay('solid2', 720)

    const probabilities = predictWinProbabilities([[carry, learner], [solid1, solid2]])
    const updates = calculateTeamRatings([
      { players: [carry, learner] },
      { players: [solid1, solid2] },
    ])

    const carryUpdate = playerById(updates, 'carry')
    const learnerUpdate = playerById(updates, 'learner')

    expect(probabilities[0]).toBeCloseTo(0.5, 6)
    expect(probabilities[1]).toBeCloseTo(0.5, 6)
    expect(learnerUpdate.displayDelta).toBeGreaterThan(carryUpdate.displayDelta)
    expect(carryUpdate.displayDelta).toBeGreaterThan(0)
  })

  test('mixed-team upsets punish weaker favorites more than the carry', () => {
    const updates = calculateTeamRatings([
      { players: [playerFromDisplay('solid1', 720), playerFromDisplay('solid2', 720)] },
      { players: [playerFromDisplay('carry', 800, 4), playerFromDisplay('learner', 650)] },
    ])

    const carryUpdate = playerById(updates, 'carry')
    const learnerUpdate = playerById(updates, 'learner')

    expect(carryUpdate.displayDelta).toBeLessThan(0)
    expect(learnerUpdate.displayDelta).toBeLessThan(carryUpdate.displayDelta)
  })

  test('elite 3v3 stacks are overwhelming favorites over average stacks', () => {
    const eliteTeam = [
      playerFromDisplay('pro1', 800, 4),
      playerFromDisplay('pro2', 800, 4),
      playerFromDisplay('pro3', 800, 4),
    ]
    const averageTeam = [
      playerFromDisplay('avg1', 650),
      playerFromDisplay('avg2', 650),
      playerFromDisplay('avg3', 650),
    ]

    const probabilities = predictWinProbabilities([eliteTeam, averageTeam])
    const expectedWinUpdates = calculateTeamRatings([
      { players: eliteTeam },
      { players: averageTeam },
    ])
    const upsetUpdates = calculateTeamRatings([
      { players: averageTeam },
      { players: eliteTeam },
    ])

    expect(probabilities[0]).toBeGreaterThan(0.99)
    expect(probabilities[1]).toBeLessThan(0.01)

    for (const playerId of ['pro1', 'pro2', 'pro3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(1)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeLessThan(-6)
    }

    for (const playerId of ['avg1', 'avg2', 'avg3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(1)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeGreaterThan(10)
    }
  })
})
