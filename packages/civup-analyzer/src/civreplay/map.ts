import { CivReplayStateReader } from './state-reader.ts'

const MAP_BEGIN = [
  0x0A, 0, 0, 0,
  0x0B, 0, 0, 0,
  0x0C, 0, 0, 0,
  0x0D, 0, 0, 0,
  0x0E, 0, 0, 0,
  0x0F, 0, 0, 0,
  0x06, 0, 0, 0,
] as const

export interface CivReplayMapSnapshot {
  startOffset: number
  endOffset: number
  width: number
  height: number | null
  tileCount: number
  tiles: CivReplayMapTileSnapshot[]
  ownedTileCount: number
  cityTileCount: number
  districtTileCount: number
  wonderTileCount: number
  overlayTileCount: number
  pillagedTileCount: number
  roadTileCount: number
  terrainCounts: Record<string, number>
  featureCounts: Record<string, number>
  resourceCounts: Record<string, number>
  improvementCounts: Record<string, number>
}

export interface CivReplayMapTileSnapshot {
  index: number
  x: number
  y: number
  terrain: number
  feature: number
  resource: number
  resourceCount: number
  improvement: number
  road: number
  roadLevel: number
  appeal: number
  pillage: number
  found: number
  cityId: number | null
  cityToken: number | null
  ownershipToken: number | null
  districtId: number | null
  districtToken: number | null
  wonder: number | null
}

export function parseCivReplayMap(bytes: Uint8Array): CivReplayMapSnapshot {
  const reader = new CivReplayStateReader(bytes, 'map')
  const startOffset = reader.indexOf(MAP_BEGIN)
  if (startOffset < 0) throw new Error('map: MAP_BEGIN marker not found')

  reader.offset = startOffset + MAP_BEGIN.length
  const tileCount = reader.readU32()
  if (tileCount > 200000) throw new Error(`map: invalid tile count ${tileCount}`)

  const summary = createMapSummary(startOffset, tileCount)
  for (let index = 0; index < tileCount; index += 1) summary.tiles.push(parseTile(reader, summary, index))

  reader.skip(4)
  summary.width = reader.readU32()
  summary.height = summary.width > 0 && summary.tileCount % summary.width === 0
    ? summary.tileCount / summary.width
    : null
  for (const tile of summary.tiles) {
    tile.x = summary.width > 0 ? tile.index % summary.width : tile.index
    tile.y = summary.width > 0 ? Math.floor(tile.index / summary.width) : 0
  }
  summary.endOffset = reader.offset
  return summary
}

function parseTile(reader: CivReplayStateReader, summary: CivReplayMapSnapshot, index: number): CivReplayMapTileSnapshot {
  reader.readU32()
  reader.readU32()

  reader.readU32()
  const terrain = reader.readU32()
  const feature = reader.readU32()
  increment(summary.terrainCounts, terrain)
  increment(summary.featureCounts, feature)

  reader.skip(2)
  reader.readU32()
  reader.skip(1)

  const resource = reader.readU32()
  const resourceCount = reader.readU16()
  const improvement = reader.readU32()
  increment(summary.resourceCounts, resource)
  increment(summary.improvementCounts, improvement)

  reader.skip(1)
  const road = reader.readU8()
  const roadLevel = reader.readU8()
  if (road || roadLevel) summary.roadTileCount += 1

  const appeal = reader.readI16()
  reader.skip(3)
  reader.readU8()
  reader.readU8()
  reader.readU8()
  const pillage = reader.readU8()
  if (pillage) summary.pillagedTileCount += 1
  const found = reader.readU8()
  reader.skip(1)

  const overlay = reader.readU32()
  if (overlay) {
    summary.overlayTileCount += 1
    skipOverlay(reader)
  }

  let cityId: number | null = null
  let cityToken: number | null = null
  let ownershipToken: number | null = null
  let districtId: number | null = null
  let districtToken: number | null = null
  let wonder: number | null = null

  if (found & 0x40) {
    summary.ownedTileCount += 1
    const city = reader.readU16()
    const cityTokenRaw = reader.readU16()
    const ownershipTokenRaw = reader.readU32()
    const district = reader.readU16()
    const districtTokenRaw = reader.readU16()
    reader.readU8()
    const wonderRaw = reader.readU32()

    cityId = city !== 0xFFFF ? city : null
    cityToken = cityTokenRaw !== 0xFFFF ? cityTokenRaw : null
    ownershipToken = ownershipTokenRaw !== 0xFFFFFFFF ? ownershipTokenRaw : null
    districtId = district !== 0xFFFF ? district : null
    districtToken = districtTokenRaw !== 0xFFFF ? districtTokenRaw : null
    wonder = wonderRaw !== 0xFFFFFFFF ? wonderRaw : null

    if (city !== 0xFFFF) summary.cityTileCount += 1
    if (district !== 0xFFFF) summary.districtTileCount += 1
    if (wonderRaw !== 0xFFFFFFFF) summary.wonderTileCount += 1
  }

  return {
    index,
    x: 0,
    y: 0,
    terrain,
    feature,
    resource,
    resourceCount,
    improvement,
    road,
    roadLevel,
    appeal,
    pillage,
    found,
    cityId,
    cityToken,
    ownershipToken,
    districtId,
    districtToken,
    wonder,
  }
}

function skipOverlay(reader: CivReplayStateReader) {
  const count = reader.readU32()
  if (count > 200000) throw new Error(`map overlay: invalid overlay count ${count}`)

  for (let index = 0; index < count; index += 1) {
    reader.skip(11)
    const value = reader.readU32()
    reader.skip(1)
    const nestedCount = reader.readU32()
    if (nestedCount > 200000) throw new Error(`map overlay: invalid nested overlay count ${nestedCount}`)
    if (value) reader.skip(nestedCount * 20)
  }
}

function createMapSummary(startOffset: number, tileCount: number): CivReplayMapSnapshot {
  return {
    startOffset,
    endOffset: startOffset,
    width: 0,
    height: null,
    tileCount,
    tiles: [],
    ownedTileCount: 0,
    cityTileCount: 0,
    districtTileCount: 0,
    wonderTileCount: 0,
    overlayTileCount: 0,
    pillagedTileCount: 0,
    roadTileCount: 0,
    terrainCounts: {},
    featureCounts: {},
    resourceCounts: {},
    improvementCounts: {},
  }
}

function increment(counts: Record<string, number>, value: number) {
  const key = toHexKey(value)
  counts[key] = (counts[key] ?? 0) + 1
}

function toHexKey(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`
}
