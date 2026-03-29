/* eslint-disable no-console */
import type { Leader } from '../src/types.ts'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { leaders as existingLiveLeaders } from '../src/leaders.ts'

type Variant = 'live' | 'beta'

interface ConfigPlayerRow {
  Domain?: string
  CivilizationType: string
  LeaderType: string
  CivilizationName?: string
  CivilizationIcon?: string
  CivilizationAbilityName?: string
  CivilizationAbilityDescription?: string
  CivilizationAbilityIcon?: string
  LeaderName?: string
  LeaderIcon?: string
  LeaderAbilityName?: string
  LeaderAbilityDescription?: string
  LeaderAbilityIcon?: string
  Portrait?: string
  PortraitBackground?: string
}

interface ConfigPlayerItemRow {
  Domain?: string
  CivilizationType: string
  LeaderType: string
  Type: string
  Icon?: string
  Name?: string
  Description?: string
  SortIndex?: number | string
}

interface RulesetDomainOverrideRow {
  Ruleset?: string
  ParameterId?: string
  Domain?: string
}

interface LocalizationRow {
  Language?: string
  Tag: string
  Text: string
}

interface SourceRosterRow {
  player: ConfigPlayerRow
  items: ConfigPlayerItemRow[]
}

const TARGET_DOMAIN = 'Players:Expansion2_Players'
const ENGLISH_LANGUAGE = 'en_US'
const GAME_ROOT = 'C:/Program Files (x86)/Steam/steamapps/common/Sid Meier\'s Civilization VI'
const BBG_EXPANDED_ROOT = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/289070/3533091092'
const BBG_ROOT_BY_VARIANT: Record<Variant, string> = {
  live: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/289070/2865001760',
  beta: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/289070/2849005639',
}
const OUTPUT_PATH_BY_VARIANT: Record<Variant, string> = {
  live: resolve(import.meta.dir, '../src/leaders.ts'),
  beta: resolve(import.meta.dir, '../src/leaders-beta.ts'),
}
const ITEM_ASSET_ROOT = resolve(import.meta.dir, '../../../apps/activity/public/assets/bbg/items')
const NON_SCENARIO_RULESETS = ['RULESET_STANDARD', 'RULESET_EXPANSION_1', 'RULESET_EXPANSION_2']
const TEXT_OVERRIDES: Record<string, string> = {
  LOC_IMPROVEMENT_SUK_DUNON_NAME: 'Dūnon',
  LOC_IMPROVEMENT_SUK_DUNON_REWORK_DESCRIPTION: 'Unlocks the Builder ability to construct a Dūnon, unique to Gaul. +1 :food: Food, +1 :housing: Housing. +1 :production: Production if built on a Hill. Friendly units within 1 tile of a Dūnon receive +5 :strength: Combat Strength. The Dūnon must be built on a Camp or Pasture resource and provides that resource’s yield modifier to adjacent tiles. One per City. Tiles with Dūnons cannot be swapped.',
}
const ITEM_ICON_ASSET_NAME_OVERRIDES: Partial<Record<ConfigPlayerItemRow['Type'], string>> = {
  UNIT_LIME_THULE_DOGSLED: 'Dogsled Hunter',
  UNIT_MACEDONIAN_HETAIROI: 'Hetairoi',
  IMPROVEMENT_LIME_THULE_WBH: 'Hunter\'s House',
}
const ITEM_ICON_ASSET_NAME_OVERRIDES_BY_NAME: Record<string, string> = {
  'Whalebone House': 'Hunter\'s House',
}

async function main(): Promise<void> {
  const variant = parseVariant(process.argv[2])
  const rosterRows = await loadRosterRows()
  const localizationDb = await buildLocalizationDatabase(variant)
  const itemAssetIndex = await buildItemAssetIndex()
  const leaders = buildLeaders(rosterRows, localizationDb, itemAssetIndex)
  const outputPath = OUTPUT_PATH_BY_VARIANT[variant]
  const output = renderLeadersTs(leaders, variant)

  await writeFile(outputPath, output, 'utf8')
  localizationDb.close()

  console.log(`Wrote ${leaders.length} ${variant} leaders to ${outputPath}`)
}

