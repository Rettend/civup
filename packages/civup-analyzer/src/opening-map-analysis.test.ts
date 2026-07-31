import { expect, test } from 'bun:test'
import type { CivReplayMapSnapshot, CivReplayMapTileSnapshot } from './civreplay/map.ts'
import type { CivReplayCitySnapshot, CivReplayDistrictSnapshot, CivReplayPlayerSnapshot } from './civreplay/players.ts'
import type { CivReplayTurnSnapshot } from './civreplay/snapshot.ts'
import { civHash, formatHash, type HashResolver } from './hash.ts'
import {
  buildDistrictAdjacencyChanges,
  buildDistrictCostChanges,
  buildLuxuryOwnershipChanges,
  type OpeningMapAnalysisData,
} from './opening-map-analysis.ts'

test('computes district adjacency changes and luxury ownership changes from map tiles', () => {
  const hashResolver = testHashResolver([
    'DISTRICT_CITY_CENTER',
    'DISTRICT_HARBOR',
    'IMPROVEMENT_PLANTATION',
    'RESOURCE_SPICES',
    'TERRAIN_COAST',
    'TERRAIN_GRASS',
    'YIELD_GOLD',
  ])
  const data: OpeningMapAnalysisData = {
    adjacencyRules: [
      adjacencyRule({ id: 'Harbor_City', yieldChange: 2, adjacentDistrict: 'DISTRICT_CITY_CENTER' }),
      adjacencyRule({ id: 'Harbor_Luxury', adjacentResourceClass: 'RESOURCECLASS_LUXURY' }),
      adjacencyRule({ id: 'Harbor_River', yieldChange: 2, adjacentRiver: true }),
    ],
    luxuryResourceHashes: new Set([hash('RESOURCE_SPICES')]),
    resourceClasses: new Map([[hash('RESOURCE_SPICES'), 'RESOURCECLASS_LUXURY']]),
    districtDefinitions: new Map(),
    districtReplacements: new Map(),
    gameSpeeds: new Map(),
    progressionTotals: { tech: 0, civic: 0 },
    tradeRouteDistrictYields: [],
    tradeRoutePolicyYields: [],
    unsupportedTradeRoutePolicyModifiers: [],
  }
  const snapshots = [openingSnapshot(1, 'none'), openingSnapshot(2, 'unimproved'), openingSnapshot(3, 'improved')]

  expect(buildDistrictAdjacencyChanges(snapshots, 0, hashResolver, data)).toEqual([
    {
      turn: 1,
      cityId: 5,
      cityName: 'Capital',
      districtGlobalId: 20,
      districtId: 1,
      districtType: 'DISTRICT_HARBOR',
      x: 2,
      y: 2,
      built: false,
      totals: { YIELD_GOLD: 2 },
      parts: [{ id: 'Harbor_City', yieldType: 'YIELD_GOLD', value: 2, count: 1, tilesRequired: 1 }],
      unsupported: ['AdjacentRiver'],
    },
    {
      turn: 2,
      cityId: 5,
      cityName: 'Capital',
      districtGlobalId: 20,
      districtId: 1,
      districtType: 'DISTRICT_HARBOR',
      x: 2,
      y: 2,
      built: false,
      totals: { YIELD_GOLD: 3 },
      parts: [
        { id: 'Harbor_City', yieldType: 'YIELD_GOLD', value: 2, count: 1, tilesRequired: 1 },
        { id: 'Harbor_Luxury', yieldType: 'YIELD_GOLD', value: 1, count: 1, tilesRequired: 1 },
      ],
      unsupported: ['AdjacentRiver'],
    },
  ])

  expect(buildLuxuryOwnershipChanges(snapshots, 0, hashResolver, data)).toEqual([
    {
      turn: 2,
      resources: [{ resourceType: 'RESOURCE_SPICES', x: 3, y: 2, cityId: 5, cityName: 'Capital', improved: false, improvementType: null }],
    },
    {
      turn: 3,
      resources: [{ resourceType: 'RESOURCE_SPICES', x: 3, y: 2, cityId: 5, cityName: 'Capital', improved: true, improvementType: 'IMPROVEMENT_PLANTATION' }],
    },
  ])
})

