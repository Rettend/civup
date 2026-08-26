import { CivReplayStateReader } from './state-reader.ts'
import {
  buildCivReplayTradeRoutes,
  UNITOPERATION_MAKE_TRADE_ROUTE,
  type CivReplayTradeRouteSnapshot,
  type CivReplayUnitTradeRouteOperationSnapshot,
} from './trade-routes.ts'
import { civHash, CIV_REPLAY_DEDICATION_TYPE_NAMES } from '../hash.ts'

const TERRITORY_BUILDER = [...new TextEncoder().encode('TerritoryBuilder')] as const
const END_IA_STUFF = [0xBA, 0xF1, 0xBF, 0x93] as const
const END_PLAYER_STUFF = [0xBC, 0x0A, 0x2B, 0xDE] as const
const DEDICATION_RECORD_MARKER = 0x4D0D7B8C
const DEDICATION_RECORD_MARKER_BYTES = [0x8C, 0x7B, 0x0D, 0x4D] as const
const DEDICATION_SELECTION_BLOCK_MARKER_BYTES = [0x40, 0, 0, 0, 0x1E, 0, 0, 0] as const
const ERA_GOLDEN_AGE_FLAGS_RELATIVE_OFFSET = -136
const ERA_DARK_AGE_FLAGS_RELATIVE_OFFSET = -68
const ERA_SCORE_PLAYER_ROW_MARKER = 30
const ERA_SCORE_MAX_SOURCE_COUNT = 128
const KNOWN_DEDICATION_HASHES = new Set<number>(CIV_REPLAY_DEDICATION_TYPE_NAMES.map(type => civHash(type)))

export type CivReplayAgeState = 'normal' | 'dark' | 'golden' | 'heroic'

export interface CivReplayPlayersSnapshot {
  startOffset: number
  internalPlayerCount: number
  religionCount: number
  parsedPlayerCount: number
  cityCount: number
  players: CivReplayPlayerSnapshot[]
}

export interface CivReplayPlayerSnapshot {
  id: number
  diploFavor: number
  goodyHuts: CivReplayHashValue[]
  dedication: CivReplayDedicationSnapshot | null
  era: CivReplayEraSnapshot | null
  government: number | null
  lastTurnChangeGovernment: number | null
  policies: number[][]
  civics: CivReplayProgressionSnapshot | null
  techs: CivReplayProgressionSnapshot | null
  faith: number | null
  pantheon: number | null
  diploPoint: number | null
  gold: number | null
  maintenance: number | null
  strategicResourceCount: number
  unitsCount: CivReplayHashValue[]
  districts: CivReplayDistrictSnapshot[]
  units: CivReplayUnitSnapshot[]
  governors: CivReplayGovernorSnapshot[]
  improvements: CivReplayImprovementSnapshot[]
  influenceTokensReceived?: number[]
  tradeRouteCount: number
  tradeRoutes: CivReplayTradeRouteSnapshot[]
  districtCount: number
  cityCount: number
  cities: CivReplayCitySnapshot[]
}

export interface CivReplayDedicationSnapshot {
  hash: number
  recordId: number | null
  availableHashes: number[]
}

export interface CivReplayEraSnapshot {
  currentScore: number | null
  previousScore: number | null
  hasGoldenAge: boolean | null
  hasDarkAge: boolean | null
  age: CivReplayAgeState | null
}

interface CivReplayDedicationRecordSnapshot {
  hash: number
  recordId: number
}

interface CivReplayDedicationSelectionSnapshot {
  hash: number
  selectedHashes: number[]
  availableHashes: number[]
}

interface CivReplayDedicationSelectionBlockSnapshot {
  offset: number
  endOffset: number
  selections: Map<number, CivReplayDedicationSelectionSnapshot>
}

interface CivReplayEraScoreBlockSnapshot {
  endOffset: number
  scores: Map<number, number>
}

export interface CivReplayDistrictSnapshot {
  globalId: number
  id: number
  x: number
  y: number
  cityId: number
  type: number
  damage: number
  wallDamage: number
  wall: number
  cost: number
  built: number
  pillage: number
}

export interface CivReplayUnitSnapshot {
  id: number
  type: number
  x: number
  y: number
  army: number
  damage: number
  fortified: number
  xp: number
  level: number
  name: string
  operationTypes: number[]
  tradeRouteOperations: CivReplayUnitTradeRouteOperationSnapshot[]
}

export interface CivReplayGovernorSnapshot {
  id: number
  type: number
  player: number
  city: number
  turns: number[]
  promotions: CivReplayHashValue[]
}

export interface CivReplayImprovementSnapshot {
  x: number
  y: number
  district: number
  type: number
}

export interface CivReplayCitySnapshot {
  id: number
  x: number
  y: number
  population: number
  name: string
  religion: number
  currentProductionType: number | null
  currentProductionItems: number[]
  productionProgressCount: number
  productionProgress: CivReplayHashValue[]
  builtCount: number
  builtItems: CivReplayHashValue[]
  yields: CivReplayHashFloatValue[]
  yields2: CivReplayHashFloatValue[]
}

export interface CivReplayHashValue {
  hash: number
  value: number
}

export interface CivReplayHashBoolValue {
  hash: number
  value: boolean
}

export interface CivReplayHashFloatValue {
  hash: number
  value: number
}

export interface CivReplayProgressionSnapshot {
  found: CivReplayHashBoolValue[]
  boost: CivReplayHashBoolValue[]
  research: CivReplayHashFloatValue[]
  current: number[]
  turnTo: CivReplayHashValue[]
}

interface CivReplayPostCitySnapshot {
  government: number | null
  lastTurnChangeGovernment: number | null
  policies: number[][]
  civics: CivReplayProgressionSnapshot | null
  techs: CivReplayProgressionSnapshot | null
  faith: number | null
  pantheon: number | null
  diploPoint: number | null
  gold: number | null
  maintenance: number | null
  strategicResourceCount: number
  unitsCount: CivReplayHashValue[]
  districts: CivReplayDistrictSnapshot[]
  units: CivReplayUnitSnapshot[]
  governors: CivReplayGovernorSnapshot[]
  improvements: CivReplayImprovementSnapshot[]
  influenceTokensReceived: number[]
  districtCount: number
}

interface CivReplayPostYieldSnapshot {
  units: CivReplayUnitSnapshot[]
  governors: CivReplayGovernorSnapshot[]
  improvements: CivReplayImprovementSnapshot[]
  influenceTokensReceived: number[]
  maintenance: number | null
}

export function parseCivReplayPlayers(bytes: Uint8Array): CivReplayPlayersSnapshot {
  const reader = new CivReplayStateReader(bytes, 'players')
  const startOffset = reader.indexOf(TERRITORY_BUILDER)
  if (startOffset < 0) throw new Error('players: TerritoryBuilder marker not found')

  reader.offset = startOffset + TERRITORY_BUILDER.length
  reader.skip(8)
  reader.skip(8)

  const religionCount = reader.readU32()
  for (let index = 0; index < religionCount; index += 1) skipReligion(reader)

  expectU32(reader, 1, 'players marker after religion block')
  const internalPlayerCount = reader.readU32()
  if (internalPlayerCount > 64) throw new Error(`players: invalid internal player count ${internalPlayerCount}`)

  const players: CivReplayPlayerSnapshot[] = []
  for (let playerIndex = 0; playerIndex < internalPlayerCount; playerIndex += 1) {
    const player = parsePlayerCityBlock(reader)
    players.push(player)
    if (playerIndex < internalPlayerCount - 1) {
      try {
        skipToNextPlayerHeader(reader)
      }
      catch (error) {
        if (player.id === 0x3E || player.id === 0x3F) break
        const message = error instanceof Error ? error.message : 'unknown player-boundary error'
        throw new Error(`players: after player index ${playerIndex} id ${player.id}: ${message}`)
      }
    }
  }

  attachCivReplayDedications(bytes, players)
  buildCivReplayTradeRoutes(players)

  return {
    startOffset,
    internalPlayerCount,
    religionCount,
    parsedPlayerCount: players.length,
    cityCount: players.reduce((sum, player) => sum + player.cityCount, 0),
    players,
  }
}

