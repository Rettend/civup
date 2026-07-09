import type {
  CivReplayAgeState,
  CivReplayCitySnapshot,
  CivReplayDistrictSnapshot,
  CivReplayGovernorSnapshot,
  CivReplayHashBoolValue,
  CivReplayHashFloatValue,
  CivReplayHashValue,
  CivReplayImprovementSnapshot,
  CivReplayPlayerSnapshot,
  CivReplayProgressionSnapshot,
  CivReplayUnitSnapshot,
} from './players.ts'
import type { CivReplayTurnSnapshot } from './snapshot.ts'
import { createCivReplayCityAttributionContext, inferUnitCreatedCity, type CivReplayCityAttributionContext } from './city-attribution.ts'

export type CivReplaySnapshotEvent =
  | CivReplayCityFoundedEvent
  | CivReplayCityProductionChangedEvent
  | CivReplayCityBuiltItemCompletedEvent
  | CivReplayProgressionCompletedEvent
  | CivReplayGovernmentChangedEvent
  | CivReplayGoodyHutCategoryCountChangedEvent
  | CivReplayDedicationChangedEvent
  | CivReplayAgeChangedEvent
  | CivReplayPantheonChangedEvent
  | CivReplayCityReligionChangedEvent
  | CivReplayDistrictPlacedEvent
  | CivReplayDistrictBuiltEvent
  | CivReplayUnitCreatedEvent
  | CivReplayUnitLostEvent
  | CivReplayUnitUpgradedEvent
  | CivReplayGovernorAssignedEvent
  | CivReplayGovernorPromotedEvent
  | CivReplayTileImprovementChangedEvent

export interface CivReplayCityFoundedEvent {
  type: 'cityFounded'
  turn: number | null
  playerId: number
  cityId: number
  name: string
  x: number
  y: number
  population: number
}

export interface CivReplayCityProductionChangedEvent {
  type: 'cityProductionChanged'
  turn: number | null
  playerId: number
  cityId: number
  name: string
  x: number
  y: number
  previousProductionType: number | null
  currentProductionType: number | null
  previousProductionItems: number[]
  currentProductionItems: number[]
}

export interface CivReplayCityBuiltItemCompletedEvent {
  type: 'cityBuiltItemCompleted'
  turn: number | null
  playerId: number
  cityId: number
  name: string
  x: number
  y: number
  itemHash: number
  previousValue: number | null
  currentValue: number
}

export interface CivReplayGovernmentChangedEvent {
  type: 'governmentChanged'
  turn: number | null
  playerId: number
  previousGovernment: number | null
  currentGovernment: number | null
  previousLastTurnChangeGovernment: number | null
  currentLastTurnChangeGovernment: number | null
  previousPolicies: number[][]
  currentPolicies: number[][]
}

export interface CivReplayGoodyHutCategoryCountChangedEvent {
  type: 'goodyHutCategoryCountChanged'
  turn: number | null
  playerId: number
  categoryHash: number
  previousValue: number
  currentValue: number
}

export interface CivReplayDedicationChangedEvent {
  type: 'dedicationChanged'
  turn: number | null
  playerId: number
  previousHash: number | null
  currentHash: number | null
  previousRecordId: number | null
  currentRecordId: number | null
}

export interface CivReplayAgeChangedEvent {
  type: 'ageChanged'
  turn: number | null
  playerId: number
  previousAge: CivReplayAgeState | null
  currentAge: CivReplayAgeState | null
  previousCurrentScore: number | null
  currentCurrentScore: number | null
  previousHasGoldenAge: boolean | null
  currentHasGoldenAge: boolean | null
  previousHasDarkAge: boolean | null
  currentHasDarkAge: boolean | null
}

export interface CivReplayProgressionCompletedEvent {
  type: 'techCompleted' | 'civicCompleted'
  turn: number | null
  playerId: number
  hash: number
  boosted: boolean
  research: number | null
}

export interface CivReplayPantheonChangedEvent {
  type: 'pantheonChanged'
  turn: number | null
  playerId: number
  previousPantheon: number | null
  currentPantheon: number | null
}

