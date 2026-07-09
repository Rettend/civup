import { expect, test } from 'bun:test'
import { civHash, createHashResolver } from '../hash.ts'
import type { CivReplayCitySnapshot, CivReplayDistrictSnapshot, CivReplayPlayerSnapshot, CivReplayUnitSnapshot } from './players.ts'
import { buildCivReplayTradeRoutes, summarizeCivReplayKnownTradeRouteYields, summarizeCivReplayTradeRoutes, type CivReplayTradeRouteSnapshot } from './trade-routes.ts'

test('builds active trade routes from trader operation endpoint coordinates', () => {
  const foreignCity = city({ id: 4, name: 'Rheims', x: 12, y: 21 })
  const ownerCity = city({ id: 1, name: 'New York', x: 25, y: 29 })
  const players = [
    player({ id: 1, cities: [foreignCity] }),
    player({
      id: 2,
      cities: [ownerCity],
      units: [unit({
        id: 7,
        tradeRouteOperations: [{ destinationX: 12, destinationY: 21, originX: 25, originY: 29 }],
      })],
    }),
  ]

  buildCivReplayTradeRoutes(players)

  expect(players[1]!.tradeRoutes).toEqual([{
    ownerPlayerId: 2,
    traderUnitId: 7,
    originX: 25,
    originY: 29,
    destinationX: 12,
    destinationY: 21,
    originCity: { playerId: 2, cityId: 1, name: 'New York', x: 25, y: 29 },
    destinationCity: { playerId: 1, cityId: 4, name: 'Rheims', x: 12, y: 21 },
    originCityId: 1,
    originCityName: 'New York',
    originCityPlayerId: 2,
    destinationCityId: 4,
    destinationCityName: 'Rheims',
    destinationCityPlayerId: 1,
    relationship: 'international',
    yields: [],
    remainingTurns: null,
    length: null,
  }])
})

test('normalizes endpoint order when the owner city is stored first', () => {
  const players = [
    player({ id: 1, cities: [city({ id: 4, name: 'Rheims', x: 12, y: 21 })] }),
    player({
      id: 2,
      cities: [city({ id: 1, name: 'New York', x: 25, y: 29 })],
      units: [unit({ tradeRouteOperations: [{ destinationX: 25, destinationY: 29, originX: 12, originY: 21 }] })],
    }),
  ]

  buildCivReplayTradeRoutes(players)

  expect(players[1]!.tradeRoutes[0]!.originCityName).toBe('New York')
  expect(players[1]!.tradeRoutes[0]!.destinationCityName).toBe('Rheims')
})

test('summarizes route counts, team routes, and decoded route yields', () => {
  const hashResolver = createHashResolver({ loadDefaultTypesDb: false })
  const scienceHash = civHash('YIELD_SCIENCE')
  const cultureHash = civHash('YIELD_CULTURE')
  const routes = [
    tradeRoute({ ownerPlayerId: 2, destinationCityPlayerId: 2, relationship: 'domestic' }),
    tradeRoute({ ownerPlayerId: 2, destinationCityPlayerId: 1, relationship: 'international', yields: [{ hash: scienceHash, value: 2 }, { hash: cultureHash, value: 1 }] }),
    tradeRoute({ ownerPlayerId: 2, destinationCityPlayerId: null, relationship: 'unknown' }),
  ]

  expect(summarizeCivReplayTradeRoutes(routes, hashResolver, new Map([[1, 7], [2, 7]]))).toEqual({
    activeCount: 3,
    domesticCount: 1,
    internationalCount: 1,
    teamCount: 1,
    unknownDestinationOwnerCount: 1,
    yieldTotals: { YIELD_CULTURE: 1, YIELD_SCIENCE: 2 },
    science: 2,
    culture: 1,
  })
})

test('summarizes known route yields from destination districts and active route policy rules', () => {
  const hashResolver = createHashResolver({ loadDefaultTypesDb: false })
  const players = [
    player({
      id: 1,
      cities: [city({ id: 4, name: 'Rheims', x: 12, y: 21 })],
      districts: [
        district({ cityId: 4, type: civHash('DISTRICT_CITY_CENTER') }),
        district({ cityId: 4, type: civHash('DISTRICT_CAMPUS') }),
        district({ cityId: 4, type: civHash('DISTRICT_THEATER') }),
        district({ cityId: 4, type: civHash('DISTRICT_COMMERCIAL_HUB'), built: 0 }),
      ],
    }),
    player({
      id: 2,
      policies: [[], [], [], [civHash('POLICY_TRADE_CONFEDERATION')]],
      cities: [city({ id: 1, name: 'New York', x: 25, y: 29 })],
      tradeRoutes: [tradeRoute({
        ownerPlayerId: 2,
        originCityId: 1,
        originCityName: 'New York',
        originCityPlayerId: 2,
        destinationCityId: 4,
        destinationCityName: 'Rheims',
        destinationCityPlayerId: 1,
        relationship: 'international',
      })],
    }),
  ]

  expect(summarizeCivReplayKnownTradeRouteYields(players[1]!, players, hashResolver, {
    districtYields: [
      { districtType: 'DISTRICT_CITY_CENTER', yieldType: 'YIELD_GOLD', origin: 0, domesticDestination: 0, internationalDestination: 3 },
      { districtType: 'DISTRICT_CAMPUS', yieldType: 'YIELD_SCIENCE', origin: 0, domesticDestination: 0, internationalDestination: 1 },
      { districtType: 'DISTRICT_THEATER', yieldType: 'YIELD_CULTURE', origin: 0, domesticDestination: 0, internationalDestination: 1 },
      { districtType: 'DISTRICT_COMMERCIAL_HUB', yieldType: 'YIELD_GOLD', origin: 0, domesticDestination: 0, internationalDestination: 3 },
    ],
    policyYields: [
      { policyType: 'POLICY_TRADE_CONFEDERATION', modifierId: 'TRADECONFEDERATION_TRADEROUTESCIENCE', yieldType: 'YIELD_SCIENCE', amount: 1, scope: 'international' },
      { policyType: 'POLICY_TRADE_CONFEDERATION', modifierId: 'TRADECONFEDERATION_TRADEROUTECULTURE', yieldType: 'YIELD_CULTURE', amount: 1, scope: 'international' },
    ],
    unsupportedPolicyModifiers: [],
  })).toEqual({
    yieldTotals: { YIELD_CULTURE: 2, YIELD_GOLD: 3, YIELD_SCIENCE: 2 },
    science: 2,
    culture: 2,
    unsupported: [],
  })
})