function parseVariant(value: string | undefined): Variant {
  if (value === 'live' || value === 'beta') return value
  if (value == null) return 'beta'
  throw new Error(`Unknown variant: ${value}. Expected 'live' or 'beta'.`)
}

async function loadRosterRows(): Promise<SourceRosterRow[]> {
  const configDb = createConfigDatabase()
  await seedBaseAndDlcConfig(configDb)
  await seedExpandedConfig(configDb)

  const players = configDb.query(`
    SELECT *
    FROM Players
    WHERE Domain = ?
      AND LeaderType <> 'LEADER_DEFAULT'
      AND LeaderType NOT LIKE 'LEADER_MINOR_CIV_%'
      AND CivilizationType <> 'CIVILIZATION_BARBARIAN'
    ORDER BY CivilizationType, LeaderType
  `).all(TARGET_DOMAIN) as ConfigPlayerRow[]

  const itemRows = configDb.query(`
    SELECT *
    FROM PlayerItems
    WHERE Domain = ?
    ORDER BY CivilizationType, LeaderType, SortIndex, Type
  `).all(TARGET_DOMAIN) as ConfigPlayerItemRow[]
  configDb.close()

  const itemsByKey = new Map<string, ConfigPlayerItemRow[]>()
  for (const item of itemRows) {
    const key = rosterKey(item.CivilizationType, item.LeaderType)
    const rows = itemsByKey.get(key)
    if (rows) rows.push(item)
    else itemsByKey.set(key, [item])
  }

  return players.map(player => ({
    player,
    items: itemsByKey.get(rosterKey(player.CivilizationType, player.LeaderType)) ?? [],
  }))
}

