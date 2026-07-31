import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

export type CivReplayCityStateCategory = 'scientific' | 'religious' | 'trade' | 'cultural' | 'militaristic' | 'industrial'
export type CivReplayCityStateStatus = 'alive' | 'captured'
export type CivReplayCityStateOwnerKind = 'major' | 'minor' | 'unknown'
export type CivReplayCityStateSuzerainStatus = 'suzerained' | 'tied' | 'none' | 'unknown'

export interface CivReplayCityStateEnvoySnapshot {
  playerId: number
  envoys: number
}

export interface CivReplayCityStateDefinition {
  civilizationType: string
  leaderType: string
  category: CivReplayCityStateCategory
  name: string | null
  description: string | null
  displayName: string
  capitalName: string
  cityNames: string[]
}

export interface CivReplayCityStateSnapshot {
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
  ownerKind: CivReplayCityStateOwnerKind
  alive: boolean
  status: CivReplayCityStateStatus
  envoys: CivReplayCityStateEnvoySnapshot[]
  suzerainPlayerId: number | null
  suzerainEnvoys: number | null
  suzerainStatus: CivReplayCityStateSuzerainStatus
  identification: 'capital-city-name'
}

export interface CivReplayCityStateRoster {
  count: number
  aliveCount: number
  capturedCount: number
  scientificCount: number
  scientificAliveCount: number
  sources: string[]
  cityStates: CivReplayCityStateSnapshot[]
}

export interface CivReplayCityStateResolver {
  sources: string[]
  resolveCityName(cityName: string): CivReplayCityStateDefinition | null
  definitions(): CivReplayCityStateDefinition[]
}

export interface CreateCityStateResolverOptions {
  typesDbPath?: string | null
  loadDefaultTypesDb?: boolean
}

export interface BuildCivReplayCityStateRosterOptions {
  majorPlayerIds?: readonly number[] | null
  includeCapturedCapitalCities?: boolean
}

interface CivReplayCityStateRosterCity {
  id: number
  name: string
  x: number
  y: number
  population: number
}

interface CivReplayCityStateRosterPlayer {
  id: number
  influenceTokensReceived?: readonly number[]
  cities: readonly CivReplayCityStateRosterCity[]
}

interface CivReplayCityStateInfluenceSnapshot {
  envoys: CivReplayCityStateEnvoySnapshot[]
  suzerainPlayerId: number | null
  suzerainEnvoys: number | null
  suzerainStatus: CivReplayCityStateSuzerainStatus
}

interface CityStateDbRow {
  CivilizationType: string | null
  Name: string | null
  Description: string | null
  LeaderType: string | null
  InheritFrom: string | null
  CapitalName: string | null
  CityName: string | null
}

