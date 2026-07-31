import { Database } from 'bun:sqlite'
import type { CivReplayMapTileSnapshot } from './civreplay/map.ts'
import type {
  CivReplayCitySnapshot,
  CivReplayDistrictSnapshot,
  CivReplayPlayerSnapshot,
  CivReplayProgressionSnapshot,
} from './civreplay/players.ts'
import type { CivReplayTurnSnapshot } from './civreplay/snapshot.ts'
import type {
  CivReplayTradeRouteDistrictYieldRule,
  CivReplayTradeRoutePolicyYieldRule,
  CivReplayTradeRoutePolicyYieldScope,
  CivReplayTradeRouteUnsupportedPolicyModifier,
} from './civreplay/trade-routes.ts'
import { createCivReplayCityAttributionContext, inferTileOwningCity } from './civreplay/city-attribution.ts'
import { civHash, formatHash, type HashResolver } from './hash.ts'

export interface CivupOpeningDistrictAdjacencyChange {
  turn: number | null
  cityId: number
  cityName: string | null
  districtGlobalId: number
  districtId: number
  districtType: string
  x: number
  y: number
  built: boolean
  totals: Record<string, number>
  parts: CivupOpeningDistrictAdjacencyPart[]
  unsupported: string[]
}

export interface CivupOpeningDistrictAdjacencyPart {
  id: string
  yieldType: string
  value: number
  count: number
  tilesRequired: number
}

export interface CivupOpeningLuxuryOwnershipChange {
  turn: number | null
  resources: CivupOpeningLuxuryResource[]
}

export interface CivupOpeningLuxuryResource {
  resourceType: string
  x: number
  y: number
  cityId: number
  cityName: string
  improved: boolean
  improvementType: string | null
}

export interface CivupOpeningDistrictCostChange {
  turn: number | null
  cityId: number
  cityName: string | null
  districtGlobalId: number
  districtId: number
  districtType: string
  canonicalDistrictType: string
  x: number
  y: number
  observedCost: number
  estimatedFullCost: number | null
  discountPercent: number | null
  likelyDiscounted: boolean
  completedTechCount: number
  completedCivicCount: number
  gameSpeed: string | null
  reason: string
}

export interface OpeningMapAnalysisData {
  adjacencyRules: OpeningDistrictAdjacencyRule[]
  luxuryResourceHashes: Set<number>
  resourceClasses: Map<number, string>
  districtDefinitions: Map<string, OpeningDistrictDefinition>
  districtReplacements: Map<string, string>
  gameSpeeds: Map<string, OpeningGameSpeedDefinition>
  progressionTotals: OpeningProgressionTotals
  tradeRouteDistrictYields: CivReplayTradeRouteDistrictYieldRule[]
  tradeRoutePolicyYields: CivReplayTradeRoutePolicyYieldRule[]
  unsupportedTradeRoutePolicyModifiers: CivReplayTradeRouteUnsupportedPolicyModifier[]
}

export interface OpeningDistrictAdjacencyRule {
  id: string
  districtType: string
  yieldType: string
  yieldChange: number
  tilesRequired: number
  adjacentDistrict: string | null
  otherDistrictAdjacent: boolean
  adjacentTerrain: string | null
  adjacentFeature: string | null
  adjacentResource: string | null
  adjacentResourceClass: string | null
  adjacentImprovement: string | null
  adjacentSeaResource: boolean
  adjacentWonder: boolean
  adjacentNaturalWonder: boolean
  adjacentRiver: boolean
  prereqTech: string | null
  prereqCivic: string | null
  obsoleteTech: string | null
  self: boolean
}

export interface OpeningDistrictDefinition {
  districtType: string
  cost: number
  prereqTech: string | null
  prereqCivic: string | null
  requiresPlacement: boolean
  requiresPopulation: boolean
  cityCenter: boolean
  aqueduct: boolean
  internalOnly: boolean
  costProgressionModel: string | null
  costProgressionParam1: number | null
  maxPerPlayer: number
}

export interface OpeningGameSpeedDefinition {
  gameSpeedType: string
  costMultiplier: number
}

export interface OpeningProgressionTotals {
  tech: number
  civic: number
}

