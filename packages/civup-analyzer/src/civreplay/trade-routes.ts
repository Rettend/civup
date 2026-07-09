import { civHash, formatHash, type HashResolver } from '../hash.ts'
import type { CivReplayHashFloatValue, CivReplayPlayerSnapshot } from './players.ts'

export const UNITOPERATION_MAKE_TRADE_ROUTE = civHash('UNITOPERATION_MAKE_TRADE_ROUTE')
export const TRADE_ROUTE_YIELDS_UNSUPPORTED = 'active trade-route endpoints are decoded from trader unit operation state; per-route yields, remaining turns, and total length are not decoded from save data yet'
export const KNOWN_TRADE_ROUTE_YIELDS_DESCRIPTION = 'known route-yield components include destination/origin district route yields and active policy modifiers with unconditional, domestic, or international route-yield scopes; exact UI route yields remain unsupported'
export const KNOWN_TRADE_ROUTE_YIELDS_EXCLUDED = 'excluded components include route-yield buildings/wonders, civ traits, great people, governments, commemorations, alliance type/level effects, suzerain/envoy effects, and any modifier scope not explicitly modeled'

export interface CivReplayUnitTradeRouteOperationSnapshot {
  destinationX: number
  destinationY: number
  originX: number
  originY: number
}

export interface CivReplayTradeRouteCityRefSnapshot {
  playerId: number
  cityId: number
  name: string
  x: number
  y: number
}

export type CivReplayTradeRouteRelationship = 'domestic' | 'international' | 'unknown'

export interface CivReplayTradeRouteSnapshot {
  ownerPlayerId: number
  traderUnitId: number
  originX: number
  originY: number
  destinationX: number
  destinationY: number
  originCity: CivReplayTradeRouteCityRefSnapshot | null
  destinationCity: CivReplayTradeRouteCityRefSnapshot | null
  originCityId: number | null
  originCityName: string | null
  originCityPlayerId: number | null
  destinationCityId: number | null
  destinationCityName: string | null
  destinationCityPlayerId: number | null
  relationship: CivReplayTradeRouteRelationship
  yields: CivReplayHashFloatValue[]
  remainingTurns: number | null
  length: number | null
}

export interface CivReplayTradeRouteSummary {
  activeCount: number
  domesticCount: number
  internationalCount: number
  teamCount: number
  unknownDestinationOwnerCount: number
  yieldTotals: Record<string, number>
  science: number | null
  culture: number | null
}

export interface CivReplayTradeRouteKnownYieldSummary {
  yieldTotals: Record<string, number>
  science: number | null
  culture: number | null
  unsupported: string[]
}

export interface CivReplayTradeRouteYieldModel {
  districtYields: readonly CivReplayTradeRouteDistrictYieldRule[]
  policyYields: readonly CivReplayTradeRoutePolicyYieldRule[]
  unsupportedPolicyModifiers: readonly CivReplayTradeRouteUnsupportedPolicyModifier[]
}

export interface CivReplayTradeRouteDistrictYieldRule {
  districtType: string
  yieldType: string
  origin: number
  domesticDestination: number
  internationalDestination: number
}

export type CivReplayTradeRoutePolicyYieldScope = 'all' | 'domestic' | 'international'

export interface CivReplayTradeRoutePolicyYieldRule {
  policyType: string
  modifierId: string
  yieldType: string
  amount: number
  scope: CivReplayTradeRoutePolicyYieldScope
}

export interface CivReplayTradeRouteUnsupportedPolicyModifier {
  policyType: string
  modifierId: string
  modifierType: string
}

export function buildCivReplayTradeRoutes(players: CivReplayPlayerSnapshot[]) {
  const cityByCoordinate = buildCityCoordinateIndex(players)
  for (const player of players) {
    player.tradeRoutes = player.units.flatMap(unit => unit.tradeRouteOperations.map(operation => {
      const route = normalizeTradeRouteEndpointOrder({
        ownerPlayerId: player.id,
        traderUnitId: unit.id,
        originX: operation.originX,
        originY: operation.originY,
        destinationX: operation.destinationX,
        destinationY: operation.destinationY,
        originCity: resolveCityAt(cityByCoordinate, operation.originX, operation.originY),
        destinationCity: resolveCityAt(cityByCoordinate, operation.destinationX, operation.destinationY),
      })
      return attachTradeRouteMetadata(route)
    }))
    player.tradeRouteCount = player.tradeRoutes.length
  }
}

