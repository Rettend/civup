import type {
  CivReplayAgeChangedEvent,
  CivReplayCityBuiltItemCompletedEvent,
  CivReplayCityFoundedEvent,
  CivReplayCityProductionChangedEvent,
  CivReplayCityReligionChangedEvent,
  CivReplayDedicationChangedEvent,
  CivReplayDistrictBuiltEvent,
  CivReplayDistrictPlacedEvent,
  CivReplayGoodyHutCategoryCountChangedEvent,
  CivReplayGovernmentChangedEvent,
  CivReplayGovernorAssignedEvent,
  CivReplayGovernorPromotedEvent,
  CivReplayPantheonChangedEvent,
  CivReplayProgressionCompletedEvent,
  CivReplayTileImprovementChangedEvent,
  CivReplayUnitCreatedEvent,
  CivReplayUnitLostEvent,
  CivReplayUnitUpgradedEvent,
} from './civreplay/events.ts'
import { createCityStateResolver, type CivReplayCityStateCategory, type CivReplayCityStateEnvoySnapshot, type CivReplayCityStateResolver, type CivReplayCityStateSnapshot, type CivReplayCityStateStatus } from './civreplay/city-states.ts'
import {
  KNOWN_TRADE_ROUTE_YIELDS_DESCRIPTION,
  KNOWN_TRADE_ROUTE_YIELDS_EXCLUDED,
  summarizeCivReplayKnownTradeRouteYields,
  summarizeCivReplayTradeRoutes,
  TRADE_ROUTE_YIELDS_UNSUPPORTED,
} from './civreplay/trade-routes.ts'
import type { CivReplayAgeState, CivReplayPlayerSnapshot } from './civreplay/players.ts'
import type { CivReplayTurnSnapshot } from './civreplay/snapshot.ts'
import type { CivupTimelinePlayerSummary } from './types.ts'
import { analyzeAutosaveTimelineBytes } from './autosave-timeline.ts'
import { analyzeCivReplaySnapshotsBytes } from './civreplay/snapshot.ts'
import { createHashResolver, formatHash, resolveCivReplayDedicationDisplayName, type HashResolver } from './hash.ts'
import {
  buildDistrictCostChanges,
  buildDistrictAdjacencyChanges,
  buildLuxuryOwnershipChanges,
  loadOpeningMapAnalysisData,
  type CivupOpeningDistrictCostChange,
  type CivupOpeningDistrictAdjacencyChange,
  type CivupOpeningLuxuryOwnershipChange,
  type OpeningMapAnalysisData,
} from './opening-map-analysis.ts'

export interface AnalyzeOpeningReportOptions {
  focus?: string | null
  playerId?: number | null
  fromTurn?: number | null
  toTurn?: number | null
  limit?: number | null
  failFast?: boolean
  hashResolver?: HashResolver | null
  cityStateResolver?: CivReplayCityStateResolver | null
}

export interface CivupOpeningReport {
  tool: 'civup-analyzer'
  schemaVersion: 1
  source: string
  generatedAt: string
  hashResolution: { sources: string[], resolvedCount: number }
  hashNames: Record<string, string>
  seeds: CivupOpeningSeeds
  player: CivupOpeningPlayer
  turnRange: { from: number, to: number }
  summary: CivupOpeningSummary
  turns: CivupOpeningTurnMetric[]
  milestones: CivupOpeningMilestones
  cityStates: CivupOpeningCityStatesState
  religion: CivupOpeningReligionState
  tradeRoutes: CivupOpeningTradeRoutesState
  districtCostChanges: CivupOpeningDistrictCostChange[]
  districtAdjacencyChanges: CivupOpeningDistrictAdjacencyChange[]
  luxuryOwnershipChanges: CivupOpeningLuxuryOwnershipChange[]
}

export interface CivupOpeningPlayer {
  id: number
  slot: number | null
  team: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
}

export interface CivupOpeningSeeds {
  gameRandomSeed: number | null
  mapRandomSeed: number | null
}

export interface CivupOpeningSummary {
  parsedSnapshots: number
  firstTurn: number | null
  lastTurn: number | null
  end: CivupOpeningTurnMetric | null
  keyTurns: CivupOpeningTurnMetric[]
}

export interface CivupOpeningTurnMetric {
  turn: number | null
  cityCount: number
  population: number
  districtCount: number
  unitCount: number
  governorCount: number
  improvementCount: number
  gold: number | null
  faith: number | null
  maintenance: number | null
  pantheon: number | null
  age: CivReplayAgeState | null
  eraScoreCurrent: number | null
  eraScorePrevious: number | null
  hasGoldenAge: boolean | null
  hasDarkAge: boolean | null
  dedicationHash: number | null
  dedicationRecordId: number | null
  dedicationAvailableHashes: number[]
  cityReligionCount: number
  yields: Record<string, number>
  tradeRouteCount: number
  domesticTradeRouteCount: number
  internationalTradeRouteCount: number
  teamTradeRouteCount: number
  unknownTradeRouteDestinationOwnerCount: number
  tradeRouteYields: Record<string, number>
  tradeRouteScience: number | null
  tradeRouteCulture: number | null
  knownTradeRouteYields: Record<string, number>
  knownTradeRouteScience: number | null
  knownTradeRouteCulture: number | null
  knownTradeRouteYieldUnsupported: string[]
  techBoostedCount: number
  techCompletedCount: number
  civicBoostedCount: number
  civicCompletedCount: number
  cityFoundedCount: number
  productionChangedCount: number
  cityBuiltItemCompletedCount: number
  governmentChangedCount: number
  goodyHutCategoryCountChangedCount: number
  dedicationChangedCount: number
  ageChangedCount: number
  pantheonChangedCount: number
  cityReligionChangedCount: number
  districtPlacedCount: number
  districtBuiltCount: number
  unitCreatedCount: number
  unitLostCount: number
  unitUpgradedCount: number
  governorAssignedCount: number
  governorPromotedCount: number
  tileImprovementChangedCount: number
}

export interface CivupOpeningMilestones {
  citiesFounded: CivReplayCityFoundedEvent[]
  techCompleted: CivReplayProgressionCompletedEvent[]
  civicCompleted: CivReplayProgressionCompletedEvent[]
  productionChanged: CivReplayCityProductionChangedEvent[]
  cityBuiltItemsCompleted: CivReplayCityBuiltItemCompletedEvent[]
  governmentChanged: CivReplayGovernmentChangedEvent[]
  goodyHutCategoryCountChanged: CivReplayGoodyHutCategoryCountChangedEvent[]
  dedicationChanged: CivReplayDedicationChangedEvent[]
  ageChanged: CivReplayAgeChangedEvent[]
  pantheonChanged: CivReplayPantheonChangedEvent[]
  cityReligionChanged: CivReplayCityReligionChangedEvent[]
  districtPlaced: CivReplayDistrictPlacedEvent[]
  districtBuilt: CivReplayDistrictBuiltEvent[]
  unitsCreated: CivReplayUnitCreatedEvent[]
  unitsLost: CivReplayUnitLostEvent[]
  unitsUpgraded: CivReplayUnitUpgradedEvent[]
  governorsAssigned: CivReplayGovernorAssignedEvent[]
  governorsPromoted: CivReplayGovernorPromotedEvent[]
  tileImprovementsChanged: CivReplayTileImprovementChangedEvent[]
}