const LIKELY_DISTRICT_DISCOUNT_RATIO = 0.8
const LIKELY_DISTRICT_DISCOUNT_MIN_DELTA = 8

interface AdjacencyRow {
  [key: string]: unknown
}

interface ResourceRow {
  ResourceType: string | null
  ResourceClassType: string | null
}

interface DistrictRow {
  [key: string]: unknown
}

interface DistrictReplacementRow {
  CivUniqueDistrictType: string | null
  ReplacesDistrictType: string | null
}

interface GameSpeedRow {
  GameSpeedType: string | null
  CostMultiplier: number | null
}

interface CountRow {
  count: number
}

interface TradeRouteDistrictYieldRow {
  DistrictType: string | null
  YieldType: string | null
  YieldChangeAsOrigin: number | null
  YieldChangeAsDomesticDestination: number | null
  YieldChangeAsInternationalDestination: number | null
}

interface PolicyModifierRow {
  PolicyType: string | null
  ModifierId: string | null
  ModifierType: string | null
  YieldType: string | null
  Amount: string | number | null
}

interface DistrictRef {
  player: CivReplayPlayerSnapshot
  district: CivReplayDistrictSnapshot
  districtType: string
}

interface OwnedTileRef {
  tile: CivReplayMapTileSnapshot
  city: CivReplayCitySnapshot
}

export function createEmptyOpeningMapAnalysisData(): OpeningMapAnalysisData {
  return {
    adjacencyRules: [],
    luxuryResourceHashes: new Set(),
    resourceClasses: new Map(),
    districtDefinitions: new Map(),
    districtReplacements: new Map(),
    gameSpeeds: new Map(),
    progressionTotals: { tech: 0, civic: 0 },
    tradeRouteDistrictYields: [],
    tradeRoutePolicyYields: [],
    unsupportedTradeRoutePolicyModifiers: [],
  }
}

export function loadOpeningMapAnalysisData(hashResolver: HashResolver): OpeningMapAnalysisData {
  if (!hashResolver.typesDbPath) return createEmptyOpeningMapAnalysisData()

  try {
    const db = new Database(hashResolver.typesDbPath, { readonly: true })
    try {
      const resourceClasses = loadResourceClasses(db)
      const tradeRoutePolicyYields = loadTradeRoutePolicyYields(db)
      return {
        adjacencyRules: loadDistrictAdjacencyRules(db),
        luxuryResourceHashes: new Set([...resourceClasses].filter(([, resourceClass]) => resourceClass === 'RESOURCECLASS_LUXURY').map(([hash]) => hash)),
        resourceClasses,
        districtDefinitions: loadDistrictDefinitions(db),
        districtReplacements: loadDistrictReplacements(db),
        gameSpeeds: loadGameSpeeds(db),
        progressionTotals: loadProgressionTotals(db),
        tradeRouteDistrictYields: loadTradeRouteDistrictYields(db),
        tradeRoutePolicyYields: tradeRoutePolicyYields.supported,
        unsupportedTradeRoutePolicyModifiers: tradeRoutePolicyYields.unsupported,
      }
    }
    finally {
      db.close()
    }
  }
  catch {
    return createEmptyOpeningMapAnalysisData()
  }
}

export function buildDistrictAdjacencyChanges(
  snapshots: readonly CivReplayTurnSnapshot[],
  playerId: number,
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
): CivupOpeningDistrictAdjacencyChange[] {
  if (data.adjacencyRules.length === 0) return []

  const rulesByDistrict = groupRulesByDistrict(data.adjacencyRules)
  const previousSignatures = new Map<string, string>()
  const changes: CivupOpeningDistrictAdjacencyChange[] = []

  for (const snapshot of snapshots) {
    const player = findPlayer(snapshot, playerId)
    if (!player) continue

    const tileByCoordinate = new Map(snapshot.map.tiles.map(tile => [coordinateKey(tile.x, tile.y), tile]))
    const districtByCoordinate = buildDistrictCoordinateMap(snapshot, hashResolver)
    const cityById = new Map(player.cities.map(city => [city.id, city]))

    for (const district of [...player.districts].sort(compareDistricts)) {
      const districtType = resolveTypeName(district.type, hashResolver)
      const rules = rulesByDistrict.get(districtType)
      if (!rules?.length) continue

      const adjacency = computeDistrictAdjacency(snapshot, player, district, rules, hashResolver, data, tileByCoordinate, districtByCoordinate)
      const city = cityById.get(district.cityId) ?? null
      const change: CivupOpeningDistrictAdjacencyChange = {
        turn: snapshot.turnFromName,
        cityId: district.cityId,
        cityName: city?.name ?? null,
        districtGlobalId: district.globalId,
        districtId: district.id,
        districtType,
        x: district.x,
        y: district.y,
        built: district.built !== 0,
        totals: adjacency.totals,
        parts: adjacency.parts,
        unsupported: adjacency.unsupported,
      }
      const signature = districtAdjacencySignature(change)
      const key = `${district.globalId}:${district.id}`
      if (previousSignatures.get(key) === signature) continue
      previousSignatures.set(key, signature)
      changes.push(change)
    }
  }

  return changes
}

