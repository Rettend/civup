import { Database } from 'bun:sqlite'
import { analyzeAutosaveTimelineBytes } from './autosave-timeline.ts'
import { createCityStateResolver, type CivReplayCityStateCategory, type CivReplayCityStateEnvoySnapshot, type CivReplayCityStateResolver, type CivReplayCityStateSnapshot } from './civreplay/city-states.ts'
import type { CivReplayCitySnapshot, CivReplayGovernorSnapshot, CivReplayPlayerSnapshot } from './civreplay/players.ts'
import { analyzeCivReplaySnapshotsBytes, type CivReplayTurnSnapshot } from './civreplay/snapshot.ts'
import {
  KNOWN_TRADE_ROUTE_YIELDS_EXCLUDED,
  summarizeCivReplayKnownTradeRouteYields,
  summarizeCivReplayTradeRoutes,
  type CivReplayTradeRouteKnownYieldSummary,
  type CivReplayTradeRouteSummary,
} from './civreplay/trade-routes.ts'
import { civHash, createHashResolver, formatHash, type HashResolver } from './hash.ts'
import {
  buildDistrictAdjacencyChanges,
  loadOpeningMapAnalysisData,
  type CivupOpeningDistrictAdjacencyChange,
  type OpeningMapAnalysisData,
} from './opening-map-analysis.ts'
import type { CivupTimelinePlayerSummary } from './types.ts'

export interface AnalyzeScienceReportOptions {
  focus?: string | null
  playerId?: number | null
  turn?: number | null
  limit?: number | null
  failFast?: boolean
  hashResolver?: HashResolver | null
  cityStateResolver?: CivReplayCityStateResolver | null
}

export interface CivupScienceReport {
  tool: 'civup-analyzer'
  schemaVersion: 1
  source: string
  generatedAt: string
  turn: number | null
  saveName: string | null
  hashResolution: { sources: string[], resolvedCount: number }
  cityStates: CivupScienceCityStates
  players: CivupSciencePlayer[]
  unsupported: string[]
}

export interface CivupScienceCityStates {
  count: number
  aliveCount: number
  scientificCount: number
  scientificAliveCount: number
  scientific: CivupScienceCityState[]
  unsupported: {
    envoyCounts: string
    suzerain: string
  }
}

export interface CivupScienceCityState {
  displayName: string
  status: string
  playerId: number | null
  x: number
  y: number
  envoys: CivReplayCityStateEnvoySnapshot[]
  suzerainPlayerId: number | null
  suzerainEnvoys: number | null
  suzerainStatus: CivReplayCityStateSnapshot['suzerainStatus']
}

export interface CivupSciencePlayer {
  player: CivupSciencePlayerIdentity
  science: number
  visibleScience: number
  modifierScience: number
  cityCount: number
  population: number
  districtCount: number
  campusCount: number
  builtCampusCount: number
  libraryCount: number
  universityCount: number
  researchLabCount: number
  activePolicies: string[]
  sciencePolicies: string[]
  governors: CivupScienceGovernor[]
  tradeRoutes: CivReplayTradeRouteSummary
  knownTradeRouteYields: CivReplayTradeRouteKnownYieldSummary
  cityStateYields: CivupScienceCityStateYieldSummary
  cities: CivupScienceCity[]
  unsupported: string[]
}

export interface CivupScienceCityStateYieldSummary {
  standardScientificBuildingScience: number
  owlSuzerainRouteYields: Record<string, number>
  scientificEnvoys: CivupScienceScientificCityStateEnvoy[]
}

export interface CivupScienceScientificCityStateEnvoy {
  displayName: string
  envoys: number
  tier: number
  suzerain: boolean
}

export interface CivupSciencePlayerIdentity {
  id: number
  slot: number | null
  team: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
}

export interface CivupScienceGovernor {
  id: number
  type: string
  cityId: number
  cityName: string | null
  promotions: string[]
}