function parsePlayerCityBlock(reader: CivReplayStateReader): CivReplayPlayerSnapshot {
  const playerId = reader.readU32()
  expectU32(reader, 47, 'player header')
  expectU32(reader, playerId, 'player header id echo')

  reader.skip(4)
  reader.skip(4)
  reader.skip(56)
  reader.skip(10)
  reader.skip(4)
  reader.skip(7 * 4)

  let count = reader.readU32()
  for (let index = 0; index < count; index += 1) skipUnitPosition(reader)

  reader.skip(4)
  count = reader.readU32()
  reader.skip(count * 4)
  reader.skip(12)

  const goodyHuts = readMap(reader)
  reader.skip(4)
  skipMap(reader)
  expectU32(reader, 0x0C, 'diplo favor marker')
  const diploFavor = reader.readU32()
  reader.skip(20)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipArray(reader, { separatorBytes: 0 })
  skipMap(reader)

  reader.skip(33)
  expectU32(reader, 0x10, 'city block marker')
  reader.skip(4)
  const cityCount = reader.readU32()
  if (cityCount > 256) throw new Error(`players: invalid city count ${cityCount} for player ${playerId}`)

  const cities: CivReplayCitySnapshot[] = []
  for (let cityIndex = 0; cityIndex < cityCount; cityIndex += 1) cities.push(parseCity(reader))
  const postCity = parsePlayerPostCityProgression(reader, cities)

  return {
    id: playerId,
    diploFavor,
    goodyHuts: mapToHashValues(goodyHuts),
    dedication: null,
    era: null,
    government: postCity.government,
    lastTurnChangeGovernment: postCity.lastTurnChangeGovernment,
    policies: postCity.policies,
    civics: postCity.civics,
    techs: postCity.techs,
    faith: postCity.faith,
    pantheon: postCity.pantheon,
    diploPoint: postCity.diploPoint,
    gold: postCity.gold,
    maintenance: postCity.maintenance,
    strategicResourceCount: postCity.strategicResourceCount,
    unitsCount: postCity.unitsCount,
    districts: postCity.districts,
    units: postCity.units,
    governors: postCity.governors,
    improvements: postCity.improvements,
    influenceTokensReceived: postCity.influenceTokensReceived,
    tradeRouteCount: 0,
    tradeRoutes: [],
    districtCount: postCity.districtCount,
    cityCount,
    cities,
  }
}

function attachCivReplayDedications(bytes: Uint8Array, players: CivReplayPlayerSnapshot[]) {
  const selectionBlock = scanCivReplayDedicationSelectionBlock(bytes)
  const selections = selectionBlock?.selections ?? new Map<number, CivReplayDedicationSelectionSnapshot>()
  const records = scanCivReplayDedicationRecords(bytes)
  const eras = selectionBlock ? parseCivReplayEraSnapshots(bytes, selectionBlock) : new Map<number, CivReplayEraSnapshot>()
  for (const player of players) {
    const selection = selections.get(player.id)
    const record = records.get(player.id)
    player.era = eras.get(player.id) ?? null
    if (selection) {
      player.dedication = {
        hash: selection.hash,
        availableHashes: selection.availableHashes,
        recordId: record?.hash === selection.hash ? record.recordId : null,
      }
      continue
    }
    player.dedication = record ? { hash: record.hash, availableHashes: [], recordId: record.recordId } : null
  }
}

function scanCivReplayDedicationRecords(bytes: Uint8Array): Map<number, CivReplayDedicationRecordSnapshot> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dedications = new Map<number, CivReplayDedicationRecordSnapshot>()
  for (let offset = indexOfBytes(bytes, DEDICATION_RECORD_MARKER_BYTES); offset >= 0 && offset + 24 <= view.byteLength; offset = indexOfBytes(bytes, DEDICATION_RECORD_MARKER_BYTES, offset + 1)) {
    if (view.getUint32(offset, true) !== DEDICATION_RECORD_MARKER) continue
    if (view.getUint32(offset + 4, true) !== 2) continue
    const playerId = view.getUint32(offset + 8, true)
    if (playerId > 0x3F) continue
    if (view.getUint32(offset + 12, true) !== 5) continue
    const hash = view.getUint32(offset + 16, true)
    if (!KNOWN_DEDICATION_HASHES.has(hash)) continue
    const recordId = view.getUint32(offset + 20, true)
    const previous = dedications.get(playerId)
    if (!previous || recordId >= previous.recordId) dedications.set(playerId, { hash, recordId })
  }
  return dedications
}

function scanCivReplayDedicationSelectionBlock(bytes: Uint8Array): CivReplayDedicationSelectionBlockSnapshot | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let best: CivReplayDedicationSelectionBlockSnapshot | null = null
  for (let offset = indexOfBytes(bytes, DEDICATION_SELECTION_BLOCK_MARKER_BYTES); offset >= 0 && offset + 8 <= view.byteLength; offset = indexOfBytes(bytes, DEDICATION_SELECTION_BLOCK_MARKER_BYTES, offset + 1)) {
    const parsed = parseDedicationSelectionBlock(view, offset)
    if (parsed && (!best || parsed.selections.size > best.selections.size)) best = parsed
  }
  return best
}

function parseDedicationSelectionBlock(view: DataView, offset: number): CivReplayDedicationSelectionBlockSnapshot | null {
  let cursor = offset
  const read = () => {
    if (cursor + 4 > view.byteLength) return null
    const value = view.getUint32(cursor, true)
    cursor += 4
    return value
  }

  if (read() !== 64) return null
  const selections = new Map<number, CivReplayDedicationSelectionSnapshot>()
  for (let playerId = 0; playerId < 64; playerId += 1) {
    if (read() !== 30) return null
    const availableCount = read()
    if (availableCount == null || availableCount > 16) return null
    const availableHashes: number[] = []
    for (let index = 0; index < availableCount; index += 1) {
      const hash = read()
      if (hash == null || !KNOWN_DEDICATION_HASHES.has(hash)) return null
      availableHashes.push(hash)
    }
    if (read() !== 0) return null
    const selectedCount = read()
    if (selectedCount == null || selectedCount > 4 || selectedCount > Math.max(1, availableCount)) return null
    const selectedHashes: number[] = []
    for (let index = 0; index < selectedCount; index += 1) {
      const hash = read()
      if (hash == null || !KNOWN_DEDICATION_HASHES.has(hash)) return null
      selectedHashes.push(hash)
    }
    if (read() !== 0) return null
    if (selectedHashes.length > 0) selections.set(playerId, { hash: selectedHashes[0]!, selectedHashes, availableHashes })
  }
  return { offset, endOffset: cursor, selections }
}