export interface CivupOpeningCityStatesState {
  count: number
  aliveCount: number
  capturedCount: number
  notPresentCount: number
  scientificCount: number
  scientificAliveCount: number
  sources: string[]
  unsupported: {
    suzerain: string
    envoyCounts: string
  }
  cityStates: CivupOpeningCityState[]
}

export interface CivupOpeningCityState {
  cityStateId: string
  civilizationType: string
  leaderType: string
  category: CivReplayCityStateCategory
  name: string | null
  description: string | null
  displayName: string
  capitalName: string
  cityName: string
  cityId: number
  x: number
  y: number
  population: number
  playerId: number | null
  ownerPlayerId: number
  ownerKind: CivReplayCityStateSnapshot['ownerKind']
  alive: boolean
  status: CivReplayCityStateStatus | 'notPresent'
  envoys: CivReplayCityStateEnvoySnapshot[]
  suzerainPlayerId: number | null
  suzerainEnvoys: number | null
  suzerainStatus: CivReplayCityStateSnapshot['suzerainStatus']
  firstTurn: number | null
  lastTurn: number | null
}

export interface CivupOpeningReligionState {
  pantheon: number | null
  cityReligions: CivupOpeningCityReligion[]
}

export interface CivupOpeningTradeRoutesState {
  knownYieldModel: {
    included: string
    excluded: string
  }
  unsupported: {
    yields: string
    duration: string
  }
}

export interface CivupOpeningCityReligion {
  cityId: number
  cityName: string
  x: number
  y: number
  religion: number
}

export function analyzeOpeningReportBytes(source: string, bytes: Uint8Array, options: AnalyzeOpeningReportOptions = {}): CivupOpeningReport {
  const fromTurn = options.fromTurn ?? 1
  const toTurn = options.toTurn ?? 50
  if (fromTurn > toTurn) throw new Error(`opening: fromTurn ${fromTurn} is after toTurn ${toTurn}`)
  const hashResolver = options.hashResolver ?? createHashResolver()
  const cityStateResolver = options.cityStateResolver ?? createCityStateResolver({
    typesDbPath: hashResolver.typesDbPath,
    loadDefaultTypesDb: hashResolver.typesDbPath != null,
  })

  const timeline = analyzeAutosaveTimelineBytes(source, bytes, { limit: options.limit, failFast: options.failFast })
  const player = selectOpeningPlayer(timeline.summary.players, options)
  const teamByPlayerId = buildTeamByPlayerId(timeline.summary.players)
  const snapshots = analyzeCivReplaySnapshotsBytes(source, bytes, { limit: options.limit, failFast: options.failFast, cityStateResolver }).snapshots
    .filter(snapshot => snapshot.turnFromName != null && snapshot.turnFromName >= fromTurn && snapshot.turnFromName <= toTurn)

  const mapAnalysisData = loadOpeningMapAnalysisData(hashResolver)
  const turns = snapshots.map(snapshot => buildTurnMetric(snapshot, player.id, hashResolver, teamByPlayerId, mapAnalysisData))
  const milestones = buildMilestones(snapshots, player.id)
  const cityStates = buildCityStatesState(snapshots)
  const religion = buildReligionState(snapshots, player.id)
  const gameSpeed = firstPresentString(timeline.turns.map(turn => turn.gameSpeed))
  const districtCostChanges = buildDistrictCostChanges(snapshots, player.id, hashResolver, mapAnalysisData, gameSpeed)
  const districtAdjacencyChanges = buildDistrictAdjacencyChanges(snapshots, player.id, hashResolver, mapAnalysisData)
  const luxuryOwnershipChanges = buildLuxuryOwnershipChanges(snapshots, player.id, hashResolver, mapAnalysisData)
  const hashNames = collectOpeningHashNames(milestones, religion, turns, hashResolver)
  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    source,
    generatedAt: new Date().toISOString(),
    hashResolution: { sources: hashResolver.sources, resolvedCount: Object.keys(hashNames).length },
    hashNames,
    seeds: {
      gameRandomSeed: firstPresent(timeline.turns.map(turn => turn.gameRandomSeed)),
      mapRandomSeed: firstPresent(timeline.turns.map(turn => turn.mapRandomSeed)),
    },
    player,
    turnRange: { from: fromTurn, to: toTurn },
    summary: {
      parsedSnapshots: turns.length,
      firstTurn: turns[0]?.turn ?? null,
      lastTurn: turns.at(-1)?.turn ?? null,
      end: turns.at(-1) ?? null,
      keyTurns: pickKeyTurns(turns, toTurn),
    },
    turns,
    milestones,
    cityStates,
    religion,
    tradeRoutes: buildTradeRoutesState(),
    districtCostChanges,
    districtAdjacencyChanges,
    luxuryOwnershipChanges,
  }
}

