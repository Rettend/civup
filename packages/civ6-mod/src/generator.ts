import type { CivBlitzModCivilizationMetadata, CivBlitzModComponentMetadata, CivBlitzModLeaderMetadata } from './catalog-types.ts'
import type { ResolvedCivBlitzModSeat } from './internal-types.ts'
import type { CivBlitzModFile, CivBlitzModInput, CivBlitzModSeatInput, GeneratedCivBlitzModFiles, LeaderDataVersion } from './types.ts'
import {
  generateArtDep,
  generateCivilizationsArtDef,
  generateCulturesArtDef,
  generateFallbackLeadersArtDef,
  generateLandmarksArtDef,
  generateLeadersArtDef,
} from './art.ts'
import { civilizationCatalog, componentCatalog, componentIdsByVersion, leaderCatalog } from './generated/catalog.generated.ts'
import { leaderSceneLua, upstreamLicenseText } from './generated/static.generated.ts'
import { civBlitzModUuid, sha1Hex } from './hash.ts'
import { generateModInfo } from './modinfo.ts'
import { generateColorsSql, generateCompatibilitySql, generateFrontendSql, generateGameplaySql, generateIconsSql, generateLocaleSql } from './sql.ts'
import { CivBlitzModError } from './types.ts'
import { createStoredZip } from './zip.ts'

const CATEGORIES = ['civilizationAbility', 'leaderAbility', 'infrastructure', 'unit'] as const
const COMPONENT_CATALOG: Readonly<Record<string, CivBlitzModComponentMetadata>> = componentCatalog
const CIVILIZATION_CATALOG: Readonly<Record<string, CivBlitzModCivilizationMetadata>> = civilizationCatalog
const LEADER_CATALOG: Readonly<Record<string, CivBlitzModLeaderMetadata>> = leaderCatalog
const COMPONENT_IDS: Readonly<Record<LeaderDataVersion, readonly string[]>> = componentIdsByVersion
const INVALID_SURROGATE = /[\uD800-\uDFFF]/u
const MAX_SEATS = 64

export function generateCivBlitzModFiles(input: CivBlitzModInput): GeneratedCivBlitzModFiles {
  const normalized = validateInput(input)
  const identity = canonicalIdentity(normalized)
  const digest = sha1Hex(identity)
  const modId = civBlitzModUuid(identity)
  const artId = civBlitzModUuid(`${identity}\0art`)
  const seats = resolveSeats(normalized.seats, identity)
  const archiveFilename = `civblitz-${archiveSlug(normalized.matchName)}-${digest.slice(0, 12)}.zip`
  const modInfoPath = `CivBlitz-${digest.slice(0, 12)}.modinfo`
  const title = normalized.matchName ? `CivBlitz - ${normalized.matchName}` : `CivBlitz - ${digest.slice(0, 8)}`
  const description = normalized.matchName
    ? `Combined CivBlitz seat kits for ${normalized.matchName}.`
    : `Combined CivBlitz seat kits for match ${normalized.matchId}.`

  const files: CivBlitzModFile[] = [
    { path: 'Art.dep', content: generateArtDep(`CivBlitz${digest.slice(0, 12)}`, artId) },
    { path: 'ArtDefs/Civilizations.artdef', content: generateCivilizationsArtDef(seats) },
    { path: 'ArtDefs/Cultures.artdef', content: generateCulturesArtDef(seats) },
    { path: 'ArtDefs/FallbackLeaders.artdef', content: generateFallbackLeadersArtDef(seats) },
    { path: 'ArtDefs/Landmarks.artdef', content: generateLandmarksArtDef(seats) },
    { path: 'ArtDefs/Leaders.artdef', content: generateLeadersArtDef(seats) },
    { path: 'Colors.sql', content: generateColorsSql(seats) },
    { path: 'Compatibility.sql', content: generateCompatibilitySql(seats) },
    { path: 'Frontend.sql', content: generateFrontendSql(seats) },
    { path: 'Gameplay.sql', content: generateGameplaySql(seats) },
    { path: 'Icons.sql', content: generateIconsSql(seats) },
    { path: 'Locale.sql', content: generateLocaleSql(seats) },
    { path: 'NOTICE.txt', content: noticeText() },
    { path: 'lua/LeaderScene_layeredBg.lua', content: leaderSceneLua },
  ]
  const paths = files.map(file => file.path).sort()
  files.push({ path: modInfoPath, content: generateModInfo({ modId, title, description, paths }) })
  files.sort((left, right) => compareText(left.path, right.path))
  return { archiveFilename, modId, files }
}

export function generateCivBlitzModZip(input: CivBlitzModInput): Uint8Array {
  return createStoredZip(generateCivBlitzModFiles(input).files)
}