export function buildDistrictCostChanges(
  snapshots: readonly CivReplayTurnSnapshot[],
  playerId: number,
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
  gameSpeed: string | null,
): CivupOpeningDistrictCostChange[] {
  if (data.districtDefinitions.size === 0) return []

  const gameSpeedDefinition = gameSpeed ? data.gameSpeeds.get(gameSpeed) : null
  const costMultiplier = gameSpeedDefinition?.costMultiplier ?? 100
  const previousDistrictKeys = new Set<string>()
  const changes: CivupOpeningDistrictCostChange[] = []

  for (const snapshot of snapshots) {
    const player = findPlayer(snapshot, playerId)
    if (!player) continue

    const cityById = new Map(player.cities.map(city => [city.id, city]))
    const currentDistrictKeys = new Set(player.districts.map(district => districtKey(district)))

    for (const district of [...player.districts].sort(compareDistricts)) {
      const key = districtKey(district)
      if (previousDistrictKeys.has(key)) continue

      const districtType = resolveTypeName(district.type, hashResolver)
      const definition = data.districtDefinitions.get(districtType)
      if (!definition || !isDistrictCostAnalysisEligible(definition)) continue

      const estimatedFullCost = estimateFullDistrictCost(player, definition, data.progressionTotals, costMultiplier)
      if (estimatedFullCost == null || district.cost <= 0) continue


      const discountPercent = estimatedFullCost > 0 ? Math.max(0, 1 - (district.cost / estimatedFullCost)) : null
      const likelyDiscounted = estimatedFullCost - district.cost >= LIKELY_DISTRICT_DISCOUNT_MIN_DELTA
        && district.cost <= estimatedFullCost * LIKELY_DISTRICT_DISCOUNT_RATIO
      const city = cityById.get(district.cityId) ?? null
      changes.push({
        turn: snapshot.turnFromName,
        cityId: district.cityId,
        cityName: city?.name ?? null,
        districtGlobalId: district.globalId,
        districtId: district.id,
        districtType,
        canonicalDistrictType: data.districtReplacements.get(districtType) ?? districtType,
        x: district.x,
        y: district.y,
        observedCost: district.cost,
        estimatedFullCost,
        discountPercent,
        likelyDiscounted,
        completedTechCount: countCompletedProgression(player.techs),
        completedCivicCount: countCompletedProgression(player.civics),
        gameSpeed: gameSpeedDefinition?.gameSpeedType ?? gameSpeed,
        reason: likelyDiscounted
          ? 'observed saved cost is substantially below estimated full district cost'
          : 'observed saved cost is near estimated full district cost',
      })
    }

    previousDistrictKeys.clear()
    for (const key of currentDistrictKeys) previousDistrictKeys.add(key)
  }

  return changes.sort(compareDistrictCostChanges)
}

