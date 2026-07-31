import type { CivBlitzModFile, CivBlitzModInput } from '../src/index.ts'
import { describe, expect, test } from 'bun:test'
import { sha1Hex } from '../src/hash.ts'
import { CivBlitzModError, generateCivBlitzModFiles, generateCivBlitzModZip } from '../src/index.ts'

const singleInput = {
  matchId: 'match-42',
  leaderDataVersion: 'live',
  excludeBbgExpanded: true,
  seats: [{
    seatIndex: 0,
    displayName: 'Alice',
    kit: {
      civilizationAbility: 'civblitz:civilizationAbility:gran-colombia',
      leaderAbility: 'civblitz:leaderAbility:america-teddy-roosevelt-rough-rider',
      infrastructure: 'civblitz:infrastructure:hansa',
      unit: 'civblitz:unit:mamluk',
    },
  }],
} as const satisfies CivBlitzModInput

const multiInput = {
  matchId: '9007199254740991',
  leaderDataVersion: 'beta',
  excludeBbgExpanded: true,
  seats: [
    {
      seatIndex: 0,
      displayName: 'O\'Connor <&>',
      kit: {
        civilizationAbility: 'civblitz:civilizationAbility:america',
        leaderAbility: 'civblitz:leaderAbility:rome-trajan',
        infrastructure: 'civblitz:infrastructure:hansa',
        unit: 'civblitz:unit:mamluk',
      },
    },
    {
      seatIndex: 1,
      displayName: 'Zoë & Co.',
      kit: {
        civilizationAbility: 'civblitz:civilizationAbility:arabia',
        leaderAbility: 'civblitz:leaderAbility:france-catherine-de-medici-black-queen',
        infrastructure: 'civblitz:infrastructure:acropolis',
        unit: 'civblitz:unit:legion',
      },
    },
  ],
} as const satisfies CivBlitzModInput