const STATIC_CITY_STATES: Array<{
  civilizationType: string
  leaderType: string
  category: CivReplayCityStateCategory
  capitalName: string
  name?: string
  description?: string
  displayName?: string
}> = [
  { civilizationType: 'CIVILIZATION_AKKAD', leaderType: 'LEADER_MINOR_CIV_AKKAD', category: 'militaristic', capitalName: 'LOC_CITY_NAME_AKKAD' },
  { civilizationType: 'CIVILIZATION_ANTANANARIVO', leaderType: 'LEADER_MINOR_CIV_ANTANANARIVO', category: 'cultural', capitalName: 'LOC_CITY_NAME_ANTANANARIVO' },
  { civilizationType: 'CIVILIZATION_ANTIOCH', leaderType: 'LEADER_MINOR_CIV_ANTIOCH', category: 'trade', capitalName: 'LOC_CITY_NAME_ANTIOCH' },
  { civilizationType: 'CIVILIZATION_ARMAGH', leaderType: 'LEADER_MINOR_CIV_ARMAGH', category: 'religious', capitalName: 'LOC_CITY_NAME_ARMAGH' },
  { civilizationType: 'CIVILIZATION_AUCKLAND', leaderType: 'LEADER_MINOR_CIV_AUCKLAND', category: 'industrial', capitalName: 'LOC_CITY_NAME_AUCKLAND' },
  { civilizationType: 'CIVILIZATION_AYUTTHAYA', leaderType: 'LEADER_MINOR_CIV_AYUTTHAYA', category: 'cultural', capitalName: 'LOC_CITY_NAME_AYUTTHAYA' },
  { civilizationType: 'CIVILIZATION_BABYLON', leaderType: 'LEADER_MINOR_CIV_BABYLON', category: 'scientific', capitalName: 'LOC_CITY_NAME_BABYLON' },
  { civilizationType: 'CIVILIZATION_BOLOGNA', leaderType: 'LEADER_MINOR_CIV_BOLOGNA', category: 'scientific', capitalName: 'LOC_CITY_NAME_BOLOGNA' },
  { civilizationType: 'CIVILIZATION_BRUSSELS', leaderType: 'LEADER_MINOR_CIV_BRUSSELS', category: 'industrial', capitalName: 'LOC_CITY_NAME_BRUSSELS' },
  { civilizationType: 'CIVILIZATION_BUENOS_AIRES', leaderType: 'LEADER_MINOR_CIV_BUENOS_AIRES', category: 'industrial', capitalName: 'LOC_CITY_NAME_BUENOS_AIRES' },
  { civilizationType: 'CIVILIZATION_CAGUANA', leaderType: 'LEADER_MINOR_CIV_CAGUANA', category: 'cultural', capitalName: 'LOC_CITY_NAME_CAGUANA' },
  { civilizationType: 'CIVILIZATION_CAHOKIA', leaderType: 'LEADER_MINOR_CIV_CAHOKIA', category: 'trade', capitalName: 'LOC_CITY_NAME_CAHOKIA' },
  { civilizationType: 'CIVILIZATION_CARDIFF', leaderType: 'LEADER_MINOR_CIV_CARDIFF', category: 'industrial', capitalName: 'LOC_CITY_NAME_CARDIFF' },
  { civilizationType: 'CIVILIZATION_CHINGUETTI', leaderType: 'LEADER_MINOR_CIV_CHINGUETTI', category: 'religious', capitalName: 'LOC_CITY_NAME_CHINGUETTI' },
  { civilizationType: 'CIVILIZATION_FEZ', leaderType: 'LEADER_MINOR_CIV_FEZ', category: 'scientific', capitalName: 'LOC_CITY_NAME_FEZ' },
  { civilizationType: 'CIVILIZATION_GENEVA', leaderType: 'LEADER_MINOR_CIV_GENEVA', category: 'scientific', capitalName: 'LOC_CITY_NAME_GENEVA' },
  { civilizationType: 'CIVILIZATION_GRANADA', leaderType: 'LEADER_MINOR_CIV_GRANADA', category: 'militaristic', capitalName: 'LOC_CITY_NAME_GRANADA' },
  { civilizationType: 'CIVILIZATION_HATTUSA', leaderType: 'LEADER_MINOR_CIV_HATTUSA', category: 'scientific', capitalName: 'LOC_CITY_NAME_HATTUSA' },
  { civilizationType: 'CIVILIZATION_HONG_KONG', leaderType: 'LEADER_MINOR_CIV_HONG_KONG', category: 'industrial', capitalName: 'LOC_CITY_NAME_HONG_KONG' },
  { civilizationType: 'CIVILIZATION_HUNZA', leaderType: 'LEADER_MINOR_CIV_HUNZA', category: 'trade', capitalName: 'LOC_CITY_NAME_HUNZA' },
  { civilizationType: 'CIVILIZATION_JAKARTA', leaderType: 'LEADER_MINOR_CIV_JAKARTA', category: 'trade', capitalName: 'LOC_CITY_NAME_BANDAR_BRUNEI', name: 'LOC_CIVILIZATION_BANDAR_BRUNEI_NAME', description: 'LOC_CIVILIZATION_BANDAR_BRUNEI_DESCRIPTION', displayName: 'Bandar Brunei' },
  { civilizationType: 'CIVILIZATION_JERUSALEM', leaderType: 'LEADER_MINOR_CIV_JERUSALEM', category: 'religious', capitalName: 'LOC_CITY_NAME_JERUSALEM' },
  { civilizationType: 'CIVILIZATION_JOHANNESBURG', leaderType: 'LEADER_MINOR_CIV_JOHANNESBURG', category: 'industrial', capitalName: 'LOC_CITY_NAME_JOHANNESBURG' },
  { civilizationType: 'CIVILIZATION_KABUL', leaderType: 'LEADER_MINOR_CIV_KABUL', category: 'militaristic', capitalName: 'LOC_CITY_NAME_KABUL' },
  { civilizationType: 'CIVILIZATION_KANDY', leaderType: 'LEADER_MINOR_CIV_KANDY', category: 'religious', capitalName: 'LOC_CITY_NAME_KANDY' },
  { civilizationType: 'CIVILIZATION_KUMASI', leaderType: 'LEADER_MINOR_CIV_KUMASI', category: 'cultural', capitalName: 'LOC_CITY_NAME_KUMASI' },
  { civilizationType: 'CIVILIZATION_LAHORE', leaderType: 'LEADER_MINOR_CIV_LAHORE', category: 'militaristic', capitalName: 'LOC_CITY_NAME_LAHORE' },
  { civilizationType: 'CIVILIZATION_LA_VENTA', leaderType: 'LEADER_MINOR_CIV_LA_VENTA', category: 'religious', capitalName: 'LOC_CITY_NAME_LA_VENTA' },
  { civilizationType: 'CIVILIZATION_LISBON', leaderType: 'LEADER_MINOR_CIV_LISBON', category: 'trade', capitalName: 'LOC_CITY_NAME_LISBON' },
  { civilizationType: 'CIVILIZATION_MEXICO_CITY', leaderType: 'LEADER_MINOR_CIV_MEXICO_CITY', category: 'industrial', capitalName: 'LOC_CITY_NAME_MEXICO_CITY' },
  { civilizationType: 'CIVILIZATION_MOHENJO_DARO', leaderType: 'LEADER_MINOR_CIV_MOHENJO_DARO', category: 'cultural', capitalName: 'LOC_CITY_NAME_MOHENJO_DARO' },
  { civilizationType: 'CIVILIZATION_MUSCAT', leaderType: 'LEADER_MINOR_CIV_MUSCAT', category: 'trade', capitalName: 'LOC_CITY_NAME_MUSCAT' },
  { civilizationType: 'CIVILIZATION_NALANDA', leaderType: 'LEADER_MINOR_CIV_NALANDA', category: 'scientific', capitalName: 'LOC_CITY_NAME_NALANDA' },
  { civilizationType: 'CIVILIZATION_NAN_MADOL', leaderType: 'LEADER_MINOR_CIV_NAN_MADOL', category: 'cultural', capitalName: 'LOC_CITY_NAME_NAN_MADOL' },
  { civilizationType: 'CIVILIZATION_NAZCA', leaderType: 'LEADER_MINOR_CIV_NAZCA', category: 'religious', capitalName: 'LOC_CITY_NAME_NAZCA' },
  { civilizationType: 'CIVILIZATION_NGAZARGAMU', leaderType: 'LEADER_MINOR_CIV_NGAZARGAMU', category: 'militaristic', capitalName: 'LOC_CITY_NAME_NGAZARGAMU' },
  { civilizationType: 'CIVILIZATION_PALENQUE', leaderType: 'LEADER_MINOR_CIV_PALENQUE', category: 'scientific', capitalName: 'LOC_CITY_NAME_PALENQUE', name: 'LOC_CIVILIZATION_MITLA_NAME', description: 'LOC_CIVILIZATION_MITLA_DESCRIPTION', displayName: 'Mitla' },
  { civilizationType: 'CIVILIZATION_PRESLAV', leaderType: 'LEADER_MINOR_CIV_PRESLAV', category: 'militaristic', capitalName: 'LOC_CITY_NAME_PRESLAV' },
  { civilizationType: 'CIVILIZATION_RAPA_NUI', leaderType: 'LEADER_MINOR_CIV_RAPA_NUI', category: 'cultural', capitalName: 'LOC_CITY_NAME_RAPA_NUI' },
  { civilizationType: 'CIVILIZATION_SAMARKAND', leaderType: 'LEADER_MINOR_CIV_SAMARKAND', category: 'trade', capitalName: 'LOC_CITY_NAME_SAMARKAND' },
  { civilizationType: 'CIVILIZATION_SINGAPORE', leaderType: 'LEADER_MINOR_CIV_SINGAPORE', category: 'industrial', capitalName: 'LOC_CITY_NAME_SINGAPORE' },
  { civilizationType: 'CIVILIZATION_TARUGA', leaderType: 'LEADER_MINOR_CIV_TARUGA', category: 'scientific', capitalName: 'LOC_CITY_NAME_TARUGA' },
  { civilizationType: 'CIVILIZATION_VALLETTA', leaderType: 'LEADER_MINOR_CIV_VALLETTA', category: 'militaristic', capitalName: 'LOC_CITY_NAME_VALLETTA' },
  { civilizationType: 'CIVILIZATION_VATICAN_CITY', leaderType: 'LEADER_MINOR_CIV_VATICAN_CITY', category: 'religious', capitalName: 'LOC_CITY_NAME_VATICAN_CITY' },
  { civilizationType: 'CIVILIZATION_VILNIUS', leaderType: 'LEADER_MINOR_CIV_VILNIUS', category: 'cultural', capitalName: 'LOC_CITY_NAME_VILNIUS' },
  { civilizationType: 'CIVILIZATION_WOLIN', leaderType: 'LEADER_MINOR_CIV_WOLIN', category: 'militaristic', capitalName: 'LOC_CITY_NAME_WOLIN' },
  { civilizationType: 'CIVILIZATION_YEREVAN', leaderType: 'LEADER_MINOR_CIV_YEREVAN', category: 'religious', capitalName: 'LOC_CITY_NAME_YEREVAN' },
  { civilizationType: 'CIVILIZATION_ZANZIBAR', leaderType: 'LEADER_MINOR_CIV_ZANZIBAR', category: 'trade', capitalName: 'LOC_CITY_NAME_ZANZIBAR' },
]