export function formatOpeningReportSummary(report: CivupOpeningReport): string {
  const lines: string[] = []
  lines.push('CivUp Opening Report')
  lines.push(`source: ${report.source}`)
  lines.push(`player: id ${report.player.id}${report.player.playerName ? ` | ${report.player.playerName}` : ''}${report.player.leader ? ` | ${report.player.leader}` : ''}${report.player.civilization ? ` | ${report.player.civilization}` : ''}`)
  lines.push(`turns: ${report.summary.firstTurn ?? '?'} -> ${report.summary.lastTurn ?? '?'} (${report.summary.parsedSnapshots} snapshots)`)
  if (report.seeds.gameRandomSeed != null || report.seeds.mapRandomSeed != null) lines.push(`seeds: game random ${report.seeds.gameRandomSeed ?? '?'}, map random ${report.seeds.mapRandomSeed ?? '?'}`)
  lines.push(`hash names: ${report.hashResolution.resolvedCount} resolved from ${report.hashResolution.sources.join(', ')}`)

  if (report.summary.end) {
    const end = report.summary.end
    lines.push(`end: cities ${end.cityCount}, pop ${end.population}, districts ${end.districtCount}, units ${end.unitCount}, improvements ${end.improvementCount}, trade routes ${formatTradeRouteCounts(end)}, gold ${end.gold ?? '?'}, faith ${end.faith ?? '?'}`)
    lines.push(`age end: ${formatAgeMetric(end)}`)
    lines.push(`progression end: techs ${end.techCompletedCount} completed/${end.techBoostedCount} boosted, civics ${end.civicCompletedCount} completed/${end.civicBoostedCount} boosted`)
  }

  lines.push('')
  lines.push('Key Turns')
  for (const turn of report.summary.keyTurns) {
    lines.push(`  T${turn.turn ?? '?'}: cities ${turn.cityCount}, pop ${turn.population}, districts ${turn.districtCount}, units ${turn.unitCount}, improvements ${turn.improvementCount}, trade routes ${formatTradeRouteCounts(turn)}, age ${formatAgeMetric(turn)}, techs ${turn.techCompletedCount} completed/${turn.techBoostedCount} boosted, civics ${turn.civicCompletedCount} completed/${turn.civicBoostedCount} boosted, yields ${formatYields(turn.yields)}, known route yields ${formatYields(turn.knownTradeRouteYields)}`)
  }

  lines.push('')
  lines.push('Trade Routes')
  lines.push(`  current: ${report.summary.end ? formatTradeRouteCounts(report.summary.end) : '?'}`)
  lines.push(`  known route yields: ${report.summary.end ? formatYields(report.summary.end.knownTradeRouteYields) : '?'}`)
  lines.push(`  known model: ${report.tradeRoutes.knownYieldModel.included}`)
  lines.push(`  excluded: ${report.tradeRoutes.knownYieldModel.excluded}`)
  lines.push(`  exact route yields: ${report.tradeRoutes.unsupported.yields}`)
  lines.push(`  route duration: ${report.tradeRoutes.unsupported.duration}`)

  lines.push('')
  lines.push('City-States')
  lines.push(`  known ${report.cityStates.count}, alive ${report.cityStates.aliveCount}, captured ${report.cityStates.capturedCount}, not present ${report.cityStates.notPresentCount}, scientific ${report.cityStates.scientificAliveCount}/${report.cityStates.scientificCount} alive/known`)
  const scientificCityStates = report.cityStates.cityStates.filter(cityState => cityState.category === 'scientific')
  lines.push(`  scientific: ${scientificCityStates.length ? scientificCityStates.map(formatOpeningCityStateBrief).join('; ') : 'none'}`)
  for (const cityState of report.cityStates.cityStates.slice(0, 20)) lines.push(`  ${formatOpeningCityStateBrief(cityState)}${formatOpeningCityStateLocation(cityState)}${formatOpeningCityStateTurns(cityState)}`)
  if (report.cityStates.cityStates.length > 20) lines.push(`  ... ${report.cityStates.cityStates.length - 20} more`)
  lines.push(`  suzerain/envoys: ${report.cityStates.unsupported.suzerain}; ${report.cityStates.unsupported.envoyCounts}`)

  lines.push('')
  lines.push('Cities Founded')
  if (report.milestones.citiesFounded.length === 0) lines.push('  none')
  for (const event of report.milestones.citiesFounded) lines.push(`  T${event.turn ?? '?'}: ${event.name} (${event.x},${event.y})${event.population === 1 ? '' : ` pop ${event.population}`}`)

  lines.push('')
  lines.push('Progression')
  lines.push(`  tech completed: ${report.milestones.techCompleted.length}`)
  for (const event of report.milestones.techCompleted.slice(0, 20)) lines.push(`    T${event.turn ?? '?'}: ${formatResolvedHash(event.hash, report.hashNames)}${event.boosted ? ' boosted' : ''}`)
  if (report.milestones.techCompleted.length > 20) lines.push(`    ... ${report.milestones.techCompleted.length - 20} more`)
  lines.push(`  civic completed: ${report.milestones.civicCompleted.length}`)
  for (const event of report.milestones.civicCompleted.slice(0, 20)) lines.push(`    T${event.turn ?? '?'}: ${formatResolvedHash(event.hash, report.hashNames)}${event.boosted ? ' boosted' : ''}`)
  if (report.milestones.civicCompleted.length > 20) lines.push(`    ... ${report.milestones.civicCompleted.length - 20} more`)

  lines.push('')
  lines.push(`Government/policy changes: ${report.milestones.governmentChanged.length}`)
  for (const event of report.milestones.governmentChanged.slice(0, 12)) lines.push(`  T${event.turn ?? '?'}: ${event.previousGovernment == null ? '-' : formatResolvedHash(event.previousGovernment, report.hashNames)} -> ${event.currentGovernment == null ? '-' : formatResolvedHash(event.currentGovernment, report.hashNames)}; policies ${formatPolicySlots(event.currentPolicies, report.hashNames)}`)
  if (report.milestones.governmentChanged.length > 12) lines.push(`  ... ${report.milestones.governmentChanged.length - 12} more`)

  lines.push(`Dedication changes: ${report.milestones.dedicationChanged.length}; current ${formatDedication(report.summary.end?.dedicationHash ?? null, report.summary.end?.dedicationRecordId ?? null, report.hashNames)}`)
  if (report.summary.end?.dedicationAvailableHashes.length) lines.push(`  available: ${report.summary.end.dedicationAvailableHashes.map(hash => formatDedicationName(hash, report.hashNames)).join(', ')}`)
  if (report.milestones.dedicationChanged.length === 0) lines.push('  none')
  for (const event of report.milestones.dedicationChanged.slice(0, 12)) lines.push(`  T${event.turn ?? '?'}: ${formatDedication(event.previousHash, event.previousRecordId, report.hashNames)} -> ${formatDedication(event.currentHash, event.currentRecordId, report.hashNames)}`)
  if (report.milestones.dedicationChanged.length > 12) lines.push(`  ... ${report.milestones.dedicationChanged.length - 12} more`)

  lines.push(`Age changes: ${report.milestones.ageChanged.length}; current ${report.summary.end ? formatAgeMetric(report.summary.end) : '?'}`)
  if (report.milestones.ageChanged.length === 0) lines.push('  none')
  for (const event of report.milestones.ageChanged.slice(0, 12)) lines.push(`  T${event.turn ?? '?'}: ${event.previousAge ?? '?'} -> ${event.currentAge ?? '?'}; score ${event.currentCurrentScore ?? '?'}`)
  if (report.milestones.ageChanged.length > 12) lines.push(`  ... ${report.milestones.ageChanged.length - 12} more`)

  lines.push(`Religion/pantheon changes: pantheon ${report.milestones.pantheonChanged.length}, city religion ${report.milestones.cityReligionChanged.length}`)
  lines.push(`  current pantheon: ${formatOptionalResolvedHash(report.religion.pantheon, report.hashNames)}`)
  lines.push(`  current city religions: ${formatCityReligions(report.religion.cityReligions, report.hashNames)}`)
  for (const event of report.milestones.pantheonChanged.slice(0, 8)) lines.push(`  T${event.turn ?? '?'}: pantheon ${formatOptionalResolvedHash(event.previousPantheon, report.hashNames)} -> ${formatOptionalResolvedHash(event.currentPantheon, report.hashNames)}`)
  if (report.milestones.pantheonChanged.length > 8) lines.push(`  ... ${report.milestones.pantheonChanged.length - 8} more pantheon changes`)
  for (const event of report.milestones.cityReligionChanged.slice(0, 12)) lines.push(`  T${event.turn ?? '?'}: ${event.name} religion ${formatOptionalResolvedHash(event.previousReligion, report.hashNames)} -> ${formatOptionalResolvedHash(event.currentReligion, report.hashNames)}`)
  if (report.milestones.cityReligionChanged.length > 12) lines.push(`  ... ${report.milestones.cityReligionChanged.length - 12} more city religion changes`)

  lines.push(`Goody hut category changes: ${report.milestones.goodyHutCategoryCountChanged.length}`)
  for (const event of report.milestones.goodyHutCategoryCountChanged.slice(0, 12)) lines.push(`  T${event.turn ?? '?'}: ${formatResolvedHash(event.categoryHash, report.hashNames)} ${event.previousValue} -> ${event.currentValue}`)
  if (report.milestones.goodyHutCategoryCountChanged.length > 12) lines.push(`  ... ${report.milestones.goodyHutCategoryCountChanged.length - 12} more`)

  lines.push('')
  lines.push(`Production changes: ${report.milestones.productionChanged.length}; built item completions: ${report.milestones.cityBuiltItemsCompleted.length}`)
  for (const event of report.milestones.productionChanged.slice(0, 20)) lines.push(`  T${event.turn ?? '?'}: ${event.name} ${event.previousProductionItems.map(hash => formatResolvedHash(hash, report.hashNames)).join(', ') || '-'} -> ${event.currentProductionItems.map(hash => formatResolvedHash(hash, report.hashNames)).join(', ') || '-'}`)
  if (report.milestones.productionChanged.length > 20) lines.push(`  ... ${report.milestones.productionChanged.length - 20} more`)
  for (const event of report.milestones.cityBuiltItemsCompleted.slice(0, 20)) lines.push(`  T${event.turn ?? '?'}: ${event.name} completed ${formatResolvedHash(event.itemHash, report.hashNames)}`)
  if (report.milestones.cityBuiltItemsCompleted.length > 20) lines.push(`  ... ${report.milestones.cityBuiltItemsCompleted.length - 20} more completions`)

  lines.push('')
  lines.push('Map And Unit Events')
  lines.push(`  districts placed ${report.milestones.districtPlaced.length}, built ${report.milestones.districtBuilt.length}`)
  for (const event of report.milestones.districtPlaced.slice(0, 12)) lines.push(`    T${event.turn ?? '?'}: placed ${formatResolvedHash(event.districtType, report.hashNames)} at (${event.x},${event.y}) city ${event.cityId}`)
  if (report.milestones.districtPlaced.length > 12) lines.push(`    ... ${report.milestones.districtPlaced.length - 12} more placed`)
  for (const event of report.milestones.districtBuilt.slice(0, 12)) lines.push(`    T${event.turn ?? '?'}: built ${formatResolvedHash(event.districtType, report.hashNames)} at (${event.x},${event.y}) city ${event.cityId}`)
  if (report.milestones.districtBuilt.length > 12) lines.push(`    ... ${report.milestones.districtBuilt.length - 12} more built`)
  lines.push(`  units created ${report.milestones.unitsCreated.length}, lost ${report.milestones.unitsLost.length}, upgraded ${report.milestones.unitsUpgraded.length}`)
  for (const event of report.milestones.unitsCreated.slice(0, 12)) lines.push(`    T${event.turn ?? '?'}: created ${formatResolvedHash(event.unitType, report.hashNames)}${formatUnitCreationMethod(event, report.hashNames)} at (${event.x},${event.y})${formatUnitCreatedCity(event)}`)
  if (report.milestones.unitsCreated.length > 12) lines.push(`    ... ${report.milestones.unitsCreated.length - 12} more created`)
  for (const event of report.milestones.unitsUpgraded.slice(0, 12)) lines.push(`    T${event.turn ?? '?'}: upgraded ${formatResolvedHash(event.previousUnitType, report.hashNames)} -> ${formatResolvedHash(event.currentUnitType, report.hashNames)} at (${event.x},${event.y})`)
  if (report.milestones.unitsUpgraded.length > 12) lines.push(`    ... ${report.milestones.unitsUpgraded.length - 12} more upgraded`)
  lines.push(`  improvements changed ${report.milestones.tileImprovementsChanged.length}`)
  for (const event of report.milestones.tileImprovementsChanged.slice(0, 12)) lines.push(`    T${event.turn ?? '?'}: (${event.x},${event.y}) ${event.previousImprovementType == null ? '-' : formatResolvedHash(event.previousImprovementType, report.hashNames)} -> ${event.currentImprovementType == null ? '-' : formatResolvedHash(event.currentImprovementType, report.hashNames)}`)
  if (report.milestones.tileImprovementsChanged.length > 12) lines.push(`    ... ${report.milestones.tileImprovementsChanged.length - 12} more`)
  lines.push(`  governors assigned ${report.milestones.governorsAssigned.length}, promoted ${report.milestones.governorsPromoted.length}`)
  for (const event of report.milestones.governorsAssigned.slice(0, 8)) lines.push(`    T${event.turn ?? '?'}: ${formatResolvedHash(event.governorType, report.hashNames)} city ${event.previousCityId ?? '-'} -> ${event.currentCityId}${event.promotionHashes.length ? ` promotions ${event.promotionHashes.map(hash => formatResolvedHash(hash, report.hashNames)).join(', ')}` : ''}`)
  for (const event of report.milestones.governorsPromoted.slice(0, 8)) lines.push(`    T${event.turn ?? '?'}: ${formatResolvedHash(event.governorType, report.hashNames)} promotion ${formatResolvedHash(event.promotionHash, report.hashNames)}`)

  lines.push('')
  const likelyDiscountedDistricts = report.districtCostChanges.filter(change => change.likelyDiscounted)
  lines.push(`District cost analysis: ${report.districtCostChanges.length} placements analyzed, ${likelyDiscountedDistricts.length} likely discounted`)
  if (likelyDiscountedDistricts.length === 0) lines.push('  none')
  for (const change of likelyDiscountedDistricts.slice(0, 12)) lines.push(`  T${change.turn ?? '?'}: ${change.cityName ?? `city ${change.cityId}`} ${formatTypeDisplayName(change.districtType)} (${change.x},${change.y}) observed ${change.observedCost} vs estimated full ${change.estimatedFullCost ?? '?'}${change.discountPercent == null ? '' : ` (${formatPercent(change.discountPercent)} lower)`}`)
  if (likelyDiscountedDistricts.length > 12) lines.push(`  ... ${likelyDiscountedDistricts.length - 12} more`)

  lines.push('')
  lines.push(`District adjacency changes: ${report.districtAdjacencyChanges.length}`)
  if (report.districtAdjacencyChanges.length === 0) lines.push('  none')
  for (const change of report.districtAdjacencyChanges.slice(0, 12)) lines.push(`  T${change.turn ?? '?'}: ${change.cityName ?? `city ${change.cityId}`} ${formatTypeDisplayName(change.districtType)} (${change.x},${change.y}) ${formatYields(change.totals)}${change.unsupported.length ? `; unsupported ${change.unsupported.map(formatCamelName).join(',')}` : ''}`)
  if (report.districtAdjacencyChanges.length > 12) lines.push(`  ... ${report.districtAdjacencyChanges.length - 12} more`)

  lines.push(`Luxury ownership changes: ${report.luxuryOwnershipChanges.length}`)
  if (report.luxuryOwnershipChanges.length === 0) lines.push('  none')
  for (const change of report.luxuryOwnershipChanges.slice(0, 12)) lines.push(`  T${change.turn ?? '?'}: ${formatLuxuryResources(change.resources)}`)
  if (report.luxuryOwnershipChanges.length > 12) lines.push(`  ... ${report.luxuryOwnershipChanges.length - 12} more`)

  return `${lines.join('\n')}\n`
}