describe('@civup/civ6-mod generator', () => {
  test('uses a portable standards-compatible SHA-1 implementation', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  test('generates a complete representative single-seat mod', () => {
    const generated = generateCivBlitzModFiles(singleInput)
    const paths = generated.files.map(file => file.path)
    const modInfoPath = paths.find(path => path.endsWith('.modinfo'))

    expect(generated.archiveFilename).toMatch(/^civblitz-match-[a-f0-9]{12}\.zip$/)
    expect(generated.modId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual([
      'Art.dep',
      'ArtDefs/Civilizations.artdef',
      'ArtDefs/Cultures.artdef',
      'ArtDefs/FallbackLeaders.artdef',
      'ArtDefs/Landmarks.artdef',
      'ArtDefs/Leaders.artdef',
      expect.stringMatching(/^CivBlitz-[a-f0-9]{12}\.modinfo$/),
      'Colors.sql',
      'Compatibility.sql',
      'Frontend.sql',
      'Gameplay.sql',
      'Icons.sql',
      'LICENSE.txt',
      'Locale.sql',
      'lua/LeaderScene_layeredBg.lua',
    ])
    expect(paths.filter(path => path.endsWith('.modinfo'))).toHaveLength(1)
    expect(modInfoPath).toBeDefined()

    const gameplay = textFile(generated.files, 'Gameplay.sql')
    const frontend = textFile(generated.files, 'Frontend.sql')
    const leaderArt = textFile(generated.files, 'ArtDefs/Leaders.artdef')
    expect(gameplay).toContain('\'TRAIT_CIVILIZATION_EJERCITO_PATRIOTA\'')
    expect(gameplay).toContain('\'TRAIT_CIVILIZATION_COMANDANTE_GENERAL\'')
    expect(gameplay).toContain('\'TRAIT_LEADER_ROOSEVELT_COROLLARY\'')
    expect(gameplay).toContain('\'TRAIT_LEADER_UNIT_AMERICAN_ROUGH_RIDER\'')
    expect(frontend).toContain('\'UNIT_COMANDANTE_GENERAL\'')
    expect(frontend).toContain('\'UNIT_AMERICAN_ROUGH_RIDER\'')
    expect(frontend).toContain('\'DISTRICT_HANSA\'')
    expect(frontend).toContain('\'UNIT_ARABIAN_MAMLUK\'')
    expect(frontend.indexOf('\'UNIT_ARABIAN_MAMLUK\'')).toBeLessThan(frontend.indexOf('\'DISTRICT_HANSA\''))
    expect(textFile(generated.files, 'Locale.sql')).toContain('Roosevelt Corollary (Ejército Patriota)')
    expect(textFile(generated.files, 'Locale.sql')).not.toContain('Alice')
    expect(leaderArt).toContain(blpEntryXml(
      'Leader_BLP_Entry',
      'LEAD_AMER_TheodoreRoughRider',
      'Leader',
      'leader_teddy_roughrider.xlp',
      'leaders/leader_teddy_roughrider',
      'Leader',
    ))
    expect(leaderArt).toContain(blpEntryXml(
      'Leader_Lightrig_BLP_Entry',
      'Teddy_Roughrider_LightRig',
      'LeaderLighting',
      'leader_lightrigs.xlp',
      'leaders/light_rigs',
      'LeaderLighting',
    ))
    expect(leaderArt).toContain(blpEntryXml(
      'Leader_ColorKey_BLP_Entry',
      'Leader_Colorkey_2',
      'ColorKey',
      'ColorKeys.xlp',
      'ColorKeys',
      'ColorKey',
    ))
  })

  test('combines seats with unique bounded IDs and one global compatibility payload', () => {
    const generated = generateCivBlitzModFiles(multiInput)
    const gameplay = textFile(generated.files, 'Gameplay.sql')
    const compatibility = textFile(generated.files, 'Compatibility.sql')
    const civilizationIds = [...gameplay.matchAll(/CIVILIZATION_IMP_CIVUP_S\d+_[A-F0-9]{24}/g)].map(match => match[0])
    const leaderIds = [...gameplay.matchAll(/LEADER_IMP_CIVUP_S\d+_[A-F0-9]{24}/g)].map(match => match[0])

    expect(new Set(civilizationIds).size).toBe(2)
    expect(new Set(leaderIds).size).toBe(2)
    expect([...new Set(civilizationIds)].every(id => id.length <= 64)).toBe(true)
    expect([...new Set(leaderIds)].every(id => id.length <= 64)).toBe(true)
    expect(generated.files.filter(file => file.path === 'Compatibility.sql')).toHaveLength(1)
    expect(count(compatibility, '-- CivBlitz / Better Balanced Game compatibility.')).toBe(1)
    expect(count(compatibility, '-- Fixes to integrate Better Balanced Game mod with Civ Blitz.')).toBe(1)
  })

  test('produces deterministic standard stored ZIP bytes with manifest parity', () => {
    const first = generateCivBlitzModZip(multiInput)
    const second = generateCivBlitzModZip(multiInput)
    const generated = generateCivBlitzModFiles(multiInput)
    const entries = parseStoredZip(first)
    const modInfoPath = generated.files.find(file => file.path.endsWith('.modinfo'))!.path
    const modInfo = new TextDecoder().decode(entries.get(modInfoPath))
    const manifestPaths = parseManifestPaths(modInfo)

    expect(first).toEqual(second)
    expect([...entries.keys()]).toEqual(generated.files.map(file => file.path))
    expect(manifestPaths).toEqual([...entries.keys()].filter(path => path !== modInfoPath).sort())
    expect(manifestPaths).not.toContain(modInfoPath)
    for (const declaration of [...modInfo.matchAll(/<File>([^<]+)<\/File>/g)].map(match => match[1]!)) {
      expect(entries.has(declaration)).toBe(true)
    }
    for (const file of generated.files) {
      const expected = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
      expect(entries.get(file.path)).toEqual(expected)
    }
    expect(modInfo).not.toContain('DLC_Indones_Khmer.dep')
    expect(modInfo).not.toContain('Exp1.dep')
    expect(modInfo.match(/<File>Art\.dep<\/File>/g)).toHaveLength(2)
  })

  test('produces the same shared mod before and after players swap kits', () => {
    const swapped = structuredClone(multiInput) as CivBlitzModInput
    const firstKit = swapped.seats[0]!.kit
    swapped.seats[0]!.kit = swapped.seats[1]!.kit
    swapped.seats[1]!.kit = firstKit
    swapped.seats[0]!.displayName = 'Different Player One'
    swapped.seats[1]!.displayName = 'Different Player Two'

    expect(generateCivBlitzModFiles(swapped)).toEqual(generateCivBlitzModFiles(multiInput))
    expect(generateCivBlitzModZip(swapped)).toEqual(generateCivBlitzModZip(multiInput))
  })

  test('emits every player item represented by a selected trait', () => {
    const input = structuredClone(singleInput) as CivBlitzModInput
    input.seats[0]!.kit.infrastructure = 'civblitz:infrastructure:street-carnival'
    const frontend = textFile(generateCivBlitzModFiles(input).files, 'Frontend.sql')

    expect(frontend).toContain('Type = \'DISTRICT_STREET_CARNIVAL\'')
    expect(frontend).toContain('Type = \'DISTRICT_WATER_STREET_CARNIVAL\'')
  })

  test('rejects direct, granted, and semantic trait collisions across the combined mod', () => {
    const roughRider = structuredClone(singleInput) as CivBlitzModInput
    roughRider.seats[0]!.kit.unit = 'civblitz:unit:rough-rider'
    expect(() => generateCivBlitzModFiles(roughRider)).toThrow('TRAIT_LEADER_UNIT_AMERICAN_ROUGH_RIDER')

    const streetCarnivalAliases = structuredClone(multiInput) as CivBlitzModInput
    streetCarnivalAliases.seats[0]!.kit.infrastructure = 'civblitz:infrastructure:street-carnival'
    streetCarnivalAliases.seats[1]!.kit.infrastructure = 'civblitz:infrastructure:copacabana'
    expect(() => generateCivBlitzModFiles(streetCarnivalAliases)).toThrow('TRAIT_CIVILIZATION_STREET_CARNIVAL')
  })

  test('keeps player names out of generated files and attributes upstream code only in the license', () => {
    const generated = generateCivBlitzModFiles(multiInput)
    const locale = textFile(generated.files, 'Locale.sql')
    const modInfo = textFile(generated.files, generated.files.find(file => file.path.endsWith('.modinfo'))!.path)
    const license = textFile(generated.files, 'LICENSE.txt')
    const renamed = generateCivBlitzModFiles({
      ...multiInput,
      seats: multiInput.seats.map((seat, index) => ({ ...seat, displayName: `Renamed ${index}` })),
    })

    expect(locale).toContain('Trajan\'\'s Column (Founding Fathers)')
    expect(locale).toContain('Catherine\'\'s Flying Squadron (The Last Prophet)')
    expect(locale).not.toContain('O\'\'Connor <&>')
    expect(locale).not.toContain('Zoë & Co.')
    expect(modInfo).toContain('<Name>CivBlitz leaders mod for match 9007199254740991</Name>')
    expect(modInfo).toContain('<Description>CivBlitz leaders mod for match 9007199254740991</Description>')
    expect(modInfo).toContain('<Teaser>CivBlitz leaders mod for match 9007199254740991</Teaser>')
    expect(modInfo).not.toContain('<Authors>')
    for (const visibleText of [modInfo, locale]) expect(visibleText).not.toMatch(/CivUp|Rocket Jump Technology|—/)
    expect(license).toContain('Copyright (c) 2021 Rocket Jump Technology')
    expect(renamed.modId).toBe(generated.modId)
    expect(customIds(textFile(renamed.files, 'Gameplay.sql'))).toEqual(customIds(textFile(generated.files, 'Gameplay.sql')))
    expect(renamed).toEqual(generated)
  })

  test('escapes the match ID in modinfo text', () => {
    const generated = generateCivBlitzModFiles({ ...singleInput, matchId: 'match-<&"' })
    const modInfo = textFile(generated.files, generated.files.find(file => file.path.endsWith('.modinfo'))!.path)

    expect(modInfo).toContain('CivBlitz leaders mod for match match-&lt;&amp;&quot;')
    expect(modInfo).not.toContain('match-<&"')
  })

  test('returns safe typed validation errors', () => {
    expect(() => generateCivBlitzModFiles({ ...singleInput, excludeBbgExpanded: false })).toThrow(CivBlitzModError)
    try {
      generateCivBlitzModFiles({ ...singleInput, excludeBbgExpanded: false })
      throw new Error('Expected generation to fail')
    }
    catch (error) {
      expect(error).toBeInstanceOf(CivBlitzModError)
      const typed = error as CivBlitzModError
      expect(typed.code).toBe('BBG_EXPANDED_UNSUPPORTED')
      expect(typed.status).toBe(422)
      expect(typed.safeMessage).not.toContain('C:\\')
    }

    const unsupported = structuredClone(singleInput) as CivBlitzModInput
    unsupported.seats[0]!.kit.civilizationAbility = 'civblitz:civilizationAbility:babylon'
    expect(() => generateCivBlitzModFiles(unsupported)).toThrow('Babylon')
  })
})

function textFile(files: readonly CivBlitzModFile[], path: string): string {
  const content = files.find(file => file.path === path)?.content
  if (typeof content !== 'string') throw new Error(`Missing text file ${path}`)
  return content
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function blpEntryXml(parameterName: string, name: string, xlpClass: string, xlpPath: string, blpPackage: string, libraryName: string): string {
  return `<Element class="AssetObjects..BLPEntryValue"><m_EntryName text="${name}"/><m_XLPClass text="${xlpClass}"/><m_XLPPath text="${xlpPath}"/><m_BLPPackage text="${blpPackage}"/><m_LibraryName text="${libraryName}"/><m_ParamName text="${parameterName}"/></Element>`
}

function customIds(sql: string): string[] {
  return [...new Set(sql.match(/(?:CIVILIZATION|LEADER)_IMP_CIVUP_S\d+_[A-F0-9]{24}/g) ?? [])].sort()
}

function parseManifestPaths(modInfo: string): string[] {
  const filesSection = /<Files>([\s\S]*?)<\/Files>/.exec(modInfo)?.[1]
  if (!filesSection) throw new Error('Missing Files manifest')
  return [...filesSection.matchAll(/<File>([^<]+)<\/File>/g)].map(match => match[1]!).sort()
}

function parseStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = bytes.length - 22
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054B50)
  const count = view.getUint16(eocdOffset + 10, true)
  let offset = view.getUint32(eocdOffset + 16, true)
  const result = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014B50)
    expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800)
    expect(view.getUint16(offset + 10, true)).toBe(0)
    const expectedCrc = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    expect(compressedSize).toBe(size)
    expect(view.getUint32(localOffset, true)).toBe(0x04034B50)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const content = bytes.slice(dataOffset, dataOffset + size)
    expect(crc32(content)).toBe(expectedCrc)
    result.set(name, content)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return result
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFF_FFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
  }
  return (crc ^ 0xFFFF_FFFF) >>> 0
}