export interface CivupScienceCity {
  id: number
  name: string
  x: number
  y: number
  population: number
  science: number
  visibleScience: number
  modifierScience: number
  populationScience: number
  scienceBuildingScience: number
  campusAdjacencyScience: number
  naturalPhilosophyScience: number
  scientificCityStateScience: number
  campusCount: number
  builtCampusCount: number
  scienceBuildings: CivupScienceBuilding[]
}

export interface CivupScienceBuilding {
  type: string
  science: number
  builtValue: number
}

interface ScienceBuildingYield {
  hash: number
  type: string
  science: number
}

const SCIENCE_YIELD_HASH = civHash('YIELD_SCIENCE')
const CAMPUS_HASH = civHash('DISTRICT_CAMPUS')
const PALACE_HASH = civHash('BUILDING_PALACE')
const LIBRARY_HASH = civHash('BUILDING_LIBRARY')
const UNIVERSITY_HASH = civHash('BUILDING_UNIVERSITY')
const CONSULATE_HASH = civHash('BUILDING_CONSULATE')
const CHANCERY_HASH = civHash('BUILDING_CHANCERY')
const RESEARCH_LAB_HASH = civHash('BUILDING_RESEARCH_LAB')
const NATURAL_PHILOSOPHY_HASH = civHash('POLICY_NATURAL_PHILOSOPHY')
const OWL_LEADER_TYPE = 'LEADER_LIME_TEO_OWL'
const ABSENT_BUILT_ITEM_VALUE = 0xffff
const OWL_ROUTE_YIELDS_BY_CITY_STATE_CATEGORY: Record<CivReplayCityStateCategory, Record<string, number>> = {
  scientific: { YIELD_SCIENCE: 1 },
  religious: { YIELD_FOOD: 1 },
  trade: { YIELD_GOLD: 3 },
  cultural: { YIELD_CULTURE: 1 },
  militaristic: { YIELD_PRODUCTION: 1 },
  industrial: { YIELD_PRODUCTION: 1 },
}

export function analyzeScienceReportBytes(source: string, bytes: Uint8Array, options: AnalyzeScienceReportOptions = {}): CivupScienceReport {
  const hashResolver = options.hashResolver ?? createHashResolver()
  const cityStateResolver = options.cityStateResolver ?? createCityStateResolver({
    typesDbPath: hashResolver.typesDbPath,
    loadDefaultTypesDb: hashResolver.typesDbPath != null,
  })
  const timeline = analyzeAutosaveTimelineBytes(source, bytes, { limit: options.limit, failFast: options.failFast })
  const snapshots = analyzeCivReplaySnapshotsBytes(source, bytes, {
    limit: options.limit,
    turn: options.turn,
    failFast: options.failFast,
    cityStateResolver,
  }).snapshots
  const snapshot = pickScienceSnapshot(snapshots, options.turn)
  const mapAnalysisData = loadOpeningMapAnalysisData(hashResolver)
  const scienceBuildings = loadScienceBuildingYields(hashResolver)
  const majorPlayerIds = new Set(timeline.summary.players.map(player => player.slot).filter((slot): slot is number => slot != null))
  const teamByPlayerId = new Map(timeline.summary.players.map(player => [player.slot, player.team] as const))
  const players = selectSciencePlayers(snapshot.players.players, timeline.summary.players, majorPlayerIds, options)
    .map(player => buildSciencePlayer(snapshot, player, timeline.summary.players, teamByPlayerId, hashResolver, mapAnalysisData, scienceBuildings))
    .sort(compareSciencePlayers)

  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    source,
    generatedAt: new Date().toISOString(),
    turn: snapshot.turnFromName,
    saveName: snapshot.saveName,
    hashResolution: { sources: hashResolver.sources, resolvedCount: hashResolver.entries().length },
    cityStates: buildScienceCityStates(snapshot),
    players,
    unsupported: [
      'city yields are observed from the save, but Civ VI does not expose a decoded per-modifier source list here',
      'visibleScience estimates population, science-yielding buildings, campus adjacency, Natural Philosophy, standard scientific city-state building bonuses, currently modeled route-yield components, and Owl suzerain route yields',
      'modifierScience may include Pingala, civ/leader traits, great people, alliances, city projects, amenities, conditional city-state duplicate-copy modifiers, or custom mod modifiers',
      `known trade-route model excluded components: ${KNOWN_TRADE_ROUTE_YIELDS_EXCLUDED}; decoded Owl suzerain route yields are modeled separately in cityStateYields`,
    ],
  }
}