export function createCityStateResolver(options: CreateCityStateResolverOptions = {}): CivReplayCityStateResolver {
  const definitions = new Map<string, CivReplayCityStateDefinition>()
  const sources: string[] = []

  for (const definition of buildStaticCityStateDefinitions()) definitions.set(definition.civilizationType, definition)
  sources.push('static-city-states')

  const dbPath = options.typesDbPath ?? (options.loadDefaultTypesDb === false ? null : findDefaultTypesDbPath())
  if (dbPath && existsSync(dbPath)) {
    try {
      for (const definition of loadCityStatesFromSqlite(dbPath)) definitions.set(definition.civilizationType, definition)
      sources.push(dbPath)
    }
    catch {
      sources.push(`${dbPath} (failed)`)
    }
  }

  const byCityName = buildCityNameIndex(definitions.values())
  return {
    sources,
    resolveCityName(cityName: string) {
      return byCityName.get(cityName) ?? null
    },
    definitions() {
      return [...definitions.values()].sort(compareDefinitions)
    },
  }
}

export function buildCivReplayCityStateRoster(
  players: readonly CivReplayCityStateRosterPlayer[],
  resolver: CivReplayCityStateResolver,
  options: BuildCivReplayCityStateRosterOptions = {},
): CivReplayCityStateRoster {
  const majorPlayerIds = new Set(options.majorPlayerIds ?? [])
  const includeCapturedCapitalCities = options.includeCapturedCapitalCities ?? true
  const byCityState = new Map<string, CivReplayCityStateSnapshot>()
  const playerById = new Map(players.map(player => [player.id, player] as const))

  for (const player of players) {
    const isKnownMajor = majorPlayerIds.has(player.id)
    const ownsOneCity = player.cities.length === 1
    for (const city of player.cities) {
      const definition = resolver.resolveCityName(city.name)
      if (!definition) continue
      const ownerKind = isKnownMajor ? 'major' : ownsOneCity ? 'minor' : 'unknown'
      const alive = ownerKind === 'minor'
      if (!alive && !includeCapturedCapitalCities) continue
      const snapshot = buildCityStateSnapshot(definition, city, player.id, ownerKind, alive, readCityStateInfluence(playerById.get(player.id) ?? null, majorPlayerIds, alive))
      const previous = byCityState.get(snapshot.cityStateId)
      if (!previous || compareCityStatePriority(snapshot, previous) < 0) byCityState.set(snapshot.cityStateId, snapshot)
    }
  }

  const cityStates = [...byCityState.values()].sort(compareCityStateSnapshots)
  const aliveCount = cityStates.filter(cityState => cityState.alive).length
  const scientificCount = cityStates.filter(cityState => cityState.category === 'scientific').length
  const scientificAliveCount = cityStates.filter(cityState => cityState.category === 'scientific' && cityState.alive).length
  return {
    count: cityStates.length,
    aliveCount,
    capturedCount: cityStates.length - aliveCount,
    scientificCount,
    scientificAliveCount,
    sources: resolver.sources,
    cityStates,
  }
}