export function summarizeCivReplayTradeRoutes(
  routes: readonly CivReplayTradeRouteSnapshot[],
  hashResolver: HashResolver,
  teamByPlayerId: ReadonlyMap<number, number | null> = new Map(),
): CivReplayTradeRouteSummary {
  const yieldTotals = sumTradeRouteYields(routes, hashResolver)
  const hasDecodedYields = routes.some(route => route.yields.length > 0)
  return {
    activeCount: routes.length,
    domesticCount: routes.filter(route => route.relationship === 'domestic').length,
    internationalCount: routes.filter(route => route.relationship === 'international').length,
    teamCount: routes.filter(route => isTeamRoute(route, teamByPlayerId)).length,
    unknownDestinationOwnerCount: routes.filter(route => route.destinationCityPlayerId == null).length,
    yieldTotals,
    science: hasDecodedYields ? yieldTotals.YIELD_SCIENCE ?? 0 : null,
    culture: hasDecodedYields ? yieldTotals.YIELD_CULTURE ?? 0 : null,
  }
}

export function summarizeCivReplayKnownTradeRouteYields(
  player: CivReplayPlayerSnapshot | null,
  players: readonly CivReplayPlayerSnapshot[],
  hashResolver: HashResolver,
  model: CivReplayTradeRouteYieldModel,
): CivReplayTradeRouteKnownYieldSummary {
  if (!player || model.districtYields.length + model.policyYields.length + model.unsupportedPolicyModifiers.length === 0) {
    return { yieldTotals: {}, science: null, culture: null, unsupported: [] }
  }

  const totals = new Map<string, number>()
  const unsupported = new Set<string>()
  const districtRules = groupDistrictYieldRules(model.districtYields)
  const policyRules = groupPolicyYieldRules(model.policyYields)
  const unsupportedPolicyModifiers = groupUnsupportedPolicyModifiers(model.unsupportedPolicyModifiers)
  const builtDistrictsByCity = buildBuiltDistrictsByCity(players, hashResolver)
  const activePolicyTypes = flattenPolicyTypes(player, hashResolver)

  for (const route of player.tradeRoutes) {
    addKnownDistrictRouteYields(totals, route, builtDistrictsByCity, districtRules)
    addKnownPolicyRouteYields(totals, route, activePolicyTypes, policyRules)
    if (route.originCityId == null || route.destinationCityId == null || route.relationship === 'unknown') unsupported.add('unknown endpoint owner or city prevents district route-yield calculation for at least one route')
  }

  for (const policyType of activePolicyTypes) {
    for (const modifier of unsupportedPolicyModifiers.get(policyType) ?? []) {
      unsupported.add(`${modifier.policyType}:${modifier.modifierId}:${modifier.modifierType}`)
    }
  }

  const yieldTotals = Object.fromEntries([...totals].sort(([left], [right]) => left.localeCompare(right)))
  return {
    yieldTotals,
    science: yieldTotals.YIELD_SCIENCE ?? 0,
    culture: yieldTotals.YIELD_CULTURE ?? 0,
    unsupported: [...unsupported].sort(),
  }
}

function buildCityCoordinateIndex(players: readonly CivReplayPlayerSnapshot[]): Map<string, CivReplayTradeRouteCityRefSnapshot[]> {
  const index = new Map<string, CivReplayTradeRouteCityRefSnapshot[]>()
  for (const player of players) {
    for (const city of player.cities) {
      const key = coordinateKey(city.x, city.y)
      const refs = index.get(key) ?? []
      refs.push({ playerId: player.id, cityId: city.id, name: city.name, x: city.x, y: city.y })
      index.set(key, refs)
    }
  }
  return index
}