function parseCivReplayEraSnapshots(bytes: Uint8Array, selectionBlock: CivReplayDedicationSelectionBlockSnapshot): Map<number, CivReplayEraSnapshot> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const goldenAgeFlags = parsePlayerBoolArray(bytes, selectionBlock.offset + ERA_GOLDEN_AGE_FLAGS_RELATIVE_OFFSET)
  const darkAgeFlags = parsePlayerBoolArray(bytes, selectionBlock.offset + ERA_DARK_AGE_FLAGS_RELATIVE_OFFSET)
  const currentScores = parseEraScoreBlock(view, selectionBlock.endOffset)
  const previousScores = currentScores ? parseEraScoreBlock(view, currentScores.endOffset) : null
  const eras = new Map<number, CivReplayEraSnapshot>()

  for (let playerId = 0; playerId < 64; playerId += 1) {
    const currentScore = currentScores?.scores.get(playerId) ?? null
    const previousScore = previousScores?.scores.get(playerId) ?? null
    const hasGoldenAge = goldenAgeFlags ? goldenAgeFlags[playerId] ?? false : null
    const hasDarkAge = darkAgeFlags ? darkAgeFlags[playerId] ?? false : null
    const selectedCount = selectionBlock.selections.get(playerId)?.selectedHashes.length ?? 0
    eras.set(playerId, {
      currentScore,
      previousScore,
      hasGoldenAge,
      hasDarkAge,
      age: inferAgeState(hasGoldenAge, hasDarkAge, selectedCount, currentScore, previousScore),
    })
  }

  return eras
}

function parsePlayerBoolArray(bytes: Uint8Array, offset: number): boolean[] | null {
  if (offset < 0 || offset + 68 > bytes.length) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(offset, true) !== 64) return null
  const values: boolean[] = []
  for (let index = 0; index < 64; index += 1) {
    const value = bytes[offset + 4 + index]
    if (value !== 0 && value !== 1) return null
    values.push(value === 1)
  }
  return values
}

function parseEraScoreBlock(view: DataView, offset: number): CivReplayEraScoreBlockSnapshot | null {
  let cursor = offset
  const read = () => {
    if (cursor + 4 > view.byteLength) return null
    const value = view.getUint32(cursor, true)
    cursor += 4
    return value
  }

  if (read() !== 64) return null
  const scores = new Map<number, number>()
  for (let playerId = 0; playerId < 64; playerId += 1) {
    if (read() !== ERA_SCORE_PLAYER_ROW_MARKER) return null
    const sourceCount = read()
    const score = read()
    if (sourceCount == null || score == null || sourceCount > ERA_SCORE_MAX_SOURCE_COUNT) return null
    const remainingValueCount = sourceCount * 2 - 1
    if (remainingValueCount < 0 || cursor + remainingValueCount * 4 > view.byteLength) return null
    cursor += remainingValueCount * 4
    scores.set(playerId, score)
  }
  return { endOffset: cursor, scores }
}

function inferAgeState(
  hasGoldenAge: boolean | null,
  hasDarkAge: boolean | null,
  selectedCount: number,
  currentScore: number | null,
  previousScore: number | null,
): CivReplayAgeState | null {
  if (selectedCount > 1) return 'heroic'
  if (hasGoldenAge) return 'golden'
  if (hasDarkAge) return 'dark'
  if (hasGoldenAge === false || hasDarkAge === false || currentScore != null || previousScore != null) return 'normal'
  return null
}

function indexOfBytes(bytes: Uint8Array, pattern: readonly number[], from = 0): number {
  let offset = bytes.indexOf(pattern[0]!, from)
  while (offset >= 0 && offset + pattern.length <= bytes.length) {
    let matches = true
    for (let index = 1; index < pattern.length; index += 1) {
      if (bytes[offset + index] !== pattern[index]) {
        matches = false
        break
      }
    }
    if (matches) return offset
    offset = bytes.indexOf(pattern[0]!, offset + 1)
  }
  return -1
}

function parsePlayerPostCityProgression(reader: CivReplayStateReader, cities: CivReplayCitySnapshot[]): CivReplayPostCitySnapshot {
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)
  reader.skip(5)
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(4)
  reader.skip(8)
  skipFixedArray(reader, 4)
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(4)
  skipFixedArray(reader, 8)
  expectU32(reader, 0x32, 'post-city player marker')

  reader.skip(3137)
  skipMap(reader)
  skipMap(reader)
  reader.skip(53)
  skipFixedArray(reader, 264)
  skipFixedArray(reader, 72)

  const tooltipCount = reader.readU32()
  if (tooltipCount !== 64) throw new Error(`players: expected tooltip player count 64, got ${tooltipCount}`)
  for (let playerIndex = 0; playerIndex < tooltipCount; playerIndex += 1) {
    const count = reader.readU32()
    for (let index = 0; index < count; index += 1) {
      reader.skip(4)
      reader.skip(4)
      reader.skip(33)
      reader.readString()
      reader.skip(4)
    }
  }
  reader.skip(12)

  reader.skip(64 * 16)
  reader.skip(64 * 4)
  reader.skip(64 * 4)
  reader.skip(768)

  skipFixedArray(reader, 8)
  for (let index = 0; index < 64; index += 1) {
    expectU32(reader, 0x32, 'post-city repeated player marker')
    reader.skip(9)
  }

  skipFixedArray(reader, 21)
  skipFixedArray(reader, 16)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 16)

  let count = reader.readU32()
  reader.skip(count * 12)
  reader.skip(86)

  count = reader.readU32()
  if (count !== 64) throw new Error(`players: expected post-city count 64, got ${count}`)
  reader.skip(count * 4)
  count = reader.readU32()
  if (count !== 64) throw new Error(`players: expected post-city count 64, got ${count}`)
  reader.skip(count * 4)
  skipFixedArray(reader, 16)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(8)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 8)
  }

  skipFixedArray(reader, 14)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(8)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 20)
  }

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(8)
    const nestedCount = reader.readU32()
    for (let nested = 0; nested < nestedCount; nested += 1) {
      reader.skip(4)
      const deepCount = reader.readU32()
      reader.skip(deepCount * 4)
    }
  }

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(8)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 20)
  }

  skipArray(reader)
  skipArray(reader, { separatorBytes: 0 })
  skipMap(reader)
  reader.skip(16)

  const districtCount = reader.readU32()
  if (districtCount > 4096) throw new Error(`players: invalid district count ${districtCount}`)
  const districts: CivReplayDistrictSnapshot[] = []
  for (let index = 0; index < districtCount; index += 1) districts.push(parseDistrict(reader))

  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)
  reader.skip(8)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  skipFixedArray(reader, 22)
  skipFixedArray(reader, 12)
  skipFixedArray(reader, 16)
  skipFixedArray(reader, 12)

  reader.skip(4)
  reader.skip(4)
  count = reader.readU32()
  expectU32(reader, count, 'government count echo')
  reader.skip(count * 2)
  reader.skip(4)
  const government = reader.readU32()
  reader.skip(8)
  const lastTurnChangeGovernment = reader.readU32()
  reader.skip(4)
  reader.skip(1)

  skipArray(reader)
  skipMap(reader)
  skipMap(reader)
  for (let index = 0; index < 5; index += 1) skipArray(reader)

  count = reader.readU32()
  reader.skip(4)
  const policies: number[][] = [[], [], [], []]
  for (let index = 0; index < count; index += 1) {
    const policy = reader.readU32()
    let position = reader.readU32()
    if (position === 4) position = 3
    if (position >= policies.length) throw new Error(`players: invalid policy position ${position}`)
    policies[position]!.push(policy)
  }

  skipFixedArray(reader, 8)
  reader.skip(4)
  reader.skip(8)

  const civics = readProgressionSnapshot(reader)

  reader.skip(25)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 1)
  skipFixedArray(reader, 4)
  reader.skip(12)
  reader.skip(12)
  reader.skip(4)
  reader.skip(4)
  reader.skip(8)

  count = reader.readU32()
  if (count !== 0x40) throw new Error(`players: expected tourism player count 64, got ${count}`)
  reader.skip(count * 4)
  reader.skip(8)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(4)
    reader.skip(4)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 8)
  }

  skipFixedArray(reader, 17)
  skipFixedArray(reader, 12)
  reader.skip(1)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x2D, 'tourism marker')
    reader.skip(8)
  }
  reader.skip(4)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x2D, 'tourism marker')
    reader.skip(9)
  }
  reader.skip(16)
  reader.skip(4)
  skipFixedArray(reader, 8)
  reader.skip(4)
  reader.skip(8)
  reader.skip(8)

  skipFixedArray(reader, 13)
  skipFixedArray(reader, 16)

  expectU32(reader, 0x11, 'spy marker')
  reader.skip(4)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(24)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 4)
  }

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(40)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 4)
    reader.skip(4)
  }

  skipFixedArray(reader, 16)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  skipFixedArray(reader, 44)
  skipFixedArray(reader, 16)
  skipFixedArray(reader, 12)

  expectU32(reader, 0x14, 'faith marker')
  reader.skip(1)
  const faith = reader.readU32()
  reader.skip(3)
  const pantheon = reader.readU32()
  reader.skip(4)
  reader.skip(8)

  skipFixedArray(reader, 24)
  skipFixedArray(reader, 13)
  reader.skip(4)
  reader.skip(44)
  reader.skip(2)
  reader.skip(4)
  reader.skip(20)

  skipMap(reader)
  reader.skip(16)
  skipArray(reader, { separatorBytes: 0 })
  reader.skip(4)
  skipArray(reader)
  reader.skip(13)

  const strategicResourceCount = reader.readU32()
  if (strategicResourceCount > 128) throw new Error(`players: invalid strategic resource count ${strategicResourceCount}`)
  for (let index = 0; index < strategicResourceCount; index += 1) {
    reader.skip(4)
    expectU32(reader, 0x03, 'strategic resource marker')
    reader.skip(12)
  }
  expectU32(reader, strategicResourceCount, 'strategic resource count echo')
  for (let index = 0; index < strategicResourceCount; index += 1) {
    reader.skip(4)
    readFixedPoint(reader)
  }

  skipFixedArray(reader, 8)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  count = reader.readU32()
  reader.skip(count * 8)
  skipMap(reader)
  skipMap(reader)

  count = reader.readU32()
  reader.skip(count * 8)
  skipMap(reader)
  skipMap(reader)

  reader.skip(32)
  reader.skip(65)
  const diploPoint = reader.readCount(3)
  reader.skip(3)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(13)
    reader.readString()
    reader.skip(22)
  }
  reader.skip(20)

  const unitsCount = readMap(reader)
  skipMap(reader)
  skipFixedArray(reader, 4)
  skipMap(reader)

  reader.skip(1888)

  const techs: CivReplayProgressionSnapshot = {
    current: readArrayValues(reader, { separatorBytes: 0 }),
    turnTo: [],
    found: [],
    boost: [],
    research: [],
  }
  reader.skip(12)
  techs.found = mapToHashBoolValues(readMapBool(reader))
  techs.boost = mapToHashBoolValues(readMapBool(reader))
  techs.research = mapToHashFloatValues(readMapFloat(reader))

  reader.skip(8)
  reader.skip(4)
  reader.skip(4)
  reader.skip(1)
  const gold = reader.readU32()
  reader.skip(4)
  reader.skip(4)
  reader.skip(20)
  reader.skip(4)
  reader.skip(3)

  const postYield = parsePostTechCityYields(reader, cities, civics, techs)

  return {
    government,
    lastTurnChangeGovernment,
    policies,
    civics,
    techs,
    faith,
    pantheon,
    diploPoint,
    gold,
    maintenance: postYield.maintenance,
    strategicResourceCount,
    unitsCount: mapToHashValues(unitsCount),
    districts,
    units: postYield.units,
    governors: postYield.governors,
    improvements: postYield.improvements,
    influenceTokensReceived: postYield.influenceTokensReceived,
    districtCount,
  }
}

