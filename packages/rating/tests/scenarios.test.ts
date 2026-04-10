import type { FfaEntry, PlayerRating, RatingUpdate } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import {
  calculateFfaRatings,
  calculateTeamRatings,
  createRating,
  DEFAULT_MU,
  DEFAULT_SIGMA,
  DISPLAY_RATING_BASE,
  DISPLAY_RATING_SCALE,
  displayRating,
  predictWinProbabilities,
  Z_MULTIPLIER,
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

function simulateFfaPatternDisplayAfterGames(pattern: number[], games: number, playerCount: number = 8): number {
  let hero = createRating('hero')

  for (let game = 1; game <= games; game++) {
    const placement = pattern[(game - 1) % pattern.length]!
    const entries: FfaEntry[] = []

    for (let index = 1; index <= playerCount; index++) {
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
    [6, [47.85, 28.71, 9.57, -9.57, -28.71, -47.85]],
    [7, [54.62, 36.41, 18.21, 0.0, -18.21, -36.41, -54.62]],
    [8, [60.31, 43.08, 25.85, 8.62, -8.62, -25.85, -43.08, -60.31]],
    [9, [65.03, 48.77, 32.52, 16.26, 0.0, -16.26, -32.52, -48.77, -65.03]],
    [10, [68.93, 53.61, 38.29, 22.98, 7.66, -7.66, -22.98, -38.29, -53.61, -68.93]],
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

  test('8-player FFA provisional wins stay more volatile than established ones without exploding', () => {
    const provisional = calculateFfaRatings(buildEqualFfaEntries(8))
    const established = calculateFfaRatings(Array.from({ length: 8 }, (_, index) => ({
      player: playerFromDisplay(`est${index + 1}`, 1000),
      placement: index + 1,
    })))

    const provisionalWinner = playerById(provisional, 'p1')
    const establishedWinner = playerById(established, 'est1')

    expect(provisionalWinner.displayDelta).toBeCloseTo(60.31, 2)
    expect(establishedWinner.displayDelta).toBeCloseTo(28.6, 2)
    expect(provisionalWinner.displayDelta).toBeGreaterThan(establishedWinner.displayDelta + 25)
    expect(provisionalWinner.displayDelta).toBeLessThan(70)
  })

  test('elite players still need top finishes against average 10-player FFA lobbies', () => {
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

    expect(winDelta).toBeGreaterThan(11)
    expect(winDelta).toBeLessThan(13)
    expect(midDelta).toBeLessThan(-5)
    expect(midDelta).toBeGreaterThan(-7)
  })
})

describe('duel progression simulations', () => {
  test('provisional equal-skill duel wins are much more volatile than established ones', () => {
    const provisional = calculateTeamRatings([
      { players: [createRating('new1')] },
      { players: [createRating('new2')] },
    ])
    const established = calculateTeamRatings([
      { players: [playerFromDisplay('est1', 1000)] },
      { players: [playerFromDisplay('est2', 1000)] },
    ])

    const provisionalWinner = playerById(provisional, 'new1')
    const establishedWinner = playerById(established, 'est1')

    expect(provisionalWinner.displayDelta).toBeCloseTo(99.87, 2)
    expect(establishedWinner.displayDelta).toBeCloseTo(54.69, 2)
    expect(provisionalWinner.displayDelta).toBeGreaterThan(establishedWinner.displayDelta + 40)
  })

  test.each([
    [0.5, 1009],
    [0.52, 1028],
    [0.55, 1057],
    [0.6, 1101],
    [0.7, 1167],
    [0.8, 1221],
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

    expect(winner.displayDelta).toBeCloseTo(54.69, 2)
    expect(loser.displayDelta).toBeCloseTo(-54.69, 2)
  })

  test('duel favorites keep normal value until 70% and then taper hard', () => {
    const modestFavorite = calculateTeamRatings([
      { players: [playerFromDisplay('fav-1150', 1150)] },
      { players: [playerFromDisplay('dog-1000', 1000)] },
    ])
    const mediumFavorite = calculateTeamRatings([
      { players: [playerFromDisplay('fav-1200', 1200)] },
      { players: [playerFromDisplay('dog-1000', 1000)] },
    ])
    const heavyFavorite = calculateTeamRatings([
      { players: [playerFromDisplay('fav-1200', 1200)] },
      { players: [playerFromDisplay('dog-800', 800)] },
    ])
    const fullStomp = calculateTeamRatings([
      { players: [playerFromDisplay('fav-1400', 1400)] },
      { players: [playerFromDisplay('dog-800', 800)] },
    ])

    expect(playerById(modestFavorite, 'fav-1150').displayDelta).toBeCloseTo(41.18, 2)
    expect(playerById(mediumFavorite, 'fav-1200').displayDelta).toBeCloseTo(28.16, 2)
    expect(playerById(heavyFavorite, 'fav-1200').displayDelta).toBeCloseTo(3.65, 2)
    expect(playerById(fullStomp, 'fav-1400').displayDelta).toBeCloseTo(0.64, 2)
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
    expect(carryUpdate.displayDelta).toBeGreaterThan(13)
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

  test('stacked favorites in 2v2, 3v3, and 4v4 get sharply discounted expected wins', () => {
    const duoFavorite = [
      playerFromDisplay('duo-pro1', 1200),
      playerFromDisplay('duo-pro2', 1200),
    ]
    const duoAverage = [
      playerFromDisplay('duo-avg1', 1000),
      playerFromDisplay('duo-avg2', 1000),
    ]
    const squadFavorite = [
      playerFromDisplay('squad-pro1', 1200),
      playerFromDisplay('squad-pro2', 1200),
      playerFromDisplay('squad-pro3', 1200),
    ]
    const squadAverage = [
      playerFromDisplay('squad-avg1', 1000),
      playerFromDisplay('squad-avg2', 1000),
      playerFromDisplay('squad-avg3', 1000),
    ]
    const fourStackFavorite = [
      playerFromDisplay('stack4-pro1', 1200),
      playerFromDisplay('stack4-pro2', 1200),
      playerFromDisplay('stack4-pro3', 1200),
      playerFromDisplay('stack4-pro4', 1200),
    ]
    const fourStackAverage = [
      playerFromDisplay('stack4-avg1', 1000),
      playerFromDisplay('stack4-avg2', 1000),
      playerFromDisplay('stack4-avg3', 1000),
      playerFromDisplay('stack4-avg4', 1000),
    ]

    const duoProbabilities = predictWinProbabilities([duoFavorite, duoAverage])
    const squadProbabilities = predictWinProbabilities([squadFavorite, squadAverage])
    const fourStackProbabilities = predictWinProbabilities([fourStackFavorite, fourStackAverage])
    const duoUpdates = calculateTeamRatings([
      { players: duoFavorite },
      { players: duoAverage },
    ])
    const squadUpdates = calculateTeamRatings([
      { players: squadFavorite },
      { players: squadAverage },
    ])
    const fourStackUpdates = calculateTeamRatings([
      { players: fourStackFavorite },
      { players: fourStackAverage },
    ])

    expect(duoProbabilities[0]).toBeCloseTo(0.8468, 3)
    expect(squadProbabilities[0]).toBeCloseTo(0.9008, 3)
    expect(fourStackProbabilities[0]).toBeCloseTo(0.9338, 3)

    for (const playerId of ['duo-pro1', 'duo-pro2']) {
      expect(playerById(duoUpdates, playerId).displayDelta).toBeCloseTo(8.02, 2)
    }
    for (const playerId of ['squad-pro1', 'squad-pro2', 'squad-pro3']) {
      expect(playerById(squadUpdates, playerId).displayDelta).toBeCloseTo(2.87, 2)
    }
    for (const playerId of ['stack4-pro1', 'stack4-pro2', 'stack4-pro3', 'stack4-pro4']) {
      expect(playerById(fourStackUpdates, playerId).displayDelta).toBeCloseTo(1.15, 2)
    }
  })

  test('balanced mixed 3v3 and 4v4 teams still get full-value updates', () => {
    const mixedThree = [
      playerFromDisplay('mix3-carry', 1400),
      playerFromDisplay('mix3-mate1', 1000),
      playerFromDisplay('mix3-mate2', 1000),
    ]
    const balancedThree = [
      playerFromDisplay('bal3-1', 1133),
      playerFromDisplay('bal3-2', 1133),
      playerFromDisplay('bal3-3', 1133),
    ]
    const mixedFour = [
      playerFromDisplay('mix4-carry', 1400),
      playerFromDisplay('mix4-mate1', 1000),
      playerFromDisplay('mix4-mate2', 1000),
      playerFromDisplay('mix4-mate3', 1000),
    ]
    const balancedFour = [
      playerFromDisplay('bal4-1', 1100),
      playerFromDisplay('bal4-2', 1100),
      playerFromDisplay('bal4-3', 1100),
      playerFromDisplay('bal4-4', 1100),
    ]

    const threeProbabilities = predictWinProbabilities([mixedThree, balancedThree])
    const fourProbabilities = predictWinProbabilities([mixedFour, balancedFour])
    const threeUpdates = calculateTeamRatings([
      { players: mixedThree },
      { players: balancedThree },
    ])
    const fourUpdates = calculateTeamRatings([
      { players: mixedFour },
      { players: balancedFour },
    ])

    expect(threeProbabilities[0]).toBeCloseTo(0.5, 2)
    expect(fourProbabilities[0]).toBeCloseTo(0.5, 2)
    expect(playerById(threeUpdates, 'mix3-carry').displayDelta).toBeCloseTo(34.75, 2)
    expect(playerById(fourUpdates, 'mix4-carry').displayDelta).toBeCloseTo(30.54, 2)
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

    expect(probabilities[0]).toBeGreaterThan(0.99)
    expect(probabilities[1]).toBeLessThan(0.01)

    for (const playerId of ['pro1', 'pro2', 'pro3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(4)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeLessThan(-40)
    }

    for (const playerId of ['avg1', 'avg2', 'avg3']) {
      expect(Math.abs(playerById(expectedWinUpdates, playerId).displayDelta)).toBeLessThan(6)
      expect(playerById(upsetUpdates, playerId).displayDelta).toBeGreaterThan(65)
    }
  })
})

describe('multi-team placements (e.g. Red Death 2v2v2v2)', () => {
  test('four equal teams of two use FFA-style spread: symmetric, teammates match', () => {
    const team = (prefix: string) => ({
      players: [createRating(`${prefix}a`), createRating(`${prefix}b`)],
    })

    const updates = calculateTeamRatings([
      team('t1'),
      team('t2'),
      team('t3'),
      team('t4'),
    ])

    expect(updates).toHaveLength(8)

    const byId = new Map(updates.map(u => [u.playerId, u]))
    expect(byId.get('t1a')!.displayDelta).toBeCloseTo(byId.get('t1b')!.displayDelta, 5)
    expect(byId.get('t4a')!.displayDelta).toBeCloseTo(byId.get('t4b')!.displayDelta, 5)

    const first = byId.get('t1a')!.displayDelta
    const second = byId.get('t2a')!.displayDelta
    const third = byId.get('t3a')!.displayDelta
    const fourth = byId.get('t4a')!.displayDelta

    expect(first).toBeGreaterThan(second)
    expect(second).toBeGreaterThan(third)
    expect(third).toBeGreaterThan(fourth)
    expect(first).toBeCloseTo(-fourth, 2)
    expect(second).toBeCloseTo(-third, 2)
  })

  test('predictWin for four equal teams is ~25% each', () => {
    const t = (id: string) => [createRating(id)]
    const probs = predictWinProbabilities([t('a'), t('b'), t('c'), t('d')])
    expect(probs).toHaveLength(4)
    for (const p of probs) {
      expect(p).toBeCloseTo(0.25, 2)
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

    expect(duel60).toBeCloseTo(1101, 0)
    expect(twoVTwo60).toBeCloseTo(1148, 0)
    expect(threeVThree60).toBeCloseTo(1183, 0)
    expect(twoVTwo60).toBeGreaterThan(duel60)
    expect(threeVThree60).toBeGreaterThan(twoVTwo60)
    expect(threeVThree60 - duel60).toBeLessThan(120)
  })

  test('8-player FFA placement patterns move Elo in intuitive directions', () => {
    const averagePattern = simulateFfaPatternDisplayAfterGames([4, 5], 100, 8)
    const slightTopPattern = simulateFfaPatternDisplayAfterGames([4, 4, 4, 5], 100, 8)
    const mildTopPattern = simulateFfaPatternDisplayAfterGames([3, 4, 4, 5], 100, 8)
    const slightBottomPattern = simulateFfaPatternDisplayAfterGames([4, 5, 5, 6], 100, 8)

    expect(averagePattern).toBeGreaterThan(990)
    expect(averagePattern).toBeLessThan(1010)
    expect(slightTopPattern).toBeGreaterThan(1040)
    expect(slightTopPattern).toBeLessThan(1065)
    expect(mildTopPattern).toBeGreaterThan(1090)
    expect(mildTopPattern).toBeLessThan(1120)
    expect(slightBottomPattern).toBeGreaterThan(870)
    expect(slightBottomPattern).toBeLessThan(905)
  })
})
