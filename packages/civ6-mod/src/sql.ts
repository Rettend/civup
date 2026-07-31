import type { CivBlitzModBbgAdjacencyMetadata, CivBlitzModComponentMetadata } from './catalog-types.ts'
import type { ResolvedCivBlitzModSeat } from './internal-types.ts'
import { sqlString } from './escape.ts'
import { bbgAdjacencyCatalog } from './generated/catalog.generated.ts'
import { bbgIntegrationSql, gameplayPatchSqlByTrait } from './generated/static.generated.ts'

const PLAYER_DOMAIN = 'Players:Expansion2_Players'
const BBG_ADJACENCIES: readonly CivBlitzModBbgAdjacencyMetadata[] = bbgAdjacencyCatalog
const GAMEPLAY_PATCHES: Readonly<Record<string, string>> = gameplayPatchSqlByTrait

export function generateGameplaySql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return `${seats.map(generateSeatGameplaySql).join('\n\n')}\n`
}

export function generateFrontendSql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return `${seats.map(generateSeatFrontendSql).join('\n\n')}\n`
}

export function generateColorsSql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return `${seats.map(seat => `-- Seat ${seat.input.seatIndex}
INSERT OR REPLACE INTO PlayerColors
(Type, Usage, PrimaryColor, SecondaryColor, Alt1PrimaryColor, Alt1SecondaryColor, Alt2PrimaryColor, Alt2SecondaryColor, Alt3PrimaryColor, Alt3SecondaryColor)
SELECT ${sqlString(seat.leaderType)}, Usage, PrimaryColor, SecondaryColor,
       Alt1PrimaryColor, Alt1SecondaryColor, Alt2PrimaryColor, Alt2SecondaryColor, Alt3PrimaryColor, Alt3SecondaryColor
FROM PlayerColors
WHERE Type = ${sqlString(seat.sourceLeader.leaderType)};`).join('\n\n')}\n`
}

export function generateIconsSql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return `${seats.map(seat => `-- Seat ${seat.input.seatIndex}
INSERT OR REPLACE INTO IconDefinitions (Name, Atlas, "Index")
SELECT ${sqlString(`ICON_${seat.civilizationType}`)}, Atlas, "Index"
FROM IconDefinitions
WHERE Name = ${sqlString(seat.sourceCivilization.civilizationIcon)};

INSERT OR REPLACE INTO IconDefinitions (Name, Atlas, "Index")
SELECT ${sqlString(`ICON_${seat.leaderType}`)}, Atlas, "Index"
FROM IconDefinitions
WHERE Name = ${sqlString(seat.sourceLeader.leaderIcon)};`).join('\n\n')}\n`
}

export function generateLocaleSql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return `${seats.map((seat) => {
    const label = `${seat.leaderAbility.displayName} (${seat.civilizationAbility.displayName})`
    return `INSERT OR REPLACE INTO LocalizedText (Tag, Language, Text)
VALUES (${sqlString(seat.leaderNameTag)}, 'en_US', ${sqlString(label)});`
  }).join('\n')}\n`
}