export function formatScienceReportSummary(report: CivupScienceReport): string {
  const lines: string[] = []
  lines.push('CivUp Science Report')
  lines.push(`source: ${report.source}`)
  lines.push(`turn: ${report.turn ?? '?'}${report.saveName ? ` | ${report.saveName}` : ''}`)
  lines.push(`hash names: ${report.hashResolution.resolvedCount} resolved from ${report.hashResolution.sources.join(', ')}`)
  lines.push(`city-states: scientific ${report.cityStates.scientificAliveCount}/${report.cityStates.scientificCount} alive${report.cityStates.scientific.length ? ` (${report.cityStates.scientific.map(formatScienceCityState).join('; ')})` : ''}`)
  lines.push(`city-state envoys/suzerain: ${report.cityStates.unsupported.envoyCounts}; ${report.cityStates.unsupported.suzerain}`)
  lines.push('')
  lines.push('Players')
  for (const player of report.players) {
    lines.push(`  P${player.player.id} ${formatPlayerIdentity(player.player)} | science ${formatNumber(player.science)} | visible ${formatNumber(player.visibleScience)} | modifier/unattributed ${formatNumber(player.modifierScience)} | cities ${player.cityCount}, pop ${player.population}, campuses ${player.builtCampusCount}/${player.campusCount}, libraries ${player.libraryCount}, universities ${player.universityCount}, routes ${player.tradeRoutes.activeCount} known route science ${formatNullableNumber(player.knownTradeRouteYields.science)} | cs science ${formatNumber(player.cityStateYields.standardScientificBuildingScience + (player.cityStateYields.owlSuzerainRouteYields.YIELD_SCIENCE ?? 0))}`)
  }

  lines.push('')
  lines.push('Details')
  for (const player of report.players) {
    lines.push(`  P${player.player.id} ${formatPlayerIdentity(player.player)}`)
    lines.push(`    policies: ${player.activePolicies.length ? player.activePolicies.map(formatTypeDisplayName).join(', ') : 'none decoded'}`)
    if (player.sciencePolicies.length) lines.push(`    science-ish policies: ${player.sciencePolicies.map(formatTypeDisplayName).join(', ')}`)
    lines.push(`    governors: ${player.governors.length ? player.governors.map(formatGovernor).join('; ') : 'none decoded'}`)
    lines.push(`    city-state yields: ${formatScienceCityStateYieldSummary(player.cityStateYields)}`)
    lines.push('    top science cities:')
    for (const city of player.cities.slice(0, 6)) lines.push(`      ${formatCityName(city.name)} pop ${city.population}: science ${formatNumber(city.science)} | visible ${formatNumber(city.visibleScience)} | modifier/unattributed ${formatNumber(city.modifierScience)} | campus ${city.builtCampusCount}/${city.campusCount} adj ${formatNumber(city.campusAdjacencyScience)} | cs buildings +${formatNumber(city.scientificCityStateScience)} | buildings ${formatScienceBuildings(city.scienceBuildings)}`)
    if (player.cities.length > 6) lines.push(`      ... ${player.cities.length - 6} more cities`)
    if (player.unsupported.length) lines.push(`    unsupported: ${player.unsupported.join('; ')}`)
  }

  lines.push('')
  lines.push('Model Notes')
  for (const item of report.unsupported) lines.push(`  ${item}`)
  return `${lines.join('\n')}\n`
}

function pickScienceSnapshot(snapshots: readonly CivReplayTurnSnapshot[], requestedTurn: number | null | undefined): CivReplayTurnSnapshot {
  if (snapshots.length === 0) throw new Error(requestedTurn == null ? 'science: no snapshots parsed' : `science: turn ${requestedTurn} not found or failed to parse`)
  return snapshots.at(-1)!
}

