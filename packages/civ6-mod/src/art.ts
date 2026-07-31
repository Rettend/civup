import type { CivBlitzModBlpEntry, CivBlitzModLandmarkMetadata } from './catalog-types.ts'
import type { ResolvedCivBlitzModSeat } from './internal-types.ts'
import { xmlEscape } from './escape.ts'
import { landmarkCatalog } from './generated/catalog.generated.ts'

const WORLD_ART = ['Civilizations.artdef', 'Cultures.artdef', 'Landmarks.artdef'] as const

export function generateCivilizationsArtDef(seats: readonly ResolvedCivBlitzModSeat[]): string {
  const civilizations = seats.map(seat => civElement(
    seat.civilizationType,
    [],
    [collection('Audio', [civElement('Entry', [stringValue('XrefName', seat.sourceCivilization.audio)])])],
  ))
  return artDef('Civilizations', [collection('Civilization', civilizations)])
}

export function generateCulturesArtDef(seats: readonly ResolvedCivBlitzModSeat[]): string {
  return artDef('Cultures', [
    collection('Culture', cultureElements(seats, seat => seat.sourceCivilization.cultures)),
    collection('UnitCulture', cultureElements(seats, seat => seat.sourceCivilization.unitCultures)),
  ])
}

export function generateLeadersArtDef(seats: readonly ResolvedCivBlitzModSeat[]): string {
  const leaders = seats.map(seat => civElement(seat.leaderType, [
    blpValue(seat.sourceLeader.leaderEntry),
    blpValue(seat.sourceLeader.lightrigEntry),
    blpValue(seat.sourceLeader.colorKeyEntry),
    blpValue({ parameterName: 'Leader_Background_BLP_Entry', name: '', xlpClass: 'Leader', xlpPath: '', blpPackage: '', libraryName: 'Leader' }),
    stringValue('Leader_Background_Animation_State', ''),
    stringValue('Audio', seat.sourceLeader.audio),
  ]))
  return artDef('Leaders', [collection('Leaders', leaders)])
}

export function generateFallbackLeadersArtDef(seats: readonly ResolvedCivBlitzModSeat[]): string {
  const leaders = seats
    .filter(seat => seat.sourceLeader.fallbackLeader)
    .map(seat => civElement(seat.leaderType, [], [
      collection('Animations', [
        civElement('DEFAULT', [blpValue({
          parameterName: 'BLP Entry',
          name: seat.sourceLeader.fallbackLeader,
          xlpClass: 'LeaderFallback',
          xlpPath: 'leaderfallbackimages.xlp',
          blpPackage: 'LeaderFallbackImages',
          libraryName: 'LeaderFallback',
        })]),
      ]),
    ]))
  return artDef('LeaderFallback', [collection('Leaders', leaders)])
}