export function buildLuxuryOwnershipChanges(
  snapshots: readonly CivReplayTurnSnapshot[],
  playerId: number,
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
): CivupOpeningLuxuryOwnershipChange[] {
  if (data.luxuryResourceHashes.size === 0) return []

  const changes: CivupOpeningLuxuryOwnershipChange[] = []
  let previousSignature: string | null = null

  for (const snapshot of snapshots) {
    const player = findPlayer(snapshot, playerId)
    if (!player) continue

    const resources = inferOwnedTiles(snapshot, playerId)
      .filter(({ tile }) => data.luxuryResourceHashes.has(tile.resource))
      .map(({ tile, city }): CivupOpeningLuxuryResource => {
        const improvementType = isHashPresent(tile.improvement) ? resolveTypeName(tile.improvement, hashResolver) : null
        return {
          resourceType: resolveTypeName(tile.resource, hashResolver),
          x: tile.x,
          y: tile.y,
          cityId: city.id,
          cityName: city.name,
          improved: improvementType != null,
          improvementType,
        }
      })
      .sort(compareLuxuryResources)
    const signature = JSON.stringify(resources)
    if (previousSignature == null) {
      previousSignature = signature
      if (resources.length > 0) changes.push({ turn: snapshot.turnFromName, resources })
      continue
    }
    if (signature === previousSignature) continue
    previousSignature = signature
    changes.push({ turn: snapshot.turnFromName, resources })
  }

  return changes
}

function loadDistrictAdjacencyRules(db: Database): OpeningDistrictAdjacencyRule[] {
  const rows = db.query<AdjacencyRow, []>(`
    select da.DistrictType as DistrictType, ayc.*
    from District_Adjacencies da
    join Adjacency_YieldChanges ayc on ayc.ID = da.YieldChangeId
    where da.DistrictType is not null
      and ayc.ID is not null
      and ayc.YieldType is not null
  `).all()

  return rows.map(row => ({
    id: readString(row, 'ID') ?? readString(row, 'Description') ?? 'UNKNOWN_ADJACENCY',
    districtType: readString(row, 'DistrictType') ?? '',
    yieldType: readString(row, 'YieldType') ?? '',
    yieldChange: readNumber(row, 'YieldChange', 0),
    tilesRequired: Math.max(1, readNumber(row, 'TilesRequired', 1)),
    adjacentDistrict: readString(row, 'AdjacentDistrict'),
    otherDistrictAdjacent: readBoolean(row, 'OtherDistrictAdjacent'),
    adjacentTerrain: readString(row, 'AdjacentTerrain'),
    adjacentFeature: readString(row, 'AdjacentFeature'),
    adjacentResource: readString(row, 'AdjacentResource'),
    adjacentResourceClass: normalizeResourceClass(readString(row, 'AdjacentResourceClass')),
    adjacentImprovement: readString(row, 'AdjacentImprovement'),
    adjacentSeaResource: readBoolean(row, 'AdjacentSeaResource'),
    adjacentWonder: readBoolean(row, 'AdjacentWonder'),
    adjacentNaturalWonder: readBoolean(row, 'AdjacentNaturalWonder'),
    adjacentRiver: readBoolean(row, 'AdjacentRiver'),
    prereqTech: readString(row, 'PrereqTech'),
    prereqCivic: readString(row, 'PrereqCivic'),
    obsoleteTech: readString(row, 'ObsoleteTech'),
    self: readBoolean(row, 'Self'),
  })).filter(rule => rule.districtType && rule.yieldType)
}

function loadResourceClasses(db: Database): Map<number, string> {
  const rows = db.query<ResourceRow, []>(`
    select ResourceType, ResourceClassType
    from Resources
    where ResourceType is not null and ResourceClassType is not null
  `).all()
  return new Map(rows
    .filter((row): row is { ResourceType: string, ResourceClassType: string } => Boolean(row.ResourceType && row.ResourceClassType))
    .map(row => [civHash(row.ResourceType), row.ResourceClassType]))
}

function loadDistrictDefinitions(db: Database): Map<string, OpeningDistrictDefinition> {
  const rows = db.query<DistrictRow, []>(`
    select DistrictType, Cost, PrereqTech, PrereqCivic, RequiresPlacement, RequiresPopulation,
           CityCenter, Aqueduct, InternalOnly, CostProgressionModel, CostProgressionParam1, MaxPerPlayer
    from Districts
    where DistrictType is not null
  `).all()

  const definitions = new Map<string, OpeningDistrictDefinition>()
  for (const row of rows) {
    const districtType = readString(row, 'DistrictType')
    if (!districtType) continue
    definitions.set(districtType, {
      districtType,
      cost: readNumber(row, 'Cost', 0),
      prereqTech: readString(row, 'PrereqTech'),
      prereqCivic: readString(row, 'PrereqCivic'),
      requiresPlacement: readBoolean(row, 'RequiresPlacement'),
      requiresPopulation: readBoolean(row, 'RequiresPopulation'),
      cityCenter: readBoolean(row, 'CityCenter'),
      aqueduct: readBoolean(row, 'Aqueduct'),
      internalOnly: readBoolean(row, 'InternalOnly'),
      costProgressionModel: readString(row, 'CostProgressionModel'),
      costProgressionParam1: readNullableNumber(row, 'CostProgressionParam1'),
      maxPerPlayer: readNumber(row, 'MaxPerPlayer', -1),
    })
  }
  return definitions
}

