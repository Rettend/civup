import type { AnalyzeAutosaveTimelineOptions, CivupAutosaveTimeline, CivupTimelineFailure, CivupTimelinePlayerSummary, CivupTimelineSummary, CivupTurnSnapshot } from './types.ts'
import type { Civ6SaveMetadata, Civ6SavePlayerMetadata } from '@civup/civ6-save-metadata'
import { inflateRawSync } from 'node:zlib'
import { listAutosaveZipEntries, parseCiv6SaveMetadata, parseZipEntries, readZipEntryData } from '@civup/civ6-save-metadata'

export function analyzeAutosaveTimelineBytes(
  source: string,
  bytes: Uint8Array,
  options: AnalyzeAutosaveTimelineOptions = {},
): CivupAutosaveTimeline {
  const sourceKind = isCiv6SavePath(source) ? 'save' : 'autosave-zip'
  const result = sourceKind === 'save'
    ? analyzeSingleSave(source, bytes)
    : analyzeAutosaveZip(source, bytes, options)

  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    source,
    sourceKind,
    generatedAt: new Date().toISOString(),
    turns: result.turns,
    failures: result.failures,
    summary: buildTimelineSummary(result.turns, result.failures),
  }
}

function analyzeSingleSave(source: string, bytes: Uint8Array): { turns: CivupTurnSnapshot[], failures: CivupTimelineFailure[] } {
  try {
    const metadata = parseCiv6SaveMetadata(bytes)
    return {
      turns: [buildTurnSnapshot({
        index: 0,
        saveName: source,
        turnFromName: null,
        compressedSizeBytes: null,
        uncompressedSizeBytes: bytes.length,
        metadata,
      })],
      failures: [],
    }
  }
  catch (error) {
    return {
      turns: [],
      failures: [{ index: 0, saveName: source, turnFromName: null, error: errorMessage(error) }],
    }
  }
}

function analyzeAutosaveZip(
  source: string,
  bytes: Uint8Array,
  options: AnalyzeAutosaveTimelineOptions,
): { turns: CivupTurnSnapshot[], failures: CivupTimelineFailure[] } {
  const zipEntries = parseZipEntries(bytes)
  const saveEntries = listAutosaveZipEntries(zipEntries)
  const limit = normalizeLimit(options.limit)
  const selectedEntries = limit == null ? saveEntries : saveEntries.slice(0, limit)
  const turns: CivupTurnSnapshot[] = []
  const failures: CivupTimelineFailure[] = []

  for (let index = 0; index < selectedEntries.length; index += 1) {
    const entry = selectedEntries[index]!
    try {
      const saveBytes = readZipEntryData(bytes, entry, inflateRaw)
      const metadata = parseCiv6SaveMetadata(saveBytes)
      turns.push(buildTurnSnapshot({
        index,
        saveName: entry.name,
        turnFromName: entry.turn,
        compressedSizeBytes: entry.compressedSize,
        uncompressedSizeBytes: entry.uncompressedSize,
        metadata,
      }))
    }
    catch (error) {
      const failure = { index, saveName: entry.name, turnFromName: entry.turn, error: errorMessage(error) }
      failures.push(failure)
      if (options.failFast) throw new Error(`${source}: ${entry.name}: ${failure.error}`)
    }
  }

  return { turns, failures }
}

function buildTurnSnapshot(input: {
  index: number
  saveName: string
  turnFromName: number | null
  compressedSizeBytes: number | null
  uncompressedSizeBytes: number
  metadata: Civ6SaveMetadata
}): CivupTurnSnapshot {
  return {
    index: input.index,
    saveName: input.saveName,
    turnFromName: input.turnFromName,
    gameTurn: input.metadata.gameTurn,
    compressedSizeBytes: input.compressedSizeBytes,
    uncompressedSizeBytes: input.uncompressedSizeBytes,
    playerCount: input.metadata.playerCount,
    gameMode: input.metadata.gameMode,
    gameSpeed: input.metadata.gameSpeed,
    mapFile: input.metadata.mapFile,
    gameRandomSeed: input.metadata.gameRandomSeed,
    mapRandomSeed: input.metadata.mapRandomSeed,
    bbgDetected: input.metadata.bbgDetected,
    bbgTitle: input.metadata.bbgTitle,
    bbgVersion: input.metadata.bbgVersion,
    players: input.metadata.players,
    leaders: input.metadata.leaders,
    civilizations: input.metadata.civs,
    mods: input.metadata.mods,
  }
}

function buildTimelineSummary(turns: readonly CivupTurnSnapshot[], failures: readonly CivupTimelineFailure[]): CivupTimelineSummary {
  const firstTurn = turns[0]?.gameTurn ?? turns[0]?.turnFromName ?? null
  const last = turns.at(-1)
  const lastTurn = last?.gameTurn ?? last?.turnFromName ?? null
  const gameModes = uniqueStrings(turns.map(turn => turn.gameMode))
  const gameRandomSeeds = uniqueNumbers(turns.map(turn => turn.gameRandomSeed))
  const mapRandomSeeds = uniqueNumbers(turns.map(turn => turn.mapRandomSeed))
  const players = summarizePlayers(turns)

  return {
    saveCount: turns.length + failures.length,
    parsedCount: turns.length,
    failureCount: failures.length,
    firstTurn,
    lastTurn,
    gameRandomSeeds,
    mapRandomSeeds,
    gameModes,
    players,
  }
}

function summarizePlayers(turns: readonly CivupTurnSnapshot[]): CivupTimelinePlayerSummary[] {
  const summaries = new Map<string, CivupTimelinePlayerSummary>()
  for (const turn of turns) {
    const turnNumber = turn.gameTurn ?? turn.turnFromName
    for (const player of turn.players) {
      const key = playerSummaryKey(player)
      const existing = summaries.get(key)
      if (!existing) {
        summaries.set(key, {
          slot: player.slot,
          team: player.team,
          playerName: player.playerName,
          leader: player.leader,
          civilization: player.civilization,
          firstTurn: turnNumber,
          lastTurn: turnNumber,
          seenTurns: 1,
        })
        continue
      }

      existing.seenTurns += 1
      if (existing.firstTurn == null || (turnNumber != null && turnNumber < existing.firstTurn)) existing.firstTurn = turnNumber
      if (existing.lastTurn == null || (turnNumber != null && turnNumber > existing.lastTurn)) existing.lastTurn = turnNumber
    }
  }

  return [...summaries.values()].sort((left, right) => left.slot - right.slot)
}

function playerSummaryKey(player: Civ6SavePlayerMetadata): string {
  return [player.slot, player.playerName ?? '', player.leader ?? '', player.civilization ?? ''].join('\n')
}

function uniqueStrings(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.length > 0))]
}

function uniqueNumbers(values: readonly (number | null)[]): number[] {
  return [...new Set(values.filter((value): value is number => value != null))]
}

function normalizeLimit(value: number | null | undefined): number | null {
  return value != null && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isCiv6SavePath(value: string): boolean {
  return /\.Civ6Save$/i.test(value)
}

function inflateRaw(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(inflateRawSync(bytes))
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : 'Parse failed'
}