export function generateCompatibilitySql(seats: readonly ResolvedCivBlitzModSeat[]): string {
  const civilizationExceptions = BBG_ADJACENCIES.filter(entry => entry.civilizationTrait)
  const leaderExceptions = BBG_ADJACENCIES.filter(entry => entry.leaderTrait)
  const allYieldChanges = leaderExceptions.map(entry => entry.yieldChangeId)
  const perSeat = seats.map((seat) => {
    const excluded = civilizationExceptions
      .filter(entry => entry.civilizationTrait !== seat.civilizationAbility.traitType)
      .map(entry => entry.yieldChangeId)
    if (excluded.length === 0) return ''
    return `-- Preserve BBG adjacency exclusions for seat ${seat.input.seatIndex}.
INSERT OR REPLACE INTO ExcludedAdjacencies (TraitType, YieldChangeId)
SELECT ${sqlString(seat.civilizationAbility.traitType)}, ID
FROM Adjacency_YieldChanges
WHERE ID IN (${excluded.map(sqlString).join(', ')});`
  }).filter(Boolean).join('\n\n')

  const leaderFixes = leaderExceptions.map(entry => `INSERT OR REPLACE INTO ExcludedAdjacencies (TraitType, YieldChangeId)
SELECT candidate.TraitType, adjacency.ID
FROM (
  SELECT DISTINCT own.TraitType
  FROM LeaderTraits own
  LEFT JOIN LeaderTraits sibling USING (LeaderType)
  GROUP BY own.TraitType, own.LeaderType
  HAVING MAX(sibling.TraitType = ${sqlString(entry.leaderTrait!)}) = 0
) candidate
CROSS JOIN (SELECT ID FROM Adjacency_YieldChanges WHERE ID = ${sqlString(entry.yieldChangeId)}) adjacency;`).join('\n\n')

  const globalLeaderFix = allYieldChanges.length === 0
    ? ''
    : `-- Apply BBG leader-based adjacency exclusions once for the combined mod.
DELETE FROM ExcludedAdjacencies
WHERE TraitType IN (SELECT TraitType FROM CivilizationTraits)
  AND YieldChangeId IN (${allYieldChanges.map(sqlString).join(', ')});

${leaderFixes}`

  return `-- CivBlitz / Better Balanced Game compatibility.
${perSeat}

${globalLeaderFix}

${bbgIntegrationSql.trim()}
`
}