function createConfigDatabase(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE Players (
      Domain TEXT DEFAULT 'Players:StandardPlayers',
      CivilizationType TEXT NOT NULL,
      LeaderType TEXT NOT NULL,
      CivilizationName TEXT,
      CivilizationIcon TEXT,
      CivilizationAbilityName TEXT,
      CivilizationAbilityDescription TEXT,
      CivilizationAbilityIcon TEXT,
      LeaderName TEXT,
      LeaderIcon TEXT,
      LeaderAbilityName TEXT,
      LeaderAbilityDescription TEXT,
      LeaderAbilityIcon TEXT,
      Portrait TEXT,
      PortraitBackground TEXT
    );

    CREATE TABLE PlayerItems (
      Domain TEXT DEFAULT 'Players:StandardPlayers',
      CivilizationType TEXT NOT NULL,
      LeaderType TEXT NOT NULL,
      Type TEXT NOT NULL,
      Icon TEXT,
      Name TEXT,
      Description TEXT,
      SortIndex INTEGER
    );

    CREATE TABLE RulesetDomainOverrides (
      Ruleset TEXT,
      ParameterId TEXT,
      Domain TEXT
    );

    CREATE TABLE RuleSets (
      RuleSetType TEXT PRIMARY KEY,
      IsScenario INTEGER NOT NULL
    );
  `)

  const insertRuleSet = db.query('INSERT INTO RuleSets (RuleSetType, IsScenario) VALUES (?, ?)')
  for (const ruleset of NON_SCENARIO_RULESETS) insertRuleSet.run(ruleset, 0)
  return db
}

async function seedBaseAndDlcConfig(db: Database): Promise<void> {
  const xmlFiles = await collectFiles(GAME_ROOT, filePath => extname(filePath).toLowerCase() === '.xml')
  const playerInsert = db.query(`
    INSERT INTO Players (
      Domain,
      CivilizationType,
      LeaderType,
      CivilizationName,
      CivilizationIcon,
      CivilizationAbilityName,
      CivilizationAbilityDescription,
      CivilizationAbilityIcon,
      LeaderName,
      LeaderIcon,
      LeaderAbilityName,
      LeaderAbilityDescription,
      LeaderAbilityIcon,
      Portrait,
      PortraitBackground
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const itemInsert = db.query(`
    INSERT INTO PlayerItems (
      Domain,
      CivilizationType,
      LeaderType,
      Type,
      Icon,
      Name,
      Description,
      SortIndex
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const overrideInsert = db.query('INSERT INTO RulesetDomainOverrides (Ruleset, ParameterId, Domain) VALUES (?, ?, ?)')

  for (const filePath of xmlFiles) {
    const content = await readFile(filePath, 'utf8')
    if (!content.includes('<Players>') && !content.includes('<PlayerItems>') && !content.includes('<RulesetDomainOverrides>')) continue

    const parsed = parseConfigXml(content)
    if (parsed.players.length === 0 && parsed.items.length === 0 && parsed.rulesetDomainOverrides.length === 0) continue

    for (const row of parsed.players) {
      playerInsert.run(
        row.Domain ?? 'Players:StandardPlayers',
        row.CivilizationType,
        row.LeaderType,
        row.CivilizationName ?? null,
        row.CivilizationIcon ?? null,
        row.CivilizationAbilityName ?? null,
        row.CivilizationAbilityDescription ?? null,
        row.CivilizationAbilityIcon ?? null,
        row.LeaderName ?? null,
        row.LeaderIcon ?? null,
        row.LeaderAbilityName ?? null,
        row.LeaderAbilityDescription ?? null,
        row.LeaderAbilityIcon ?? null,
        row.Portrait ?? null,
        row.PortraitBackground ?? null,
      )
    }

    for (const row of parsed.items) {
      itemInsert.run(
        row.Domain ?? 'Players:StandardPlayers',
        row.CivilizationType,
        row.LeaderType,
        row.Type,
        row.Icon ?? null,
        row.Name ?? null,
        row.Description ?? null,
        row.SortIndex == null ? null : Number(row.SortIndex),
      )
    }

    for (const row of parsed.rulesetDomainOverrides) {
      overrideInsert.run(row.Ruleset ?? null, row.ParameterId ?? null, row.Domain ?? null)
    }
  }
}

async function seedExpandedConfig(db: Database): Promise<void> {
  const sqlFiles = await collectFiles(BBG_EXPANDED_ROOT, filePath => extname(filePath).toLowerCase() === '.sql')
  for (const filePath of sqlFiles) {
    const content = await readFile(filePath, 'utf8')
    if (!/\bPlayers\b|\bPlayerItems\b/.test(content)) continue

    for (const statement of splitSqlStatements(content)) {
      if (!isRelevantConfigStatement(statement)) continue
      try {
        db.exec(statement)
      }
      catch (error) {
        console.warn(`Skipped config statement from ${filePath}: ${String(error)}`)
      }
    }
  }
}

function parseConfigXml(content: string): {
  players: ConfigPlayerRow[]
  items: ConfigPlayerItemRow[]
  rulesetDomainOverrides: RulesetDomainOverrideRow[]
} {
  return {
    players: parseXmlSectionRows<ConfigPlayerRow>(content, 'Players'),
    items: parseXmlSectionRows<ConfigPlayerItemRow>(content, 'PlayerItems'),
    rulesetDomainOverrides: parseXmlSectionRows<RulesetDomainOverrideRow>(content, 'RulesetDomainOverrides'),
  }
}

async function buildLocalizationDatabase(variant: Variant): Promise<Database> {
  const db = createLocalizationDatabase()
  await seedBaseAndDlcLocalizations(db)
  await seedVariantLocalizations(db, variant)
  await seedExpandedLocalizations(db)
  return db
}

function createLocalizationDatabase(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE LocalizedText (
      Language TEXT NOT NULL,
      Tag TEXT NOT NULL,
      Text TEXT,
      Gender TEXT,
      Plurality TEXT,
      PRIMARY KEY (Language, Tag)
    );

    CREATE TABLE BaseGameText (
      Tag TEXT PRIMARY KEY,
      Text TEXT
    );

    CREATE TABLE EnglishText (
      Tag TEXT PRIMARY KEY,
      Text TEXT
    );
  `)
  return db
}

async function seedBaseAndDlcLocalizations(db: Database): Promise<void> {
  const xmlFiles = await collectFiles(GAME_ROOT, filePath => extname(filePath).toLowerCase() === '.xml' && /[\\/]Text[\\/]en_US[\\/]/.test(filePath))
  const insert = db.query('INSERT OR REPLACE INTO LocalizedText (Language, Tag, Text) VALUES (?, ?, ?)')

  for (const filePath of xmlFiles) {
    const content = await readFile(filePath, 'utf8')
    for (const row of parseLocalizationXml(content)) {
      insert.run(row.Language ?? ENGLISH_LANGUAGE, row.Tag, row.Text)
    }
  }
}

async function seedVariantLocalizations(db: Database, variant: Variant): Promise<void> {
  const filePath = resolve(BBG_ROOT_BY_VARIANT[variant], 'lang/english.xml')
  const content = await readFile(filePath, 'utf8')
  const insert = db.query('INSERT OR REPLACE INTO LocalizedText (Language, Tag, Text) VALUES (?, ?, ?)')
  for (const row of parseLocalizationXml(content)) {
    insert.run(row.Language ?? ENGLISH_LANGUAGE, row.Tag, row.Text)
  }
}

async function seedExpandedLocalizations(db: Database): Promise<void> {
  const files = await collectFiles(BBG_EXPANDED_ROOT, (filePath) => {
    const extension = extname(filePath).toLowerCase()
    return extension === '.xml' || extension === '.sql'
  })
  const insert = db.query('INSERT OR REPLACE INTO LocalizedText (Language, Tag, Text) VALUES (?, ?, ?)')

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8')
    const extension = extname(filePath).toLowerCase()

    if (extension === '.xml') {
      for (const row of parseLocalizationXml(content)) {
        insert.run(row.Language ?? ENGLISH_LANGUAGE, row.Tag, row.Text)
      }
      continue
    }

    if (!/\bLocalizedText\b/.test(content)) continue
    for (const statement of splitSqlStatements(content)) {
      if (!isRelevantLocalizationStatement(statement)) continue
      try {
        db.exec(statement)
      }
      catch (error) {
        console.warn(`Skipped localization statement from ${filePath}: ${String(error)}`)
      }
    }
  }
}