function loadDistrictReplacements(db: Database): Map<string, string> {
  const rows = db.query<DistrictReplacementRow, []>(`
    select CivUniqueDistrictType, ReplacesDistrictType
    from DistrictReplaces
    where CivUniqueDistrictType is not null and ReplacesDistrictType is not null
  `).all()
  return new Map(rows
    .filter((row): row is { CivUniqueDistrictType: string, ReplacesDistrictType: string } => Boolean(row.CivUniqueDistrictType && row.ReplacesDistrictType))
    .map(row => [row.CivUniqueDistrictType, row.ReplacesDistrictType]))
}

function loadGameSpeeds(db: Database): Map<string, OpeningGameSpeedDefinition> {
  const rows = db.query<GameSpeedRow, []>(`
    select GameSpeedType, CostMultiplier
    from GameSpeeds
    where GameSpeedType is not null and CostMultiplier is not null
  `).all()
  return new Map(rows
    .filter((row): row is { GameSpeedType: string, CostMultiplier: number } => Boolean(row.GameSpeedType && typeof row.CostMultiplier === 'number'))
    .map(row => [row.GameSpeedType, { gameSpeedType: row.GameSpeedType, costMultiplier: row.CostMultiplier }]))
}

function loadProgressionTotals(db: Database): OpeningProgressionTotals {
  return {
    tech: db.query<CountRow, []>('select count(*) as count from Technologies').get()?.count ?? 0,
    civic: db.query<CountRow, []>('select count(*) as count from Civics').get()?.count ?? 0,
  }
}

function loadTradeRouteDistrictYields(db: Database): CivReplayTradeRouteDistrictYieldRule[] {
  const rows = db.query<TradeRouteDistrictYieldRow, []>(`
    select DistrictType, YieldType, YieldChangeAsOrigin, YieldChangeAsDomesticDestination, YieldChangeAsInternationalDestination
    from District_TradeRouteYields
    where DistrictType is not null and YieldType is not null
  `).all()

  return rows.flatMap(row => {
    if (!row.DistrictType || !row.YieldType) return []
    const rule = {
      districtType: row.DistrictType,
      yieldType: row.YieldType,
      origin: row.YieldChangeAsOrigin ?? 0,
      domesticDestination: row.YieldChangeAsDomesticDestination ?? 0,
      internationalDestination: row.YieldChangeAsInternationalDestination ?? 0,
    }
    return rule.origin === 0 && rule.domesticDestination === 0 && rule.internationalDestination === 0 ? [] : [rule]
  })
}

function loadTradeRoutePolicyYields(db: Database): { supported: CivReplayTradeRoutePolicyYieldRule[], unsupported: CivReplayTradeRouteUnsupportedPolicyModifier[] } {
  const rows = db.query<PolicyModifierRow, []>(`
    select pm.PolicyType, pm.ModifierId, m.ModifierType, yieldArg.Value as YieldType, amountArg.Value as Amount
    from PolicyModifiers pm
    join Modifiers m on m.ModifierId = pm.ModifierId
    left join ModifierArguments yieldArg on yieldArg.ModifierId = pm.ModifierId and yieldArg.Name = 'YieldType'
    left join ModifierArguments amountArg on amountArg.ModifierId = pm.ModifierId and amountArg.Name = 'Amount'
    where m.ModifierType like '%TRADE_ROUTE%YIELD%'
  `).all()

  const supported: CivReplayTradeRoutePolicyYieldRule[] = []
  const unsupported: CivReplayTradeRouteUnsupportedPolicyModifier[] = []
  for (const row of rows) {
    if (!row.PolicyType || !row.ModifierId || !row.ModifierType) continue
    const scope = tradeRoutePolicyYieldScope(row.ModifierType)
    const amount = readPolicyModifierAmount(row.Amount)
    if (scope && row.YieldType && amount != null) {
      supported.push({ policyType: row.PolicyType, modifierId: row.ModifierId, yieldType: row.YieldType, amount, scope })
    }
    else {
      unsupported.push({ policyType: row.PolicyType, modifierId: row.ModifierId, modifierType: row.ModifierType })
    }
  }
  return { supported, unsupported }
}