export interface CivReplayCityReligionChangedEvent {
  type: 'cityReligionChanged'
  turn: number | null
  playerId: number
  cityId: number
  name: string
  x: number
  y: number
  previousReligion: number | null
  currentReligion: number | null
}

export interface CivReplayDistrictPlacedEvent {
  type: 'districtPlaced'
  turn: number | null
  playerId: number
  globalId: number
  id: number
  cityId: number
  x: number
  y: number
  districtType: number
  built: number
}

export interface CivReplayDistrictBuiltEvent {
  type: 'districtBuilt'
  turn: number | null
  playerId: number
  globalId: number
  id: number
  cityId: number
  x: number
  y: number
  districtType: number
  previousBuilt: number
  currentBuilt: number
}

export interface CivReplayUnitCreatedEvent {
  type: 'unitCreated'
  turn: number | null
  playerId: number
  unitId: number
  unitType: number
  x: number
  y: number
  name: string
  cityId: number | null
  cityName: string | null
  cityX: number | null
  cityY: number | null
  creationMethod: CivReplayUnitCreationMethod
  creationConfidence: CivReplayUnitCreationConfidence
  creationReason: string
  previousCityProductionType: number | null
  currentCityProductionType: number | null
  previousCityProductionItems: number[]
  currentCityProductionItems: number[]
}

export type CivReplayUnitCreationMethod = 'producedOrChopped' | 'likelyPurchasedOrGranted' | 'likelySettlementGrantOrInstant' | 'unknown'
export type CivReplayUnitCreationConfidence = 'high' | 'medium' | 'low'

interface CivReplayUnitCreationInference {
  creationMethod: CivReplayUnitCreationMethod
  creationConfidence: CivReplayUnitCreationConfidence
  creationReason: string
  previousCityProductionType: number | null
  currentCityProductionType: number | null
  previousCityProductionItems: number[]
  currentCityProductionItems: number[]
}

export interface CivReplayUnitLostEvent {
  type: 'unitLost'
  turn: number | null
  playerId: number
  unitId: number
  unitType: number
  x: number
  y: number
  name: string
}

export interface CivReplayUnitUpgradedEvent {
  type: 'unitUpgraded'
  turn: number | null
  playerId: number
  unitId: number
  previousUnitType: number
  currentUnitType: number
  x: number
  y: number
  name: string
}

export interface CivReplayGovernorAssignedEvent {
  type: 'governorAssigned'
  turn: number | null
  playerId: number
  governorId: number
  governorType: number
  previousCityId: number | null
  currentCityId: number
  promotionHashes: number[]
}

export interface CivReplayGovernorPromotedEvent {
  type: 'governorPromoted'
  turn: number | null
  playerId: number
  governorId: number
  governorType: number
  promotionHash: number
}

export interface CivReplayTileImprovementChangedEvent {
  type: 'tileImprovementChanged'
  turn: number | null
  playerId: number
  x: number
  y: number
  previousImprovementType: number | null
  currentImprovementType: number | null
  previousDistrict: number | null
  currentDistrict: number | null
}

export function attachCivReplaySnapshotEvents(snapshots: CivReplayTurnSnapshot[]) {
  let previous: CivReplayTurnSnapshot | null = null
  const seenCityLocationKeys = new Set<string>()
  for (const snapshot of snapshots) {
    snapshot.events = previous && areConsecutiveTurns(previous, snapshot)
      ? diffConsecutiveSnapshots(previous, snapshot, seenCityLocationKeys)
      : []
    for (const { city } of iterateCities(snapshot)) seenCityLocationKeys.add(cityLocationKey(city))
    previous = snapshot
  }
}