function resolveCityAt(index: ReadonlyMap<string, readonly CivReplayTradeRouteCityRefSnapshot[]>, x: number, y: number): CivReplayTradeRouteCityRefSnapshot | null {
  if (!isPlausibleMapCoordinate(x) || !isPlausibleMapCoordinate(y)) return null
  const refs = index.get(coordinateKey(x, y)) ?? []
  return refs.length === 1 ? refs[0]! : null
}

function normalizeTradeRouteEndpointOrder(route: Omit<CivReplayTradeRouteSnapshot, 'originCityId' | 'originCityName' | 'originCityPlayerId' | 'destinationCityId' | 'destinationCityName' | 'destinationCityPlayerId' | 'relationship' | 'yields' | 'remainingTurns' | 'length'>): Omit<CivReplayTradeRouteSnapshot, 'originCityId' | 'originCityName' | 'originCityPlayerId' | 'destinationCityId' | 'destinationCityName' | 'destinationCityPlayerId' | 'relationship' | 'yields' | 'remainingTurns' | 'length'> {
  if (route.originCity?.playerId === route.ownerPlayerId || route.destinationCity?.playerId !== route.ownerPlayerId) return route
  return {
    ...route,
    originX: route.destinationX,
    originY: route.destinationY,
    destinationX: route.originX,
    destinationY: route.originY,
    originCity: route.destinationCity,
    destinationCity: route.originCity,
  }
}

function attachTradeRouteMetadata(route: Omit<CivReplayTradeRouteSnapshot, 'originCityId' | 'originCityName' | 'originCityPlayerId' | 'destinationCityId' | 'destinationCityName' | 'destinationCityPlayerId' | 'relationship' | 'yields' | 'remainingTurns' | 'length'>): CivReplayTradeRouteSnapshot {
  const originCityPlayerId = route.originCity?.playerId ?? null
  const destinationCityPlayerId = route.destinationCity?.playerId ?? null
  return {
    ...route,
    originCityId: route.originCity?.cityId ?? null,
    originCityName: route.originCity?.name ?? null,
    originCityPlayerId,
    destinationCityId: route.destinationCity?.cityId ?? null,
    destinationCityName: route.destinationCity?.name ?? null,
    destinationCityPlayerId,
    relationship: destinationCityPlayerId == null ? 'unknown' : destinationCityPlayerId === route.ownerPlayerId ? 'domestic' : 'international',
    yields: [],
    remainingTurns: null,
    length: null,
  }
}

function isTeamRoute(route: CivReplayTradeRouteSnapshot, teamByPlayerId: ReadonlyMap<number, number | null>): boolean {
  if (route.destinationCityPlayerId == null || route.destinationCityPlayerId === route.ownerPlayerId) return false
  const ownerTeam = teamByPlayerId.get(route.ownerPlayerId) ?? null
  const destinationTeam = teamByPlayerId.get(route.destinationCityPlayerId) ?? null
  return ownerTeam != null && ownerTeam === destinationTeam
}

function sumTradeRouteYields(routes: readonly CivReplayTradeRouteSnapshot[], hashResolver: HashResolver): Record<string, number> {
  const totals = new Map<string, number>()
  for (const route of routes) {
    for (const item of route.yields) {
      const label = hashResolver.resolve(item.hash) ?? formatHash(item.hash)
      totals.set(label, (totals.get(label) ?? 0) + item.value)
    }
  }
  return Object.fromEntries([...totals].sort(([left], [right]) => left.localeCompare(right)))
}

function addKnownDistrictRouteYields(
  totals: Map<string, number>,
  route: CivReplayTradeRouteSnapshot,
  builtDistrictsByCity: ReadonlyMap<string, readonly string[]>,
  districtRules: ReadonlyMap<string, readonly CivReplayTradeRouteDistrictYieldRule[]>,
): void {
  if (route.originCityPlayerId != null && route.originCityId != null) {
    for (const districtType of builtDistrictsByCity.get(cityKey(route.originCityPlayerId, route.originCityId)) ?? []) {
      for (const rule of districtRules.get(districtType) ?? []) addYield(totals, rule.yieldType, rule.origin)
    }
  }

  if (route.destinationCityPlayerId == null || route.destinationCityId == null || route.relationship === 'unknown') return
  const field = route.relationship === 'domestic' ? 'domesticDestination' : 'internationalDestination'
  for (const districtType of builtDistrictsByCity.get(cityKey(route.destinationCityPlayerId, route.destinationCityId)) ?? []) {
    for (const rule of districtRules.get(districtType) ?? []) addYield(totals, rule.yieldType, rule[field])
  }
}