export function cityStateCategoryFromLeader(leaderType: string | null | undefined, inheritFrom?: string | null): CivReplayCityStateCategory | null {
  const value = inheritFrom ?? leaderType
  if (leaderType === 'LEADER_MINOR_CIV_SCIENTIFIC' || value === 'LEADER_MINOR_CIV_SCIENTIFIC') return 'scientific'
  if (leaderType === 'LEADER_MINOR_CIV_RELIGIOUS' || value === 'LEADER_MINOR_CIV_RELIGIOUS') return 'religious'
  if (leaderType === 'LEADER_MINOR_CIV_TRADE' || value === 'LEADER_MINOR_CIV_TRADE') return 'trade'
  if (leaderType === 'LEADER_MINOR_CIV_CULTURAL' || value === 'LEADER_MINOR_CIV_CULTURAL') return 'cultural'
  if (leaderType === 'LEADER_MINOR_CIV_MILITARISTIC' || value === 'LEADER_MINOR_CIV_MILITARISTIC') return 'militaristic'
  if (leaderType === 'LEADER_MINOR_CIV_INDUSTRIAL' || value === 'LEADER_MINOR_CIV_INDUSTRIAL') return 'industrial'
  return null
}

function buildCityStateSnapshot(
  definition: CivReplayCityStateDefinition,
  city: CivReplayCityStateRosterCity,
  ownerPlayerId: number,
  ownerKind: CivReplayCityStateOwnerKind,
  alive: boolean,
  influence: CivReplayCityStateInfluenceSnapshot,
): CivReplayCityStateSnapshot {
  return {
    cityStateId: definition.civilizationType,
    civilizationType: definition.civilizationType,
    leaderType: definition.leaderType,
    category: definition.category,
    name: definition.name,
    description: definition.description,
    displayName: definition.displayName,
    capitalName: definition.capitalName,
    cityName: city.name,
    cityId: city.id,
    x: city.x,
    y: city.y,
    population: city.population,
    playerId: alive ? ownerPlayerId : null,
    ownerPlayerId,
    ownerKind,
    alive,
    status: alive ? 'alive' : 'captured',
    envoys: influence.envoys,
    suzerainPlayerId: influence.suzerainPlayerId,
    suzerainEnvoys: influence.suzerainEnvoys,
    suzerainStatus: influence.suzerainStatus,
    identification: 'capital-city-name',
  }
}