function parseCity(reader: CivReplayStateReader): CivReplayCitySnapshot {
  const id = reader.readU32()
  expectU32(reader, 0x33, 'city header')
  reader.skip(4)
  const x = reader.readU32()
  const y = reader.readU32()

  reader.skip(12)
  reader.skip(4)
  reader.skip(4)
  const population = reader.readU32()
  reader.skip(2)
  reader.skip(4)
  reader.skip(8)
  reader.skip(4)
  reader.skip(64 * 4)
  reader.skip(1)
  reader.skip(18)

  for (let index = 0; index < 13; index += 1) {
    expectMapCount(reader, 0x06, 'city yield/map marker')
    skipMap(reader)
  }

  let count = reader.readU32()
  reader.skip(count * 20)
  count = reader.readU32()
  reader.skip(count * 16)
  count = reader.readU32()
  reader.skip(count * 8)
  count = reader.readU32()
  reader.skip(count * 12)
  reader.skip(8)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x33, 'city local district/name marker')
    reader.skip(4)
    reader.skip(8)
    reader.skip(4)
    reader.skip(6)
    reader.skip(4)
    reader.skip(8)
    reader.readString()
  }

  count = reader.readU32()
  reader.skip(count * 16)
  reader.skip(17)
  expectMapCount(reader, 0x06, 'city pre-name map marker')
  skipMap(reader)
  reader.skip(13)
  const name = reader.readString()
  reader.skip(8)
  reader.skip(4)

  count = reader.readU32()
  reader.skip(count * 4)
  reader.skip(8)
  skipArray(reader, { separatorBytes: 0 })
  skipArray(reader, { separatorBytes: 0 })
  skipArray(reader)
  skipArray(reader)
  reader.skip(9)
  reader.skip(36)

  count = reader.readU32()
  reader.skip(count * 22)
  count = reader.readU32()
  reader.skip(count * 20)
  reader.skip(4)
  reader.skip(25)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  reader.skip(4)
  skipMap(reader)
  skipMap(reader)
  reader.skip(5)
  skipArray(reader, { separatorBytes: 0 })
  reader.skip(33)

  count = reader.readU32()
  reader.skip(count * 8)
  reader.skip(4)
  const religion = reader.readU32()
  count = reader.readU32()
  reader.skip(count * 17)
  reader.skip(8)
  reader.skip(18)
  reader.skip(4)
  reader.skip(16)

  skipMap(reader)
  skipMap(reader)
  reader.skip(12)
  skipMap(reader)
  skipMap(reader)

  reader.skip(4)
  count = reader.readU32()
  const currentProductionItems: number[] = []
  let currentProductionType: number | null = null
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x2C0F4A46, 'city current production marker')
    reader.skip(4)
    reader.skip(4)
    currentProductionType = reader.readU32()
    reader.skip(4)
    if (currentProductionType > 4) throw new Error(`players: invalid production type ${currentProductionType}`)
    currentProductionItems.push(reader.readU32())
    if (currentProductionType === 0) reader.skip(4)
    reader.skip(12)
  }

  reader.skip(40)
  skipMap(reader)
  skipMap(reader)
  const productionProgress = readMap(reader)
  skipMap(reader, 2)
  mergeMapInto(readMap(reader), productionProgress)
  mergeMapInto(readMap(reader), productionProgress)
  mergeMapInto(readMap(reader), productionProgress)
  skipMap(reader, 2)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipArray(reader)
  reader.skip(8)

  count = reader.readU32()
  reader.skip(count * 12)
  skipMap(reader)
  skipMap(reader)
  reader.skip(9)
  count = reader.readU32()
  reader.skip(count * 12)
  reader.skip(4)
  const built = readMap(reader, 2)
  skipArray(reader)
  skipMap(reader, 2)
  skipMap(reader, 2)

  skipCityTail(reader)

  return {
    id,
    x,
    y,
    population,
    name,
    religion,
    currentProductionType,
    currentProductionItems,
    productionProgressCount: productionProgress.size,
    productionProgress: mapToHashValues(productionProgress),
    builtCount: built.size,
    builtItems: mapToHashValues(built),
    yields: [],
    yields2: [],
  }
}