test('flags district placements whose saved cost is below estimated full cost', () => {
  const hashResolver = testHashResolver(['DISTRICT_CITY_CENTER', 'DISTRICT_CAMPUS'])
  const data: OpeningMapAnalysisData = {
    adjacencyRules: [],
    luxuryResourceHashes: new Set(),
    resourceClasses: new Map(),
    districtDefinitions: new Map([[
      'DISTRICT_CAMPUS',
      {
        districtType: 'DISTRICT_CAMPUS',
        cost: 54,
        prereqTech: 'TECH_WRITING',
        prereqCivic: null,
        requiresPlacement: true,
        requiresPopulation: true,
        cityCenter: false,
        aqueduct: false,
        internalOnly: false,
        costProgressionModel: 'COST_PROGRESSION_NUM_UNDER_AVG_PLUS_TECH',
        costProgressionParam1: 35,
        maxPerPlayer: -1,
      },
    ]]),
    districtReplacements: new Map(),
    gameSpeeds: new Map([['GAMESPEED_ONLINE', { gameSpeedType: 'GAMESPEED_ONLINE', costMultiplier: 50 }]]),
    progressionTotals: { tech: 100, civic: 100 },
    tradeRouteDistrictYields: [],
    tradeRoutePolicyYields: [],
    unsupportedTradeRoutePolicyModifiers: [],
  }
  const snapshot = openingSnapshot(1, 'none')
  snapshot.players.players[0]!.districts.push(district({ globalId: 40, id: 2, cityId: 5, x: 3, y: 2, type: hash('DISTRICT_CAMPUS'), cost: 14 }))

  expect(buildDistrictCostChanges([snapshot], 0, hashResolver, data, 'GAMESPEED_ONLINE')).toEqual([{
    turn: 1,
    cityId: 5,
    cityName: 'Capital',
    districtGlobalId: 40,
    districtId: 2,
    districtType: 'DISTRICT_CAMPUS',
    canonicalDistrictType: 'DISTRICT_CAMPUS',
    x: 3,
    y: 2,
    observedCost: 14,
    estimatedFullCost: 27,
    discountPercent: 0.4814814814814815,
    likelyDiscounted: true,
    completedTechCount: 0,
    completedCivicCount: 0,
    gameSpeed: 'GAMESPEED_ONLINE',
    reason: 'observed saved cost is substantially below estimated full district cost',
  }])
})

type ResourceState = 'none' | 'unimproved' | 'improved'