function readCityStateInfluence(
  player: CivReplayCityStateRosterPlayer | null,
  majorPlayerIds: ReadonlySet<number>,
  alive: boolean,
): CivReplayCityStateInfluenceSnapshot {
  if (!alive || majorPlayerIds.size === 0 || !player?.influenceTokensReceived?.length) {
    return { envoys: [], suzerainPlayerId: null, suzerainEnvoys: null, suzerainStatus: 'unknown' }
  }

  const envoys = [...majorPlayerIds]
    .map(playerId => ({ playerId, envoys: player.influenceTokensReceived?.[playerId] ?? 0 }))
    .filter(item => item.envoys > 0)
    .sort((left, right) => right.envoys - left.envoys || left.playerId - right.playerId)

  const best = envoys[0] ?? null
  if (!best || best.envoys < 3) return { envoys, suzerainPlayerId: null, suzerainEnvoys: best?.envoys ?? 0, suzerainStatus: 'none' }
  const tied = envoys.filter(item => item.envoys === best.envoys)
  if (tied.length > 1) return { envoys, suzerainPlayerId: null, suzerainEnvoys: best.envoys, suzerainStatus: 'tied' }
  return { envoys, suzerainPlayerId: best.playerId, suzerainEnvoys: best.envoys, suzerainStatus: 'suzerained' }
}

function buildStaticCityStateDefinitions(): CivReplayCityStateDefinition[] {
  return STATIC_CITY_STATES.map(row => ({
    civilizationType: row.civilizationType,
    leaderType: row.leaderType,
    category: row.category,
    name: row.name ?? defaultCivilizationName(row.civilizationType),
    description: row.description ?? defaultCivilizationDescription(row.civilizationType),
    displayName: row.displayName ?? displayNameFromType(row.civilizationType, 'CIVILIZATION_'),
    capitalName: row.capitalName,
    cityNames: [row.capitalName],
  }))
}