function parsePostTechCityYields(reader: CivReplayStateReader, cities: CivReplayCitySnapshot[], civics: CivReplayProgressionSnapshot, techs: CivReplayProgressionSnapshot): CivReplayPostYieldSnapshot {
  skipMap(reader)
  skipFixedArray(reader, 8)
  reader.skip(16)

  const unitCount = reader.readU32()
  if (unitCount > 20000) throw new Error(`players: invalid unit count ${unitCount}`)
  const units: CivReplayUnitSnapshot[] = []
  for (let index = 0; index < unitCount; index += 1) units.push(parseUnit(reader))

  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipArray(reader)
  reader.skip(3)

  let count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(4)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 8)
  }

  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)
  reader.skip(4)

  if (reader.peekU32() === 0) reader.skip(4)
  skipMap(reader)
  reader.skip(12)

  skipFixedArray(reader, 12)
  skipFixedArray(reader, 12)
  skipFixedArray(reader, 12)
  skipFixedArray(reader, 4)

  reader.skip(32)
  reader.skip(44)
  skipMap(reader)
  skipMap(reader)
  skipArray(reader, { separatorBytes: 0 })

  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(52)

  for (let index = 0; index < 2; index += 1) {
    reader.skip(4)
    reader.skip(64)
  }

  for (let index = 0; index < 13; index += 1) {
    expectMapCount(reader, 0x06, 'post-tech yield map marker')
    skipMap(reader)
  }
  reader.skip(4)

  for (let index = 0; index < 72; index += 1) {
    expectMapCount(reader, 0x06, 'post-tech yield table marker')
    skipMap(reader)
  }

  for (let group = 0; group < 3; group += 1) {
    count = reader.readU32()
    for (let index = 0; index < count; index += 1) {
      reader.skip(4)
      expectMapCount(reader, 0x06, 'improvement yield marker')
      skipMap(reader)
    }
  }

  skipMap(reader)

  for (let group = 0; group < 4; group += 1) {
    count = reader.readU32()
    for (let index = 0; index < count; index += 1) {
      reader.skip(4)
      expectMapCount(reader, 0x06, 'terrain yield marker')
      skipMap(reader)
    }
  }

  reader.skip(12)
  reader.skip(8)

  readMapFloat(reader)
  readMapFloat(reader)
  readMapFloat(reader)

  reader.skip(10)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  reader.skip(4)

  skipFixedArray(reader, 10)
  skipFixedArray(reader, 4)
  reader.skip(41)

  const influenceTokensReceived = readCountedU32Array(reader)
  skipFixedArray(reader, 4)
  count = reader.readU32()
  reader.skip(count)

  skipMap(reader)
  reader.skip(16)
  skipMap(reader)
  skipMap(reader)

  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)

  reader.skip(20)

  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)

  reader.skip(12)
  skipMap(reader)

  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)
  reader.skip(16)

  count = reader.readU32()
  if (count > 128) throw new Error(`players: invalid governor count ${count}`)
  const governors: CivReplayGovernorSnapshot[] = []
  for (let index = 0; index < count; index += 1) governors.push(parseGovernor(reader, index))

  reader.skip(4)
  skipArray(reader, { separatorBytes: 0 })
  reader.skip(8)
  reader.skip(4)
  reader.skip(1)
  reader.skip(8)
  reader.skip(64)
  reader.skip(4)
  reader.skip(4)

  count = reader.readU32()
  if (count !== 64) throw new Error(`players: expected governor player count 64, got ${count}`)
  reader.skip(count * 4)
  count = reader.readU32()
  if (count !== 64) throw new Error(`players: expected governor player count 64, got ${count}`)
  reader.skip(count * 4)
  reader.skip(8)

  skipArray(reader)
  skipArray(reader)
  skipArray(reader)
  reader.skip(24)

  skipFixedArray(reader, 20)
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)

  reader.skip(2)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    const type = reader.readU32()
    expectU32(reader, 0x03, 'emergency/competition marker')
    if (type === 0) reader.skip(61)
    else if (type === 1) reader.skip(48)
    else if (type === 2 || type === 3 || type === 4) reader.skip(44)
    else throw new Error(`players: invalid emergency/competition type ${type}`)
  }

  expectU32(reader, 0x02, 'post-tech tile visibility marker')
  const tileCount = reader.readU32()
  reader.skip(tileCount * 2)
  expectU32(reader, tileCount, 'post-tech tile visibility echo')
  reader.skip(tileCount * 2)

  reader.skip(24)
  reader.skip(4)

  const cityYieldCount = reader.readU32()
  if (cityYieldCount > cities.length) throw new Error(`players: city yield count ${cityYieldCount} exceeds parsed city count ${cities.length}`)
  for (let index = 0; index < cityYieldCount; index += 1) parseCityYield(reader, cities[index]!)

  const postYield = parsePostYieldProgressionTail(reader, civics, techs)
  return { units, governors, improvements: postYield.improvements, influenceTokensReceived, maintenance: postYield.maintenance }
}

function skipCityTail(reader: CivReplayStateReader) {
  let count = reader.readU32()
  reader.skip(count * 12)
  count = reader.readU32()
  reader.skip(count * 12)
  count = reader.readU32()
  reader.skip(count * 12)
  count = reader.readU32()
  reader.skip(count * 8)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(4)
    const nested = reader.readU32()
    reader.skip(nested * 12)
  }
  count = reader.readU32()
  reader.skip(count * 12)
  count = reader.readU32()
  reader.skip(count * 16)
  count = reader.readU32()
  reader.skip(count * 4)
  reader.skip(4)
  reader.skip(37)

  count = reader.readU32()
  if (count !== 64) throw new Error(`players: expected city global count 64, got ${count}`)
  reader.skip(count)
  reader.skip(4)

  for (let index = 0; index < 14; index += 1) {
    expectMapCount(reader, 0x06, 'city tail map marker')
    skipMap(reader)
  }

  reader.skip(4)
  reader.skip(1)
  reader.skip(4)
  reader.skip(3)

  count = reader.readU32()
  reader.skip(count * 13)
  reader.skip(12)
  reader.skip(49)
  reader.skip(12)
  reader.skip(4)

  count = reader.readU32()
  reader.skip(count * 24)
  count = reader.readU32()
  reader.skip(count * 20)
  count = reader.readU32()
  reader.skip(count * 16)
  count = reader.readU32()
  reader.skip(count * 32)
  reader.skip(4)

  count = reader.readCount(3)
  reader.skip(1)
  for (let index = 0; index < count; index += 1) {
    reader.skip(8)
    const nameLength = reader.readU16()
    reader.skip(nameLength)
    reader.skip(12)
    const nestedCount = reader.readCount(3)
    reader.skip(1)
    for (let nested = 0; nested < nestedCount; nested += 1) {
      const nestedLength = reader.readU32()
      reader.skip(nestedLength * 22)
    }
  }

  reader.skip(8)
  count = reader.readU32()
  reader.skip(count * 4)
  skipArray(reader, { separatorBytes: 0 })
  skipMap(reader)
}

function skipToNextPlayerHeader(reader: CivReplayStateReader) {
  let from = reader.offset
  const candidates: string[] = []
  while (from < reader.length) {
    const sentinel = reader.indexOf(END_IA_STUFF, from)
    if (sentinel < 0) break
    const candidate = tryFinishPlayerAtSentinel(reader, sentinel)
    if (candidate != null) {
      candidates.push(formatHeaderCandidate(reader, sentinel, candidate))
    }
    if (candidate != null && isPlayerHeader(reader, candidate)) {
      reader.offset = candidate
      return
    }
    from = sentinel + 1
  }

  throw new Error(`players: could not find next player header from offset ${reader.offset}; candidates ${candidates.slice(0, 6).join('; ')}`)
}