function buildLeaders(rosterRows: SourceRosterRow[], localizationDb: Database, itemAssetIndex: Map<string, string>): Leader[] {
  const nextLeaders = existingLiveLeaders.map(cloneLeader)
  const liveLeaderIndexByKey = new Map<string, number>()
  for (let index = 0; index < nextLeaders.length; index++) {
    const leader = nextLeaders[index]
    liveLeaderIndexByKey.set(normalizedLeaderKey(leader.civilization, leader.name), index)
  }

  for (const row of rosterRows) {
    const localizedCivilization = resolveText(localizationDb, row.player.CivilizationName) ?? row.player.CivilizationName ?? ''
    const localizedLeaderName = resolveText(localizationDb, row.player.LeaderName) ?? row.player.LeaderName ?? ''
    const key = normalizedLeaderKey(localizedCivilization, localizedLeaderName)
    const existingIndex = liveLeaderIndexByKey.get(key)
    if (existingIndex == null) continue

     const existing = nextLeaders[existingIndex]!
    const updated = buildLeaderFromRoster(row, localizationDb, itemAssetIndex, existing)
    nextLeaders[existingIndex] = updated
  }

  return nextLeaders
}

function buildLeaderFromRoster(row: SourceRosterRow, localizationDb: Database, itemAssetIndex: Map<string, string>, existing: Leader | null): Leader {
  const leaderName = resolveText(localizationDb, row.player.LeaderName) ?? existing?.name ?? row.player.LeaderName ?? row.player.LeaderType
  const civilization = resolveText(localizationDb, row.player.CivilizationName) ?? existing?.civilization ?? row.player.CivilizationName ?? row.player.CivilizationType

  const uniqueUnits: Leader['uniqueUnits'] = []
  const uniqueBuildings: Leader['uniqueBuildings'] = []
  const uniqueImprovements: Leader['uniqueImprovements'] = []
  let unitIndex = 0
  let buildingIndex = 0
  let improvementIndex = 0

  for (const item of row.items) {
    const categoryIndex = item.Type.startsWith('UNIT_')
      ? unitIndex
      : item.Type.startsWith('IMPROVEMENT_')
          ? improvementIndex
          : buildingIndex
    const normalized = buildUniqueFromItem(item, localizationDb, itemAssetIndex, existing, categoryIndex)
    if (!normalized) continue

    if (item.Type.startsWith('UNIT_')) {
      uniqueUnits.push(normalized)
      unitIndex += 1
      continue
    }

    if (item.Type.startsWith('BUILDING_') || item.Type.startsWith('DISTRICT_') || item.Type.startsWith('LEADER_BUILDING_')) {
      uniqueBuildings.push(normalized)
      buildingIndex += 1
      continue
    }

    if (item.Type.startsWith('IMPROVEMENT_')) {
      uniqueImprovements.push(normalized)
      improvementIndex += 1
    }
  }

  const civilizationAbilityName = resolveText(localizationDb, row.player.CivilizationAbilityName) ?? existing?.civilizationAbility?.name ?? row.player.CivilizationAbilityName
  const civilizationAbilityDescription = resolveText(localizationDb, row.player.CivilizationAbilityDescription) ?? existing?.civilizationAbility?.description ?? row.player.CivilizationAbilityDescription

  return {
    id: existing?.id ?? slugify(`${civilization} ${leaderName}`),
    name: leaderName,
    civilization,
    portraitUrl: existing?.portraitUrl,
    fullPortraitUrl: existing?.fullPortraitUrl,
    civilizationAbility: civilizationAbilityName && civilizationAbilityDescription
      ? {
          name: civilizationAbilityName,
          description: resolveLeaderText(civilizationAbilityDescription),
        }
      : undefined,
    ability: {
      name: resolveText(localizationDb, row.player.LeaderAbilityName) ?? existing?.ability.name ?? row.player.LeaderAbilityName ?? leaderName,
      description: resolveLeaderText(resolveText(localizationDb, row.player.LeaderAbilityDescription) ?? existing?.ability.description ?? row.player.LeaderAbilityDescription ?? ''),
    },
    secondaryAbility: existing?.secondaryAbility ? { ...existing.secondaryAbility } : undefined,
    uniqueUnits: uniqueUnits.length > 0 ? uniqueUnits : existing?.uniqueUnits.map(cloneUnique) ?? [],
    uniqueBuildings: uniqueBuildings.length > 0 ? uniqueBuildings : getExistingUniqueBuildings(existing).map(cloneUnique),
    uniqueImprovements: uniqueImprovements.length > 0 ? uniqueImprovements : getExistingUniqueImprovements(existing).map(cloneUnique),
    tags: [],
  }
}