function selectOpeningPlayer(players: readonly CivupTimelinePlayerSummary[], options: AnalyzeOpeningReportOptions): CivupOpeningPlayer {
  const selected = options.playerId != null
    ? players.find(player => player.slot === options.playerId)
    : players.find(player => options.focus != null && matchesFocus(player, options.focus))

  if (!selected) {
    if (options.playerId != null) return { id: options.playerId, slot: options.playerId, team: null, playerName: null, leader: null, civilization: null }
    throw new Error('opening: pass --focus <player|leader|civ> or --player-id <id>')
  }

  return {
    id: selected.slot,
    slot: selected.slot,
    team: selected.team,
    playerName: selected.playerName,
    leader: selected.leader,
    civilization: selected.civilization,
  }
}

function buildTurnMetric(snapshot: CivReplayTurnSnapshot, playerId: number, hashResolver: HashResolver, teamByPlayerId: ReadonlyMap<number, number | null>, mapAnalysisData: OpeningMapAnalysisData): CivupOpeningTurnMetric {
  const player = findPlayer(snapshot, playerId)
  const events = snapshot.events.filter(event => 'playerId' in event && event.playerId === playerId)
  const tradeRoutes = summarizeCivReplayTradeRoutes(player?.tradeRoutes ?? [], hashResolver, teamByPlayerId)
  const knownTradeRoutes = summarizeCivReplayKnownTradeRouteYields(player ?? null, snapshot.players.players, hashResolver, {
    districtYields: mapAnalysisData.tradeRouteDistrictYields,
    policyYields: mapAnalysisData.tradeRoutePolicyYields,
    unsupportedPolicyModifiers: mapAnalysisData.unsupportedTradeRoutePolicyModifiers,
  })
  return {
    turn: snapshot.turnFromName,
    cityCount: player?.cities.length ?? 0,
    population: player?.cities.reduce((sum, city) => sum + city.population, 0) ?? 0,
    districtCount: player?.districts.length ?? 0,
    unitCount: player?.units.length ?? 0,
    governorCount: player?.governors.length ?? 0,
    improvementCount: player?.improvements.length ?? 0,
    gold: player?.gold ?? null,
    faith: player?.faith ?? null,
    maintenance: player?.maintenance ?? null,
    pantheon: normalizeNullableHash(player?.pantheon),
    age: player?.era?.age ?? null,
    eraScoreCurrent: player?.era?.currentScore ?? null,
    eraScorePrevious: player?.era?.previousScore ?? null,
    hasGoldenAge: player?.era?.hasGoldenAge ?? null,
    hasDarkAge: player?.era?.hasDarkAge ?? null,
    dedicationHash: player?.dedication?.hash ?? null,
    dedicationRecordId: player?.dedication?.recordId ?? null,
    dedicationAvailableHashes: player?.dedication?.availableHashes ?? [],
    cityReligionCount: player?.cities.filter(city => normalizeNullableHash(city.religion) != null).length ?? 0,
    yields: player ? sumYields(player, hashResolver) : {},
    tradeRouteCount: tradeRoutes.activeCount,
    domesticTradeRouteCount: tradeRoutes.domesticCount,
    internationalTradeRouteCount: tradeRoutes.internationalCount,
    teamTradeRouteCount: tradeRoutes.teamCount,
    unknownTradeRouteDestinationOwnerCount: tradeRoutes.unknownDestinationOwnerCount,
    tradeRouteYields: tradeRoutes.yieldTotals,
    tradeRouteScience: tradeRoutes.science,
    tradeRouteCulture: tradeRoutes.culture,
    knownTradeRouteYields: knownTradeRoutes.yieldTotals,
    knownTradeRouteScience: knownTradeRoutes.science,
    knownTradeRouteCulture: knownTradeRoutes.culture,
    knownTradeRouteYieldUnsupported: knownTradeRoutes.unsupported,
    techBoostedCount: countProgressionFoundBoosted(player?.techs ?? null),
    techCompletedCount: countProgressionFound(player?.techs ?? null),
    civicBoostedCount: countProgressionFoundBoosted(player?.civics ?? null),
    civicCompletedCount: countProgressionFound(player?.civics ?? null),
    cityFoundedCount: events.filter(event => event.type === 'cityFounded').length,
    productionChangedCount: events.filter(event => event.type === 'cityProductionChanged').length,
    cityBuiltItemCompletedCount: events.filter(event => event.type === 'cityBuiltItemCompleted').length,
    governmentChangedCount: events.filter(event => event.type === 'governmentChanged').length,
    goodyHutCategoryCountChangedCount: events.filter(event => event.type === 'goodyHutCategoryCountChanged').length,
    dedicationChangedCount: events.filter(event => event.type === 'dedicationChanged').length,
    ageChangedCount: events.filter(event => event.type === 'ageChanged').length,
    pantheonChangedCount: events.filter(event => event.type === 'pantheonChanged').length,
    cityReligionChangedCount: events.filter(event => event.type === 'cityReligionChanged').length,
    districtPlacedCount: events.filter(event => event.type === 'districtPlaced').length,
    districtBuiltCount: events.filter(event => event.type === 'districtBuilt').length,
    unitCreatedCount: events.filter(event => event.type === 'unitCreated').length,
    unitLostCount: events.filter(event => event.type === 'unitLost').length,
    unitUpgradedCount: events.filter(event => event.type === 'unitUpgraded').length,
    governorAssignedCount: events.filter(event => event.type === 'governorAssigned').length,
    governorPromotedCount: events.filter(event => event.type === 'governorPromoted').length,
    tileImprovementChangedCount: events.filter(event => event.type === 'tileImprovementChanged').length,
  }
}