function isPlayerHeader(reader: CivReplayStateReader, offset: number): boolean {
  if (offset + 12 > reader.length) return false
  const playerId = reader.peekU32(offset)
  return playerId <= 0x3F && reader.peekU32(offset + 4) === 47 && reader.peekU32(offset + 8) === playerId
}

function formatHeaderCandidate(reader: CivReplayStateReader, sentinel: number, offset: number): string {
  if (offset + 12 > reader.length) return `sentinel ${sentinel} -> ${offset}: eof`
  return `sentinel ${sentinel} -> ${offset}: ${reader.peekU32(offset)},${reader.peekU32(offset + 4)},${reader.peekU32(offset + 8)}`
}

function tryFinishPlayerAtSentinel(source: CivReplayStateReader, sentinel: number): number | null {
  const reader = new CivReplayStateReaderSnapshot(source, 'players:sentinel')
  try {
    reader.offset = sentinel - 4
    skipMap(reader)
    let count = reader.readU32()
    reader.skip(count * 13)
    count = reader.readU32()
    reader.skip(count * 16)
    count = reader.readCount(3)
    reader.skip(1)
    if (count !== 0) {
      const endPlayer = reader.indexOf(END_PLAYER_STUFF)
      if (endPlayer < 0) return null
      reader.offset = endPlayer - 4
    }
    skipMap(reader)
    count = reader.readU32()
    reader.skip(count * 4)
    skipArray(reader, { separatorBytes: 0 })
    skipArray(reader, { separatorBytes: 0 })
    skipArray(reader, { separatorBytes: 0 })
    return reader.offset
  }
  catch {
    return null
  }
}

class CivReplayStateReaderSnapshot extends CivReplayStateReader {
  constructor(source: CivReplayStateReader, section: string) {
    super(source.sourceBytes, section)
  }
}

function skipReligion(reader: CivReplayStateReader) {
  expectU32(reader, 7, 'religion marker')
  reader.skip(8)
  reader.skip(12)
  reader.readString()
  let count = reader.readU32()
  reader.skip(count * 4)
  count = reader.readU32()
  reader.skip(count * 4)
  count = reader.readU32()
  reader.skip(count * 4)
  reader.skip(11)
}

function skipUnitPosition(reader: CivReplayStateReader) {
  reader.skip(3 * 4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(8)
  reader.skip(12)
  let count = reader.readU32()
  reader.skip(8)
  reader.skip(count * 20)
  count = reader.readU32()
  reader.skip(count * 4)
}

function parseDistrict(reader: CivReplayStateReader): CivReplayDistrictSnapshot {
  const globalId = reader.readU32()
  expectU32(reader, 0x0F, 'district marker')
  const id = reader.readU16()
  reader.skip(2)
  const x = reader.readU32()
  const y = reader.readU32()
  const cityId = reader.readU16()
  reader.skip(2)
  const type = reader.readU32()
  const damage = reader.readU32()
  const wallDamage = reader.readU32()
  reader.skip(4)
  const wall = reader.readU32()
  const cost = reader.readU32()
  const built = reader.readU32()
  reader.skip(1)
  for (let index = 0; index < 3; index += 1) {
    expectMapCount(reader, 0x06, 'district map marker')
    skipMap(reader)
  }
  reader.skip(12)
  expectMapCount(reader, 0x06, 'district map marker')
  skipMap(reader)
  expectMapCount(reader, 0x06, 'district map marker')
  skipMap(reader)
  reader.skip(4)
  skipFixedArray(reader, 16)
  skipMap(reader)
  reader.skip(17)
  const pillage = reader.readU8()
  return { globalId, id, x, y, cityId, type, damage, wallDamage, wall, cost, built, pillage }
}

function parseUnit(reader: CivReplayStateReader): CivReplayUnitSnapshot {
  const id = reader.readU32()
  reader.skip(4)
  reader.skip(4)
  const type = reader.readU32()
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  const x = reader.readU32()
  const y = reader.readU32()
  reader.skip(17)
  const army = reader.readU32()
  reader.skip(8)
  const damage = reader.readU32()
  reader.skip(58)
  const fortified = reader.readU32()
  reader.skip(11)
  reader.skip(199)
  for (let index = 0; index < 4; index += 1) reader.skip(4)
  reader.skip(4)
  reader.skip(1)

  skipFixedArray(reader, 8)
  skipMap(reader)
  skipArray(reader)
  skipArray(reader)
  skipArray(reader)
  skipMap(reader)
  skipMap(reader)

  skipFixedArray(reader, 5)
  skipFixedArray(reader, 5)

  reader.skip(6)
  const xp = reader.readU32()
  const level = reader.readU32()
  reader.skip(12)
  skipArray(reader)
  const name = reader.readString()
  reader.skip(77)

  skipFixedArray(reader, 12)
  reader.skip(54)

  expectMapCount(reader, 0x06, 'unit map marker')
  skipMap(reader)
  skipFixedArray(reader, 4)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  reader.skip(66)
  skipFixedArray(reader, 13)
  skipFixedArray(reader, 12)
  reader.skip(70)

  const operationCount = reader.readU32()
  const operationTypes: number[] = []
  const tradeRouteOperations: CivReplayUnitTradeRouteOperationSnapshot[] = []
  for (let index = 0; index < operationCount; index += 1) {
    const operation = reader.peekU32()
    operationTypes.push(operation)
    if (operation === UNITOPERATION_MAKE_TRADE_ROUTE) tradeRouteOperations.push(readUnitTradeRouteOperation(reader))
    else reader.skip(unitOperationSize(operation))
  }

  skipArray(reader)
  reader.skip(16)

  const count = reader.readCount(3)
  reader.skip(1)
  for (let index = 0; index < count; index += 1) {
    const nestedCount = reader.readU32()
    for (let nested = 0; nested < nestedCount; nested += 1) {
      reader.skip(4)
      reader.readString(2)
      reader.skip(16)
    }
  }
  return { id, type, x, y, army, damage, fortified, xp, level, name, operationTypes, tradeRouteOperations }
}

function readUnitTradeRouteOperation(reader: CivReplayStateReader): CivReplayUnitTradeRouteOperationSnapshot {
  expectU32(reader, UNITOPERATION_MAKE_TRADE_ROUTE, 'trade route unit operation')
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  const destinationX = reader.readU32()
  const destinationY = reader.readU32()
  const originX = reader.readU32()
  const originY = reader.readU32()
  reader.skip(4)
  return { destinationX, destinationY, originX, originY }
}

function parseGovernor(reader: CivReplayStateReader, expectedIndex: number): CivReplayGovernorSnapshot {
  const id = reader.readU32()
  if (id !== expectedIndex) throw new Error(`players: expected governor id ${expectedIndex}, got ${id}`)
  reader.skip(4)
  reader.skip(4)
  const type = reader.readU32()
  reader.readString()
  const player = reader.readU16()
  const marker = reader.readU16()
  if (marker !== 2) throw new Error(`players: expected governor marker 2, got ${marker}`)
  const city = reader.readU16()
  reader.skip(2)
  reader.skip(62)
  reader.skip(4)
  reader.skip(4)
  let count = reader.readU32()
  const turns: number[] = []
  for (let index = 0; index < count; index += 1) {
    reader.skip(4)
    reader.skip(4)
    turns.push(reader.readU32())
  }
  const promotions = readMap(reader, 1)
  reader.skip(4)
  reader.skip(1)
  return { id, type, player, city, turns, promotions: mapToHashValues(promotions).filter(promotion => promotion.value === 1) }
}

function parseCityYield(reader: CivReplayStateReader, city: CivReplayCitySnapshot) {
  const cityId = reader.readU32()
  if (cityId !== city.id) throw new Error(`players: expected city yield id ${city.id}, got ${cityId}`)
  expectU32(reader, 0x11, 'city yield marker')
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)

  expectMapCount(reader, 0x06, 'city yield map marker')
  const yields = readMapFloat(reader)
  expectMapCount(reader, 0x06, 'city yield2 map marker')
  const yields2 = readMapFloat(reader)
  city.yields = mapToHashFloatValues(yields)
  city.yields2 = mapToHashFloatValues(yields2)

  skipMap(reader)
  reader.skip(8)
  reader.skip(9)

  skipFixedArray(reader, 16)
  skipFixedArray(reader, 4)

  reader.skip(12)
  skipFixedArray(reader, 12)
  reader.skip(1)
  reader.skip(16)

  skipFixedArray(reader, 4)

  let count = reader.readU32()
  reader.skip(4)
  reader.skip(count * 8)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x04, 'city yield nested marker')
    reader.skip(4)
    expectU32(reader, 0x64, 'city yield nested marker')
    reader.skip(35)
    const nestedCount = reader.readU32()
    if (nestedCount !== 0x40) throw new Error(`players: expected city yield nested count 64, got ${nestedCount}`)
    reader.skip(nestedCount * 4)
    reader.skip(12)
  }

  reader.skip(20)
  skipFixedArray(reader, 17)
  skipFixedArray(reader, 8)
  reader.skip(12)
  reader.skip(16)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x01, 'city yield tail marker')
    reader.skip(4)
    reader.skip(61)
  }

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    skipMap(reader)
    skipMap(reader)
    skipMap(reader)
  }

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  reader.skip(8)
  skipMap(reader)
}