function buildUniqueFromItem(
  item: ConfigPlayerItemRow,
  localizationDb: Database,
  itemAssetIndex: Map<string, string>,
  existing: Leader | null,
  index: number,
): Leader['uniqueUnits'][number] | null {
  const name = resolveText(localizationDb, item.Name) ?? inheritedUniqueName(existing, item.Type, index) ?? item.Name ?? null
  const description = resolveText(localizationDb, item.Description) ?? inheritedUniqueDescription(existing, item.Type, index) ?? item.Description ?? null
  if (!name || !description) return null

  return {
    name,
    description: resolveLeaderText(description),
    replaces: extractReplaces(description) ?? inheritedUniqueReplaces(existing, item.Type, index),
    iconUrl: resolveUniqueIconUrl(item, name, itemAssetIndex, existing, index),
  }
}

async function buildItemAssetIndex(): Promise<Map<string, string>> {
  const assets = new Map<string, string>()
  const entries = await readdir(ITEM_ASSET_ROOT, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.webp') continue
    const assetName = entry.name.replace(/\.webp$/i, '')
    assets.set(normalizeCompareText(assetName), itemAssetUrl(assetName))
  }

  return assets
}

function resolveUniqueIconUrl(
  item: ConfigPlayerItemRow,
  name: string,
  itemAssetIndex: Map<string, string>,
  existing: Leader | null,
  index: number,
): string | undefined {
  const overrideAssetName = ITEM_ICON_ASSET_NAME_OVERRIDES[item.Type] ?? ITEM_ICON_ASSET_NAME_OVERRIDES_BY_NAME[name]
  if (overrideAssetName) return itemAssetUrl(overrideAssetName)

  const iconByName = itemAssetIndex.get(normalizeCompareText(name))
  if (iconByName) return iconByName

  return inheritedUniqueIconUrl(existing, item.Type, index)
}