function selectSciencePlayers(
  players: readonly CivReplayPlayerSnapshot[],
  metadataPlayers: readonly CivupTimelinePlayerSummary[],
  majorPlayerIds: ReadonlySet<number>,
  options: AnalyzeScienceReportOptions,
): CivReplayPlayerSnapshot[] {
  let selected = players.filter(player => majorPlayerIds.size ? majorPlayerIds.has(player.id) : player.cities.length > 0)
  if (options.playerId != null) selected = selected.filter(player => player.id === options.playerId)
  if (options.focus) {
    const needle = normalize(options.focus)
    selected = selected.filter(player => {
      const metadata = metadataPlayers.find(item => item.slot === player.id) ?? null
      return [metadata?.playerName, metadata?.leader, metadata?.civilization]
        .some(value => normalize(value ?? '').includes(needle))
    })
  }
  if (selected.length === 0) throw new Error('science: no matching players found')
  return selected
}

function buildSciencePlayer(
  snapshot: CivReplayTurnSnapshot,
  player: CivReplayPlayerSnapshot,
  metadataPlayers: readonly CivupTimelinePlayerSummary[],
  teamByPlayerId: ReadonlyMap<number, number | null>,
  hashResolver: HashResolver,
  mapAnalysisData: OpeningMapAnalysisData,
  scienceBuildings: readonly ScienceBuildingYield[],
): CivupSciencePlayer {
  const metadata = metadataPlayers.find(item => item.slot === player.id) ?? null
  const adjacencyByCity = buildCampusAdjacencyByCity(snapshot, player, hashResolver, mapAnalysisData)
  const hasNaturalPhilosophy = flattenPolicies(player).includes(NATURAL_PHILOSOPHY_HASH)
  const scientificCityStateBonuses = buildScientificCityStateBonuses(snapshot, player.id)
  const cities = player.cities
    .map(city => buildScienceCity(city, player, adjacencyByCity, scienceBuildings, hasNaturalPhilosophy, scientificCityStateBonuses))
    .sort(compareScienceCities)
  const science = sum(cities.map(city => city.science))
  const cityVisibleScience = sum(cities.map(city => city.visibleScience))
  const tradeRoutes = summarizeCivReplayTradeRoutes(player.tradeRoutes, hashResolver, teamByPlayerId)
  const knownTradeRouteYields = summarizeCivReplayKnownTradeRouteYields(player, snapshot.players.players, hashResolver, {
    districtYields: mapAnalysisData.tradeRouteDistrictYields,
    policyYields: mapAnalysisData.tradeRoutePolicyYields,
    unsupportedPolicyModifiers: mapAnalysisData.unsupportedTradeRoutePolicyModifiers,
  })
  const cityStateYields = buildScienceCityStateYieldSummary(snapshot, player, metadata?.leader ?? null, cities, scientificCityStateBonuses)
  const visibleScience = cityVisibleScience + (knownTradeRouteYields.science ?? 0) + (cityStateYields.owlSuzerainRouteYields.YIELD_SCIENCE ?? 0)
  return {
    player: {
      id: player.id,
      slot: metadata?.slot ?? player.id,
      team: metadata?.team ?? null,
      playerName: metadata?.playerName ?? null,
      leader: metadata?.leader ?? null,
      civilization: metadata?.civilization ?? null,
    },
    science,
    visibleScience,
    modifierScience: science - visibleScience,
    cityCount: player.cities.length,
    population: sum(player.cities.map(city => city.population)),
    districtCount: player.districts.length,
    campusCount: player.districts.filter(district => district.type === CAMPUS_HASH).length,
    builtCampusCount: player.districts.filter(district => district.type === CAMPUS_HASH && district.built !== 0).length,
    libraryCount: countBuiltItem(player.cities, LIBRARY_HASH),
    universityCount: countBuiltItem(player.cities, UNIVERSITY_HASH),
    researchLabCount: countBuiltItem(player.cities, RESEARCH_LAB_HASH),
    activePolicies: flattenPolicies(player).map(hash => resolveHashName(hash, hashResolver)).sort(),
    sciencePolicies: flattenPolicies(player).map(hash => resolveHashName(hash, hashResolver)).filter(isSciencePolicyName).sort(),
    governors: player.governors.map(governor => buildScienceGovernor(governor, player, hashResolver)).sort(compareGovernors),
    tradeRoutes,
    knownTradeRouteYields,
    cityStateYields,
    cities,
    unsupported: [
      'exact per-city trade-route assignment is not decoded; known route science is shown at player level',
      'conditional city-state duplicate-copy modifiers, if active, are not included in visibleScience',
    ],
  }
}