function openingSnapshot(turn: number, resourceState: ResourceState): CivReplayTurnSnapshot {
  const capital = city({ id: 5, name: 'Capital', x: 1, y: 2 })
  const rivalCity = city({ id: 5, name: 'Rival', x: 5, y: 4 })
  const players = [
    player({
      id: 0,
      cities: [capital],
      districts: [
        district({ globalId: 10, id: 0, cityId: 5, x: 1, y: 2, type: hash('DISTRICT_CITY_CENTER'), built: 1 }),
        district({ globalId: 20, id: 1, cityId: 5, x: 2, y: 2, type: hash('DISTRICT_HARBOR'), built: 0 }),
      ],
    }),
    player({
      id: 1,
      cities: [rivalCity],
      districts: [district({ globalId: 30, id: 0, cityId: 5, x: 5, y: 4, type: hash('DISTRICT_CITY_CENTER'), built: 1 })],
    }),
  ]
  return {
    index: turn,
    saveName: `AutoSave_${turn}.Civ6Save`,
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
    map: mapSnapshot(resourceState),
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

function mapSnapshot(resourceState: ResourceState): CivReplayMapSnapshot {
  const width = 6
  const height = 5
  const tiles = Array.from({ length: width * height }, (_, index) => {
    const x = index % width
    const y = Math.floor(index / width)
    const tile = mapTile({ index, x, y })
    if ((x === 1 && y === 2) || (x === 2 && y === 2) || (x === 3 && y === 2)) tile.cityId = 5
    if (x === 1 && y === 2) tile.districtId = 0
    if (x === 2 && y === 2) tile.districtId = 1
    if (x === 3 && y === 2 && resourceState !== 'none') {
      tile.resource = hash('RESOURCE_SPICES')
      tile.resourceCount = 1
      if (resourceState === 'improved') tile.improvement = hash('IMPROVEMENT_PLANTATION')
    }
    return tile
  })
  return {
    startOffset: 0,
    endOffset: 0,
    width,
    height,
    tileCount: tiles.length,
    tiles,
    ownedTileCount: tiles.filter(tile => tile.cityId != null).length,
    cityTileCount: tiles.filter(tile => tile.cityId != null).length,
    districtTileCount: tiles.filter(tile => tile.districtId != null).length,
    wonderTileCount: 0,
    overlayTileCount: 0,
    pillagedTileCount: 0,
    roadTileCount: 0,
    terrainCounts: {},
    featureCounts: {},
    resourceCounts: {},
    improvementCounts: {},
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
    cities: [],
    ...overrides,
  }
  value.cityCount = value.cities.length
  value.districtCount = value.districts.length
  return value
}

function city(overrides: Partial<CivReplayCitySnapshot> = {}): CivReplayCitySnapshot {
  return {
    id: 5,
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

function district(overrides: Partial<CivReplayDistrictSnapshot> = {}): CivReplayDistrictSnapshot {
  return {
    globalId: 0,
    id: 0,
    x: 0,
    y: 0,
    cityId: 5,
    type: hash('DISTRICT_HARBOR'),
    damage: 0,
    wallDamage: 0,
    wall: 0,
    cost: 0,
    built: 0,
    pillage: 0,
    ...overrides,
  }
}

function mapTile(overrides: Partial<CivReplayMapTileSnapshot> = {}): CivReplayMapTileSnapshot {
  return {
    index: 0,
    x: 0,
    y: 0,
    terrain: hash('TERRAIN_COAST'),
    feature: 0,
    resource: 0,
    resourceCount: 0,
    improvement: 0,
    road: 0,
    roadLevel: 0,
    appeal: 0,
    pillage: 0,
    found: 0x40,
    cityId: null,
    cityToken: null,
    ownershipToken: null,
    districtId: null,
    districtToken: null,
    wonder: null,
    ...overrides,
  }
}

function adjacencyRule(overrides: Partial<OpeningMapAnalysisData['adjacencyRules'][number]> = {}): OpeningMapAnalysisData['adjacencyRules'][number] {
  return {
    id: 'Harbor_Luxury',
    districtType: 'DISTRICT_HARBOR',
    yieldType: 'YIELD_GOLD',
    yieldChange: 1,
    tilesRequired: 1,
    adjacentDistrict: null,
    otherDistrictAdjacent: false,
    adjacentTerrain: null,
    adjacentFeature: null,
    adjacentResource: null,
    adjacentResourceClass: null,
    adjacentImprovement: null,
    adjacentSeaResource: false,
    adjacentWonder: false,
    adjacentNaturalWonder: false,
    adjacentRiver: false,
    prereqTech: null,
    prereqCivic: null,
    obsoleteTech: null,
    self: false,
    ...overrides,
  }
}

function testHashResolver(types: readonly string[]): HashResolver {
  const entries = types.map(type => [hash(type), type] as [number, string])
  const names = new Map(entries)
  return {
    sources: ['test'],
    typesDbPath: null,
    resolve(hash) {
      return names.get(hash) ?? null
    },
    resolveOrHash(hash) {
      return names.get(hash) ?? formatHash(hash)
    },
    entries() {
      return [...entries]
    },
  }
}

function hash(type: string): number {
  return civHash(type)
}