function parsePostYieldProgressionTail(reader: CivReplayStateReader, civics: CivReplayProgressionSnapshot, techs: CivReplayProgressionSnapshot): { improvements: CivReplayImprovementSnapshot[], maintenance: number | null } {
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)

  reader.skip(4)
  reader.skip(4)
  skipFixedArray(reader, 12)

  reader.skip(8)
  expectU32(reader, 0x03, 'post-yield progression marker')

  skipFixedArray(reader, 8)
  reader.skip(1)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  civics.turnTo = readCivicTurnTo(reader)

  skipFixedArray(reader, 34)
  skipFixedArray(reader, 32)
  skipMap(reader)

  const improvementCount = reader.readU32()
  if (improvementCount > 20000) throw new Error(`players: invalid improvement count ${improvementCount}`)
  const improvements: CivReplayImprovementSnapshot[] = []
  for (let index = 0; index < improvementCount; index += 1) improvements.push(parseImprovement(reader))

  reader.skip(8)
  skipFixedArray(reader, 8)
  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(1)
  reader.skip(4)
  reader.skip(1844)

  const diplomaticPlayerCount = reader.readU32()
  if (diplomaticPlayerCount !== 64) throw new Error(`players: expected diplomatic state count 64, got ${diplomaticPlayerCount}`)
  for (let playerIndex = 0; playerIndex < diplomaticPlayerCount; playerIndex += 1) {
    reader.skip(8)
    expectU32(reader, playerIndex, 'diplomatic state player index')
    reader.readString()
    reader.skip(7)
    reader.skip(4)

    skipFixedArray(reader, 4)
    skipFixedArray(reader, 4)
    skipFixedArray(reader, 4)

    let count = reader.readU32()
    for (let index = 0; index < count; index += 1) {
      reader.skip(20)
      reader.readString()
      reader.skip(41)
      skipFixedArray(reader, 4)
      skipFixedArray(reader, 4)
      skipFixedArray(reader, 4)
    }

    count = reader.readU32()
    for (let index = 0; index < count; index += 1) {
      reader.skip(4)
      reader.readString()
      reader.skip(8)
    }
  }

  reader.skip(5)
  let count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x05, 'diplomatic state marker')
    const value = reader.peekU32()
    if (value === 0xFFFFFFFF) reader.skip(21)
    else {
      reader.skip(8)
      skipMap(reader)
      skipMap(reader)
      reader.skip(13)
    }
  }

  reader.skip(593)
  skipFixedArray(reader, 12)
  reader.skip(4)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) skipMap(reader)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) skipMap(reader)
  count = reader.readU32()
  for (let index = 0; index < count; index += 1) skipArray(reader)

  skipFixedArray(reader, 24)

  reader.skip(8)
  reader.skip(1)
  reader.skip(4)
  reader.skip(4)
  reader.skip(1)
  reader.skip(19)
  const maintenance = readFixedPoint(reader)
  reader.skip(4)
  reader.skip(4)
  skipFixedArray(reader, 8)
  reader.skip(4)

  skipMap(reader)
  skipFixedArray(reader, 12)

  reader.skip(12)
  reader.skip(8)
  reader.skip(8)
  reader.skip(1)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(4)
    reader.skip(8)
    reader.skip(4)
    let nestedCount = reader.readU32()
    reader.skip(nestedCount * 8)
    nestedCount = reader.readU32()
    reader.skip(nestedCount * 4)
  }

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    const test = reader.readU32()
    reader.skip(8)
    const test2 = reader.readU32()
    if (test !== test2) throw new Error(`players: governor info key mismatch ${test} != ${test2}`)
    const nestedCount = reader.readU32()
    reader.skip(nestedCount * 4)
    reader.skip(4)
  }

  count = reader.readU32()
  reader.skip(count)
  reader.skip(8)

  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)

  const scenarioCount = reader.readCount(3)
  for (let index = 0; index < scenarioCount; index += 1) {
    reader.skip(13)
    skipFixedArray(reader, 16)
    expectU32(reader, 0x05, 'scenario marker')
    reader.skip(35)
    skipMap(reader)
    skipMap(reader)
    skipMap(reader)
    skipMap(reader)
    skipMap(reader)
    skipMap(reader)
  }

  reader.skip(12)
  for (let index = 0; index < 4; index += 1) skipArray(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  reader.skip(8)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x04, 'unit info marker')
    reader.skip(4)
    reader.skip(4)
    reader.skip(7)
    reader.skip(4)
    reader.skip(4)
    reader.skip(4)
    reader.skip(4)
    reader.skip(4)
    reader.skip(280)
  }

  reader.skip(1)
  skipMap(reader)
  reader.skip(168)

  skipFixedArray(reader, 12)
  reader.skip(21)
  skipFixedArray(reader, 4)
  reader.skip(21)

  count = reader.readU32()
  reader.skip(count)
  count = reader.readU32()
  reader.skip(count)

  skipMap(reader)
  skipMap(reader)
  skipMap(reader)

  reader.skip(4)
  reader.skip(4)
  reader.skip(4)

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) skipOperationTree(reader)

  reader.skip(4)
  skipFixedArray(reader, 4)
  reader.skip(8)
  skipFixedArray(reader, 4)

  skipMap(reader)
  skipMap(reader)

  skipFixedArray(reader, 28)
  skipFixedArray(reader, 4)
  skipFixedArray(reader, 4)
  count = reader.readU32()
  reader.skip(count * 2)

  skipMap(reader)
  skipMap(reader, 1)

  techs.turnTo = readTechTurnTo(reader)
  reader.skip(1)

  return { improvements, maintenance }
}

function parseImprovement(reader: CivReplayStateReader): CivReplayImprovementSnapshot {
  reader.skip(4)
  reader.skip(4)
  reader.skip(4)
  const x = reader.readU32()
  const y = reader.readU32()
  const district = reader.readU32()
  const type = reader.readU32()
  reader.skip(1)
  return { x, y, district, type }
}