function buildScienceCity(
  city: CivReplayCitySnapshot,
  player: CivReplayPlayerSnapshot,
  adjacencyByCity: ReadonlyMap<number, number>,
  scienceBuildings: readonly ScienceBuildingYield[],
  hasNaturalPhilosophy: boolean,
  scientificCityStateBonuses: readonly CivupScienceScientificCityStateEnvoy[],
): CivupScienceCity {
  const science = getCityYield(city, SCIENCE_YIELD_HASH)
  const populationScience = city.population / 2
  const cityBuildings = scienceBuildings
    .map(building => ({ building, builtValue: getBuiltItemValue(city, building.hash) }))
    .filter((item): item is { building: ScienceBuildingYield, builtValue: number } => item.builtValue != null && isBuiltItemValue(item.builtValue))
    .map(item => ({ type: item.building.type, science: item.building.science, builtValue: item.builtValue }))
    .sort((left, right) => left.type.localeCompare(right.type))
  const scienceBuildingScience = sum(cityBuildings.map(building => building.science))
  const campusAdjacencyScience = adjacencyByCity.get(city.id) ?? 0
  const naturalPhilosophyScience = hasNaturalPhilosophy ? campusAdjacencyScience : 0
  const scientificCityStateScience = calculateScientificCityStateScience(city, scientificCityStateBonuses)
  const visibleScience = populationScience + scienceBuildingScience + campusAdjacencyScience + naturalPhilosophyScience + scientificCityStateScience
  const campuses = player.districts.filter(district => district.cityId === city.id && district.type === CAMPUS_HASH)
  return {
    id: city.id,
    name: city.name,
    x: city.x,
    y: city.y,
    population: city.population,
    science,
    visibleScience,
    modifierScience: science - visibleScience,
    populationScience,
    scienceBuildingScience,
    campusAdjacencyScience,
    naturalPhilosophyScience,
    scientificCityStateScience,
    campusCount: campuses.length,
    builtCampusCount: campuses.filter(district => district.built !== 0).length,
    scienceBuildings: cityBuildings,
  }
}

function buildScienceGovernor(governor: CivReplayGovernorSnapshot, player: CivReplayPlayerSnapshot, hashResolver: HashResolver): CivupScienceGovernor {
  const city = player.cities.find(item => item.id === governor.city) ?? null
  return {
    id: governor.id,
    type: resolveHashName(governor.type, hashResolver),
    cityId: governor.city,
    cityName: city?.name ?? null,
    promotions: governor.promotions.filter(item => item.value !== 0).map(item => resolveHashName(item.hash, hashResolver)).sort(),
  }
}

function buildScientificCityStateBonuses(snapshot: CivReplayTurnSnapshot, playerId: number): CivupScienceScientificCityStateEnvoy[] {
  return snapshot.cityStates.cityStates
    .filter(cityState => cityState.category === 'scientific' && cityState.alive)
    .map(cityState => {
      const envoys = cityState.envoys.find(item => item.playerId === playerId)?.envoys ?? 0
      return {
        displayName: cityState.displayName,
        envoys,
        tier: scientificCityStateTier(envoys),
        suzerain: cityState.suzerainPlayerId === playerId,
      }
    })
    .filter(item => item.envoys > 0)
    .sort((left, right) => right.envoys - left.envoys || left.displayName.localeCompare(right.displayName))
}