function validateInput(value: CivBlitzModInput): CivBlitzModInput {
  if (!value || typeof value !== 'object') invalid('The CivBlitz mod request must be an object.')
  const matchId = validText(value.matchId, 'matchId', 256)
  const matchName = value.matchName == null ? undefined : validText(value.matchName, 'matchName', 120)
  if (value.leaderDataVersion !== 'live' && value.leaderDataVersion !== 'beta') invalid('leaderDataVersion must be live or beta.')
  if (typeof value.excludeBbgExpanded !== 'boolean') invalid('excludeBbgExpanded must be a boolean.')
  if (!value.excludeBbgExpanded) {
    throw new CivBlitzModError(
      'BBG_EXPANDED_UNSUPPORTED',
      'BBG Expanded CivBlitz kits are not supported because their dependency and art metadata is not bundled.',
    )
  }
  if (!Array.isArray(value.seats) || value.seats.length < 1 || value.seats.length > MAX_SEATS) {
    invalid(`seats must contain between 1 and ${MAX_SEATS} entries.`)
  }

  const allowedIds = COMPONENT_IDS[value.leaderDataVersion]
  const selectedTraits = new Map<string, { componentId: string, seatIndex: number }>()
  const seats: CivBlitzModSeatInput[] = value.seats.map((seat, position) => {
    if (!seat || typeof seat !== 'object') invalid(`Seat ${position} must be an object.`)
    if (seat.seatIndex !== position) invalid(`Seat entries must be ordered contiguously from seatIndex 0; expected ${position}.`)
    const displayName = validText(seat.displayName, `seats[${position}].displayName`, 100)
    if (!seat.kit || typeof seat.kit !== 'object') kitError(`Seat ${position} must contain a complete CivBlitz kit.`)
    const kit = {} as CivBlitzModSeatInput['kit']
    for (const category of CATEGORIES) {
      const componentId = seat.kit[category]
      if (typeof componentId !== 'string' || !componentId) kitError(`Seat ${position} is missing its ${category} component.`)
      if (!allowedIds.includes(componentId)) {
        throw new CivBlitzModError('COMPONENT_NOT_FOUND', `CivBlitz component ${componentId} is not available in ${value.leaderDataVersion} data.`)
      }
      const metadata = COMPONENT_CATALOG[componentId]
      if (!metadata || metadata.category !== category) {
        kitError(`CivBlitz component ${componentId} is not a ${category} component.`)
      }
      if (metadata.unsupportedReason) {
        throw new CivBlitzModError('COMPONENT_UNSUPPORTED', `${metadata.displayName} cannot be generated safely. ${metadata.unsupportedReason}`)
      }
      for (const traitType of new Set([metadata.traitType, ...metadata.grantTraitTypes])) {
        const previous = selectedTraits.get(traitType)
        if (previous) {
          throw new CivBlitzModError(
            'DUPLICATE_COMPONENT',
            `CivBlitz components ${previous.componentId} (seat ${previous.seatIndex}) and ${componentId} (seat ${position}) overlap on game trait ${traitType}.`,
          )
        }
        selectedTraits.set(traitType, { componentId, seatIndex: position })
      }
      kit[category] = componentId
    }
    return { seatIndex: position, displayName, kit }
  })
  return { matchId, ...(matchName ? { matchName } : {}), leaderDataVersion: value.leaderDataVersion, excludeBbgExpanded: true, seats }
}

function resolveSeats(seats: readonly CivBlitzModSeatInput[], identity: string): ResolvedCivBlitzModSeat[] {
  return seats.map((input) => {
    const civilizationAbility = requiredComponent(input.kit.civilizationAbility)
    const leaderAbility = requiredComponent(input.kit.leaderAbility)
    const infrastructure = requiredComponent(input.kit.infrastructure)
    const unit = requiredComponent(input.kit.unit)
    const sourceCivilization = CIVILIZATION_CATALOG[civilizationAbility.civilizationType]
    const sourceLeader = leaderAbility.leaderType ? LEADER_CATALOG[leaderAbility.leaderType] : undefined
    if (!sourceCivilization || !sourceLeader) {
      throw new CivBlitzModError('COMPONENT_NOT_FOUND', 'The selected CivBlitz kit is missing bundled generator metadata.')
    }
    const token = `CIVUP_S${input.seatIndex}_${sha1Hex(`${identity}\0seat:${input.seatIndex}`).slice(0, 24).toUpperCase()}`
    return {
      input,
      token,
      civilizationType: `CIVILIZATION_IMP_${token}`,
      leaderType: `LEADER_IMP_${token}`,
      leaderNameTag: `LOC_LEADER_IMP_${token}`,
      civilizationAbility,
      leaderAbility,
      infrastructure,
      unit,
      sourceCivilization,
      sourceLeader,
    }
  })
}

function requiredComponent(id: string): CivBlitzModComponentMetadata {
  const component = COMPONENT_CATALOG[id]
  if (!component) throw new CivBlitzModError('COMPONENT_NOT_FOUND', `CivBlitz component ${id} has no bundled generator metadata.`)
  return component
}

function canonicalIdentity(input: CivBlitzModInput): string {
  return JSON.stringify({
    format: 1,
    matchId: input.matchId,
    leaderDataVersion: input.leaderDataVersion,
    excludeBbgExpanded: input.excludeBbgExpanded,
    seats: input.seats.map(seat => ({
      seatIndex: seat.seatIndex,
      kit: CATEGORIES.map(category => seat.kit[category]),
    })),
  })
}

function validText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || hasInvalidXmlText(trimmed) || INVALID_SURROGATE.test(trimmed)) {
    invalid(`${field} must contain between 1 and ${maxLength} valid text characters.`)
  }
  return trimmed
}

function archiveSlug(value: string | undefined): string {
  if (!value) return 'match'
  const slug = value.normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'match'
}

function noticeText(): string {
  return `CivBlitz generator attribution
================================

The normal four-component generator behavior, catalog data, SQL fixes, art aliases,
and LeaderScene integration are copied or substantially derived from Civ Blitz:
https://github.com/rossturner/civ-blitz
commit 413d329664183ab13b5f889df0bea62dc2131131.

The LeaderScene integration retains its in-file Firaxis copyright notice.

${upstreamLicenseText}
`
}

function invalid(message: string): never {
  throw new CivBlitzModError('INVALID_INPUT', message, 400)
}

function kitError(message: string): never {
  throw new CivBlitzModError('INVALID_KIT', message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasInvalidXmlText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7F) return true
  }
  return false
}
