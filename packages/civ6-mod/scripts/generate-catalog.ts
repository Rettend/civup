/* eslint-disable no-console */
import type { CivBlitzComponent, Leader, LeaderDataVersion } from '@civup/game'
import type {
  CivBlitzModBbgAdjacencyMetadata,
  CivBlitzModBlpEntry,
  CivBlitzModCivilizationMetadata,
  CivBlitzModComponentMetadata,
  CivBlitzModLandmarkMetadata,
  CivBlitzModLeaderMetadata,
} from '../src/catalog-types.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getCivBlitzRegistry, getLeaders } from '@civup/game'

type CsvRow = Record<string, string>

const UPSTREAM_COMMIT = '413d329664183ab13b5f889df0bea62dc2131131'
const versions = ['live', 'beta'] as const satisfies readonly LeaderDataVersion[]
const vendorRoot = resolve(import.meta.dir, '../vendor/civ-blitz')
const outputRoot = resolve(import.meta.dir, '../src/generated')
const unsupportedReasonByTrait: Readonly<Record<string, string>> = {
  TRAIT_CIVILIZATION_BABYLON: 'The upstream Civ Blitz normal-card registry intentionally excludes Babylon\'s civilization ability because it is not safe to transplant.',
  TRAIT_CIVILIZATION_BYZANTIUM: 'The upstream Civ Blitz normal-card registry intentionally excludes Byzantium\'s civilization ability because it is not safe to transplant.',
  TRAIT_CIVILIZATION_UNIT_AMERICAN_P51: 'The upstream Civ Blitz normal-card registry intentionally excludes the P-51 Mustang trait because it is not safe to transplant.',
  TRAIT_CIVILIZATION_UNIT_GERMAN_UBOAT: 'The upstream Civ Blitz normal-card registry intentionally excludes the U-Boat trait because it is not safe to transplant.',
}
const componentTraitOverrides: Readonly<Record<string, string>> = {
  'civblitz:infrastructure:copacabana': 'TRAIT_CIVILIZATION_STREET_CARNIVAL',
  'civblitz:infrastructure:qhapaq-an': 'TRAIT_LEADER_PACHACUTI_IMPROVEMENT_MOUNTAIN_ROAD',
}
const componentGrantOverrides: Readonly<Record<string, readonly string[]>> = {
  'civblitz:infrastructure:qhapaq-an': [],
}
const grantPlayerItemTypeOverrides: Readonly<Record<string, readonly string[]>> = {
  'civblitz:leaderAbility:inca-pachacuti': ['IMPROVEMENT_MOUNTAIN_ROAD'],
}

const [
  bbgAdjacencyRows,
  cardPatchRows,
  civTraitRows,
  civilizationLeaderRows,
  civilizationRows,
  cultureRows,
  fallbackLeaderRows,
  landmarkRows,
  leaderArtRows,
  leaderTraitRows,
  playerRows,
  subtypeRows,
] = await Promise.all([
  readCsv('csv/BbgBsAdjacencies.csv'),
  readCsv('csv/CardPatches.csv'),
  readCsv('csv/CivTraits.csv'),
  readCsv('csv/CivilizationLeaders.csv'),
  readCsv('csv/Civilizations.csv'),
  readCsv('csv/CivilizationsCulture.csv'),
  readCsv('csv/FallbackLeadersArtDefs.csv'),
  readCsv('csv/LandmarksArtDefs.csv'),
  readCsv('csv/LeaderArtDefs.csv'),
  readCsv('csv/LeaderTraits.csv'),
  readCsv('csv/Players.csv'),
  readCsv('csv/subtypes.csv'),
])

const playerItemTypesByTrait = new Map(
  [...groupBy(subtypeRows, row => required(row.TraitType, 'subtype trait')).entries()]
    .map(([traitType, rows]) => [
      traitType,
      unique(rows.map(row => required(row.Type, `player item type for ${traitType}`))),
    ]),
)
const playerByLeaderType = uniqueMap(playerRows, 'LeaderType')
const civilizationByType = uniqueMap(civilizationRows, 'CivilizationType')
const leaderArtByType = uniqueMap(leaderArtRows, 'LeaderType')
const fallbackByLeaderType = uniqueMap(fallbackLeaderRows, 'LeaderType')

const leaderRowsByType = groupBy(leaderTraitRows, row => row.LeaderType!)
const mainLeaderRowByType = new Map<string, CsvRow>()
for (const [leaderType, rows] of leaderRowsByType) {
  const grantedTraits = new Set(rows.flatMap(row => splitValues(row.Grants)))
  const main = rows.find(row => !grantedTraits.has(row.TraitType!) && (row.MediaName || row.LocTraitTypeDesc))
    ?? rows.find(row => !grantedTraits.has(row.TraitType!))
    ?? rows[0]
  if (main) mainLeaderRowByType.set(leaderType, main)
}