function itemAssetUrl(assetName: string): string {
  return `/assets/bbg/items/${encodeURIComponent(assetName)}.webp`
}

function inheritedUniqueName(existing: Leader | null, type: string, index: number): string | undefined {
  return getExistingUnique(existing, type, index)?.name
}

function inheritedUniqueDescription(existing: Leader | null, type: string, index: number): string | undefined {
  return getExistingUnique(existing, type, index)?.description
}

function inheritedUniqueReplaces(existing: Leader | null, type: string, index: number): string | undefined {
  return getExistingUnique(existing, type, index)?.replaces
}

function inheritedUniqueIconUrl(existing: Leader | null, type: string, index: number): string | undefined {
  return getExistingUnique(existing, type, index)?.iconUrl
}

function getExistingUnique(existing: Leader | null, type: string, index: number): Leader['uniqueUnits'][number] | Leader['uniqueBuildings'][number] | Leader['uniqueImprovements'][number] | undefined {
  if (!existing) return undefined
  if (type.startsWith('UNIT_')) return existing.uniqueUnits[index] ?? existing.uniqueUnits.find(unit => normalizeCompareText(unit.name) === normalizeCompareText(type))
  if (type.startsWith('IMPROVEMENT_')) return getExistingUniqueImprovements(existing)[index]
  return getExistingUniqueBuildings(existing)[index]
}

function getExistingUniqueBuildings(existing: Leader | null): Leader['uniqueBuildings'] {
  if (!existing) return []
  const leader = existing as Leader & { uniqueBuilding?: Leader['uniqueUnits'][number] }
  if (Array.isArray(leader.uniqueBuildings)) return leader.uniqueBuildings
  return leader.uniqueBuilding ? [leader.uniqueBuilding] : []
}

function getExistingUniqueImprovements(existing: Leader | null): Leader['uniqueImprovements'] {
  if (!existing) return []
  const leader = existing as Leader & { uniqueImprovement?: Leader['uniqueUnits'][number] }
  if (Array.isArray(leader.uniqueImprovements)) return leader.uniqueImprovements
  return leader.uniqueImprovement ? [leader.uniqueImprovement] : []
}