function readCivicTurnTo(reader: CivReplayStateReader): CivReplayHashValue[] {
  const count = reader.readU32()
  const turnTo = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const key = reader.readU32()
    expectU32(reader, 0x02, 'civic turnTo marker')
    reader.skip(4)
    expectU32(reader, key, 'civic turnTo key echo')
    reader.skip(4)
    reader.skip(4)
    reader.skip(8)
    turnTo.set(key, reader.readU32())
  }
  return mapToHashValues(turnTo)
}

function readTechTurnTo(reader: CivReplayStateReader): CivReplayHashValue[] {
  const count = reader.readU32()
  const turnTo = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const key = reader.readU32()
    expectU32(reader, 0x03, 'tech turnTo marker')
    expectU32(reader, key, 'tech turnTo key echo')
    reader.skip(4)
    reader.skip(4)
    turnTo.set(key, reader.readU32())
    reader.skip(8)
    reader.skip(4)
  }
  return mapToHashValues(turnTo)
}

function skipOperationTree(reader: CivReplayStateReader) {
  reader.skip(16)
  reader.readString()
  reader.skip(17)
  reader.readString()
  reader.skip(4)
  let count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    expectU32(reader, 0x02, 'operation tree marker')
    reader.skip(21)
    const nestedCount = reader.readU32()
    for (let nested = 0; nested < nestedCount; nested += 1) {
      expectU32(reader, 0x02, 'operation tree nested marker')
      reader.skip(25)
    }
  }

  reader.skip(20)
  reader.skip(11)
  reader.readString()
  reader.skip(4)
  reader.readString()

  count = reader.readU32()
  for (let index = 0; index < count; index += 1) {
    reader.skip(11)
    skipFixedArray(reader, 4)
    skipFixedArray(reader, 4)
    let nestedCount = reader.readU32()
    for (let nested = 0; nested < nestedCount; nested += 1) {
      const itemCount = reader.readU32()
      reader.skip(itemCount * 4)
    }
    skipFixedArray(reader, 8)
    skipFixedArray(reader, 4)
    reader.skip(1)
    nestedCount = reader.readU32()
    reader.skip(nestedCount * 8)
    reader.skip(8)
  }

  for (let index = 0; index < 3; index += 1) reader.skip(16)
  reader.skip(8)
  for (let index = 0; index < 3; index += 1) reader.skip(16)
  reader.skip(8)
}

function unitOperationSize(operation: number): number {
  switch (operation) {
    case 0x580F2F68:
    case 0xB2CCA377:
    case 0x9C0B44C6:
    case 0x09D0292A:
    case 0x886FFCD1:
    case 0x7FA205D1:
    case 0xCFB9B561:
    case 0xC8CE5DFB:
    case 0x1F633B1E:
    case 0x852CE4DF:
      return 44
    case 0x8374D954:
      return 56
    case 0x98ECA9EA:
      return 48
    case 0x1D60E778:
    case 0x4885D724:
    case 0x08CA367F:
    case 0x06E68AEF:
      return 40
    default:
      return 32
  }
}

function readProgressionSnapshot(reader: CivReplayStateReader): CivReplayProgressionSnapshot {
  return {
    found: mapToHashBoolValues(readMapBool(reader)),
    boost: mapToHashBoolValues(readMapBool(reader)),
    research: mapToHashFloatValues(readMapFloat(reader)),
    current: readArrayValues(reader, { separatorBytes: 0 }),
    turnTo: [],
  }
}

function skipFixedArray(reader: CivReplayStateReader, itemSize: number) {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid fixed array count ${count} at offset ${reader.offset - 4}`)
  reader.skip(count * itemSize)
}

function readCountedU32Array(reader: CivReplayStateReader): number[] {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid u32 array count ${count} at offset ${reader.offset - 4}`)
  const values: number[] = []
  for (let index = 0; index < count; index += 1) values.push(reader.readU32())
  return values
}

function readMap(reader: CivReplayStateReader, valueSize = 4): Map<number, number> {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid map count ${count} at offset ${reader.offset - 4}`)
  const map = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const key = reader.readU32()
    map.set(key, reader.readCount(valueSize as 1 | 2 | 3 | 4))
  }
  return map
}

function readMapBool(reader: CivReplayStateReader): Map<number, boolean> {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid bool map count ${count} at offset ${reader.offset - 4}`)
  const map = new Map<number, boolean>()
  for (let index = 0; index < count; index += 1) {
    const key = reader.readU32()
    map.set(key, reader.readU8() !== 0)
  }
  return map
}

function readMapFloat(reader: CivReplayStateReader): Map<number, number> {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid float map count ${count} at offset ${reader.offset - 4}`)
  const map = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const key = reader.readU32()
    map.set(key, readFixedPoint(reader))
  }
  return map
}

function readFixedPoint(reader: CivReplayStateReader): number {
  const value = reader.readU32()
  return Math.floor(value / 256) + (value & 0xFF) / 256
}

function skipMap(reader: CivReplayStateReader, valueSize = 4) {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`players: invalid map count ${count} at offset ${reader.offset - 4}`)
  reader.skip(count * (4 + valueSize))
}

function skipArray(reader: CivReplayStateReader, options: { valueSize?: number, separatorBytes?: number, countSize?: 1 | 2 | 3 | 4 } = {}) {
  const valueSize = options.valueSize ?? 4
  const separatorBytes = options.separatorBytes ?? 1
  const count = reader.readCount(options.countSize ?? 4)
  if (count > 200000) throw new Error(`players: invalid array count ${count} at offset ${reader.offset - (options.countSize ?? 4)}`)
  for (let index = 0; index < count; index += 1) {
    const value = reader.readCount(valueSize as 1 | 2 | 3 | 4)
    if (value !== 0) reader.skip(separatorBytes)
  }
}

function readArrayValues(reader: CivReplayStateReader, options: { valueSize?: number, separatorBytes?: number, countSize?: 1 | 2 | 3 | 4 } = {}): number[] {
  const valueSize = options.valueSize ?? 4
  const separatorBytes = options.separatorBytes ?? 1
  const count = reader.readCount(options.countSize ?? 4)
  if (count > 200000) throw new Error(`players: invalid array count ${count} at offset ${reader.offset - (options.countSize ?? 4)}`)
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const value = reader.readCount(valueSize as 1 | 2 | 3 | 4)
    values.push(value)
    if (value !== 0) reader.skip(separatorBytes)
  }
  return values
}

function mergeMapInto(source: Map<number, number>, target: Map<number, number>) {
  for (const [key, value] of source) target.set(key, value)
}

function mapToHashValues(map: Map<number, number>): CivReplayHashValue[] {
  return [...map]
    .map(([hash, value]) => ({ hash, value }))
    .sort((left, right) => left.hash - right.hash)
}

function mapToHashBoolValues(map: Map<number, boolean>): CivReplayHashBoolValue[] {
  return [...map]
    .map(([hash, value]) => ({ hash, value }))
    .sort((left, right) => left.hash - right.hash)
}

function mapToHashFloatValues(map: Map<number, number>): CivReplayHashFloatValue[] {
  return [...map]
    .map(([hash, value]) => ({ hash, value }))
    .sort((left, right) => left.hash - right.hash)
}

function expectU32(reader: CivReplayStateReader, expected: number, label: string) {
  const actual = reader.readU32()
  if (actual !== expected) throw new Error(`players: expected ${label} 0x${expected.toString(16)}, got 0x${actual.toString(16)}`)
}

function expectMapCount(reader: CivReplayStateReader, expected: number, label: string) {
  const actual = reader.peekU32()
  if (actual !== expected) throw new Error(`players: expected ${label} count 0x${expected.toString(16)}, got 0x${actual.toString(16)}`)
}
