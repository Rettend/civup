import { expect, test } from 'bun:test'
import type { CivReplayMapTileSnapshot } from './map.ts'
import type { CivReplayCitySnapshot, CivReplayPlayerSnapshot } from './players.ts'
import type { CivReplayUnitSnapshot } from './players.ts'
import type { CivReplayTurnSnapshot } from './snapshot.ts'
import { attachCivReplaySnapshotEvents } from './events.ts'

test('derives government, religion, hut, built item, and initial governor events', () => {
  const snapshots = [
    snapshot(1, [player({
      id: 0,
      government: 1,
      lastTurnChangeGovernment: 1,
      policies: [[10], [], [], []],
      pantheon: 0xFFFFFFFF,
      goodyHuts: [{ hash: 99, value: 1 }],
      cities: [city({ id: 5, religion: 0xFFFFFFFF, builtItems: [{ hash: 100, value: 0xFFFF }, { hash: 101, value: 77 }] })],
    })]),
    snapshot(2, [player({
      id: 0,
      government: 2,
      lastTurnChangeGovernment: 2,
      policies: [[10], [20], [], []],
      pantheon: 3000,
      goodyHuts: [{ hash: 99, value: 2 }, { hash: 98, value: 1 }],
      governors: [{ id: 1, type: 200, player: 0, city: 5, turns: [], promotions: [{ hash: 300, value: 1 }] }],
      cities: [city({ id: 5, religion: 4000, builtItems: [{ hash: 100, value: 1200 }, { hash: 101, value: 77 }, { hash: 102, value: 0xFFFF }] })],
    })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[0]!.events).toEqual([])
  expect(snapshots[1]!.events.filter(event => event.type === 'governmentChanged')).toEqual([{
    type: 'governmentChanged',
    turn: 2,
    playerId: 0,
    previousGovernment: 1,
    currentGovernment: 2,
    previousLastTurnChangeGovernment: 1,
    currentLastTurnChangeGovernment: 2,
    previousPolicies: [[10], [], [], []],
    currentPolicies: [[10], [20], [], []],
  }])
  expect(snapshots[1]!.events.filter(event => event.type === 'goodyHutCategoryCountChanged')).toEqual([
    { type: 'goodyHutCategoryCountChanged', turn: 2, playerId: 0, categoryHash: 98, previousValue: 0, currentValue: 1 },
    { type: 'goodyHutCategoryCountChanged', turn: 2, playerId: 0, categoryHash: 99, previousValue: 1, currentValue: 2 },
  ])
  expect(snapshots[1]!.events.filter(event => event.type === 'pantheonChanged')).toEqual([{
    type: 'pantheonChanged',
    turn: 2,
    playerId: 0,
    previousPantheon: null,
    currentPantheon: 3000,
  }])
  expect(snapshots[1]!.events.filter(event => event.type === 'cityReligionChanged')).toEqual([{
    type: 'cityReligionChanged',
    turn: 2,
    playerId: 0,
    cityId: 5,
    name: 'Capital',
    x: 10,
    y: 20,
    previousReligion: null,
    currentReligion: 4000,
  }])
  expect(snapshots[1]!.events.filter(event => event.type === 'cityBuiltItemCompleted')).toEqual([{
    type: 'cityBuiltItemCompleted',
    turn: 2,
    playerId: 0,
    cityId: 5,
    name: 'Capital',
    x: 10,
    y: 20,
    itemHash: 100,
    previousValue: 0xFFFF,
    currentValue: 1200,
  }])
  expect(snapshots[1]!.events.filter(event => event.type === 'governorAssigned')).toEqual([{
    type: 'governorAssigned',
    turn: 2,
    playerId: 0,
    governorId: 1,
    governorType: 200,
    previousCityId: null,
    currentCityId: 5,
    promotionHashes: [300],
  }])
  expect(snapshots[1]!.events.some(event => event.type === 'governorPromoted')).toBe(false)
})

test('keeps later governor promotions and ignores built item sentinels', () => {
  const snapshots = [
    snapshot(1, [player({
      governors: [{ id: 1, type: 200, player: 0, city: 5, turns: [], promotions: [{ hash: 300, value: 1 }] }],
      cities: [city({ builtItems: [{ hash: 100, value: 700 }, { hash: 101, value: 0xFFFF }, { hash: 102, value: 0 }] })],
    })]),
    snapshot(2, [player({
      governors: [{ id: 1, type: 200, player: 0, city: 6, turns: [], promotions: [{ hash: 300, value: 1 }, { hash: 301, value: 1 }] }],
      cities: [city({ builtItems: [{ hash: 100, value: 900 }, { hash: 101, value: 0xFFFF }, { hash: 102, value: 0 }] })],
    })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.some(event => event.type === 'cityBuiltItemCompleted')).toBe(false)
  expect(snapshots[1]!.events.filter(event => event.type === 'governorAssigned')).toEqual([{
    type: 'governorAssigned',
    turn: 2,
    playerId: 0,
    governorId: 1,
    governorType: 200,
    previousCityId: 5,
    currentCityId: 6,
    promotionHashes: [300, 301],
  }])
  expect(snapshots[1]!.events.filter(event => event.type === 'governorPromoted')).toEqual([{
    type: 'governorPromoted',
    turn: 2,
    playerId: 0,
    governorId: 1,
    governorType: 200,
    promotionHash: 301,
  }])
})

test('derives dedication changes, including same hash with a new record id', () => {
  const hash = 224203560
  const snapshots = [
    snapshot(1, [player({ dedication: null })]),
    snapshot(2, [player({ dedication: { hash, recordId: 10, availableHashes: [hash] } })]),
    snapshot(3, [player({ dedication: { hash, recordId: 11, availableHashes: [hash] } })]),
    snapshot(4, [player({ dedication: { hash, recordId: 11, availableHashes: [hash] } })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.filter(event => event.type === 'dedicationChanged')).toEqual([{
    type: 'dedicationChanged',
    turn: 2,
    playerId: 0,
    previousHash: null,
    currentHash: hash,
    previousRecordId: null,
    currentRecordId: 10,
  }])
  expect(snapshots[2]!.events.filter(event => event.type === 'dedicationChanged')).toEqual([{
    type: 'dedicationChanged',
    turn: 3,
    playerId: 0,
    previousHash: hash,
    currentHash: hash,
    previousRecordId: 10,
    currentRecordId: 11,
  }])
  expect(snapshots[3]!.events.some(event => event.type === 'dedicationChanged')).toBe(false)
})

test('derives age changes without emitting score-only changes', () => {
  const snapshots = [
    snapshot(1, [player({ era: { age: 'normal', currentScore: 18, previousScore: 0, hasGoldenAge: false, hasDarkAge: false } })]),
    snapshot(2, [player({ era: { age: 'normal', currentScore: 22, previousScore: 0, hasGoldenAge: false, hasDarkAge: false } })]),
    snapshot(3, [player({ era: { age: 'golden', currentScore: 45, previousScore: 44, hasGoldenAge: true, hasDarkAge: false } })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.some(event => event.type === 'ageChanged')).toBe(false)
  expect(snapshots[2]!.events.filter(event => event.type === 'ageChanged')).toEqual([{
    type: 'ageChanged',
    turn: 3,
    playerId: 0,
    previousAge: 'normal',
    currentAge: 'golden',
    previousCurrentScore: 22,
    currentCurrentScore: 45,
    previousHasGoldenAge: false,
    currentHasGoldenAge: true,
    previousHasDarkAge: false,
    currentHasDarkAge: false,
  }])
})

test('attributes created units from exact current-player city centers without map data', () => {
  const snapshots = [
    snapshot(1, [player({ units: [], cities: [city({ currentProductionType: 0, currentProductionItems: [100] })] })]),
    snapshot(2, [player({ units: [unit({ x: 10, y: 20 })] })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.filter(event => event.type === 'unitCreated')).toEqual([{
    type: 'unitCreated',
    turn: 2,
    playerId: 0,
    unitId: 1,
    unitType: 100,
    x: 10,
    y: 20,
    name: 'Warrior',
    cityId: 5,
    cityName: 'Capital',
    cityX: 10,
    cityY: 20,
    creationMethod: 'producedOrChopped',
    creationConfidence: 'high',
    creationReason: 'previous city production was this unit type',
    previousCityProductionType: 0,
    currentCityProductionType: null,
    previousCityProductionItems: [100],
    currentCityProductionItems: [],
  }])
})

test('attributes created units from uniquely nearest owner city on map tiles with duplicate city ids', () => {
  const currentPlayerCity = city({ id: 5, x: 10, y: 20, name: 'Capital' })
  const otherPlayerCity = city({ id: 5, x: 30, y: 20, name: 'Other Capital' })
  const snapshots = [
    snapshot(1, [
      player({ id: 0, cities: [currentPlayerCity], units: [] }),
      player({ id: 1, cities: [otherPlayerCity], units: [] }),
    ]),
    snapshot(2, [
      player({ id: 0, cities: [currentPlayerCity], units: [unit({ x: 11, y: 20 })] }),
      player({ id: 1, cities: [otherPlayerCity], units: [] }),
    ], [tile({ x: 11, y: 20, cityId: 5 })]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.filter(event => event.type === 'unitCreated')).toEqual([{
    type: 'unitCreated',
    turn: 2,
    playerId: 0,
    unitId: 1,
    unitType: 100,
    x: 11,
    y: 20,
    name: 'Warrior',
    cityId: 5,
    cityName: 'Capital',
    cityX: 10,
    cityY: 20,
    creationMethod: 'likelyPurchasedOrGranted',
    creationConfidence: 'high',
    creationReason: 'unit appeared while city production stayed on another item',
    previousCityProductionType: null,
    currentCityProductionType: null,
    previousCityProductionItems: [],
    currentCityProductionItems: [],
  }])
})

test('leaves created unit city attribution null for tied or non-current-owned tiles', () => {
  const currentPlayerCity = city({ id: 5, x: 9, y: 20, name: 'Capital' })
  const tiedCity = city({ id: 5, x: 11, y: 20, name: 'Other Capital' })
  const otherOwnedCity = city({ id: 6, x: 30, y: 20, name: 'Other City' })
  const snapshots = [
    snapshot(1, [
      player({ id: 0, cities: [currentPlayerCity], units: [] }),
      player({ id: 1, cities: [tiedCity, otherOwnedCity], units: [] }),
    ]),
    snapshot(2, [
      player({ id: 0, cities: [currentPlayerCity], units: [
        unit({ id: 1, x: 10, y: 20 }),
        unit({ id: 2, x: 29, y: 20 }),
      ] }),
      player({ id: 1, cities: [tiedCity, otherOwnedCity], units: [] }),
    ], [
      tile({ x: 10, y: 20, cityId: 5 }),
      tile({ x: 29, y: 20, cityId: 6 }),
    ]),
  ]

  attachCivReplaySnapshotEvents(snapshots)

  expect(snapshots[1]!.events.filter(event => event.type === 'unitCreated')).toEqual([
    {
      type: 'unitCreated',
      turn: 2,
      playerId: 0,
      unitId: 1,
      unitType: 100,
      x: 10,
      y: 20,
      name: 'Warrior',
      cityId: null,
      cityName: null,
      cityX: null,
      cityY: null,
      creationMethod: 'unknown',
      creationConfidence: 'low',
      creationReason: 'unit creation could not be attributed to a city',
      previousCityProductionType: null,
      currentCityProductionType: null,
      previousCityProductionItems: [],
      currentCityProductionItems: [],
    },
    {
      type: 'unitCreated',
      turn: 2,
      playerId: 0,
      unitId: 2,
      unitType: 100,
      x: 29,
      y: 20,
      name: 'Warrior',
      cityId: null,
      cityName: null,
      cityX: null,
      cityY: null,
      creationMethod: 'unknown',
      creationConfidence: 'low',
      creationReason: 'unit creation could not be attributed to a city',
      previousCityProductionType: null,
      currentCityProductionType: null,
      previousCityProductionItems: [],
      currentCityProductionItems: [],
    },
  ])
})

function snapshot(turn: number, players: CivReplayPlayerSnapshot[], tiles: CivReplayMapTileSnapshot[] = []): CivReplayTurnSnapshot {
  return {
    index: turn,
    saveName: `AutoSave_${turn.toString().padStart(4, '0')}.Civ6Save`,
    turnFromName: turn,
    compressedSizeBytes: null,
    uncompressedSizeBytes: 0,
    packetArrayCount: 0,
    compressedBlobCount: 0,
    stateBlobOffset: 0,
    stateBlobSourceLengthBytes: 0,
    stateBlobDeflatedSizeBytes: 0,
    stateBlobInflatedSizeBytes: 0,
    gameRandomSeed: null,
    mapRandomSeed: null,
    map: {
      startOffset: 0,
      endOffset: 0,
      width: 0,
      height: null,
      tileCount: tiles.length,
      tiles,
      ownedTileCount: tiles.filter(tile => tile.cityId != null).length,
      cityTileCount: 0,
      districtTileCount: 0,
      wonderTileCount: 0,
      overlayTileCount: 0,
      pillagedTileCount: 0,
      roadTileCount: 0,
      terrainCounts: {},
      featureCounts: {},
      resourceCounts: {},
      improvementCounts: {},
    },
    players: {
      startOffset: 0,
      internalPlayerCount: players.length,
      religionCount: 0,
      parsedPlayerCount: players.length,
      cityCount: players.reduce((sum, player) => sum + player.cities.length, 0),
      players,
    },
    cityStates: {
      count: 0,
      aliveCount: 0,
      capturedCount: 0,
      scientificCount: 0,
      scientificAliveCount: 0,
      sources: [],
      cityStates: [],
    },
    events: [],
    timestamp: null,
  }
}

function player(overrides: Partial<CivReplayPlayerSnapshot> = {}): CivReplayPlayerSnapshot {
  const value: CivReplayPlayerSnapshot = {
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
    cityCount: 0,
    cities: [city()],
    ...overrides,
  }
  value.cityCount = value.cities.length
  value.districtCount = value.districts.length
  return value
}

function city(overrides: Partial<CivReplayCitySnapshot> = {}): CivReplayCitySnapshot {
  const value: CivReplayCitySnapshot = {
    id: 5,
    x: 10,
    y: 20,
    population: 1,
    name: 'Capital',
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
  value.builtCount = value.builtItems.length
  return value
}

function unit(overrides: Partial<CivReplayUnitSnapshot> = {}): CivReplayUnitSnapshot {
  return {
    id: 1,
    type: 100,
    x: 10,
    y: 20,
    army: 0,
    damage: 0,
    fortified: 0,
    xp: 0,
    level: 0,
    name: 'Warrior',
    operationTypes: [],
    tradeRouteOperations: [],
    ...overrides,
  }
}

function tile(overrides: Partial<CivReplayMapTileSnapshot> = {}): CivReplayMapTileSnapshot {
  return {
    index: 0,
    x: 10,
    y: 20,
    terrain: 0,
    feature: 0,
    resource: 0,
    resourceCount: 0,
    improvement: 0,
    road: 0,
    roadLevel: 0,
    appeal: 0,
    pillage: 0,
    found: 0,
    cityId: null,
    cityToken: null,
    ownershipToken: null,
    districtId: null,
    districtToken: null,
    wonder: null,
    ...overrides,
  }
}