const localLeaderById = new Map<string, Leader>()
for (const version of versions) {
  for (const leader of getLeaders(version)) localLeaderById.set(leader.id, leader)
}

const sourceLeaderIds = new Set<string>()
const componentsByVersion: Record<LeaderDataVersion, CivBlitzComponent[]> = { live: [], beta: [] }
for (const version of versions) {
  const components = getCivBlitzRegistry(version, { excludeBbgExpanded: true }).components
  componentsByVersion[version] = components
  for (const component of components) sourceLeaderIds.add(component.sourceLeaderId)
}

const sourceLeaderTypeByLocalId = new Map<string, string>()
const usedSourceLeaderTypes = new Set<string>()
for (const localId of [...sourceLeaderIds].sort()) {
  const localLeader = localLeaderById.get(localId)
  if (!localLeader) throw new Error(`Missing local leader ${localId}.`)
  const result = matchLeader(localLeader, [...mainLeaderRowByType.entries()])
  if (result.tied || result.score < 20) {
    throw new Error(`Could not uniquely map ${localId} (${localLeader.civilization} / ${localLeader.name}); best=${result.key} score=${result.score}.`)
  }
  if (usedSourceLeaderTypes.has(result.key)) {
    throw new Error(`Source leader ${result.key} mapped more than once (latest: ${localId}).`)
  }
  sourceLeaderTypeByLocalId.set(localId, result.key)
  usedSourceLeaderTypes.add(result.key)
}

const componentById = new Map<string, CivBlitzComponent>()
for (const version of versions) {
  for (const component of componentsByVersion[version]) componentById.set(component.id, component)
}

const itemCandidates = createItemCandidates(civTraitRows, leaderTraitRows, playerItemTypesByTrait)
const components: Record<string, CivBlitzModComponentMetadata> = {}
for (const component of [...componentById.values()].sort((a, b) => compareText(a.id, b.id))) {
  const sourceLeaderType = required(sourceLeaderTypeByLocalId.get(component.sourceLeaderId), `leader mapping for ${component.id}`)
  const sourceLeaderRow = required(mainLeaderRowByType.get(sourceLeaderType), `leader row ${sourceLeaderType}`)
  let sourceRow: CsvRow

  if (component.category === 'leaderAbility') {
    sourceRow = sourceLeaderRow
  }
  else if (component.category === 'civilizationAbility') {
    const rows = civTraitRows.filter(row => row.CardType === 'CA' && row.CivilizationType === sourceLeaderRow.CivilizationType)
    sourceRow = required(bestNamedRow(component.name, rows, row => row.Unused || row.LocTraitTypeName), `civilization ability ${component.id}`)
  }
  else {
    const matchingCategory = itemCandidates.filter(candidate => candidate.category === component.category)
    const overriddenTrait = componentTraitOverrides[component.id]
    const result = overriddenTrait
      ? { row: matchingCategory.find(candidate => candidate.row.TraitType === overriddenTrait)?.row, score: 1000, tied: false }
      : bestItemCandidate(component, sourceLeaderRow.CivilizationType!, matchingCategory)
    if (result.tied || result.score < 40) {
      throw new Error(`Could not uniquely map ${component.id} (${component.name}); best=${result.row?.TraitType} score=${result.score}.`)
    }
    sourceRow = required(result.row, `item ${component.id}`)
  }

  const traitType = required(sourceRow.TraitType, `trait type for ${component.id}`)
  const grantTraitTypes = componentGrantOverrides[component.id] ?? splitValues(sourceRow.Grants)
  const metadata: CivBlitzModComponentMetadata = {
    category: component.category,
    displayName: component.name,
    civilizationType: required(sourceRow.CivilizationType, `civilization type for ${component.id}`),
    traitType,
    playerItemTypes: playerItemTypesByTrait.get(traitType) ?? [],
    grantTraitTypes,
    grantPlayerItemTypes: grantPlayerItemTypeOverrides[component.id]
      ?? grantTraitTypes.flatMap(grant => required(playerItemTypesByTrait.get(grant), `player item types for granted trait ${grant} (${component.id})`)),
  }
  if (component.category === 'leaderAbility') metadata.leaderType = sourceLeaderType
  const unsupportedReason = unsupportedReasonByTrait[traitType]
  if (unsupportedReason) metadata.unsupportedReason = unsupportedReason
  components[component.id] = metadata
}