function tradeRoutePolicyYieldScope(modifierType: string): CivReplayTradeRoutePolicyYieldScope | null {
  if (modifierType === 'MODIFIER_PLAYER_ADJUST_TRADE_ROUTE_YIELD') return 'all'
  if (modifierType === 'MODIFIER_PLAYER_ADJUST_TRADE_ROUTE_YIELD_FOR_DOMESTIC') return 'domestic'
  if (modifierType === 'MODIFIER_PLAYER_ADJUST_TRADE_ROUTE_YIELD_FOR_INTERNATIONAL') return 'international'
  return null
}

function readPolicyModifierAmount(value: string | number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function computeDistrictAdjacency(
  snapshot: CivReplayTurnSnapshot,
  player: CivReplayPlayerSnapshot,
  district: CivReplayDistrictSnapshot,
  rules: readonly OpeningDistrictAdjacencyRule[],
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
  tileByCoordinate: ReadonlyMap<string, CivReplayMapTileSnapshot>,
  districtByCoordinate: ReadonlyMap<string, DistrictRef>,
): { totals: Record<string, number>, parts: CivupOpeningDistrictAdjacencyPart[], unsupported: string[] } {
  const totals = new Map<string, number>()
  const parts: CivupOpeningDistrictAdjacencyPart[] = []
  const unsupported = new Set<string>()
  const neighbors = neighborCoordinates(district.x, district.y, snapshot.map.width, snapshot.map.height)

  for (const rule of rules) {
    for (const item of unsupportedFeatures(rule)) unsupported.add(item)
    if (unsupportedFeatures(rule).length > 0 || !isAdjacencyRuleUnlocked(rule, player)) continue

    const count = countAdjacencyRuleMatches(rule, neighbors, hashResolver, data, tileByCoordinate, districtByCoordinate)
    const value = Math.floor(count / rule.tilesRequired) * rule.yieldChange
    if (count === 0 && value === 0) continue

    parts.push({ id: rule.id, yieldType: rule.yieldType, value, count, tilesRequired: rule.tilesRequired })
    if (value !== 0) totals.set(rule.yieldType, (totals.get(rule.yieldType) ?? 0) + value)
  }

  return {
    totals: Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right))),
    parts: parts.sort(compareAdjacencyParts),
    unsupported: [...unsupported].sort(),
  }
}

function countAdjacencyRuleMatches(
  rule: OpeningDistrictAdjacencyRule,
  coordinates: ReadonlyArray<{ x: number, y: number }>,
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
  tileByCoordinate: ReadonlyMap<string, CivReplayMapTileSnapshot>,
  districtByCoordinate: ReadonlyMap<string, DistrictRef>,
): number {
  let count = 0
  for (const coordinate of coordinates) {
    const tile = tileByCoordinate.get(coordinateKey(coordinate.x, coordinate.y))
    if (!tile) continue
    if (matchesAdjacencyRule(rule, tile, hashResolver, data, districtByCoordinate)) count += 1
  }
  return count
}