function buildTradeRoutesState(): CivupOpeningTradeRoutesState {
  return {
    knownYieldModel: {
      included: KNOWN_TRADE_ROUTE_YIELDS_DESCRIPTION,
      excluded: KNOWN_TRADE_ROUTE_YIELDS_EXCLUDED,
    },
    unsupported: {
      yields: TRADE_ROUTE_YIELDS_UNSUPPORTED,
      duration: 'remaining turns and route length are not decoded from save data yet',
    },
  }
}

function buildTeamByPlayerId(players: readonly CivupTimelinePlayerSummary[]): Map<number, number | null> {
  return new Map(players.map(player => [player.slot, player.team]))
}

function buildMilestones(snapshots: readonly CivReplayTurnSnapshot[], playerId: number): CivupOpeningMilestones {
  const events = snapshots.flatMap(snapshot => snapshot.events).filter(event => 'playerId' in event && event.playerId === playerId)
  return {
    citiesFounded: events.filter((event): event is CivReplayCityFoundedEvent => event.type === 'cityFounded'),
    techCompleted: events.filter((event): event is CivReplayProgressionCompletedEvent => event.type === 'techCompleted'),
    civicCompleted: events.filter((event): event is CivReplayProgressionCompletedEvent => event.type === 'civicCompleted'),
    productionChanged: events.filter((event): event is CivReplayCityProductionChangedEvent => event.type === 'cityProductionChanged'),
    cityBuiltItemsCompleted: events.filter((event): event is CivReplayCityBuiltItemCompletedEvent => event.type === 'cityBuiltItemCompleted'),
    governmentChanged: events.filter((event): event is CivReplayGovernmentChangedEvent => event.type === 'governmentChanged'),
    goodyHutCategoryCountChanged: events.filter((event): event is CivReplayGoodyHutCategoryCountChangedEvent => event.type === 'goodyHutCategoryCountChanged'),
    dedicationChanged: events.filter((event): event is CivReplayDedicationChangedEvent => event.type === 'dedicationChanged'),
    ageChanged: events.filter((event): event is CivReplayAgeChangedEvent => event.type === 'ageChanged'),
    pantheonChanged: events.filter((event): event is CivReplayPantheonChangedEvent => event.type === 'pantheonChanged'),
    cityReligionChanged: events.filter((event): event is CivReplayCityReligionChangedEvent => event.type === 'cityReligionChanged'),
    districtPlaced: events.filter((event): event is CivReplayDistrictPlacedEvent => event.type === 'districtPlaced'),
    districtBuilt: events.filter((event): event is CivReplayDistrictBuiltEvent => event.type === 'districtBuilt'),
    unitsCreated: events.filter((event): event is CivReplayUnitCreatedEvent => event.type === 'unitCreated'),
    unitsLost: events.filter((event): event is CivReplayUnitLostEvent => event.type === 'unitLost'),
    unitsUpgraded: events.filter((event): event is CivReplayUnitUpgradedEvent => event.type === 'unitUpgraded'),
    governorsAssigned: events.filter((event): event is CivReplayGovernorAssignedEvent => event.type === 'governorAssigned'),
    governorsPromoted: events.filter((event): event is CivReplayGovernorPromotedEvent => event.type === 'governorPromoted'),
    tileImprovementsChanged: events.filter((event): event is CivReplayTileImprovementChangedEvent => event.type === 'tileImprovementChanged'),
  }
}