test('reports active unsupported route-yield policy modifiers without guessing their value', () => {
  const hashResolver = createHashResolver({ loadDefaultTypesDb: false })
  const foreignPlayer = player({ id: 1, cities: [city({ id: 4, name: 'Rheims', x: 12, y: 21 })] })
  const activePlayer = player({
    id: 2,
    policies: [[], [], [], [civHash('POLICY_WISSELBANKEN')]],
    cities: [city({ id: 1, name: 'New York', x: 25, y: 29 })],
    tradeRoutes: [tradeRoute({
      ownerPlayerId: 2,
      originCityId: 1,
      originCityName: 'New York',
      originCityPlayerId: 2,
      destinationCityId: 4,
      destinationCityName: 'Rheims',
      destinationCityPlayerId: 1,
      relationship: 'international',
    })],
  })

  expect(summarizeCivReplayKnownTradeRouteYields(activePlayer, [foreignPlayer, activePlayer], hashResolver, {
    districtYields: [],
    policyYields: [],
    unsupportedPolicyModifiers: [{
      policyType: 'POLICY_WISSELBANKEN',
      modifierId: 'WISSELBANKEN_TRADEROUTEPRODUCTIONFROMALLY',
      modifierType: 'MODIFIER_PLAYER_ADJUST_TRADE_ROUTE_ORIGIN_YIELD_FOR_ALLY_ROUTE',
    }],
  })).toEqual({
    yieldTotals: {},
    science: 0,
    culture: 0,
    unsupported: ['POLICY_WISSELBANKEN:WISSELBANKEN_TRADEROUTEPRODUCTIONFROMALLY:MODIFIER_PLAYER_ADJUST_TRADE_ROUTE_ORIGIN_YIELD_FOR_ALLY_ROUTE'],
  })
})

function player(overrides: Partial<CivReplayPlayerSnapshot>): CivReplayPlayerSnapshot {
  return {
    id: 0,
    diploFavor: 0,
    goodyHuts: [],
    dedication: null,
    era: null,
    government: null,
    lastTurnChangeGovernment: null,
    policies: [[], [], [], []],
    civics: null,
    techs: null,
    faith: null,
    pantheon: null,
    diploPoint: null,
    gold: null,
    maintenance: null,
    strategicResourceCount: 0,
    unitsCount: [],
    districts: [],
    units: [],
    governors: [],
    improvements: [],
    tradeRouteCount: 0,
    tradeRoutes: [],
    districtCount: 0,
    cityCount: overrides.cities?.length ?? 0,
    cities: [],
    ...overrides,
  }
}

function city(overrides: Partial<CivReplayCitySnapshot>): CivReplayCitySnapshot {
  return {
    id: 0,
    x: 0,
    y: 0,
    population: 1,
    name: 'City',
    religion: 0,
    currentProductionType: null,
    currentProductionItems: [],
    productionProgressCount: 0,
    productionProgress: [],
    builtCount: 0,
    builtItems: [],
    yields: [],
    yields2: [],
    ...overrides,
  }
}

function unit(overrides: Partial<CivReplayUnitSnapshot>): CivReplayUnitSnapshot {
  return {
    id: 1,
    type: 100,
    x: 0,
    y: 0,
    army: 0,
    damage: 0,
    fortified: 0,
    xp: 0,
    level: 0,
    name: 'Trader',
    operationTypes: [],
    tradeRouteOperations: [],
    ...overrides,
  }
}

function district(overrides: Partial<CivReplayDistrictSnapshot>): CivReplayDistrictSnapshot {
  return {
    globalId: 1,
    id: 1,
    x: 0,
    y: 0,
    cityId: 0,
    type: civHash('DISTRICT_CITY_CENTER'),
    damage: 0,
    wallDamage: 0,
    wall: 0,
    cost: 0,
    built: 1,
    pillage: 0,
    ...overrides,
  }
}

function tradeRoute(overrides: Partial<CivReplayTradeRouteSnapshot>): CivReplayTradeRouteSnapshot {
  return {
    ownerPlayerId: 2,
    traderUnitId: 1,
    originX: 0,
    originY: 0,
    destinationX: 0,
    destinationY: 0,
    originCity: null,
    destinationCity: null,
    originCityId: null,
    originCityName: null,
    originCityPlayerId: null,
    destinationCityId: null,
    destinationCityName: null,
    destinationCityPlayerId: null,
    relationship: 'unknown',
    yields: [],
    remainingTurns: null,
    length: null,
    ...overrides,
  }
}
