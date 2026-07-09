import type { AutosaveZipEntry } from '@civup/civ6-save-metadata'
import { inflateRawSync } from 'node:zlib'
import { listAutosaveZipEntries, parseZipEntries, readZipEntryData } from '@civup/civ6-save-metadata'

export interface CivupSaveFile {
  index: number
  saveName: string
  turnFromName: number | null
  compressedSizeBytes: number | null
  uncompressedSizeBytes: number
  bytes: Uint8Array
}

export interface ExtractSaveFilesOptions {
  limit?: number | null
}

export function extractSaveFilesFromSourceBytes(
  source: string,
  bytes: Uint8Array,
  options: ExtractSaveFilesOptions = {},
): CivupSaveFile[] {
  if (isCiv6SavePath(source)) {
    return [{
      index: 0,
      saveName: source,
      turnFromName: null,
      compressedSizeBytes: null,
      uncompressedSizeBytes: bytes.length,
      bytes,
    }]
  }

  const entries = listAutosaveZipEntries(parseZipEntries(bytes))
  const limit = normalizeLimit(options.limit)
  const selected = limit == null ? entries : entries.slice(0, limit)
  return selected.map((entry, index) => buildSaveFile(bytes, entry, index))
}

export function pickSaveFile(files: readonly CivupSaveFile[], requestedTurn: number | null): CivupSaveFile | null {
  if (files.length === 0) return null
  if (requestedTurn == null) return files.at(-1) ?? null
  return files.find(file => file.turnFromName === requestedTurn) ?? null
}

function buildSaveFile(zipBytes: Uint8Array, entry: AutosaveZipEntry, index: number): CivupSaveFile {
  const bytes = readZipEntryData(zipBytes, entry, inflateRaw)
  return {
    index,
    saveName: entry.name,
    turnFromName: entry.turn,
    compressedSizeBytes: entry.compressedSize,
    uncompressedSizeBytes: entry.uncompressedSize,
    bytes,
  }
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