function buildCityStatesState(snapshots: readonly CivReplayTurnSnapshot[]): CivupOpeningCityStatesState {
  const byCityState = new Map<string, CivupOpeningCityState>()
  const sources = new Set<string>()
  for (const snapshot of snapshots) {
    for (const source of snapshot.cityStates.sources) sources.add(source)
    for (const cityState of snapshot.cityStates.cityStates) {
      const existing = byCityState.get(cityState.cityStateId)
      const turn = snapshot.turnFromName
      if (!existing) {
        byCityState.set(cityState.cityStateId, {
          cityStateId: cityState.cityStateId,
          civilizationType: cityState.civilizationType,
          leaderType: cityState.leaderType,
          category: cityState.category,
          name: cityState.name,
          description: cityState.description,
          displayName: cityState.displayName,
          capitalName: cityState.capitalName,
          cityName: cityState.cityName,
          cityId: cityState.cityId,
          x: cityState.x,
          y: cityState.y,
          population: cityState.population,
          playerId: cityState.playerId,
          ownerPlayerId: cityState.ownerPlayerId,
          ownerKind: cityState.ownerKind,
          alive: cityState.alive,
          status: cityState.status,
          envoys: cityState.envoys,
          suzerainPlayerId: cityState.suzerainPlayerId,
          suzerainEnvoys: cityState.suzerainEnvoys,
          suzerainStatus: cityState.suzerainStatus,
          firstTurn: turn,
          lastTurn: turn,
        })
        continue
      }

      existing.cityName = cityState.cityName
      existing.cityId = cityState.cityId
      existing.x = cityState.x
      existing.y = cityState.y
      existing.population = cityState.population
      existing.playerId = cityState.playerId ?? existing.playerId
      existing.ownerPlayerId = cityState.ownerPlayerId
      existing.ownerKind = cityState.ownerKind
      existing.alive = cityState.alive
      existing.status = cityState.status
      existing.envoys = cityState.envoys
      existing.suzerainPlayerId = cityState.suzerainPlayerId
      existing.suzerainEnvoys = cityState.suzerainEnvoys
      existing.suzerainStatus = cityState.suzerainStatus
      existing.lastTurn = turn
    }
  }

  const finalTurn = snapshots.at(-1)?.turnFromName ?? null
  const currentCityStateIds = new Set(snapshots.at(-1)?.cityStates.cityStates.map(cityState => cityState.cityStateId) ?? [])
  for (const cityState of byCityState.values()) {
    if (finalTurn != null && !currentCityStateIds.has(cityState.cityStateId)) {
      cityState.alive = false
      cityState.status = 'notPresent'
      cityState.lastTurn = cityState.lastTurn ?? finalTurn
    }
  }

  const cityStates = [...byCityState.values()].sort(compareOpeningCityStates)
  const aliveCount = cityStates.filter(cityState => cityState.status === 'alive').length
  const capturedCount = cityStates.filter(cityState => cityState.status === 'captured').length
  const notPresentCount = cityStates.filter(cityState => cityState.status === 'notPresent').length
  const scientificCount = cityStates.filter(cityState => cityState.category === 'scientific').length
  const scientificAliveCount = cityStates.filter(cityState => cityState.category === 'scientific' && cityState.status === 'alive').length
  return {
    count: cityStates.length,
    aliveCount,
    capturedCount,
    notPresentCount,
    scientificCount,
    scientificAliveCount,
    sources: [...sources].sort(),
    unsupported: {
      suzerain: 'suzerain player is decoded from city-state influence token tables; quest/visibility state is not decoded yet',
      envoyCounts: 'envoy counts are decoded from city-state influence token tables',
    },
    cityStates,
  }
}

function buildReligionState(snapshots: readonly CivReplayTurnSnapshot[], playerId: number): CivupOpeningReligionState {
  const player = snapshots.findLast(snapshot => findPlayer(snapshot, playerId))?.players.players.find(player => player.id === playerId) ?? null
  if (!player) return { pantheon: null, cityReligions: [] }
  return {
    pantheon: normalizeNullableHash(player.pantheon),
    cityReligions: player.cities
      .map(city => ({ city, religion: normalizeNullableHash(city.religion) }))
      .filter((item): item is { city: CivReplayPlayerSnapshot['cities'][number], religion: number } => item.religion != null)
      .map(({ city, religion }) => ({ cityId: city.id, cityName: city.name, x: city.x, y: city.y, religion }))
      .sort(compareCityReligions),
  }
}