const usedCivilizationTypes = new Set(Object.values(components).map(component => component.civilizationType))
const usedLeaderTypes = new Set(
  [...sourceLeaderTypeByLocalId.entries()]
    .filter(([localId]) => sourceLeaderIds.has(localId))
    .map(([, leaderType]) => leaderType),
)

const civilizations: Record<string, CivBlitzModCivilizationMetadata> = {}
for (const civilizationType of [...usedCivilizationTypes].sort()) {
  const civ = required(civilizationByType.get(civilizationType), `civilization ${civilizationType}`)
  const player = required(playerRows.find(row => row.CivilizationType === civilizationType), `player civilization ${civilizationType}`)
  const leaders = civilizationLeaderRows.filter(row => row.CivilizationType === civilizationType)
  const firstLeader = required(leaders[0], `civilization leader ${civilizationType}`)
  civilizations[civilizationType] = {
    civilizationType,
    name: required(civ.Name, `${civilizationType} name`),
    description: required(civ.Description, `${civilizationType} description`),
    adjective: required(civ.Adjective, `${civilizationType} adjective`),
    ethnicity: civ.Ethnicity ?? '',
    capitalName: required(firstLeader.CapitalName, `${civilizationType} capital`),
    civilizationName: required(player.CivilizationName, `${civilizationType} player name`),
    civilizationIcon: required(player.CivilizationIcon, `${civilizationType} player icon`),
    civilizationAbilityName: required(player.CivilizationAbilityName, `${civilizationType} ability name`),
    civilizationAbilityDescription: required(player.CivilizationAbilityDescription, `${civilizationType} ability description`),
    civilizationAbilityIcon: required(player.CivilizationAbilityIcon, `${civilizationType} ability icon`),
    backgroundLeaderType: required(firstLeader.LeaderType, `${civilizationType} background leader`),
    audio: cultureRows.find(row => row.CultureType === 'Audio' && row.CivilizationType === civilizationType)?.Culture ?? civilizationType.replace(/^CIVILIZATION_/, ''),
    cultures: cultureRows.filter(row => row.CultureType === 'Culture' && row.CivilizationType === civilizationType).map(row => row.Culture!),
    unitCultures: cultureRows.filter(row => row.CultureType === 'UnitCulture' && row.CivilizationType === civilizationType).map(row => row.Culture!),
  }
}

const leaders: Record<string, CivBlitzModLeaderMetadata> = {}
for (const leaderType of [...usedLeaderTypes].sort()) {
  const player = required(playerByLeaderType.get(leaderType), `player leader ${leaderType}`)
  const art = required(leaderArtByType.get(leaderType), `leader art ${leaderType}`)
  leaders[leaderType] = {
    leaderType,
    leaderIcon: required(player.LeaderIcon, `${leaderType} player icon`),
    leaderAbilityName: required(player.LeaderAbilityName, `${leaderType} ability name`),
    leaderAbilityDescription: required(player.LeaderAbilityDescription, `${leaderType} ability description`),
    leaderAbilityIcon: required(player.LeaderAbilityIcon, `${leaderType} ability icon`),
    portrait: player.Portrait || `${leaderType}_NEUTRAL`,
    portraitBackground: player.PortraitBackground || `${leaderType}_BACKGROUND`,
    leaderEntry: blp('Leader_BLP_Entry', required(art.LeaderEntryName, `${leaderType} leader entry`), 'Leader', art.LeaderXLPPath!, art.LeaderBLPPackage!, 'Leader'),
    lightrigEntry: blp('Leader_Lightrig_BLP_Entry', required(art.LightrigEntryName, `${leaderType} lightrig entry`), 'LeaderLighting', art.LightrigXLPPath!, 'leaders/light_rigs', 'LeaderLighting'),
    colorKeyEntry: blp('Leader_ColorKey_BLP_Entry', required(art.ColorKeyEntryName, `${leaderType} color key entry`), 'ColorKey', 'ColorKeys.xlp', 'ColorKeys', 'ColorKey'),
    audio: art.Audio ?? '',
    fallbackLeader: fallbackByLeaderType.get(leaderType)?.FallbackLeader ?? '',
  }
}

const landmarks: CivBlitzModLandmarkMetadata[] = landmarkRows.map(row => ({
  collection: row.Collection!,
  name: row.Name!,
  subjectName: row.SubjectName!,
  era: row.Era!,
  asset: blp('Asset', row.Asset!, 'TileBase', row.XLPPath!, row.BLPPackage!, 'TileBase'),
  entryName: row.EntryName!,
  flatten: row.Flatten === 'true',
  traitType: row.TraitType!,
}))