export function generateLandmarksArtDef(seats: readonly ResolvedCivBlitzModSeat[]): string {
  const traits = new Set(seats.flatMap(seat => [
    seat.civilizationAbility.traitType,
    seat.leaderAbility.traitType,
    seat.infrastructure.traitType,
    seat.unit.traitType,
  ]))
  const enabled = landmarkCatalog.filter(landmark => traits.has(landmark.traitType))
  const districtGroups = groupLandmarks(enabled.filter(landmark => landmark.collection !== 'Eras'))
  const eraGroups = groupLandmarks(enabled.filter(landmark => landmark.collection === 'Eras'))

  const districts = [...districtGroups.entries()].sort(([left], [right]) => compareText(left, right)).map(([name, entries]) => {
    const fields = name === 'DISTRICT_CITY_CENTER' ? cityCenterFields() : districtFields()
    return civElement(name, fields, [
      collection('BaseVariants', entries.filter(entry => entry.collection === 'BaseVariants').map(entry => civElement(`${entry.entryName} CIVUP`, [
        artDefReference('Set_HeroBuildings', entry.subjectName, 'BuildingSets', 'Landmarks.artdef', true, 'Landmarks'),
        eraReference(entry.era),
        defaultCultureReference(),
        anyAppealReference(),
        blpValue(entry.asset),
        stringValue('SelectionRule', ''),
        intValue('Priority', 0),
        stringValue('Placement', 'INHERIT'),
      ]))),
      collection('BuildingVariants', entries.filter(entry => entry.collection === 'BuildingVariants').map(entry => civElement(`${entry.entryName} CIVUP`, [
        artDefReference('Tag_HeroBuilding', entry.subjectName, 'Building', 'Buildings.artdef', true, 'Buildings'),
        eraReference(entry.era),
        defaultCultureReference(),
        anyAppealReference(),
        blpValue(entry.asset),
        stringValue('SelectionRule', ''),
        intValue('Priority', 0),
      ]))),
    ])
  })

  const landmarks = [...eraGroups.entries()].sort(([left], [right]) => compareText(left, right)).map(([name, entries]) => civElement(name, [
    boolValue('FlattenTerrain', entries[0]?.flatten ?? false),
    stringValue('RotationType', name.includes('POLDER') ? 'COASTAL' : 'ONLY_FIRST_60'),
  ], [
    collection('Eras', entries.map(entry => civElement(`${entry.entryName} CIVUP`, [
      eraReference(entry.era),
      blpValue(entry.asset),
      defaultCultureReference(),
      anyAppealReference(),
      stringValue('SelectionRule', ''),
      floatValue('Priority', 0),
    ]))),
  ]))

  return artDef('Landmarks', [
    collection('Districts', districts),
    collection('Landmarks', landmarks),
    collection('ResourceTags', []),
    collection('Globals', []),
    collection('TerrainTags', []),
  ])
}

export function generateArtDep(name: string, uuid: string): string {
  // The immutable dependency table is declared after the XML helpers to keep the generator readable.
  // eslint-disable-next-line ts/no-use-before-define
  const systems = artSystems.map(system => `<Element>
<ConsumerName text="${xmlEscape(system.name)}"/>
${textElements('ArtDefDependencyPaths', system.paths)}
${textElements('LibraryDependencies', system.libraries)}
<LoadsLibraries>${String(system.loadsLibraries)}</LoadsLibraries>
</Element>`).join('\n')
  const artDependencies = [
    ['Civilizations.artdef', []],
    ['Cultures.artdef', []],
    ['Landmarks.artdef', WORLD_ART],
    ['Leaders.artdef', []],
    ['FallbackLeaders.artdef', []],
  ] as const
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssetObjects..GameDependencyData>
<ID><name text="${xmlEscape(name)}"/><id text="${xmlEscape(uuid)}"/></ID>
<RequiredGameArtIDs/>
<SystemDependencies>${systems}</SystemDependencies>
<ArtDefDependencies>${artDependencies.map(([path, dependencies]) => `<Element><ArtDefPath text="${path}"/>${textElements('ArtDefDependencyPaths', dependencies)}</Element>`).join('')}</ArtDefDependencies>
</AssetObjects..GameDependencyData>
`
}

function cultureElements(
  seats: readonly ResolvedCivBlitzModSeat[],
  cultures: (seat: ResolvedCivBlitzModSeat) => readonly string[],
): string[] {
  const grouped = new Map<string, ResolvedCivBlitzModSeat[]>()
  for (const seat of seats) {
    for (const culture of cultures(seat)) {
      const group = grouped.get(culture)
      if (group) group.push(seat)
      else grouped.set(culture, [seat])
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => compareText(left, right)).map(([culture, cultureSeats]) => civElement(culture, [
    collectionValue('Civilizations', cultureSeats.map((seat, index) => artDefReference(
      `Civilizations${String(index + 1).padStart(3, '0')}`,
      seat.civilizationType,
      'Civilization',
      'Civilizations.artdef',
      true,
      'Civilizations',
    ))),
  ], [], true))
}

function districtFields(): string[] {
  return [
    artDefReference('DistrictGenerator', '', '', '', true, ''),
    rgbValue('TintColor'),
    boolValue('IsAlignedToCoast', false),
    boolValue('FlattenTerrain', true),
    boolValue('bUseCityScale', false),
    boolValue('DistrictDamagePillagesBuildings', false),
    stringValue('ProceduralPlacementMode', 'NONE'),
  ]
}

function cityCenterFields(): string[] {
  return [
    artDefReference('DistrictGenerator', 'Gen_CityCenter', 'Generator', 'CityGenerators.artdef', true, ''),
    rgbValue('TintColor'),
    boolValue('IsAlignedToCoast', false),
    boolValue('FlattenTerrain', true),
    boolValue('bUseCityScale', false),
    boolValue('DistrictDamagePillagesBuildings', true),
    stringValue('ProceduralPlacementMode', 'NONE'),
  ]
}

function eraReference(era: string): string {
  return artDefReference('Tag_Era', era, 'ArtEra', 'Eras.artdef', true, 'Eras')
}

function defaultCultureReference(): string {
  return artDefReference('Tag_Culture', 'DEFAULT', 'Culture', 'Cultures.artdef', true, 'Cultures')
}

function anyAppealReference(): string {
  return artDefReference('Tag_Appeal', 'ANY', 'AppealTags', 'Appeal.artdef', true, 'Appeal')
}

function groupLandmarks(values: readonly CivBlitzModLandmarkMetadata[]): Map<string, CivBlitzModLandmarkMetadata[]> {
  const groups = new Map<string, CivBlitzModLandmarkMetadata[]>()
  for (const value of values) {
    const group = groups.get(value.name)
    if (group) group.push(value)
    else groups.set(value.name, [value])
  }
  return groups
}

function artDef(templateName: string, collections: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssetObjects..ArtDefSet>
<m_Version><major>4</major><minor>0</minor><build>762</build><revision>531</revision></m_Version>
<m_TemplateName text="${xmlEscape(templateName)}"/>
<m_RootCollections>${collections.join('')}</m_RootCollections>
</AssetObjects..ArtDefSet>
`
}