function buildScienceCityStateYieldSummary(
  snapshot: CivReplayTurnSnapshot,
  player: CivReplayPlayerSnapshot,
  leaderType: string | null,
  cities: readonly CivupScienceCity[],
  scientificEnvoys: readonly CivupScienceScientificCityStateEnvoy[],
): CivupScienceCityStateYieldSummary {
  return {
    standardScientificBuildingScience: sum(cities.map(city => city.scientificCityStateScience)),
    owlSuzerainRouteYields: buildOwlSuzerainRouteYields(snapshot, player, leaderType),
    scientificEnvoys: [...scientificEnvoys],
  }
}

function calculateScientificCityStateScience(city: CivReplayCitySnapshot, bonuses: readonly CivupScienceScientificCityStateEnvoy[]): number {
  return sum(bonuses.map(bonus => calculateOneScientificCityStateScience(city, bonus.tier)))
}

function calculateOneScientificCityStateScience(city: CivReplayCitySnapshot, tier: number): number {
  let science = 0
  if (tier >= 1) {
    if (hasBuiltItem(city, PALACE_HASH)) science += 1
    if (hasBuiltItem(city, LIBRARY_HASH)) science += 1
  }
  if (tier >= 3) {
    if (hasBuiltItem(city, UNIVERSITY_HASH)) science += 2
    if (hasBuiltItem(city, CONSULATE_HASH)) science += 2
  }
  if (tier >= 6) {
    if (hasBuiltItem(city, RESEARCH_LAB_HASH)) science += 3
    if (hasBuiltItem(city, CHANCERY_HASH)) science += 3
  }
  return science
}

function scientificCityStateTier(envoys: number): number {
  if (envoys >= 6) return 6
  if (envoys >= 3) return 3
  if (envoys >= 1) return 1
  return 0
}

function buildOwlSuzerainRouteYields(snapshot: CivReplayTurnSnapshot, player: CivReplayPlayerSnapshot, leaderType: string | null): Record<string, number> {
  if (leaderType !== OWL_LEADER_TYPE || player.tradeRoutes.length === 0) return {}
  const suzerainedCounts = new Map<CivReplayCityStateCategory, number>()
  for (const cityState of snapshot.cityStates.cityStates) {
    if (!cityState.alive || cityState.suzerainPlayerId !== player.id) continue
    suzerainedCounts.set(cityState.category, (suzerainedCounts.get(cityState.category) ?? 0) + 1)
  }

  const totals = new Map<string, number>()
  for (const [category, count] of suzerainedCounts) {
    const multiplier = count >= 2 ? 3 : 1
    const yields = OWL_ROUTE_YIELDS_BY_CITY_STATE_CATEGORY[category]
    for (const [yieldType, amount] of Object.entries(yields)) addToMap(totals, yieldType, amount * multiplier * player.tradeRoutes.length)
  }
  return Object.fromEntries([...totals].sort(([left], [right]) => left.localeCompare(right)))
}

