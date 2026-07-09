import { parseCivReplaySavePackets } from './packet.ts'
import { parseCivReplayMap, type CivReplayMapSnapshot } from './map.ts'
import { parseCivReplayPlayers, type CivReplayPlayersSnapshot } from './players.ts'
import { attachCivReplaySnapshotEvents, type CivReplaySnapshotEvent } from './events.ts'
import { buildCivReplayCityStateRoster, createCityStateResolver, type CivReplayCityStateResolver, type CivReplayCityStateRoster } from './city-states.ts'
import { parseCiv6SaveMetadata } from '@civup/civ6-save-metadata'
import { extractSaveFilesFromSourceBytes } from '../save-source.ts'

export interface AnalyzeCivReplaySnapshotsOptions {
  limit?: number | null
  turn?: number | null
  failFast?: boolean
  cityStateResolver?: CivReplayCityStateResolver | null
}

export interface CivReplaySnapshotTimeline {
  tool: 'civup-analyzer'
  schemaVersion: 1
  source: string
  sourceKind: 'autosave-zip' | 'save'
  generatedAt: string
  snapshots: CivReplayTurnSnapshot[]
  failures: CivReplaySnapshotFailure[]
  summary: CivReplaySnapshotSummary
}

export interface CivReplayTurnSnapshot {
  index: number
  saveName: string
  turnFromName: number | null
  compressedSizeBytes: number | null
  uncompressedSizeBytes: number
  packetArrayCount: number
  compressedBlobCount: number
  stateBlobOffset: number
  stateBlobSourceLengthBytes: number
  stateBlobDeflatedSizeBytes: number
  stateBlobInflatedSizeBytes: number
  gameRandomSeed: number | null
  mapRandomSeed: number | null
  map: CivReplayMapSnapshot
  players: CivReplayPlayersSnapshot
  cityStates: CivReplayCityStateRoster
  events: CivReplaySnapshotEvent[]
  timestamp: string | null
}

export interface CivReplaySnapshotFailure {
  index: number
  saveName: string
  turnFromName: number | null
  error: string
}

export interface CivReplaySnapshotSummary {
  saveCount: number
  parsedCount: number
  failureCount: number
  firstTurn: number | null
  lastTurn: number | null
  minStateBlobBytes: number | null
  maxStateBlobBytes: number | null
  mapWidths: number[]
  mapHeights: number[]
  tileCounts: number[]
  internalPlayerCounts: number[]
  cityCounts: number[]
  cityStateCounts: number[]
  cityStateAliveCounts: number[]
  cityStateScientificCounts: number[]
  cityStateScientificAliveCounts: number[]
  gameRandomSeeds: number[]
  mapRandomSeeds: number[]
}

export function analyzeCivReplaySnapshotsBytes(source: string, bytes: Uint8Array, options: AnalyzeCivReplaySnapshotsOptions = {}): CivReplaySnapshotTimeline {
  const files = extractSaveFilesFromSourceBytes(source, bytes, { limit: options.limit })
    .filter(file => options.turn == null || file.turnFromName === options.turn)
  const cityStateResolver = options.cityStateResolver ?? createCityStateResolver({ loadDefaultTypesDb: false })
  const snapshots: CivReplayTurnSnapshot[] = []
  const failures: CivReplaySnapshotFailure[] = []

  for (const file of files) {
    try {
      const parsed = parseCivReplaySavePackets(file.bytes)
      const map = parseCivReplayMap(parsed.stateBlob.bytes)
      const players = parseCivReplayPlayers(parsed.stateBlob.bytes)
      const cityStates = buildCivReplayCityStateRoster(players.players, cityStateResolver, {
        majorPlayerIds: readMajorPlayerIds(file.bytes),
      })
      snapshots.push({
        index: file.index,
        saveName: file.saveName,
        turnFromName: file.turnFromName,
        compressedSizeBytes: file.compressedSizeBytes,
        uncompressedSizeBytes: file.uncompressedSizeBytes,
        packetArrayCount: parsed.packetArrayCount,
        compressedBlobCount: parsed.compressedBlobs.length,
        stateBlobOffset: parsed.stateBlob.sourceOffset,
        stateBlobSourceLengthBytes: parsed.stateBlob.sourceLength,
        stateBlobDeflatedSizeBytes: parsed.stateBlob.deflatedSizeBytes,
        stateBlobInflatedSizeBytes: parsed.stateBlob.inflatedSizeBytes,
        gameRandomSeed: parsed.gameRandomSeed,
        mapRandomSeed: parsed.mapRandomSeed,
        map,
        players,
        cityStates,
        events: [],
        timestamp: parsed.timestamp,
      })
    }
    catch (error) {
      const failure = {
        index: file.index,
        saveName: file.saveName,
        turnFromName: file.turnFromName,
        error: error instanceof Error ? error.message : 'Unknown CivReplay snapshot parse error',
      }
      if (options.failFast) throw new Error(`${failure.saveName}: ${failure.error}`)
      failures.push(failure)
    }
  }

  attachCivReplaySnapshotEvents(snapshots)

  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    source,
    sourceKind: /\.Civ6Save$/i.test(source) ? 'save' : 'autosave-zip',
    generatedAt: new Date().toISOString(),
    snapshots,
    failures,
    summary: buildSummary(files.length, snapshots, failures),
  }
}