function collectOpeningHashNames(milestones: CivupOpeningMilestones, religion: CivupOpeningReligionState, turns: readonly CivupOpeningTurnMetric[], hashResolver: HashResolver): Record<string, string> {
  const hashes = new Set<number>()
  for (const event of milestones.techCompleted) hashes.add(event.hash)
  for (const event of milestones.civicCompleted) hashes.add(event.hash)
  for (const event of milestones.productionChanged) {
    for (const hash of event.previousProductionItems) hashes.add(hash)
    for (const hash of event.currentProductionItems) hashes.add(hash)
  }
  for (const event of milestones.cityBuiltItemsCompleted) hashes.add(event.itemHash)
  for (const event of milestones.governmentChanged) {
    if (event.previousGovernment != null) hashes.add(event.previousGovernment)
    if (event.currentGovernment != null) hashes.add(event.currentGovernment)
    for (const slot of event.previousPolicies) for (const hash of slot) hashes.add(hash)
    for (const slot of event.currentPolicies) for (const hash of slot) hashes.add(hash)
  }
  for (const event of milestones.goodyHutCategoryCountChanged) hashes.add(event.categoryHash)
  for (const event of milestones.dedicationChanged) {
    if (event.previousHash != null) hashes.add(event.previousHash)
    if (event.currentHash != null) hashes.add(event.currentHash)
  }
  for (const event of milestones.pantheonChanged) {
    if (event.previousPantheon != null) hashes.add(event.previousPantheon)
    if (event.currentPantheon != null) hashes.add(event.currentPantheon)
  }
  for (const event of milestones.cityReligionChanged) {
    if (event.previousReligion != null) hashes.add(event.previousReligion)
    if (event.currentReligion != null) hashes.add(event.currentReligion)
  }
  for (const event of milestones.districtPlaced) hashes.add(event.districtType)
  for (const event of milestones.districtBuilt) hashes.add(event.districtType)
  for (const event of milestones.unitsCreated) {
    hashes.add(event.unitType)
    for (const hash of event.previousCityProductionItems) hashes.add(hash)
    for (const hash of event.currentCityProductionItems) hashes.add(hash)
  }
  for (const event of milestones.unitsLost) hashes.add(event.unitType)
  for (const event of milestones.unitsUpgraded) {
    hashes.add(event.previousUnitType)
    hashes.add(event.currentUnitType)
  }
  for (const event of milestones.governorsAssigned) {
    hashes.add(event.governorType)
    for (const hash of event.promotionHashes) hashes.add(hash)
  }
  for (const event of milestones.governorsPromoted) {
    hashes.add(event.governorType)
    hashes.add(event.promotionHash)
  }
  for (const event of milestones.tileImprovementsChanged) {
    if (event.previousImprovementType != null) hashes.add(event.previousImprovementType)
    if (event.currentImprovementType != null) hashes.add(event.currentImprovementType)
  }
  if (religion.pantheon != null) hashes.add(religion.pantheon)
  for (const cityReligion of religion.cityReligions) hashes.add(cityReligion.religion)
  for (const turn of turns) {
    if (turn.dedicationHash != null) hashes.add(turn.dedicationHash)
    for (const hash of turn.dedicationAvailableHashes) hashes.add(hash)
  }
  const resolved: Record<string, string> = {}
  for (const hash of hashes) {
    const name = hashResolver.resolve(hash)
    if (name) resolved[String(hash)] = name
  }
  return resolved
}

function findPlayer(snapshot: CivReplayTurnSnapshot, playerId: number): CivReplayPlayerSnapshot | null {
  return snapshot.players.players.find(player => player.id === playerId) ?? null
}

function firstPresent(values: readonly (number | null)[]): number | null {
  return values.find((value): value is number => value != null) ?? null
}

function firstPresentString(values: readonly (string | null)[]): string | null {
  return values.find((value): value is string => value != null && value.length > 0) ?? null
}

function sumYields(player: CivReplayPlayerSnapshot, hashResolver: HashResolver): Record<string, number> {
  const totals = new Map<string, number>()
  for (const city of player.cities) {
    for (const item of city.yields) {
      const label = hashResolver.resolve(item.hash) ?? formatHash(item.hash)
      totals.set(label, (totals.get(label) ?? 0) + item.value)
    }
  }
  return Object.fromEntries([...totals].sort(([left], [right]) => left.localeCompare(right)))
}

function countProgressionFound(progression: CivReplayPlayerSnapshot['techs']): number {
  return progression?.found.filter(item => item.value).length ?? 0
}

function countProgressionFoundBoosted(progression: CivReplayPlayerSnapshot['techs']): number {
  if (!progression) return 0
  const boosted = new Set(progression.boost.filter(item => item.value).map(item => item.hash))
  return progression.found.filter(item => item.value && boosted.has(item.hash)).length
}

const TYPE_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  BBG_AGRICULTURE_PROMOTION: 'Agriculture',
  BUILDING_CASA_DE_CONTRATACION: 'Casa de Contratacion',
  BUILDING_GOV_CITYSTATES: 'Foreign Ministry',
  BUILDING_GOV_WIDE: 'Ancestral Hall',
  DISTRICT_GOVERNMENT: 'Government Plaza',
  DISTRICT_THEATER: 'Theater Square',
  GOVERNOR_THE_AMBASSADOR: 'Amani',
  GOVERNOR_THE_BUILDER: 'Liang',
  GOVERNOR_THE_CARDINAL: 'Moksha',
  GOVERNOR_THE_DEFENDER: 'Victor',
  GOVERNOR_THE_EDUCATOR: 'Pingala',
  GOVERNOR_THE_MERCHANT: 'Reyna',
  GOVERNOR_THE_RESOURCE_MANAGER: 'Magnus',
  POLICY_GOV_AUTOCRACY: 'Autocratic Legacy',
}

const TYPE_PREFIXES = [
  'GOVERNOR_PROMOTION_',
  'COMMEMORATION_',
  'CIVILIZATION_',
  'IMPROVEMENT_',
  'GOVERNMENT_',
  'DISTRICT_',
  'BUILDING_',
  'RESOURCE_',
  'GOVERNOR_',
  'GOODYHUT_',
  'POLICY_',
  'CIVIC_',
  'YIELD_',
  'TECH_',
  'UNIT_',
] as const

function formatResolvedHash(hash: number, hashNames: Record<string, string>): string {
  const name = hashNames[String(hash)]
  return name ? formatTypeDisplayName(name) : formatHash(hash)
}

function formatOptionalResolvedHash(hash: number | null, hashNames: Record<string, string>): string {
  return hash == null ? '-' : formatResolvedHash(hash, hashNames)
}

function formatDedication(hash: number | null, recordId: number | null, hashNames: Record<string, string>): string {
  if (hash == null) return '-'
  return formatDedicationName(hash, hashNames)
}

function formatDedicationName(hash: number, hashNames: Record<string, string>): string {
  const displayName = resolveCivReplayDedicationDisplayName(hash)
  return displayName ?? formatResolvedHash(hash, hashNames)
}

function formatTypeDisplayName(value: string): string {
  const override = TYPE_DISPLAY_NAME_OVERRIDES[value]
  if (override) return override
  const prefix = TYPE_PREFIXES.find(prefix => value.startsWith(prefix))
  return formatTitleName(prefix ? value.slice(prefix.length) : value)
}

function formatTitleName(value: string): string {
  return value
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}

