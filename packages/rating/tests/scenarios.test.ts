import type { FfaEntry, PlayerRating, RatingUpdate } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MU,
  DEFAULT_SIGMA,
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
    mu: DEFAULT_MU + ((targetDisplay - DISPLAY_RATING_BASE) / DISPLAY_RATING_SCALE) + (Z_MULTIPLIER * (sigma - DEFAULT_SIGMA)),
    sigma,
  }
}

function playerById(updates: RatingUpdate[], playerId: string): RatingUpdate {
  const update = updates.find(candidate => candidate.playerId === playerId)
  expect(update).toBeDefined()
  return update!
}

function createLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function simulateDisplayAfterGames(winRate: number, games: number, seed: number): number {
  const random = createLcg(seed)
  let hero = createRating('hero')
  const opponent = playerFromDisplay('opponent', 1000)

  for (let game = 1; game <= games; game++) {
    const heroWon = random() < winRate
    const updates = heroWon
      ? calculateTeamRatings([{ players: [hero] }, { players: [opponent] }])
      : calculateTeamRatings([{ players: [opponent] }, { players: [hero] }])

    const heroUpdate = playerById(updates, 'hero')
    hero = { playerId: 'hero', mu: heroUpdate.after.mu, sigma: heroUpdate.after.sigma }
  }

  return displayRating(hero.mu, hero.sigma)
}

function averageDisplayAfterGames(winRate: number, games: number, seedCount: number = 100): number {
  let total = 0
  for (let seed = 1; seed <= seedCount; seed++) {
    total += simulateDisplayAfterGames(winRate, games, seed)
  }
  return total / seedCount
}

function simulateTeamDisplayAfterGames(teamSize: 2 | 3, winRate: number, games: number, seed: number): number {
  const random = createLcg(seed)
  let hero = createRating('hero')

  for (let game = 1; game <= games; game++) {
    const heroTeam = [
      hero,
      ...Array.from({ length: teamSize - 1 }, (_, index) => playerFromDisplay(`mate${index + 1}`, 1000)),
    ]
    const opponentTeam = Array.from({ length: teamSize }, (_, index) => playerFromDisplay(`opp${index + 1}`, 1000))
    const heroWon = random() < winRate
    const updates = heroWon
      ? calculateTeamRatings([{ players: heroTeam }, { players: opponentTeam }])
      : calculateTeamRatings([{ players: opponentTeam }, { players: heroTeam }])

    const heroUpdate = playerById(updates, 'hero')
    hero = { playerId: 'hero', mu: heroUpdate.after.mu, sigma: heroUpdate.after.sigma }
  }

  return displayRating(hero.mu, hero.sigma)
}

function averageTeamDisplayAfterGames(teamSize: 2 | 3, winRate: number, games: number, seedCount: number = 100): number {
  let total = 0
  for (let seed = 1; seed <= seedCount; seed++) {
    total += simulateTeamDisplayAfterGames(teamSize, winRate, games, seed)
  }
  return total / seedCount
}

function simulateFfaPatternDisplayAfterGames(pattern: number[], games: number): number {
  let hero = createRating('hero')

  for (let game = 1; game <= games; game++) {
    const placement = pattern[(game - 1) % pattern.length]!
    const entries: FfaEntry[] = []

    for (let index = 1; index <= 10; index++) {
      entries.push({
        player: index === placement ? hero : playerFromDisplay(`opp${index}`, 1000),
        placement: index,
      })
    }

    const heroUpdate = playerById(calculateFfaRatings(entries), 'hero')
    hero = { playerId: 'hero', mu: heroUpdate.after.mu, sigma: heroUpdate.after.sigma }
  }

  return displayRating(hero.mu, hero.sigma)
}

function buildEqualFfaEntries(playerCount: number): FfaEntry[] {
  return Array.from({ length: playerCount }, (_, index) => ({
    player: createRating(`p${index + 1}`),
    placement: index + 1,
  }))
}

describe('calculateFfaRatings realistic distributions', () => {
  test.each([
    [6, [44.64, 26.79, 8.93, -8.93, -26.79, -44.64]],
    [7, [43.0, 28.67, 14.33, 0.0, -14.33, -28.67, -43.0]],
    [8, [39.7, 28.36, 17.01, 5.67, -5.67, -17.01, -28.36, -39.7]],
    [9, [37.85, 28.39, 18.93, 9.46, 0.0, -9.46, -18.93, -28.39, -37.85]],
    [10, [34.71, 26.99, 19.28, 11.57, 3.86, -3.86, -11.57, -19.28, -26.99, -34.71]],
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
      { player: playerFromDisplay('hero', 1400, 4), placement: 1 },
      ...Array.from({ length: 9 }, (_, index) => ({
        player: playerFromDisplay(`avg${index + 1}`, 1000),
        placement: index + 2,
      })),
    ]
    const heroMidField: FfaEntry[] = [
      ...Array.from({ length: 4 }, (_, index) => ({
        player: playerFromDisplay(`avg-top${index + 1}`, 1000),
        placement: index + 1,
      })),
      { player: playerFromDisplay('hero', 1400, 4), placement: 5 },
      ...Array.from({ length: 5 }, (_, index) => ({
        player: playerFromDisplay(`avg-bot${index + 1}`, 1000),
        placement: index + 6,
      })),
    ]

    const winDelta = playerById(calculateFfaRatings(heroWinField), 'hero').displayDelta
    const midDelta = playerById(calculateFfaRatings(heroMidField), 'hero').displayDelta

    expect(winDelta).toBeGreaterThan(7)
    expect(winDelta).toBeLessThan(8)
    expect(midDelta).toBeGreaterThan(0)
    expect(midDelta).toBeLessThan(1)
  })
})