const bbgAdjacencies: CivBlitzModBbgAdjacencyMetadata[] = bbgAdjacencyRows.map(row => ({
  yieldChangeId: row.YieldChangeId!,
  ...(row.CivilizationTrait ? { civilizationTrait: row.CivilizationTrait } : {}),
  ...(row.LeaderTrait ? { leaderTrait: row.LeaderTrait } : {}),
}))

const componentIdsByVersion = Object.fromEntries(versions.map(version => [
  version,
  componentsByVersion[version].map(component => component.id).sort(),
]))

const patchSqlByTrait: Record<string, string> = {}
for (const row of cardPatchRows) {
  patchSqlByTrait[row.TraitType!] = await readVendor(`sql/${row.SqlFile}`)
}

const catalogSource = renderGeneratedModule([
  ['componentCatalog', components, 'Record<string, CivBlitzModComponentMetadata>'],
  ['componentIdsByVersion', componentIdsByVersion, 'Record<\'live\' | \'beta\', readonly string[]>'],
  ['civilizationCatalog', civilizations, 'Record<string, CivBlitzModCivilizationMetadata>'],
  ['leaderCatalog', leaders, 'Record<string, CivBlitzModLeaderMetadata>'],
  ['landmarkCatalog', landmarks, 'readonly CivBlitzModLandmarkMetadata[]'],
  ['bbgAdjacencyCatalog', bbgAdjacencies, 'readonly CivBlitzModBbgAdjacencyMetadata[]'],
], `Generated from Civ Blitz ${UPSTREAM_COMMIT} and @civup/game's persisted component IDs.`)

const staticSource = renderGeneratedModule([
  ['gameplayPatchSqlByTrait', patchSqlByTrait, 'Readonly<Record<string, string>>'],
  ['bbgIntegrationSql', await readVendor('sql/BggIntegration.sql'), 'string'],
  ['leaderSceneLua', await readVendor('lua/LeaderScene_layeredBg.lua'), 'string'],
  ['upstreamLicenseText', await readVendor('LICENSE.txt'), 'string'],
], `Static resources from Civ Blitz ${UPSTREAM_COMMIT}.`)

await mkdir(outputRoot, { recursive: true })
await writeFile(resolve(outputRoot, 'catalog.generated.ts'), catalogSource, 'utf8')
await writeFile(resolve(outputRoot, 'static.generated.ts'), staticSource, 'utf8')
console.log(`Generated ${Object.keys(components).length} components, ${Object.keys(civilizations).length} civilizations, and ${Object.keys(leaders).length} leaders.`)

function createItemCandidates(civRows: CsvRow[], leaderRows: CsvRow[], playerItemTypes: ReadonlyMap<string, readonly string[]>) {
  return [...civRows, ...leaderRows]
    .map((row) => {
      const itemTypes = playerItemTypes.get(row.TraitType!) ?? []
      const category = itemTypes.some(itemType => itemType.startsWith('UNIT_'))
        ? 'unit'
        : itemTypes.some(itemType => /^(?:BUILDING|DISTRICT|IMPROVEMENT|LEADER_BUILDING)_/.test(itemType))
          ? 'infrastructure'
          : null
      const displayName = itemDisplayName(row, itemTypes[0])
      return category && displayName ? { row, category, displayName, itemTypes } : null
    })
    .filter(candidate => candidate != null)
}

function bestItemCandidate(component: CivBlitzComponent, civilizationType: string, candidates: ReturnType<typeof createItemCandidates>) {
  const scored = candidates.map((candidate) => {
    let score = nameScore(component.name, candidate.displayName)
    if (candidate.row.CivilizationType === civilizationType) score += 30
    if (candidate.itemTypes.some(itemType => fold(itemType).includes(fold(component.name)))) score += 20
    return { ...candidate, score }
  }).sort((a, b) => b.score - a.score || compareText(a.row.TraitType!, b.row.TraitType!))
  return { row: scored[0]?.row, score: scored[0]?.score ?? 0, tied: scored[0]?.score === scored[1]?.score }
}

function itemDisplayName(row: CsvRow, subtype: string | undefined): string {
  const descriptionPrefix = row.Description?.includes(':') ? row.Description.slice(0, row.Description.indexOf(':')) : ''
  const unused = row.Unused?.includes(':') ? row.Unused.slice(row.Unused.lastIndexOf(':') + 1).trim() : row.Unused
  return descriptionPrefix || unused || subtype?.replace(/^(?:UNIT|BUILDING|DISTRICT|IMPROVEMENT|LEADER_BUILDING)_/, '').replaceAll('_', ' ') || ''
}