function diffConsecutiveSnapshots(previous: CivReplayTurnSnapshot, current: CivReplayTurnSnapshot, seenCityLocationKeys: Set<string>): CivReplaySnapshotEvent[] {
  const previousPlayerCityKeys = new Set<string>()
  const previousCityLocationKeys = new Set<string>()
  const previousCitiesByPlayerKey = new Map<string, CivReplayCitySnapshot>()
  const previousPlayersById = new Map<number, CivReplayPlayerSnapshot>()
  const cityAttribution = createCivReplayCityAttributionContext(current)
  for (const { player, city } of iterateCities(previous)) {
    const key = playerCityKey(player, city)
    previousPlayerCityKeys.add(key)
    previousCitiesByPlayerKey.set(key, city)
    previousCityLocationKeys.add(cityLocationKey(city))
  }
  for (const player of previous.players.players) previousPlayersById.set(player.id, player)

  const events: CivReplaySnapshotEvent[] = []
  for (const player of current.players.players) {
    const previousPlayer = previousPlayersById.get(player.id)
    if (!previousPlayer) continue
    events.push(...diffGovernment(previousPlayer, player, current.turnFromName))
    events.push(...diffGoodyHuts(previousPlayer, player, current.turnFromName))
    events.push(...diffDedication(previousPlayer, player, current.turnFromName))
    events.push(...diffAge(previousPlayer, player, current.turnFromName))
    events.push(...diffPantheon(previousPlayer, player, current.turnFromName))
    events.push(...diffProgressionCompleted(previousPlayer.techs, player.techs, 'techCompleted', current.turnFromName, player.id))
    events.push(...diffProgressionCompleted(previousPlayer.civics, player.civics, 'civicCompleted', current.turnFromName, player.id))
    events.push(...diffDistricts(previousPlayer, player, current.turnFromName))
    events.push(...diffUnits(previousPlayer, player, current.turnFromName, cityAttribution))
    events.push(...diffGovernors(previousPlayer, player, current.turnFromName))
    events.push(...diffImprovements(previousPlayer, player, current.turnFromName))
  }

  for (const { player, city } of iterateCities(current)) {
    const key = playerCityKey(player, city)
    const previousCity = previousCitiesByPlayerKey.get(key)
    if (previousCity) {
      const religionChanged = diffCityReligion(previousCity, city, player.id, current.turnFromName)
      if (religionChanged) events.push(religionChanged)
      if (!sameProduction(previousCity, city)) {
        events.push({
          type: 'cityProductionChanged',
          turn: current.turnFromName,
          playerId: player.id,
          cityId: city.id,
          name: city.name,
          x: city.x,
          y: city.y,
          previousProductionType: previousCity.currentProductionType,
          currentProductionType: city.currentProductionType,
          previousProductionItems: [...previousCity.currentProductionItems],
          currentProductionItems: [...city.currentProductionItems],
        })
      }
      events.push(...diffCityBuiltItems(previousCity, city, player.id, current.turnFromName))
      continue
    }

    if (previousPlayerCityKeys.has(key)) continue
    const locationKey = cityLocationKey(city)
    if (previousCityLocationKeys.has(locationKey) || seenCityLocationKeys.has(locationKey)) continue
    events.push({
      type: 'cityFounded',
      turn: current.turnFromName,
      playerId: player.id,
      cityId: city.id,
      name: city.name,
      x: city.x,
      y: city.y,
      population: city.population,
    })
  }
  return events
}