describe('duel progression simulations', () => {
  test.each([
    [0.5, 1006],
    [0.52, 1019],
    [0.55, 1039],
    [0.6, 1072],
    [0.7, 1143],
    [0.8, 1230],
  ])('display rating after 100 games reflects a %p duel win rate against 1000 opposition', (winRate, expectedDisplay) => {
    const averageDisplay = averageDisplayAfterGames(winRate, 100)
    expect(averageDisplay).toBeCloseTo(expectedDisplay, 0)
  })

  test('equal established duel players exchange roughly symmetric visible Elo', () => {
    const updates = calculateTeamRatings([
      { players: [playerFromDisplay('p1', 1000)] },
      { players: [playerFromDisplay('p2', 1000)] },
    ])

    const winner = playerById(updates, 'p1')
    const loser = playerById(updates, 'p2')

    expect(winner.displayDelta).toBeCloseTo(33.42, 2)
    expect(loser.displayDelta).toBeCloseTo(-33.42, 2)
  })
})

describe('teamer rating scenarios', () => {
  test('mixed 2v2 teams can be near 50-50 while learner gains more than the carry', () => {
    const carry = playerFromDisplay('carry', 1400, 4)
    const learner = playerFromDisplay('learner', 1000)
    const solid1 = playerFromDisplay('solid1', 1200)
    const solid2 = playerFromDisplay('solid2', 1200)

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
    expect(carryUpdate.displayDelta).toBeGreaterThan(15)
  })

  test('mixed-team upsets punish weaker favorites more than the carry', () => {
    const updates = calculateTeamRatings([
      { players: [playerFromDisplay('solid1', 1200), playerFromDisplay('solid2', 1200)] },
      { players: [playerFromDisplay('carry', 1400, 4), playerFromDisplay('learner', 1000)] },
    ])

    const carryUpdate = playerById(updates, 'carry')
    const learnerUpdate = playerById(updates, 'learner')

    expect(carryUpdate.displayDelta).toBeLessThan(0)
    expect(learnerUpdate.displayDelta).toBeLessThan(carryUpdate.displayDelta)
  })

  test('elite 3v3 stacks are overwhelming favorites over average stacks', () => {
    const eliteTeam = [
      playerFromDisplay('pro1', 1400, 4),
      playerFromDisplay('pro2', 1400, 4),
      playerFromDisplay('pro3', 1400, 4),
    ]
    const averageTeam = [
      playerFromDisplay('avg1', 1000),
      playerFromDisplay('avg2', 1000),
      playerFromDisplay('avg3', 1000),
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

    expect(probabilities[0]).toBeGreaterThan(0.999)
    expect(probabilities[1]).toBeLessThan(0.001)

    for (const playerId of ['pro1', 'pro2', 'pro3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(1)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeLessThan(-25)
    }

    for (const playerId of ['avg1', 'avg2', 'avg3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(1)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeGreaterThan(45)
    }
  })
})

describe('cross-mode progression sanity', () => {
  test('2v2 and 3v3 stay near 1000 at 50% win rate over 100 games', () => {
    const twoVTwo = averageTeamDisplayAfterGames(2, 0.5, 100)
    const threeVThree = averageTeamDisplayAfterGames(3, 0.5, 100)

    expect(twoVTwo).toBeGreaterThan(995)
    expect(twoVTwo).toBeLessThan(1025)
    expect(threeVThree).toBeGreaterThan(995)
    expect(threeVThree).toBeLessThan(1025)
  })

  test('higher team win rates climb in the same general band as duel', () => {
    const duel60 = averageDisplayAfterGames(0.6, 100)
    const twoVTwo60 = averageTeamDisplayAfterGames(2, 0.6, 100)
    const threeVThree60 = averageTeamDisplayAfterGames(3, 0.6, 100)

    expect(duel60).toBeCloseTo(1072, 0)
    expect(twoVTwo60).toBeCloseTo(1103, 0)
    expect(threeVThree60).toBeCloseTo(1125, 0)
    expect(twoVTwo60).toBeGreaterThan(duel60)
    expect(threeVThree60).toBeGreaterThan(twoVTwo60)
    expect(threeVThree60 - duel60).toBeLessThan(60)
  })

  test('10-player FFA placement patterns move Elo in intuitive directions', () => {
    const averagePattern = simulateFfaPatternDisplayAfterGames([5, 6], 100)
    const mildTopPattern = simulateFfaPatternDisplayAfterGames([4, 5, 5, 6], 100)
    const mildBottomPattern = simulateFfaPatternDisplayAfterGames([5, 6, 6, 7], 100)

    expect(averagePattern).toBeGreaterThan(990)
    expect(averagePattern).toBeLessThan(1010)
    expect(mildTopPattern).toBeGreaterThan(1300)
    expect(mildBottomPattern).toBeLessThan(700)
  })
})