function matchLeader(local: Leader, candidates: [string, CsvRow][]) {
  const scored = candidates.map(([leaderType, row]) => {
    const sourceName = parenthetical(row.Name ?? '')
    const sourceCivilization = (row.Name ?? '').split('(')[0]?.trim() ?? ''
    let score = nameScore(local.name, sourceName)
    score += civilizationScore(local.civilization, sourceCivilization)
    if (row.Unused && fold(local.ability.name) === fold(row.Unused)) score += 200
    if (fold(local.id).includes(fold(sourceName))) score += 20
    return { key: leaderType, score }
  }).sort((a, b) => b.score - a.score || compareText(a.key, b.key))
  return { key: scored[0]!.key, score: scored[0]!.score, tied: scored[0]!.score === scored[1]?.score }
}

function bestNamedRow(name: string, rows: CsvRow[], getName: (row: CsvRow) => string | undefined): CsvRow | undefined {
  const [best] = rows
    .map(row => ({ row, score: nameScore(name, getName(row) ?? '') }))
    .sort((a, b) => b.score - a.score)
  return best?.row
}

function nameScore(left: string, right: string): number {
  const a = fold(left)
  const b = fold(right)
  if (!a || !b) return 0
  if (a === b) return 100
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return 60
  if (Math.abs(a.length - b.length) <= 2 && editDistance(a, b) <= 2) return 50
  const aTokens = new Set(tokens(left))
  const bTokens = new Set(tokens(right))
  const exactOverlap = [...aTokens].filter(token => bTokens.has(token)).length
  const compactOverlap = [...bTokens].filter(token => token.length >= 4 && a.includes(token)).length
  return exactOverlap * 10 + compactOverlap * 8 - Math.abs(aTokens.size - bTokens.size)
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]!
}

function civilizationScore(left: string, right: string): number {
  const a = fold(left).replace(/s$/, '')
  const b = fold(right).replace(/s$/, '')
  return a === b ? 100 : nameScore(left, right)
}

function parenthetical(value: string): string {
  const start = value.indexOf('(')
  const end = value.lastIndexOf(')')
  return start >= 0 && end > start ? value.slice(start + 1, end) : value
}

function tokens(value: string): string[] {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function fold(value: string): string {
  return tokens(value).join('')
}

function splitValues(value: string | undefined): string[] {
  return value?.split(/[|;]/).map(part => part.trim()).filter(Boolean) ?? []
}

function uniqueMap(rows: CsvRow[], key: string): Map<string, CsvRow> {
  return new Map(rows.map(row => [row[key]!, row]))
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const group = grouped.get(groupKey)
    if (group) group.push(value)
    else grouped.set(groupKey, [value])
  }
  return grouped
}

function blp(parameterName: string, name: string, xlpClass: string, xlpPath: string, blpPackage: string, libraryName: string): CivBlitzModBlpEntry {
  return { parameterName, name, xlpClass, xlpPath, blpPackage, libraryName }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null || value === '') throw new Error(`Missing ${label}.`)
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function readCsv(path: string): Promise<CsvRow[]> {
  return parseCsv(await readVendor(path))
}

async function readVendor(path: string): Promise<string> {
  return readFile(resolve(vendorRoot, path), 'utf8')
}

function parseCsv(value: string): CsvRow[] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') {
        field += '"'
        index += 1
      }
      else if (char === '"') {
        quoted = false
      }
      else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    }
    else if (char === ',') {
      record.push(field)
      field = ''
    }
    else if (char === '\n') {
      record.push(field.replace(/\r$/, ''))
      records.push(record)
      record = []
      field = ''
    }
    else {
      field += char
    }
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ''))
    records.push(record)
  }
  const headers = records.shift() ?? []
  return records.filter(row => row.some(Boolean)).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])))
}

function renderGeneratedModule(entries: readonly [string, unknown, string][], note: string): string {
  const typeNames = new Set<string>()
  for (const [, , type] of entries) {
    for (const match of type.matchAll(/CivBlitzMod\w+/g)) typeNames.add(match[0])
  }
  const imports = typeNames.size > 0
    ? `import type { ${[...typeNames].sort().join(', ')} } from '../catalog-types.ts'\n\n`
    : ''
  return `/* eslint-disable style/comma-dangle, style/no-multiple-empty-lines, style/quote-props, style/quotes */\n${imports}/**\n * Generated file. Do not edit directly.\n * ${note}\n */\n${entries.map(([name, value, type]) => `\nexport const ${name} = ${JSON.stringify(value, null, 2)} as const satisfies ${type}\n`).join('')}\n`
}