function buildScienceCityStates(snapshot: CivReplayTurnSnapshot): CivupScienceCityStates {
  const scientific = snapshot.cityStates.cityStates
    .filter(cityState => cityState.category === 'scientific')
    .map(cityState => ({
      displayName: cityState.displayName,
      status: cityState.status,
      playerId: cityState.playerId,
      x: cityState.x,
      y: cityState.y,
      envoys: cityState.envoys,
      suzerainPlayerId: cityState.suzerainPlayerId,
      suzerainEnvoys: cityState.suzerainEnvoys,
      suzerainStatus: cityState.suzerainStatus,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
  return {
    count: snapshot.cityStates.count,
    aliveCount: snapshot.cityStates.aliveCount,
    scientificCount: snapshot.cityStates.scientificCount,
    scientificAliveCount: snapshot.cityStates.scientificAliveCount,
    scientific,
    unsupported: {
      envoyCounts: 'envoy counts are decoded from city-state influence token tables',
      suzerain: 'suzerain player is decoded from city-state influence token tables; quests/visibility are not decoded yet',
    },
  }
}

function buildCampusAdjacencyByCity(
  snapshot: CivReplayTurnSnapshot,
  player: CivReplayPlayerSnapshot,
  hashResolver: HashResolver,
  mapAnalysisData: OpeningMapAnalysisData,
): Map<number, number> {
  const totals = new Map<number, number>()
  const changes = buildDistrictAdjacencyChanges([snapshot], player.id, hashResolver, mapAnalysisData)
  for (const change of changes) {
    if (change.districtType !== 'DISTRICT_CAMPUS') continue
    addToMap(totals, change.cityId, readScienceAdjacency(change))
  }
  return totals
}

function readScienceAdjacency(change: CivupOpeningDistrictAdjacencyChange): number {
  return change.totals.YIELD_SCIENCE ?? 0
}

function loadScienceBuildingYields(hashResolver: HashResolver): ScienceBuildingYield[] {
  const fallback = [
    { hash: LIBRARY_HASH, type: 'BUILDING_LIBRARY', science: 2 },
    { hash: UNIVERSITY_HASH, type: 'BUILDING_UNIVERSITY', science: 4 },
    { hash: RESEARCH_LAB_HASH, type: 'BUILDING_RESEARCH_LAB', science: 5 },
  ]
  if (!hashResolver.typesDbPath) return fallback

  try {
    const db = new Database(hashResolver.typesDbPath, { readonly: true })
    try {
      const rows = db.query<{ BuildingType: string | null, YieldChange: number | null }, []>(`
        select BuildingType, YieldChange
        from Building_YieldChanges
        where YieldType = 'YIELD_SCIENCE'
          and BuildingType is not null
          and YieldChange is not null
      `).all()
      const loaded = rows
        .filter((row): row is { BuildingType: string, YieldChange: number } => Boolean(row.BuildingType && row.YieldChange))
        .map(row => ({ hash: civHash(row.BuildingType), type: row.BuildingType, science: row.YieldChange }))
        .sort((left, right) => left.type.localeCompare(right.type))
      return loaded.length ? loaded : fallback
    }
    finally {
      db.close()
    }
  }
  catch {
    return fallback
  }
}

function getCityYield(city: CivReplayCitySnapshot, hash: number): number {
  return city.yields.find(item => item.hash === hash)?.value ?? 0
}

function getBuiltItemValue(city: CivReplayCitySnapshot, hash: number): number | null {
  return city.builtItems.find(item => item.hash === hash)?.value ?? null
}

function hasBuiltItem(city: CivReplayCitySnapshot, hash: number): boolean {
  const value = getBuiltItemValue(city, hash)
  return value != null && isBuiltItemValue(value)
}

function isBuiltItemValue(value: number): boolean {
  return value !== ABSENT_BUILT_ITEM_VALUE
}

function countBuiltItem(cities: readonly CivReplayCitySnapshot[], hash: number): number {
  return cities.filter(city => hasBuiltItem(city, hash)).length
}

function flattenPolicies(player: CivReplayPlayerSnapshot): number[] {
  return player.policies.flatMap(slot => slot)
}

function resolveHashName(hash: number, hashResolver: HashResolver): string {
  return hashResolver.resolve(hash) ?? formatHash(hash)
}

function isSciencePolicyName(name: string): boolean {
  return /SCIENCE|PHILOSOPHY|RATIONALISM|CONFEDERATION|FIVE_YEAR_PLAN|INTERNATIONAL_SPACE_AGENCY/.test(name)
}

function formatScienceCityState(cityState: CivupScienceCityState): string {
  const influence = formatScienceCityStateInfluence(cityState)
  return `${cityState.displayName} ${cityState.status} (${cityState.x},${cityState.y})${influence}`
}

function formatScienceCityStateInfluence(cityState: CivupScienceCityState): string {
  if (cityState.suzerainStatus === 'unknown' && cityState.envoys.length === 0) return ''
  const suzerain = cityState.suzerainPlayerId == null
    ? cityState.suzerainStatus === 'tied' ? `suz tied ${cityState.suzerainEnvoys ?? '?'}e` : 'no suz'
    : `suz P${cityState.suzerainPlayerId} ${cityState.suzerainEnvoys ?? '?'}e`
  const envoys = cityState.envoys.length ? `envoys ${cityState.envoys.map(item => `P${item.playerId}:${item.envoys}`).join(',')}` : 'envoys none'
  return ` ${suzerain}, ${envoys}`
}

function formatScienceCityStateYieldSummary(summary: CivupScienceCityStateYieldSummary): string {
  const pieces = [`standard scientific buildings +${formatNumber(summary.standardScientificBuildingScience)}`]
  const routeYields = formatYields(summary.owlSuzerainRouteYields)
  if (routeYields !== 'none') pieces.push(`Owl suzerain routes ${routeYields}`)
  if (summary.scientificEnvoys.length) {
    pieces.push(`scientific envoys ${summary.scientificEnvoys.map(item => `${item.displayName} ${item.envoys}e tier ${item.tier}${item.suzerain ? ' suz' : ''}`).join('; ')}`)
  }
  return pieces.join('; ')
}

function formatPlayerIdentity(player: CivupSciencePlayerIdentity): string {
  const name = player.playerName ?? 'AI'
  const leader = player.leader ? formatTypeDisplayName(player.leader) : 'unknown leader'
  const civilization = player.civilization ? formatTypeDisplayName(player.civilization) : 'unknown civ'
  return `${name} | ${leader} | ${civilization}`
}

function formatGovernor(governor: CivupScienceGovernor): string {
  const city = governor.cityName ? ` in ${formatCityName(governor.cityName)}` : ''
  const promotions = governor.promotions.length ? ` (${governor.promotions.map(formatTypeDisplayName).join(', ')})` : ''
  return `${formatTypeDisplayName(governor.type)}${city}${promotions}`
}

function formatScienceBuildings(buildings: readonly CivupScienceBuilding[]): string {
  if (buildings.length === 0) return 'none'
  return buildings.map(building => `${formatTypeDisplayName(building.type)} +${formatNumber(building.science)}`).join(', ')
}

function formatCityName(value: string): string {
  return formatTypeDisplayName(value.replace(/^LOC_CITY_NAME_/, '').replace(/^LOC_CITY_/, ''))
}

function formatTypeDisplayName(value: string): string {
  const prefixes = [
    'GOV_PROMO_LIME_TEO_',
    'GOVERNOR_PROMOTION_',
    'GOVERNOR_LIME_TEO_',
    'GOVERNOR_',
    'CIVILIZATION_LIME_',
    'CIVILIZATION_',
    'LEADER_LIME_',
    'LEADER_',
    'BUILDING_',
    'DISTRICT_',
    'POLICY_',
    'YIELD_',
  ]
  const prefix = prefixes.find(item => value.startsWith(item))
  return (prefix ? value.slice(prefix.length) : value)
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '?' : formatNumber(value)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatYields(yields: Record<string, number>): string {
  const entries = Object.entries(yields).filter(([, value]) => value !== 0)
  if (entries.length === 0) return 'none'
  return entries.map(([yieldType, value]) => `${formatTypeDisplayName(yieldType)} +${formatNumber(value)}`).join(', ')
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function addToMap<Key>(map: Map<Key, number>, key: Key, value: number): void {
  if (value === 0) return
  map.set(key, (map.get(key) ?? 0) + value)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function compareSciencePlayers(left: CivupSciencePlayer, right: CivupSciencePlayer): number {
  return right.science - left.science || left.player.id - right.player.id
}

function compareScienceCities(left: CivupScienceCity, right: CivupScienceCity): number {
  return right.science - left.science || left.id - right.id
}

function compareGovernors(left: CivupScienceGovernor, right: CivupScienceGovernor): number {
  return left.id - right.id
}