function diffPantheon(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplayPantheonChangedEvent[] {
  const previousPantheon = normalizeNullableHash(previous.pantheon)
  const currentPantheon = normalizeNullableHash(current.pantheon)
  if (previousPantheon === currentPantheon) return []
  return [{ type: 'pantheonChanged', turn, playerId: current.id, previousPantheon, currentPantheon }]
}

function diffDedication(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplayDedicationChangedEvent[] {
  const previousHash = previous.dedication?.hash ?? null
  const currentHash = current.dedication?.hash ?? null
  const previousRecordId = previous.dedication?.recordId ?? null
  const currentRecordId = current.dedication?.recordId ?? null
  if (previousHash === currentHash && previousRecordId === currentRecordId) return []
  return [{ type: 'dedicationChanged', turn, playerId: current.id, previousHash, currentHash, previousRecordId, currentRecordId }]
}

function diffAge(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplayAgeChangedEvent[] {
  const previousEra = previous.era
  const currentEra = current.era
  if (
    previousEra?.age === currentEra?.age
    && previousEra?.hasGoldenAge === currentEra?.hasGoldenAge
    && previousEra?.hasDarkAge === currentEra?.hasDarkAge
  ) return []

  return [{
    type: 'ageChanged',
    turn,
    playerId: current.id,
    previousAge: previousEra?.age ?? null,
    currentAge: currentEra?.age ?? null,
    previousCurrentScore: previousEra?.currentScore ?? null,
    currentCurrentScore: currentEra?.currentScore ?? null,
    previousHasGoldenAge: previousEra?.hasGoldenAge ?? null,
    currentHasGoldenAge: currentEra?.hasGoldenAge ?? null,
    previousHasDarkAge: previousEra?.hasDarkAge ?? null,
    currentHasDarkAge: currentEra?.hasDarkAge ?? null,
  }]
}

function diffCityReligion(previous: CivReplayCitySnapshot, current: CivReplayCitySnapshot, playerId: number, turn: number | null): CivReplayCityReligionChangedEvent | null {
  const previousReligion = normalizeNullableHash(previous.religion)
  const currentReligion = normalizeNullableHash(current.religion)
  if (previousReligion === currentReligion) return null
  return {
    type: 'cityReligionChanged',
    turn,
    playerId,
    cityId: current.id,
    name: current.name,
    x: current.x,
    y: current.y,
    previousReligion,
    currentReligion,
  }
}

function diffGovernment(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplayGovernmentChangedEvent[] {
  const previousPolicies = normalizePolicySlots(previous.policies)
  const currentPolicies = normalizePolicySlots(current.policies)
  if (
    previous.government === current.government
    && previous.lastTurnChangeGovernment === current.lastTurnChangeGovernment
    && samePolicySlots(previousPolicies, currentPolicies)
  ) return []

  return [{
    type: 'governmentChanged',
    turn,
    playerId: current.id,
    previousGovernment: previous.government,
    currentGovernment: current.government,
    previousLastTurnChangeGovernment: previous.lastTurnChangeGovernment,
    currentLastTurnChangeGovernment: current.lastTurnChangeGovernment,
    previousPolicies,
    currentPolicies,
  }]
}

function diffGoodyHuts(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplayGoodyHutCategoryCountChangedEvent[] {
  const previousValues = hashValueMap(previous.goodyHuts)
  const currentValues = hashValueMap(current.goodyHuts)
  const hashes = [...new Set([...previousValues.keys(), ...currentValues.keys()])].sort((left, right) => left - right)
  const events: CivReplayGoodyHutCategoryCountChangedEvent[] = []
  for (const hash of hashes) {
    const previousValue = previousValues.get(hash) ?? 0
    const currentValue = currentValues.get(hash) ?? 0
    if (previousValue === currentValue) continue
    events.push({ type: 'goodyHutCategoryCountChanged', turn, playerId: current.id, categoryHash: hash, previousValue, currentValue })
  }
  return events
}

function diffCityBuiltItems(previous: CivReplayCitySnapshot, current: CivReplayCitySnapshot, playerId: number, turn: number | null): CivReplayCityBuiltItemCompletedEvent[] {
  const previousValues = hashValueMap(previous.builtItems)
  const events: CivReplayCityBuiltItemCompletedEvent[] = []
  for (const item of current.builtItems) {
    const previousValue = previousValues.get(item.hash) ?? null
    if (isCompletedBuiltItemValue(previousValue) || !isCompletedBuiltItemValue(item.value)) continue
    events.push({
      type: 'cityBuiltItemCompleted',
      turn,
      playerId,
      cityId: current.id,
      name: current.name,
      x: current.x,
      y: current.y,
      itemHash: item.hash,
      previousValue,
      currentValue: item.value,
    })
  }
  return events
}

function diffDistricts(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplaySnapshotEvent[] {
  const events: CivReplaySnapshotEvent[] = []
  const previousByKey = new Map(previous.districts.map(district => [districtKey(district), district]))
  for (const district of current.districts) {
    const previousDistrict = previousByKey.get(districtKey(district))
    if (!previousDistrict) {
      events.push({
        type: 'districtPlaced',
        turn,
        playerId: current.id,
        globalId: district.globalId,
        id: district.id,
        cityId: district.cityId,
        x: district.x,
        y: district.y,
        districtType: district.type,
        built: district.built,
      })
      continue
    }
    if (!isDistrictBuilt(previousDistrict) && isDistrictBuilt(district)) {
      events.push({
        type: 'districtBuilt',
        turn,
        playerId: current.id,
        globalId: district.globalId,
        id: district.id,
        cityId: district.cityId,
        x: district.x,
        y: district.y,
        districtType: district.type,
        previousBuilt: previousDistrict.built,
        currentBuilt: district.built,
      })
    }
  }
  return events
}

function diffUnits(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null, cityAttribution: CivReplayCityAttributionContext): CivReplaySnapshotEvent[] {
  const events: CivReplaySnapshotEvent[] = []
  const previousByKey = new Map(previous.units.map(unit => [unitKey(unit), unit]))
  const currentByKey = new Map(current.units.map(unit => [unitKey(unit), unit]))
  for (const unit of current.units) {
    const previousUnit = previousByKey.get(unitKey(unit))
    if (!previousUnit) {
      const city = inferUnitCreatedCity(cityAttribution, current, unit.x, unit.y)?.city ?? null
      const creation = inferUnitCreation(previous, city, unit)
      events.push({
        type: 'unitCreated',
        turn,
        playerId: current.id,
        unitId: unit.id,
        unitType: unit.type,
        x: unit.x,
        y: unit.y,
        name: unit.name,
        cityId: city?.id ?? null,
        cityName: city?.name ?? null,
        cityX: city?.x ?? null,
        cityY: city?.y ?? null,
        ...creation,
      })
      continue
    }
    if (previousUnit.type !== unit.type) {
      events.push({ type: 'unitUpgraded', turn, playerId: current.id, unitId: unit.id, previousUnitType: previousUnit.type, currentUnitType: unit.type, x: unit.x, y: unit.y, name: unit.name })
    }
  }
  for (const unit of previous.units) {
    if (currentByKey.has(unitKey(unit))) continue
    events.push({ type: 'unitLost', turn, playerId: current.id, unitId: unit.id, unitType: unit.type, x: unit.x, y: unit.y, name: unit.name })
  }
  return events
}

function inferUnitCreation(previousPlayer: CivReplayPlayerSnapshot, currentCity: CivReplayCitySnapshot | null, unit: CivReplayUnitSnapshot): CivReplayUnitCreationInference {
  const previousCity = currentCity == null ? null : previousPlayer.cities.find(city => city.id === currentCity.id) ?? null
  const previousCityProductionType = previousCity?.currentProductionType ?? null
  const currentCityProductionType = currentCity?.currentProductionType ?? null
  const previousCityProductionItems = previousCity ? [...previousCity.currentProductionItems] : []
  const currentCityProductionItems = currentCity ? [...currentCity.currentProductionItems] : []

  if (!currentCity) {
    return {
      creationMethod: 'unknown',
      creationConfidence: 'low',
      creationReason: 'unit creation could not be attributed to a city',
      previousCityProductionType,
      currentCityProductionType,
      previousCityProductionItems,
      currentCityProductionItems,
    }
  }

  if (!previousCity) {
    return {
      creationMethod: 'likelySettlementGrantOrInstant',
      creationConfidence: 'medium',
      creationReason: 'unit appeared with a city that was not present in the previous snapshot',
      previousCityProductionType,
      currentCityProductionType,
      previousCityProductionItems,
      currentCityProductionItems,
    }
  }

  if (previousCity.currentProductionItems.includes(unit.type)) {
    return {
      creationMethod: 'producedOrChopped',
      creationConfidence: 'high',
      creationReason: 'previous city production was this unit type',
      previousCityProductionType,
      currentCityProductionType,
      previousCityProductionItems,
      currentCityProductionItems,
    }
  }

  const unchangedProduction = previousCity.currentProductionType === currentCity.currentProductionType
    && previousCity.currentProductionItems.length === currentCity.currentProductionItems.length
    && previousCity.currentProductionItems.every((item, index) => item === currentCity.currentProductionItems[index])

  return {
    creationMethod: 'likelyPurchasedOrGranted',
    creationConfidence: unchangedProduction ? 'high' : 'medium',
    creationReason: unchangedProduction
      ? 'unit appeared while city production stayed on another item'
      : 'unit appeared without matching previous city production',
    previousCityProductionType,
    currentCityProductionType,
    previousCityProductionItems,
    currentCityProductionItems,
  }
}

function diffGovernors(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplaySnapshotEvent[] {
  const events: CivReplaySnapshotEvent[] = []
  const previousByKey = new Map(previous.governors.map(governor => [governorKey(governor), governor]))
  for (const governor of current.governors) {
    const previousGovernor = previousByKey.get(governorKey(governor))
    const promotionHashes = governorPromotionHashes(governor)
    if (!previousGovernor) {
      events.push({
        type: 'governorAssigned',
        turn,
        playerId: current.id,
        governorId: governor.id,
        governorType: governor.type,
        previousCityId: null,
        currentCityId: governor.city,
        promotionHashes,
      })
      continue
    }
    if (previousGovernor.city !== governor.city) {
      events.push({
        type: 'governorAssigned',
        turn,
        playerId: current.id,
        governorId: governor.id,
        governorType: governor.type,
        previousCityId: previousGovernor.city,
        currentCityId: governor.city,
        promotionHashes,
      })
    }
    const previousPromotions = new Set(governorPromotionHashes(previousGovernor))
    for (const promotionHash of promotionHashes) {
      if (previousPromotions.has(promotionHash)) continue
      events.push({ type: 'governorPromoted', turn, playerId: current.id, governorId: governor.id, governorType: governor.type, promotionHash })
    }
  }
  return events
}

function diffImprovements(previous: CivReplayPlayerSnapshot, current: CivReplayPlayerSnapshot, turn: number | null): CivReplaySnapshotEvent[] {
  const events: CivReplaySnapshotEvent[] = []
  const previousImprovements = previous.improvements.filter(isRealImprovement)
  const currentImprovements = current.improvements.filter(isRealImprovement)
  const previousByKey = new Map(previousImprovements.map(improvement => [improvementKey(improvement), improvement]))
  const currentByKey = new Map(currentImprovements.map(improvement => [improvementKey(improvement), improvement]))
  for (const improvement of currentImprovements) {
    const previousImprovement = previousByKey.get(improvementKey(improvement))
    if (previousImprovement && previousImprovement.type === improvement.type && previousImprovement.district === improvement.district) continue
    events.push({
      type: 'tileImprovementChanged',
      turn,
      playerId: current.id,
      x: improvement.x,
      y: improvement.y,
      previousImprovementType: previousImprovement?.type ?? null,
      currentImprovementType: improvement.type,
      previousDistrict: previousImprovement?.district ?? null,
      currentDistrict: improvement.district,
    })
  }
  for (const improvement of previousImprovements) {
    if (currentByKey.has(improvementKey(improvement))) continue
    events.push({
      type: 'tileImprovementChanged',
      turn,
      playerId: current.id,
      x: improvement.x,
      y: improvement.y,
      previousImprovementType: improvement.type,
      currentImprovementType: null,
      previousDistrict: improvement.district,
      currentDistrict: null,
    })
  }
  return events
}

function diffProgressionCompleted(
  previous: CivReplayProgressionSnapshot | null,
  current: CivReplayProgressionSnapshot | null,
  type: 'techCompleted' | 'civicCompleted',
  turn: number | null,
  playerId: number,
): CivReplayProgressionCompletedEvent[] {
  if (!previous || !current) return []
  const previousFound = hashBoolMap(previous.found)
  const currentBoost = hashBoolMap(current.boost)
  const currentResearch = hashFloatMap(current.research)
  const events: CivReplayProgressionCompletedEvent[] = []
  for (const found of current.found) {
    if (!found.value || previousFound.get(found.hash) === true) continue
    events.push({
      type,
      turn,
      playerId,
      hash: found.hash,
      boosted: currentBoost.get(found.hash) === true,
      research: currentResearch.get(found.hash) ?? null,
    })
  }
  return events
}

function areConsecutiveTurns(previous: CivReplayTurnSnapshot, current: CivReplayTurnSnapshot): boolean {
  return previous.turnFromName != null && current.turnFromName === previous.turnFromName + 1
}

function iterateCities(snapshot: CivReplayTurnSnapshot): Array<{ player: CivReplayPlayerSnapshot, city: CivReplayCitySnapshot }> {
  return snapshot.players.players.flatMap(player => player.cities.map(city => ({ player, city })))
}

function playerCityKey(player: CivReplayPlayerSnapshot, city: CivReplayCitySnapshot): string {
  return `${player.id}:${city.id}`
}

function cityLocationKey(city: CivReplayCitySnapshot): string {
  return `${city.x}:${city.y}`
}

function sameProduction(previous: CivReplayCitySnapshot, current: CivReplayCitySnapshot): boolean {
  if (previous.currentProductionType !== current.currentProductionType) return false
  if (previous.currentProductionItems.length !== current.currentProductionItems.length) return false
  return previous.currentProductionItems.every((item, index) => item === current.currentProductionItems[index])
}

function normalizePolicySlots(policies: readonly (readonly number[])[]): number[][] {
  const length = Math.max(4, policies.length)
  return Array.from({ length }, (_, index) => [...(policies[index] ?? [])].sort((left, right) => left - right))
}

function samePolicySlots(previous: readonly (readonly number[])[], current: readonly (readonly number[])[]): boolean {
  if (previous.length !== current.length) return false
  return previous.every((slot, slotIndex) => slot.length === current[slotIndex]!.length && slot.every((policy, policyIndex) => policy === current[slotIndex]![policyIndex]))
}

function districtKey(district: CivReplayDistrictSnapshot): string {
  return `${district.globalId}:${district.id}`
}

function isDistrictBuilt(district: CivReplayDistrictSnapshot): boolean {
  return district.built !== 0
}

function unitKey(unit: CivReplayUnitSnapshot): string {
  return String(unit.id)
}

function governorKey(governor: CivReplayGovernorSnapshot): string {
  return String(governor.id)
}

function governorPromotionHashes(governor: CivReplayGovernorSnapshot): number[] {
  return governor.promotions
    .filter(promotion => promotion.value !== 0)
    .map(promotion => promotion.hash)
    .sort((left, right) => left - right)
}

function improvementKey(improvement: CivReplayImprovementSnapshot): string {
  return `${improvement.x}:${improvement.y}`
}

function isRealImprovement(improvement: CivReplayImprovementSnapshot): boolean {
  return improvement.type !== 0 && improvement.type !== 0xFFFFFFFF
}

function isCompletedBuiltItemValue(value: number | null | undefined): value is number {
  return value != null && value > 0 && value < 0xFFFF
}

function normalizeNullableHash(value: number | null | undefined): number | null {
  return value == null || value === 0 || value === 0xFFFFFFFF ? null : value
}

function hashValueMap(values: readonly CivReplayHashValue[]): Map<number, number> {
  return new Map(values.map(value => [value.hash, value.value]))
}

function hashBoolMap(values: readonly CivReplayHashBoolValue[]): Map<number, boolean> {
  return new Map(values.map(value => [value.hash, value.value]))
}

function hashFloatMap(values: readonly CivReplayHashFloatValue[]): Map<number, number> {
  return new Map(values.map(value => [value.hash, value.value]))
}