function generateSeatGameplaySql(seat: ResolvedCivBlitzModSeat): string {
  const civ = seat.sourceCivilization
  const civTraits = unique([
    seat.civilizationAbility.traitType,
    ...seat.civilizationAbility.grantTraitTypes,
    seat.infrastructure.traitType,
    ...seat.infrastructure.grantTraitTypes,
    seat.unit.traitType,
    ...seat.unit.grantTraitTypes,
  ])
  const leaderTraits = unique([seat.leaderAbility.traitType, ...seat.leaderAbility.grantTraitTypes])
  const backgroundImage = civ.backgroundLeaderType.replace(/^LEADER_/, '')
  const loadingInfo = seat.sourceLeader.leaderType.includes('_ALT')
    ? `INSERT OR REPLACE INTO LoadingInfo (LeaderType, BackgroundImage, ForegroundImage, LeaderText)
SELECT ${sqlString(seat.leaderType)}, BackgroundImage, ForegroundImage, LeaderText
FROM LoadingInfo
WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};`
    : `INSERT OR REPLACE INTO LoadingInfo (LeaderType, BackgroundImage, ForegroundImage, LeaderText)
VALUES (${sqlString(seat.leaderType)}, ${sqlString(`${seat.sourceLeader.leaderType}_BACKGROUND`)}, ${sqlString(`${seat.sourceLeader.leaderType}_NEUTRAL`)}, ${sqlString(`LOC_LOADING_INFO_${seat.sourceLeader.leaderType}`)});`

  const patches = [seat.civilizationAbility, seat.leaderAbility, seat.infrastructure, seat.unit]
    .map(component => GAMEPLAY_PATCHES[component.traitType])
    .filter((patch): patch is string => Boolean(patch))
    .map(patch => patch.replaceAll('<modName>', seat.token))
    .join('\n\n')

  return `-- CivBlitz seat ${seat.input.seatIndex}
INSERT OR REPLACE INTO Types (Type, Kind) VALUES
(${sqlString(seat.civilizationType)}, 'KIND_CIVILIZATION'),
(${sqlString(seat.leaderType)}, 'KIND_LEADER');

INSERT OR REPLACE INTO Civilizations
(CivilizationType, Name, Description, Adjective, StartingCivilizationLevelType, RandomCityNameDepth, Ethnicity)
VALUES (${sqlString(seat.civilizationType)}, ${sqlString(civ.name)}, ${sqlString(civ.description)}, ${sqlString(civ.adjective)},
        'CIVILIZATION_LEVEL_FULL_CIV', 10, ${sqlString(civ.ethnicity)});

INSERT OR REPLACE INTO CivilizationLeaders (CivilizationType, LeaderType, CapitalName)
VALUES (${sqlString(seat.civilizationType)}, ${sqlString(seat.leaderType)}, ${sqlString(civ.capitalName)});

INSERT OR REPLACE INTO CityNames (CivilizationType, CityName)
SELECT ${sqlString(seat.civilizationType)}, CityName FROM CityNames
WHERE CivilizationType = ${sqlString(civ.civilizationType)};

INSERT OR REPLACE INTO CivilizationCitizenNames (CivilizationType, CitizenName, Female, Modern)
SELECT ${sqlString(seat.civilizationType)}, CitizenName, Female, Modern FROM CivilizationCitizenNames
WHERE CivilizationType = ${sqlString(civ.civilizationType)};

INSERT OR REPLACE INTO CivilizationInfo (CivilizationType, Header, Caption, SortIndex)
SELECT ${sqlString(seat.civilizationType)}, Header, Caption, SortIndex FROM CivilizationInfo
WHERE CivilizationType = ${sqlString(civ.civilizationType)};

${startBiasSql('StartBiasFeatures', 'FeatureType', seat)}
${startBiasSql('StartBiasResources', 'ResourceType', seat)}
${startBiasSql('StartBiasRivers', '', seat)}
${startBiasSql('StartBiasTerrains', 'TerrainType', seat)}

${civTraits.map(trait => `INSERT OR REPLACE INTO CivilizationTraits (TraitType, CivilizationType) VALUES (${sqlString(trait)}, ${sqlString(seat.civilizationType)});`).join('\n')}

INSERT OR REPLACE INTO Leaders (LeaderType, Name, InheritFrom, SceneLayers, Sex, SameSexPercentage)
SELECT ${sqlString(seat.leaderType)}, ${sqlString(seat.leaderNameTag)}, InheritFrom, SceneLayers, Sex, SameSexPercentage
FROM Leaders
WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};

INSERT OR REPLACE INTO DuplicateLeaders (LeaderType, OtherLeaderType)
VALUES (${sqlString(seat.sourceLeader.leaderType)}, ${sqlString(seat.leaderType)});

INSERT OR REPLACE INTO DiplomacyInfo (Type, BackgroundImage)
VALUES (${sqlString(seat.leaderType)}, ${sqlString(backgroundImage)});

${leaderTraits.map(trait => `INSERT OR REPLACE INTO LeaderTraits (LeaderType, TraitType) VALUES (${sqlString(seat.leaderType)}, ${sqlString(trait)});`).join('\n')}

INSERT OR REPLACE INTO LeaderQuotes (LeaderType, Quote)
SELECT ${sqlString(seat.leaderType)}, Quote FROM LeaderQuotes WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};

INSERT OR REPLACE INTO HistoricalAgendas (LeaderType, AgendaType)
SELECT ${sqlString(seat.leaderType)}, AgendaType FROM HistoricalAgendas WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};

INSERT OR REPLACE INTO AgendaPreferredLeaders (LeaderType, AgendaType)
SELECT ${sqlString(seat.leaderType)}, AgendaType FROM AgendaPreferredLeaders WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};

INSERT OR REPLACE INTO FavoredReligions (LeaderType, ReligionType)
SELECT ${sqlString(seat.leaderType)}, ReligionType FROM FavoredReligions WHERE LeaderType = ${sqlString(seat.sourceLeader.leaderType)};

${loadingInfo}

${geographySql(seat)}${patches ? `\n\n-- Upstream normal-card fixes.\n${patches}` : ''}`
}