function resolveText(localizationDb: Database, tag: string | undefined): string | undefined {
  if (!tag) return undefined
  const overrideText = TEXT_OVERRIDES[tag]
  if (overrideText != null) return overrideText

  const localizedRow = localizationDb.query('SELECT Text FROM LocalizedText WHERE Language = ? AND Tag = ?').get(ENGLISH_LANGUAGE, tag) as { Text?: string } | null
  if (localizedRow?.Text != null) return localizedRow.Text

  const baseGameRow = localizationDb.query('SELECT Text FROM BaseGameText WHERE Tag = ?').get(tag) as { Text?: string } | null
  if (baseGameRow?.Text != null) return baseGameRow.Text

  const englishRow = localizationDb.query('SELECT Text FROM EnglishText WHERE Tag = ?').get(tag) as { Text?: string } | null
  return englishRow?.Text == null ? undefined : englishRow.Text
}

function resolveLeaderText(value: string): string {
  return decodeXmlEntities(value)
    .replace(/\[NEWLINE\]/gi, ' ')
    .replace(/\[ICON_BULLET\]/gi, '- ')
    .replace(/\[ICON_(\w+)\]/g, (_, icon: string) => ` :${icon.toLowerCase().replace(/[^a-z0-9]/g, '')}: `)
    .replace(/\[COLOR_[^\]]+\]/gi, '')
    .replace(/\[ENDCOLOR\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseLocalizationXml(content: string): LocalizationRow[] {
  const rows: LocalizationRow[] = []
  const rowRe = /<(Row|Replace)\b([^>]*)>([\s\S]*?)<\/\1>/g

  let match: RegExpExecArray | null = rowRe.exec(content)
  while (match) {
    const attrs = parseXmlAttributes(match[2] ?? '')
    const language = attrs.Language ?? ENGLISH_LANGUAGE
    if (language !== ENGLISH_LANGUAGE) {
      match = rowRe.exec(content)
      continue
    }

    const tag = attrs.Tag
    const text = extractTagText(match[3] ?? '')
    if (tag && text != null) rows.push({ Language: language, Tag: tag, Text: text })
    match = rowRe.exec(content)
  }

  return rows
}

function parseXmlSectionRows<T extends Record<string, unknown>>(content: string, sectionName: string): T[] {
  const rows: T[] = []
  const sectionRe = new RegExp(`<${sectionName}>([\\s\\S]*?)</${sectionName}>`, 'g')

  let sectionMatch: RegExpExecArray | null = sectionRe.exec(content)
  while (sectionMatch) {
    const rowRe = /<Row\b([^>]*)\/>/g
    let rowMatch: RegExpExecArray | null = rowRe.exec(sectionMatch[1] ?? '')
    while (rowMatch) {
      rows.push(parseXmlAttributes(rowMatch[1] ?? '') as T)
      rowMatch = rowRe.exec(sectionMatch[1] ?? '')
    }
    sectionMatch = sectionRe.exec(content)
  }

  return rows
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe = /(\w+)="([^"]*)"/g

  let match: RegExpExecArray | null = attrRe.exec(value)
  while (match) {
    const key = match[1]
    const rawValue = match[2]
    if (key && rawValue != null) attrs[key] = decodeXmlEntities(rawValue)
    match = attrRe.exec(value)
  }

  return attrs
}

function extractTagText(value: string): string | null {
  const textMatch = value.match(/<Text>([\s\S]*?)<\/Text>/i)
  if (!textMatch?.[1]) return null
  return decodeXmlEntities(textMatch[1]).replace(/\r/g, '').replace(/\n\s*/g, ' ').trim()
}

function splitSqlStatements(content: string): string[] {
  const withoutLineComments = content.replace(/^\s*--.*$/gm, '')
  return withoutLineComments
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0)
}