function collection(name: string, elements: readonly string[]): string {
  return `<Element><m_CollectionName text="${xmlEscape(name)}"/><m_ReplaceMergedCollectionElements>false</m_ReplaceMergedCollectionElements>${elements.join('')}</Element>`
}

function civElement(name: string, fields: readonly string[] = [], children: readonly string[] = [], append = false): string {
  return `<Element><m_Fields><m_Values>${fields.join('')}</m_Values></m_Fields><m_ChildCollections>${children.join('')}</m_ChildCollections><m_Name text="${xmlEscape(name)}"/><m_AppendMergedParameterCollections>${String(append)}</m_AppendMergedParameterCollections></Element>`
}

function assetObject(className: string, paramName: string, entries: readonly string[], suffix = ''): string {
  return `<Element class="AssetObjects..${className}">${entries.join('')}<m_ParamName text="${xmlEscape(paramName)}"/>${suffix}</Element>`
}

function stringValue(paramName: string, value: string): string {
  return assetObject('StringValue', paramName, [`<m_Value text="${xmlEscape(value)}"/>`])
}

function boolValue(paramName: string, value: boolean): string {
  return assetObject('BoolValue', paramName, [`<m_bValue>${String(value)}</m_bValue>`])
}

function intValue(paramName: string, value: number): string {
  return assetObject('IntValue', paramName, [`<m_nValue>${value}</m_nValue>`])
}

function floatValue(paramName: string, value: number): string {
  return assetObject('FloatValue', paramName, [`<m_fValue>${value.toFixed(6)}</m_fValue>`])
}

function rgbValue(paramName: string): string {
  return assetObject('RGBValue', paramName, ['<m_r>255.000000</m_r><m_g>255.000000</m_g><m_b>255.000000</m_b>'])
}

function blpValue(entry: CivBlitzModBlpEntry): string {
  return assetObject('BLPEntryValue', entry.parameterName, [
    `<m_EntryName text="${xmlEscape(entry.name)}"/>`,
    `<m_XLPClass text="${xmlEscape(entry.xlpClass)}"/>`,
    `<m_XLPPath text="${xmlEscape(entry.xlpPath)}"/>`,
    `<m_BLPPackage text="${xmlEscape(entry.blpPackage)}"/>`,
    `<m_LibraryName text="${xmlEscape(entry.libraryName)}"/>`,
  ])
}

