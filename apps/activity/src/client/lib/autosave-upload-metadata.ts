import type { Civ6SaveModMetadata, Civ6SavePlayerMetadata } from '@civup/civ6-save-metadata'
import { parseAutosaveZipIndex, parseCiv6SaveMetadata, parseZipEntries, pickLatestAutosaveZipEntry, readZipEntryData } from '@civup/civ6-save-metadata'
import { inflateSync } from 'fflate'

export interface AutosaveUploadClientMetadata {
  saveCount: number
  maxTurn: number | null
  latestSaveName: string
  playerCount: number | null
  gameMode: string | null
  leaders: string[]
  civs: string[]
  players: Civ6SavePlayerMetadata[]
  mapFile: string | null
  mods: Civ6SaveModMetadata[]
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
}

export async function parseAutosaveUploadClientMetadata(file: File): Promise<AutosaveUploadClientMetadata> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const zipIndex = parseAutosaveZipIndex(bytes)
  const zipEntries = parseZipEntries(bytes)
  const latestSave = pickLatestAutosaveZipEntry(zipEntries)
  if (!latestSave) throw new Error('No .Civ6Save entries found in zip')

  const saveBytes = readZipEntryData(bytes, latestSave, inflateRaw)
  const metadata = parseCiv6SaveMetadata(saveBytes)

  return {
    saveCount: zipIndex.saveCount,
    maxTurn: zipIndex.maxTurn,
    latestSaveName: latestSave.name,
    playerCount: metadata.playerCount,
    gameMode: metadata.gameMode,
    leaders: metadata.leaders,
    civs: metadata.civs,
    players: metadata.players,
    mapFile: metadata.mapFile,
    mods: metadata.mods,
    bbgDetected: metadata.bbgDetected,
    bbgTitle: metadata.bbgTitle,
    bbgVersion: metadata.bbgVersion,
  }
}

function inflateRaw(bytes: Uint8Array): Uint8Array {
  return inflateSync(bytes)
}