function loadCityStatesFromSqlite(dbPath: string): CivReplayCityStateDefinition[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.query<CityStateDbRow, []>(`
      select
        c.CivilizationType,
        c.Name,
        c.Description,
        cl.LeaderType,
        l.InheritFrom,
        cl.CapitalName,
        cn.CityName
      from Civilizations c
      left join CivilizationLeaders cl on cl.CivilizationType = c.CivilizationType
      left join Leaders l on l.LeaderType = cl.LeaderType
      left join CityNames cn on cn.CivilizationType = c.CivilizationType
      where c.StartingCivilizationLevelType = 'CIVILIZATION_LEVEL_CITY_STATE'
      order by c.CivilizationType, cn.SortIndex
    `).all()
    return buildCityStateDefinitionsFromRows(rows)
  }
  finally {
    db.close()
  }
}

function buildCityStateDefinitionsFromRows(rows: readonly CityStateDbRow[]): CivReplayCityStateDefinition[] {
  const byCivilization = new Map<string, CivReplayCityStateDefinition>()
  for (const row of rows) {
    if (!row.CivilizationType || !row.LeaderType) continue
    const category = cityStateCategoryFromLeader(row.LeaderType, row.InheritFrom)
    const capitalName = row.CapitalName ?? row.CityName
    if (!category || !capitalName) continue
    const existing = byCivilization.get(row.CivilizationType)
    if (existing) {
      if (row.CityName) addUnique(existing.cityNames, row.CityName)
      addUnique(existing.cityNames, capitalName)
      continue
    }

    byCivilization.set(row.CivilizationType, {
      civilizationType: row.CivilizationType,
      leaderType: row.LeaderType,
      category,
      name: row.Name,
      description: row.Description,
      displayName: displayNameFromLocOrType(row.Name, row.CivilizationType),
      capitalName,
      cityNames: row.CityName ? uniqueStrings([capitalName, row.CityName]) : [capitalName],
    })
  }
  return [...byCivilization.values()]
}

function buildCityNameIndex(definitions: Iterable<CivReplayCityStateDefinition>): Map<string, CivReplayCityStateDefinition> {
  const byCityName = new Map<string, CivReplayCityStateDefinition>()
  for (const definition of definitions) {
    byCityName.set(definition.capitalName, definition)
    for (const cityName of definition.cityNames) byCityName.set(cityName, definition)
  }
  return byCityName
}

function compareCityStatePriority(left: CivReplayCityStateSnapshot, right: CivReplayCityStateSnapshot): number {
  if (left.alive !== right.alive) return left.alive ? -1 : 1
  return left.ownerPlayerId - right.ownerPlayerId || left.cityId - right.cityId
}

function compareCityStateSnapshots(left: CivReplayCityStateSnapshot, right: CivReplayCityStateSnapshot): number {
  return categoryRank(left.category) - categoryRank(right.category)
    || left.displayName.localeCompare(right.displayName)
    || left.ownerPlayerId - right.ownerPlayerId
    || left.cityId - right.cityId
}

function compareDefinitions(left: CivReplayCityStateDefinition, right: CivReplayCityStateDefinition): number {
  return categoryRank(left.category) - categoryRank(right.category)
    || left.displayName.localeCompare(right.displayName)
    || left.civilizationType.localeCompare(right.civilizationType)
}

function categoryRank(category: CivReplayCityStateCategory): number {
  switch (category) {
    case 'scientific': return 0
    case 'cultural': return 1
    case 'religious': return 2
    case 'trade': return 3
    case 'industrial': return 4
    case 'militaristic': return 5
  }
}

function defaultCivilizationName(civilizationType: string): string {
  return `LOC_${civilizationType}_NAME`
}

function defaultCivilizationDescription(civilizationType: string): string {
  return `LOC_${civilizationType}_DESCRIPTION`
}

function displayNameFromLocOrType(name: string | null, civilizationType: string): string {
  if (!name) return displayNameFromType(civilizationType, 'CIVILIZATION_')
  const locPrefix = 'LOC_CIVILIZATION_'
  const locSuffix = '_NAME'
  if (name.startsWith(locPrefix) && name.endsWith(locSuffix)) return formatTitleName(name.slice(locPrefix.length, -locSuffix.length))
  return displayNameFromType(civilizationType, 'CIVILIZATION_')
}

function displayNameFromType(type: string, prefix: string): string {
  return formatTitleName(type.startsWith(prefix) ? type.slice(prefix.length) : type)
}

function formatTitleName(value: string): string {
  return value
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value)
}

function findDefaultTypesDbPath(): string | null {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  return join(localAppData, 'Firaxis Games', 'Sid Meier\'s Civilization VI', 'Cache', 'DebugGameplay.sqlite')
}