function artDefReference(
  paramName: string,
  elementName: string,
  rootCollectionName: string,
  artDefPath: string,
  locked: boolean,
  templateName: string,
): string {
  return assetObject('ArtDefReferenceValue', paramName, [
    `<m_ElementName text="${xmlEscape(elementName)}"/>`,
    `<m_RootCollectionName text="${xmlEscape(rootCollectionName)}"/>`,
    `<m_ArtDefPath text="${xmlEscape(artDefPath)}"/>`,
    `<m_CollectionIsLocked>${String(locked)}</m_CollectionIsLocked>`,
    `<m_TemplateName text="${xmlEscape(templateName)}"/>`,
  ])
}

function collectionValue(paramName: string, values: readonly string[]): string {
  return assetObject(
    'CollectionValue',
    paramName,
    [`<m_eObjectType>INVALID</m_eObjectType><m_eValueType>ARTDEF_REF</m_eValueType><m_Values>${values.join('')}</m_Values>`],
    '<m_AppendMergedParameterCollections>true</m_AppendMergedParameterCollections>',
  )
}

function textElements(tag: string, values: readonly string[]): string {
  return `<${tag}>${values.map(value => `<Element text="${xmlEscape(value)}"/>`).join('')}</${tag}>`
}

const artSystems = [
  { name: 'Audio', paths: [...WORLD_ART, 'Leaders.artdef'], libraries: [], loadsLibraries: true },
  { name: 'Civilizations', paths: ['Civilizations.artdef'], libraries: [], loadsLibraries: false },
  { name: 'Cultures', paths: ['Civilizations.artdef', 'Cultures.artdef'], libraries: [], loadsLibraries: false },
  { name: 'Farms', paths: [...WORLD_ART], libraries: ['TileBase', 'CityBuildings'], loadsLibraries: true },
  { name: 'Features', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'Improvements', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'IndirectGrid', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'Landmarks', paths: [...WORLD_ART], libraries: ['CityBuildings', 'TileBase', 'RouteDecalMaterial'], loadsLibraries: true },
  { name: 'LeaderFallback', paths: ['FallbackLeaders.artdef'], libraries: ['LeaderFallback'], loadsLibraries: true },
  { name: 'LeaderLighting', paths: [], libraries: ['LeaderLighting', 'ColorKey'], loadsLibraries: true },
  { name: 'Leaders', paths: ['Leaders.artdef'], libraries: ['Leader', 'LeaderLighting', 'ColorKey'], loadsLibraries: true },
  { name: 'Resources', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'StrategicView_Properties', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'StrategicView_Route', paths: [...WORLD_ART], libraries: ['StrategicView_Route', 'StrategicView_DirectedAsset'], loadsLibraries: true },
  { name: 'StrategicView_Sprite', paths: [...WORLD_ART], libraries: ['StrategicView_Sprite', 'StrategicView_DirectedAsset'], loadsLibraries: true },
  { name: 'StrategicView_TerrainType', paths: [...WORLD_ART], libraries: ['StrategicView_TerrainBlend', 'StrategicView_TerrainBlendCorners', 'StrategicView_TerrainType', 'StrategicView_DirectedAsset'], loadsLibraries: true },
  { name: 'StrategicView_TerrainBlend', paths: [...WORLD_ART], libraries: ['StrategicView_TerrainBlend', 'StrategicView_DirectedAsset'], loadsLibraries: true },
  { name: 'StrategicView_TerrainBlendCorners', paths: [...WORLD_ART], libraries: ['StrategicView_TerrainBlendCorners', 'StrategicView_DirectedAsset'], loadsLibraries: true },
  { name: 'StrategicView_Translate', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'Terrain', paths: [...WORLD_ART], libraries: ['TerrainAsset', 'TerrainElement', 'TerrainMaterial'], loadsLibraries: true },
  { name: 'Terrains', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'Units', paths: [...WORLD_ART], libraries: ['Unit', 'VFX', 'Light'], loadsLibraries: true },
  { name: 'UnitSimulation', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
  { name: 'VFX', paths: [...WORLD_ART], libraries: ['VFX', 'Light'], loadsLibraries: true },
  { name: 'WorldView_Translate', paths: [...WORLD_ART], libraries: [], loadsLibraries: false },
] as const

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