function matchesAdjacencyRule(
  rule: OpeningDistrictAdjacencyRule,
  tile: CivReplayMapTileSnapshot,
  hashResolver: HashResolver,
  data: OpeningMapAnalysisData,
  districtByCoordinate: ReadonlyMap<string, DistrictRef>,
): boolean {
  let hasCondition = false
  const district = districtByCoordinate.get(coordinateKey(tile.x, tile.y))

  if (rule.adjacentDistrict != null) {
    hasCondition = true
    if (district?.districtType !== rule.adjacentDistrict) return false
  }
  if (rule.otherDistrictAdjacent) {
    hasCondition = true
    if (!district) return false
  }
  if (rule.adjacentTerrain != null) {
    hasCondition = true
    if (hashResolver.resolve(tile.terrain) !== rule.adjacentTerrain) return false
  }
  if (rule.adjacentFeature != null) {
    hasCondition = true
    if (hashResolver.resolve(tile.feature) !== rule.adjacentFeature) return false
  }
  if (rule.adjacentResource != null) {
    hasCondition = true
    if (hashResolver.resolve(tile.resource) !== rule.adjacentResource) return false
  }
  if (rule.adjacentResourceClass != null) {
    hasCondition = true
    if (data.resourceClasses.get(tile.resource) !== rule.adjacentResourceClass) return false
  }
  if (rule.adjacentImprovement != null) {
    hasCondition = true
    if (hashResolver.resolve(tile.improvement) !== rule.adjacentImprovement) return false
  }
  if (rule.adjacentSeaResource) {
    hasCondition = true
    if (!isHashPresent(tile.resource) || !isWaterTerrain(hashResolver.resolve(tile.terrain))) return false
  }
  if (rule.adjacentWonder) {
    hasCondition = true
    if (tile.wonder == null) return false
  }

  return hasCondition
}

function inferOwnedTiles(snapshot: CivReplayTurnSnapshot, playerId: number): OwnedTileRef[] {
  const cityAttribution = createCivReplayCityAttributionContext(snapshot)
  const owned: OwnedTileRef[] = []
  for (const tile of snapshot.map.tiles) {
    const nearest = inferTileOwningCity(cityAttribution, tile)
    if (!nearest || nearest.player.id !== playerId) continue
    owned.push({ tile, city: nearest.city })
  }
  return owned
}

function groupRulesByDistrict(rules: readonly OpeningDistrictAdjacencyRule[]): Map<string, OpeningDistrictAdjacencyRule[]> {
  const grouped = new Map<string, OpeningDistrictAdjacencyRule[]>()
  for (const rule of rules) {
    const items = grouped.get(rule.districtType) ?? []
    items.push(rule)
    grouped.set(rule.districtType, items)
  }
  return grouped
}

function buildDistrictCoordinateMap(snapshot: CivReplayTurnSnapshot, hashResolver: HashResolver): Map<string, DistrictRef> {
  const districts = new Map<string, DistrictRef>()
  for (const player of snapshot.players.players) {
    for (const district of player.districts) {
      districts.set(coordinateKey(district.x, district.y), {
        player,
        district,
        districtType: resolveTypeName(district.type, hashResolver),
      })
    }
  }
  return districts
}

function isAdjacencyRuleUnlocked(rule: OpeningDistrictAdjacencyRule, player: CivReplayPlayerSnapshot): boolean {
  if (rule.prereqTech && !hasCompletedProgression(player.techs, rule.prereqTech)) return false
  if (rule.prereqCivic && !hasCompletedProgression(player.civics, rule.prereqCivic)) return false
  if (rule.obsoleteTech && hasCompletedProgression(player.techs, rule.obsoleteTech)) return false
  return true
}

function estimateFullDistrictCost(
  player: CivReplayPlayerSnapshot,
  definition: OpeningDistrictDefinition,
  totals: OpeningProgressionTotals,
  costMultiplier: number,
): number | null {
  if (definition.cost <= 0) return null
  const baseCost = definition.cost * (costMultiplier / 100)
  if (definition.costProgressionModel !== 'COST_PROGRESSION_NUM_UNDER_AVG_PLUS_TECH') return Math.max(1, Math.floor(baseCost))

  const techRatio = totals.tech > 0 ? countCompletedProgression(player.techs) / totals.tech : 0
  const civicRatio = totals.civic > 0 ? countCompletedProgression(player.civics) / totals.civic : 0
  return Math.max(1, Math.floor(baseCost * (1 + 9 * Math.max(techRatio, civicRatio))))
}

function countCompletedProgression(progression: CivReplayProgressionSnapshot | null): number {
  return progression?.found.filter(item => item.value).length ?? 0
}

