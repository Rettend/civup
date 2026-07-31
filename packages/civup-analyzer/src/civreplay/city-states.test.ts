import { describe, expect, test } from 'bun:test'
import { buildCivReplayCityStateRoster, cityStateCategoryFromLeader, createCityStateResolver } from './city-states.ts'

describe('city-state resolver', () => {
  test('maps minor leader inheritance to city-state categories', () => {
    expect(cityStateCategoryFromLeader('LEADER_MINOR_CIV_BOLOGNA', 'LEADER_MINOR_CIV_SCIENTIFIC')).toBe('scientific')
    expect(cityStateCategoryFromLeader('LEADER_MINOR_CIV_MUSCAT', 'LEADER_MINOR_CIV_TRADE')).toBe('trade')
    expect(cityStateCategoryFromLeader('LEADER_MINOR_CIV_UNKNOWN', 'LEADER_DEFAULT')).toBeNull()
  })

  test('resolves static city-state capitals without a gameplay database', () => {
    const resolver = createCityStateResolver({ loadDefaultTypesDb: false })
    const geneva = resolver.resolveCityName('LOC_CITY_NAME_GENEVA')
    expect(geneva?.civilizationType).toBe('CIVILIZATION_GENEVA')
    expect(geneva?.category).toBe('scientific')
  })
})

describe('buildCivReplayCityStateRoster', () => {
  test('classifies alive minor-owned city-state capitals', () => {
    const resolver = createCityStateResolver({ loadDefaultTypesDb: false })
    const roster = buildCivReplayCityStateRoster([
      { id: 0, cities: [{ id: 0, name: 'LOC_CITY_NAME_WASHINGTON', x: 10, y: 20, population: 5 }] },
      { id: 6, influenceTokensReceived: [2, 5, 0, 5], cities: [{ id: 0, name: 'LOC_CITY_NAME_BOLOGNA', x: 12, y: 22, population: 3 }] },
    ], resolver, { majorPlayerIds: [0] })

    expect(roster.count).toBe(1)
    expect(roster.aliveCount).toBe(1)
    expect(roster.scientificAliveCount).toBe(1)
    expect(roster.cityStates[0]).toMatchObject({
      civilizationType: 'CIVILIZATION_BOLOGNA',
      category: 'scientific',
      ownerKind: 'minor',
      playerId: 6,
      ownerPlayerId: 6,
      status: 'alive',
      envoys: [{ playerId: 0, envoys: 2 }],
      suzerainPlayerId: null,
      suzerainEnvoys: 2,
      suzerainStatus: 'none',
    })
  })

  test('infers suzerain from city-state influence tokens', () => {
    const resolver = createCityStateResolver({ loadDefaultTypesDb: false })
    const roster = buildCivReplayCityStateRoster([
      { id: 0, cities: [{ id: 0, name: 'LOC_CITY_NAME_WASHINGTON', x: 10, y: 20, population: 5 }] },
      { id: 1, cities: [{ id: 0, name: 'LOC_CITY_NAME_LONDON', x: 30, y: 20, population: 5 }] },
      { id: 6, influenceTokensReceived: [2, 5, 0, 3], cities: [{ id: 0, name: 'LOC_CITY_NAME_BOLOGNA', x: 12, y: 22, population: 3 }] },
    ], resolver, { majorPlayerIds: [0, 1, 3] })

    expect(roster.cityStates[0]).toMatchObject({
      envoys: [
        { playerId: 1, envoys: 5 },
        { playerId: 3, envoys: 3 },
        { playerId: 0, envoys: 2 },
      ],
      suzerainPlayerId: 1,
      suzerainEnvoys: 5,
      suzerainStatus: 'suzerained',
    })
  })

  test('keeps captured city-state capitals distinct from suzerain/envoy state', () => {
    const resolver = createCityStateResolver({ loadDefaultTypesDb: false })
    const roster = buildCivReplayCityStateRoster([
      {
        id: 2,
        cities: [
          { id: 0, name: 'LOC_CITY_NAME_WASHINGTON', x: 10, y: 20, population: 8 },
          { id: 1, name: 'LOC_CITY_NAME_JERUSALEM', x: 11, y: 21, population: 4 },
        ],
      },
    ], resolver, { majorPlayerIds: [2] })

    expect(roster.count).toBe(1)
    expect(roster.aliveCount).toBe(0)
    expect(roster.capturedCount).toBe(1)
    expect(roster.cityStates[0]).toMatchObject({
      civilizationType: 'CIVILIZATION_JERUSALEM',
      category: 'religious',
      ownerKind: 'major',
      playerId: null,
      ownerPlayerId: 2,
      status: 'captured',
    })
  })
})