function formatCamelName(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function formatPolicySlots(policies: readonly (readonly number[])[], hashNames: Record<string, string>): string {
  const labels = ['economic', 'military', 'diplomatic', 'wildcard']
  return policies
    .map((slot, index) => `${labels[index] ?? `slot${index}`}: ${slot.map(hash => formatResolvedHash(hash, hashNames)).join(', ') || '-'}`)
    .join('; ')
}

function pickKeyTurns(turns: readonly CivupOpeningTurnMetric[], toTurn: number): CivupOpeningTurnMetric[] {
  const targets = [10, 20, 30, 40, 50].filter(turn => turn <= toTurn)
  return targets.map(target => turns.find(turn => turn.turn === target) ?? turns.findLast(turn => turn.turn != null && turn.turn <= target)).filter((turn): turn is CivupOpeningTurnMetric => turn != null)
}

function formatYields(yields: Record<string, number>): string {
  const preferred = ['YIELD_FOOD', 'YIELD_PRODUCTION', 'YIELD_SCIENCE', 'YIELD_CULTURE', 'YIELD_GOLD', 'YIELD_FAITH']
  return preferred
    .filter(key => yields[key] != null)
    .map(key => `${key.replace('YIELD_', '').toLowerCase()} ${formatNumber(yields[key]!)}`)
    .join(', ') || 'none'
}

function formatTradeRouteCounts(turn: CivupOpeningTurnMetric): string {
  const unknown = turn.unknownTradeRouteDestinationOwnerCount > 0 ? `, ${turn.unknownTradeRouteDestinationOwnerCount} unknown destination owner` : ''
  return `${turn.tradeRouteCount} (${turn.domesticTradeRouteCount} domestic, ${turn.internationalTradeRouteCount} international, ${turn.teamTradeRouteCount} team${unknown})`
}

function formatAgeMetric(turn: CivupOpeningTurnMetric): string {
  const age = turn.age ?? '?'
  const score = turn.eraScoreCurrent ?? '?'
  const previous = turn.eraScorePrevious == null ? '' : `, previous era ${turn.eraScorePrevious}`
  return `${age}, score ${score}${previous}`
}

function formatLuxuryResources(resources: readonly { resourceType: string, x: number, y: number, cityName: string, improved: boolean, improvementType: string | null }[]): string {
  if (resources.length === 0) return 'none'
  return resources
    .map(resource => `${formatTypeDisplayName(resource.resourceType)} (${resource.x},${resource.y}) ${resource.cityName}${resource.improved ? ` improved${resource.improvementType ? ` ${formatTypeDisplayName(resource.improvementType)}` : ''}` : ''}`)
    .join('; ')
}

function formatCityReligions(cityReligions: readonly CivupOpeningCityReligion[], hashNames: Record<string, string>): string {
  if (cityReligions.length === 0) return 'none'
  return cityReligions
    .map(item => `${item.cityName} ${formatResolvedHash(item.religion, hashNames)} (${item.x},${item.y})`)
    .join('; ')
}

function formatOpeningCityStateBrief(cityState: CivupOpeningCityState): string {
  const influence = formatCityStateInfluence(cityState)
  return `${cityState.displayName} (${formatTitleName(cityState.category)}, ${formatCityStateStatus(cityState.status)}${influence})`
}

function formatCityStateInfluence(cityState: CivupOpeningCityState): string {
  if (cityState.suzerainStatus === 'unknown' && cityState.envoys.length === 0) return ''
  const suzerain = cityState.suzerainPlayerId == null
    ? cityState.suzerainStatus === 'tied' ? `suz tied ${cityState.suzerainEnvoys ?? '?'}e` : 'no suz'
    : `suz P${cityState.suzerainPlayerId} ${cityState.suzerainEnvoys ?? '?'}e`
  const envoys = cityState.envoys.length ? `envoys ${cityState.envoys.map(item => `P${item.playerId}:${item.envoys}`).join(',')}` : 'envoys none'
  return `, ${suzerain}, ${envoys}`
}

function formatOpeningCityStateLocation(cityState: CivupOpeningCityState): string {
  const owner = cityState.status === 'alive'
    ? `player ${cityState.playerId ?? cityState.ownerPlayerId}`
    : `owner player ${cityState.ownerPlayerId}`
  return ` at (${cityState.x},${cityState.y}) ${owner}`
}

function formatOpeningCityStateTurns(cityState: CivupOpeningCityState): string {
  if (cityState.firstTurn == null && cityState.lastTurn == null) return ''
  if (cityState.firstTurn === cityState.lastTurn) return ` seen T${cityState.firstTurn ?? '?'}`
  return ` seen T${cityState.firstTurn ?? '?'}-${cityState.lastTurn ?? '?'}`
}

function formatCityStateStatus(status: CivupOpeningCityState['status']): string {
  return status === 'notPresent' ? 'not present' : status
}

function formatUnitCreatedCity(event: CivReplayUnitCreatedEvent): string {
  return event.cityName == null || event.cityX == null || event.cityY == null ? '' : ` from ${event.cityName} (${event.cityX},${event.cityY})`
}

function formatUnitCreationMethod(event: CivReplayUnitCreatedEvent, hashNames: Record<string, string>): string {
  const method = event.creationMethod === 'producedOrChopped'
    ? 'produced/chopped'
    : event.creationMethod === 'likelySettlementGrantOrInstant' ? 'settlement grant/instant'
      : event.creationMethod === 'likelyPurchasedOrGranted' ? 'likely bought/instant' : 'unknown source'
  const previous = event.previousCityProductionItems.length
    ? `; prev ${event.previousCityProductionItems.map(hash => formatResolvedHash(hash, hashNames)).join(', ')}`
    : ''
  return ` [${method}, ${event.creationConfidence}${previous}]`
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function matchesFocus(player: CivupTimelinePlayerSummary, focus: string): boolean {
  const needle = normalize(focus)
  return [player.playerName, player.leader, player.civilization].some(value => normalize(value ?? '').includes(needle))
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeNullableHash(value: number | null | undefined): number | null {
  return value == null || value === 0 || value === 0xFFFFFFFF ? null : value
}

function compareCityReligions(left: CivupOpeningCityReligion, right: CivupOpeningCityReligion): number {
  return left.cityId - right.cityId || left.cityName.localeCompare(right.cityName) || left.x - right.x || left.y - right.y
}

function compareOpeningCityStates(left: CivupOpeningCityState, right: CivupOpeningCityState): number {
  return cityStateCategoryRank(left.category) - cityStateCategoryRank(right.category)
    || left.displayName.localeCompare(right.displayName)
    || cityStateStatusRank(left.status) - cityStateStatusRank(right.status)
    || left.ownerPlayerId - right.ownerPlayerId
}

function cityStateCategoryRank(category: CivReplayCityStateCategory): number {
  switch (category) {
    case 'scientific': return 0
    case 'cultural': return 1
    case 'religious': return 2
    case 'trade': return 3
    case 'industrial': return 4
    case 'militaristic': return 5
  }
}

function cityStateStatusRank(status: CivupOpeningCityState['status']): number {
  if (status === 'alive') return 0
  if (status === 'captured') return 1
  return 2
}