function addKnownPolicyRouteYields(
  totals: Map<string, number>,
  route: CivReplayTradeRouteSnapshot,
  activePolicyTypes: ReadonlySet<string>,
  policyRules: ReadonlyMap<string, readonly CivReplayTradeRoutePolicyYieldRule[]>,
): void {
  for (const policyType of activePolicyTypes) {
    for (const rule of policyRules.get(policyType) ?? []) {
      if (!policyRuleApplies(rule, route.relationship)) continue
      addYield(totals, rule.yieldType, rule.amount)
    }
  }
}

function policyRuleApplies(rule: CivReplayTradeRoutePolicyYieldRule, relationship: CivReplayTradeRouteRelationship): boolean {
  if (rule.scope === 'all') return relationship !== 'unknown'
  if (rule.scope === 'domestic') return relationship === 'domestic'
  return relationship === 'international'
}

function buildBuiltDistrictsByCity(players: readonly CivReplayPlayerSnapshot[], hashResolver: HashResolver): Map<string, string[]> {
  const cityKeys = new Set<string>()
  for (const player of players) for (const city of player.cities) cityKeys.add(cityKey(player.id, city.id))

  const districts = new Map<string, string[]>()
  for (const player of players) {
    for (const district of player.districts) {
      if (district.built === 0) continue
      const key = cityKey(player.id, district.cityId)
      if (!cityKeys.has(key)) continue
      const districtType = hashResolver.resolve(district.type) ?? formatHash(district.type)
      const items = districts.get(key) ?? []
      items.push(districtType)
      districts.set(key, items)
    }
  }
  return districts
}

function flattenPolicyTypes(player: CivReplayPlayerSnapshot, hashResolver: HashResolver): Set<string> {
  const policies = new Set<string>()
  for (const slot of player.policies) {
    for (const policyHash of slot) {
      const policyType = hashResolver.resolve(policyHash)
      if (policyType) policies.add(policyType)
    }
  }
  return policies
}

function groupDistrictYieldRules(rules: readonly CivReplayTradeRouteDistrictYieldRule[]): Map<string, CivReplayTradeRouteDistrictYieldRule[]> {
  const grouped = new Map<string, CivReplayTradeRouteDistrictYieldRule[]>()
  for (const rule of rules) {
    const items = grouped.get(rule.districtType) ?? []
    items.push(rule)
    grouped.set(rule.districtType, items)
  }
  return grouped
}

function groupPolicyYieldRules(rules: readonly CivReplayTradeRoutePolicyYieldRule[]): Map<string, CivReplayTradeRoutePolicyYieldRule[]> {
  const grouped = new Map<string, CivReplayTradeRoutePolicyYieldRule[]>()
  for (const rule of rules) {
    const items = grouped.get(rule.policyType) ?? []
    items.push(rule)
    grouped.set(rule.policyType, items)
  }
  return grouped
}

function groupUnsupportedPolicyModifiers(modifiers: readonly CivReplayTradeRouteUnsupportedPolicyModifier[]): Map<string, CivReplayTradeRouteUnsupportedPolicyModifier[]> {
  const grouped = new Map<string, CivReplayTradeRouteUnsupportedPolicyModifier[]>()
  for (const modifier of modifiers) {
    const items = grouped.get(modifier.policyType) ?? []
    items.push(modifier)
    grouped.set(modifier.policyType, items)
  }
  return grouped
}

function addYield(totals: Map<string, number>, yieldType: string, amount: number): void {
  if (amount === 0) return
  totals.set(yieldType, (totals.get(yieldType) ?? 0) + amount)
}

function cityKey(playerId: number, cityId: number): string {
  return `${playerId}:${cityId}`
}

function coordinateKey(x: number, y: number): string {
  return `${x}:${y}`
}

function isPlausibleMapCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1024
}