function generateSeatFrontendSql(seat: ResolvedCivBlitzModSeat): string {
  const civ = seat.sourceCivilization
  const leader = seat.sourceLeader
  const items = playerItems(seat)
  return `-- CivBlitz seat ${seat.input.seatIndex}
INSERT OR REPLACE INTO Players
(Domain, CivilizationType, Portrait, PortraitBackground, LeaderType, LeaderName, LeaderIcon,
 LeaderAbilityName, LeaderAbilityDescription, LeaderAbilityIcon, CivilizationName, CivilizationIcon,
 CivilizationAbilityName, CivilizationAbilityDescription, CivilizationAbilityIcon)
VALUES (${sqlString(PLAYER_DOMAIN)}, ${sqlString(seat.civilizationType)}, ${sqlString(leader.portrait)}, ${sqlString(leader.portraitBackground)},
        ${sqlString(seat.leaderType)}, ${sqlString(seat.leaderNameTag)}, ${sqlString(leader.leaderIcon)},
        ${sqlString(leader.leaderAbilityName)}, ${sqlString(leader.leaderAbilityDescription)}, ${sqlString(leader.leaderAbilityIcon)},
        ${sqlString(civ.civilizationName)}, ${sqlString(civ.civilizationIcon)}, ${sqlString(civ.civilizationAbilityName)},
        ${sqlString(civ.civilizationAbilityDescription)}, ${sqlString(civ.civilizationAbilityIcon)});

${items.map((item, index) => `INSERT OR REPLACE INTO PlayerItems
(Domain, CivilizationType, LeaderType, Type, Icon, Name, Description, SortIndex)
SELECT ${sqlString(PLAYER_DOMAIN)}, ${sqlString(seat.civilizationType)}, ${sqlString(seat.leaderType)},
       Type, Icon, Name, Description, ${10 + index * 10}
FROM PlayerItems
WHERE Domain = ${sqlString(PLAYER_DOMAIN)}
  AND CivilizationType = ${sqlString(item.civilizationType)}
  AND Type = ${sqlString(item.itemType)}
LIMIT 1;`).join('\n\n')}`
}

function playerItems(seat: ResolvedCivBlitzModSeat): { civilizationType: string, itemType: string }[] {
  const components: CivBlitzModComponentMetadata[] = [
    seat.civilizationAbility,
    seat.leaderAbility,
    seat.unit,
    seat.infrastructure,
  ]
  const items: { civilizationType: string, itemType: string }[] = []
  for (const component of components) {
    for (const itemType of [...component.playerItemTypes, ...component.grantPlayerItemTypes]) {
      items.push({ civilizationType: component.civilizationType, itemType })
    }
  }
  return items.filter((item, index) => items.findIndex(candidate => candidate.civilizationType === item.civilizationType && candidate.itemType === item.itemType) === index)
}

function startBiasSql(table: string, valueColumn: string, seat: ResolvedCivBlitzModSeat): string {
  const columns = valueColumn ? `CivilizationType, ${valueColumn}, Tier` : 'CivilizationType, Tier'
  const selected = valueColumn ? `${valueColumn}, Tier` : 'Tier'
  return `INSERT OR REPLACE INTO ${table} (${columns})
SELECT ${sqlString(seat.civilizationType)}, ${selected}
FROM ${table}
WHERE CivilizationType = ${sqlString(seat.sourceCivilization.civilizationType)};`
}

function geographySql(seat: ResolvedCivBlitzModSeat): string {
  const tables = [
    ['NamedRiverCivilizations', 'NamedRiverType'],
    ['NamedMountainCivilizations', 'NamedMountainType'],
    ['NamedVolcanoCivilizations', 'NamedVolcanoType'],
    ['NamedDesertCivilizations', 'NamedDesertType'],
    ['NamedLakeCivilizations', 'NamedLakeType'],
    ['NamedSeaCivilizations', 'NamedSeaType'],
  ] as const
  return tables.map(([table, type]) => `INSERT OR REPLACE INTO ${table} (${type}, CivilizationType)
SELECT ${type}, ${sqlString(seat.civilizationType)} FROM ${table}
WHERE CivilizationType = ${sqlString(seat.sourceCivilization.civilizationType)};`).join('\n\n')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
