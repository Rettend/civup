import type { Civ6SaveModMetadata, Civ6SavePlayerMetadata } from '@civup/civ6-save-metadata'

export type CivupAnalyzerSourceKind = 'autosave-zip' | 'save'

export interface CivupTurnSnapshot {
  index: number
  saveName: string
  turnFromName: number | null
  gameTurn: number | null
  compressedSizeBytes: number | null
  uncompressedSizeBytes: number
  playerCount: number | null
  gameMode: string | null
  gameSpeed: string | null
  mapFile: string | null
  gameRandomSeed: number | null
  mapRandomSeed: number | null
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
  players: Civ6SavePlayerMetadata[]
  leaders: string[]
  civilizations: string[]
  mods: Civ6SaveModMetadata[]
}

export interface CivupTimelineFailure {
  index: number
  saveName: string
  turnFromName: number | null
  error: string
}

export interface CivupTimelineSummary {
  saveCount: number
  parsedCount: number
  failureCount: number
  firstTurn: number | null
  lastTurn: number | null
  gameRandomSeeds: number[]
  mapRandomSeeds: number[]
  gameModes: string[]
  players: CivupTimelinePlayerSummary[]
}

export interface CivupTimelinePlayerSummary {
  slot: number
  team: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
  firstTurn: number | null
  lastTurn: number | null
  seenTurns: number
}

export interface CivupAutosaveTimeline {
  tool: 'civup-analyzer'
  schemaVersion: 1
  source: string
  sourceKind: CivupAnalyzerSourceKind
  generatedAt: string
  turns: CivupTurnSnapshot[]
  failures: CivupTimelineFailure[]
  summary: CivupTimelineSummary
}

export interface AnalyzeAutosaveTimelineOptions {
  limit?: number | null
  failFast?: boolean
}