function isDistrictCostAnalysisEligible(definition: OpeningDistrictDefinition): boolean {
  if (definition.cost <= 0) return false
  if (!definition.requiresPlacement || !definition.requiresPopulation) return false
  if (definition.cityCenter || definition.aqueduct || definition.internalOnly) return false
  if (definition.maxPerPlayer === 1) return false
  return true
}

function hasCompletedProgression(progression: CivReplayProgressionSnapshot | null, typeName: string): boolean {
  if (!progression) return false
  const hash = civHash(typeName)
  return progression.found.some(item => item.hash === hash && item.value)
}

function unsupportedFeatures(rule: OpeningDistrictAdjacencyRule): string[] {
  const unsupported: string[] = []
  if (rule.adjacentRiver) unsupported.push('AdjacentRiver')
  if (rule.adjacentNaturalWonder) unsupported.push('AdjacentNaturalWonder')
  if (rule.self) unsupported.push('Self')
  return unsupported
}

function neighborCoordinates(x: number, y: number, width: number, height: number | null): Array<{ x: number, y: number }> {
  const odd = y % 2 !== 0
  const candidates = odd
    ? [
        { x, y: y - 1 },
        { x: x + 1, y: y - 1 },
        { x: x - 1, y },
        { x: x + 1, y },
        { x, y: y + 1 },
        { x: x + 1, y: y + 1 },
      ]
    : [
        { x: x - 1, y: y - 1 },
        { x, y: y - 1 },
        { x: x - 1, y },
        { x: x + 1, y },
        { x: x - 1, y: y + 1 },
        { x, y: y + 1 },
      ]
  return candidates.filter(candidate => candidate.x >= 0 && candidate.y >= 0 && (width <= 0 || candidate.x < width) && (height == null || candidate.y < height))
}

function coordinateKey(x: number, y: number): string {
  return `${x}:${y}`
}

function districtAdjacencySignature(change: CivupOpeningDistrictAdjacencyChange): string {
  return JSON.stringify({ totals: change.totals, parts: change.parts, unsupported: change.unsupported })
}

function districtKey(district: CivReplayDistrictSnapshot): string {
  return `${district.globalId}:${district.id}`
}

function compareDistricts(left: CivReplayDistrictSnapshot, right: CivReplayDistrictSnapshot): number {
  return left.cityId - right.cityId || left.globalId - right.globalId || left.id - right.id || left.x - right.x || left.y - right.y
}

function compareAdjacencyParts(left: CivupOpeningDistrictAdjacencyPart, right: CivupOpeningDistrictAdjacencyPart): number {
  return left.yieldType.localeCompare(right.yieldType) || left.id.localeCompare(right.id)
}

function compareLuxuryResources(left: CivupOpeningLuxuryResource, right: CivupOpeningLuxuryResource): number {
  return left.resourceType.localeCompare(right.resourceType) || left.x - right.x || left.y - right.y || left.cityId - right.cityId || String(left.improvementType ?? '').localeCompare(String(right.improvementType ?? ''))
}

function compareDistrictCostChanges(left: CivupOpeningDistrictCostChange, right: CivupOpeningDistrictCostChange): number {
  return compareNullableNumbers(left.turn, right.turn) || left.cityId - right.cityId || left.districtGlobalId - right.districtGlobalId || left.districtId - right.districtId
}

function findPlayer(snapshot: CivReplayTurnSnapshot, playerId: number): CivReplayPlayerSnapshot | null {
  return snapshot.players.players.find(player => player.id === playerId) ?? null
}

function resolveTypeName(hash: number, hashResolver: HashResolver): string {
  return hashResolver.resolve(hash) ?? formatHash(hash)
}

function isHashPresent(hash: number): boolean {
  return hash !== 0 && hash !== 0xFFFFFFFF
}

function isWaterTerrain(terrain: string | null): boolean {
  return terrain === 'TERRAIN_COAST' || terrain === 'TERRAIN_OCEAN'
}

function readString(row: AdjacencyRow, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeResourceClass(value: string | null): string | null {
  return value == null || value === 'NO_RESOURCECLASS' ? null : value
}

function readNumber(row: AdjacencyRow, key: string, fallback: number): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readNullableNumber(row: AdjacencyRow, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(row: AdjacencyRow, key: string): boolean {
  const value = row[key]
  return value === 1 || value === true || value === '1'
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return left - right
}