function isRelevantConfigStatement(statement: string): boolean {
  if (/\b(INSERT(?: OR REPLACE)? INTO|UPDATE)\s+Players\b/i.test(statement)) return true
  if (/\b(INSERT(?: OR REPLACE)? INTO|UPDATE)\s+PlayerItems\b/i.test(statement)) return true
  if (/\bWITH\b[\s\S]*\bINSERT(?: OR REPLACE)? INTO\s+PlayerItems\b/i.test(statement)) return true
  if (/\bWITH\b[\s\S]*\bINSERT(?: OR REPLACE)? INTO\s+Players\b/i.test(statement)) return true
  return false
}

function isRelevantLocalizationStatement(statement: string): boolean {
  if (/\b(INSERT(?: OR REPLACE)? INTO|UPDATE)\s+(LocalizedText|BaseGameText|EnglishText)\b/i.test(statement)) return true
  if (/\bWITH\b[\s\S]*\bINSERT(?: OR REPLACE)? INTO\s+(LocalizedText|BaseGameText|EnglishText)\b/i.test(statement)) return true
  return false
}

async function collectFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const filePath = resolve(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(filePath, predicate))
      continue
    }
    if (entry.isFile() && predicate(filePath)) files.push(filePath)
  }

  return files
}

function normalizedLeaderKey(civilization: string, leaderName: string): string {
  return `${normalizeCompareText(civilization)}::${normalizeCompareText(leaderName)}`
}

function rosterKey(civilizationType: string, leaderType: string): string {
  return `${civilizationType}::${leaderType}`
}

function cloneLeader(leader: Leader): Leader {
  return {
    id: leader.id,
    name: leader.name,
    civilization: leader.civilization,
    portraitUrl: leader.portraitUrl,
    fullPortraitUrl: leader.fullPortraitUrl,
    civilizationAbility: leader.civilizationAbility ? { ...leader.civilizationAbility } : undefined,
    ability: { ...leader.ability },
    secondaryAbility: leader.secondaryAbility ? { ...leader.secondaryAbility } : undefined,
    uniqueUnits: leader.uniqueUnits.map(cloneUnique),
    uniqueBuildings: getExistingUniqueBuildings(leader).map(cloneUnique),
    uniqueImprovements: getExistingUniqueImprovements(leader).map(cloneUnique),
    tags: [],
  }
}

function cloneUnique(unique: Leader['uniqueUnits'][number]): Leader['uniqueUnits'][number] {
  return { ...unique }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function normalizeCompareText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

function extractReplaces(description: string): string | undefined {
  const match = description.match(/replaces (?:the )?([^.,;|]+?)(?: when| that| and|\. |[,;|]|$)/i)
  if (!match?.[1]) return undefined
  const replaces = match[1].trim()
  return replaces.length > 0 ? replaces : undefined
}

function renderLeadersTs(leaders: Leader[], variant: Variant): string {
  const data = JSON.stringify(leaders, null, 2)
  return `import type { Leader } from './types.ts'\nimport { applyLeaderTags } from './leader-tags.ts'\n\n/**\n * Leader data synced from local Civ VI files.\n *\n * Variant: ${variant}\n * Generated by: packages/game/scripts/sync-bbg-leaders.ts\n */\nexport const leaders: Leader[] = ${data}\n\napplyLeaderTags(leaders)\n\n/** Map of leader ID to leader data for quick lookup */\nexport const leaderMap = new Map<string, Leader>(\n  leaders.map(l => [l.id, l]),\n)\n\n/** All leader IDs (the default civ pool) */\nexport const allLeaderIds = leaders.map(l => l.id)\n\n/** Get a leader by ID, throws if not found */\nexport function getLeader(id: string): Leader {\n  const leader = leaderMap.get(id)\n  if (!leader) throw new Error(\`Leader not found: \${id}\`)\n  return leader\n}\n\n/** Search leaders by name or civilization (case-insensitive) */\nexport function searchLeaders(query: string): Leader[] {\n  const q = query.toLowerCase()\n  return leaders.filter(l =>\n    l.name.toLowerCase().includes(q)\n    || l.civilization.toLowerCase().includes(q),\n  )\n}\n`
}

void main()