function buildSummary(saveCount: number, snapshots: readonly CivReplayTurnSnapshot[], failures: readonly CivReplaySnapshotFailure[]): CivReplaySnapshotSummary {
  const turns = snapshots.map(snapshot => snapshot.turnFromName).filter((turn): turn is number => turn != null)
  const sizes = snapshots.map(snapshot => snapshot.stateBlobInflatedSizeBytes)
  const mapWidths = uniqueSorted(snapshots.map(snapshot => snapshot.map.width))
  const mapHeights = uniqueSorted(snapshots.map(snapshot => snapshot.map.height).filter((height): height is number => height != null))
  const tileCounts = uniqueSorted(snapshots.map(snapshot => snapshot.map.tileCount))
  const internalPlayerCounts = uniqueSorted(snapshots.map(snapshot => snapshot.players.internalPlayerCount))
  const cityCounts = uniqueSorted(snapshots.map(snapshot => snapshot.players.cityCount))
  const cityStateCounts = uniqueSorted(snapshots.map(snapshot => snapshot.cityStates.count))
  const cityStateAliveCounts = uniqueSorted(snapshots.map(snapshot => snapshot.cityStates.aliveCount))
  const cityStateScientificCounts = uniqueSorted(snapshots.map(snapshot => snapshot.cityStates.scientificCount))
  const cityStateScientificAliveCounts = uniqueSorted(snapshots.map(snapshot => snapshot.cityStates.scientificAliveCount))
  const gameRandomSeeds = uniqueSorted(snapshots.map(snapshot => snapshot.gameRandomSeed).filter((seed): seed is number => seed != null))
  const mapRandomSeeds = uniqueSorted(snapshots.map(snapshot => snapshot.mapRandomSeed).filter((seed): seed is number => seed != null))
  return {
    saveCount,
    parsedCount: snapshots.length,
    failureCount: failures.length,
    firstTurn: turns.length ? Math.min(...turns) : null,
    lastTurn: turns.length ? Math.max(...turns) : null,
    minStateBlobBytes: sizes.length ? Math.min(...sizes) : null,
    maxStateBlobBytes: sizes.length ? Math.max(...sizes) : null,
    mapWidths,
    mapHeights,
    tileCounts,
    internalPlayerCounts,
    cityCounts,
    cityStateCounts,
    cityStateAliveCounts,
    cityStateScientificCounts,
    cityStateScientificAliveCounts,
    gameRandomSeeds,
    mapRandomSeeds,
  }
}

function readMajorPlayerIds(bytes: Uint8Array): number[] {
  try {
    return parseCiv6SaveMetadata(bytes).players
      .map(player => player.slot)
      .filter((slot): slot is number => Number.isSafeInteger(slot) && slot >= 0)
  }
  catch {
    return []
  }
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}
