import type { CivBlitzModCivilizationMetadata, CivBlitzModComponentMetadata, CivBlitzModLeaderMetadata } from '../src/catalog-types.ts'
import { getCivBlitzRegistry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { civilizationCatalog, componentCatalog, componentIdsByVersion, leaderCatalog } from '../src/generated/catalog.generated.ts'

const components: Readonly<Record<string, CivBlitzModComponentMetadata>> = componentCatalog
const civilizations: Readonly<Record<string, CivBlitzModCivilizationMetadata>> = civilizationCatalog
const leaders: Readonly<Record<string, CivBlitzModLeaderMetadata>> = leaderCatalog
const idsByVersion: Readonly<Record<'live' | 'beta', readonly string[]>> = componentIdsByVersion

const intentionallyUnsupported = new Set([
  'civblitz:civilizationAbility:babylon',
  'civblitz:civilizationAbility:byzantium',
  'civblitz:unit:p-51-mustang',
  'civblitz:unit:u-boat',
])

describe('generated CivBlitz mod catalog', () => {
  for (const version of ['live', 'beta'] as const) {
    test(`resolves every default non-expanded ${version} component`, () => {
      const registry = getCivBlitzRegistry(version, { excludeBbgExpanded: true })
      const expectedIds = registry.components.map(component => component.id).sort()
      const failures: string[] = []

      expect(idsByVersion[version] as readonly string[]).toEqual(expectedIds)
      for (const component of registry.components) {
        const metadata = components[component.id]
        if (!metadata) {
          failures.push(`${component.id}: missing metadata`)
          continue
        }
        if (metadata.category !== component.category) failures.push(`${component.id}: category mismatch`)
        if (!metadata.civilizationType || !metadata.traitType) failures.push(`${component.id}: missing game identifiers`)
        if (!civilizations[metadata.civilizationType]) {
          failures.push(`${component.id}: missing civilization metadata`)
        }
        if (!Array.isArray(metadata.playerItemTypes) || !Array.isArray(metadata.grantPlayerItemTypes)) {
          failures.push(`${component.id}: invalid player item metadata`)
        }
        if ((component.category === 'infrastructure' || component.category === 'unit') && metadata.playerItemTypes.length === 0) {
          failures.push(`${component.id}: missing player item metadata`)
        }
        if (metadata.grantTraitTypes.length > 0 && metadata.grantPlayerItemTypes.length === 0) {
          failures.push(`${component.id}: incomplete granted item metadata`)
        }
        if (component.category === 'leaderAbility') {
          if (!metadata.leaderType || !leaders[metadata.leaderType]) {
            failures.push(`${component.id}: missing leader/art metadata`)
          }
        }
        if (intentionallyUnsupported.has(component.id)) {
          if (typeof metadata.unsupportedReason !== 'string' || metadata.unsupportedReason.length < 30) {
            failures.push(`${component.id}: undocumented rejection`)
          }
        }
        else if ('unsupportedReason' in metadata) {
          failures.push(`${component.id}: unexpectedly rejected`)
        }
      }
      expect(failures).toEqual([])
    })
  }

  test('keeps exact persisted IDs, including locally slugged diacritics', () => {
    expect(componentCatalog).toHaveProperty('civblitz:civilizationAbility:m-ori')
    expect(componentCatalog).toHaveProperty('civblitz:infrastructure:ch-teau')
    expect(componentCatalog).toHaveProperty('civblitz:infrastructure:th-nh')
    expect(componentCatalog).toHaveProperty('civblitz:unit:p-tati-archer')
    expect(componentCatalog['civblitz:infrastructure:copacabana']).toMatchObject({
      traitType: 'TRAIT_CIVILIZATION_STREET_CARNIVAL',
      playerItemTypes: ['DISTRICT_STREET_CARNIVAL', 'DISTRICT_WATER_STREET_CARNIVAL'],
    })
    expect(componentCatalog['civblitz:infrastructure:street-carnival']).toMatchObject({
      traitType: 'TRAIT_CIVILIZATION_STREET_CARNIVAL',
      playerItemTypes: ['DISTRICT_STREET_CARNIVAL', 'DISTRICT_WATER_STREET_CARNIVAL'],
    })
    expect(componentCatalog['civblitz:unit:hetairos']).toMatchObject({
      traitType: 'TRAIT_LEADER_UNIT_HETAIROI',
      playerItemTypes: ['UNIT_MACEDONIAN_HETAIROI'],
    })
    expect(componentCatalog['civblitz:leaderAbility:america-teddy-roosevelt-bull-moose']).toMatchObject({
      leaderType: 'LEADER_T_ROOSEVELT',
      traitType: 'TRAIT_LEADER_ANTIQUES_AND_PARKS',
    })
    expect(componentCatalog['civblitz:leaderAbility:america-teddy-roosevelt-rough-rider']).toMatchObject({
      leaderType: 'LEADER_T_ROOSEVELT_ROUGHRIDER',
      traitType: 'TRAIT_LEADER_ROOSEVELT_COROLLARY',
    })
  })

  test('limits intentional normal-generator rejections to the upstream safety list', () => {
    const actual = Object.entries(componentCatalog)
      .filter(([, metadata]) => 'unsupportedReason' in metadata)
      .map(([id]) => id)
      .sort()
    expect(actual).toEqual([...intentionallyUnsupported].sort())
  })

  test('keeps leader BLP metadata identical to the upstream parser contract', () => {
    expect(leaderCatalog.LEADER_T_ROOSEVELT_ROUGHRIDER).toMatchObject({
      leaderEntry: {
        parameterName: 'Leader_BLP_Entry',
        name: 'LEAD_AMER_TheodoreRoughRider',
        xlpClass: 'Leader',
        xlpPath: 'leader_teddy_roughrider.xlp',
        blpPackage: 'leaders/leader_teddy_roughrider',
        libraryName: 'Leader',
      },
      lightrigEntry: {
        parameterName: 'Leader_Lightrig_BLP_Entry',
        name: 'Teddy_Roughrider_LightRig',
        xlpClass: 'LeaderLighting',
        xlpPath: 'leader_lightrigs.xlp',
        blpPackage: 'leaders/light_rigs',
        libraryName: 'LeaderLighting',
      },
      colorKeyEntry: {
        parameterName: 'Leader_ColorKey_BLP_Entry',
        name: 'Leader_Colorkey_2',
        xlpClass: 'ColorKey',
        xlpPath: 'ColorKeys.xlp',
        blpPackage: 'ColorKeys',
        libraryName: 'ColorKey',
      },
    })
  })

  for (const version of ['live', 'beta'] as const) {
    test(`keeps every future ${version} draft pool component generator-safe and semantically unique`, () => {
      const registry = getCivBlitzRegistry(version, { excludeBbgExpanded: true })
      const draftableIds = Object.values(registry.componentPools).flat()
      const traitOwner = new Map<string, string>()
      const failures: string[] = []

      for (const componentId of draftableIds) {
        const metadata = components[componentId]
        if (!metadata) {
          failures.push(`${componentId}: missing metadata`)
          continue
        }
        if (metadata.unsupportedReason) failures.push(`${componentId}: unsupported`)
        for (const traitType of new Set([metadata.traitType, ...metadata.grantTraitTypes])) {
          const previous = traitOwner.get(traitType)
          if (previous) failures.push(`${componentId}: overlaps ${previous} on ${traitType}`)
          else traitOwner.set(traitType, componentId)
        }
      }

      expect(failures).toEqual([])
    })
  }
})
