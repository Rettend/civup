<<<<<<< New base: fix: mod resolve
<<<<<<< New base: chore: update leader desc
import { Inflate } from 'fflate'

const EOCD_SIGNATURE = 0x06054B50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034B50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014B50
const ZIP64_SENTINEL_16 = 0xFFFF
const ZIP64_SENTINEL_32 = 0xFFFFFFFF
const MAX_EOCD_SEARCH_BYTES = 65_535 + 22
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8

export const MAX_AUTOSAVE_ZIP_ENTRY_COUNT = 4_096
export const MAX_AUTOSAVE_ZIP_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024
export const MAX_CIV6_SAVE_COMPRESSED_BYTES = 64 * 1024 * 1024
export const MAX_CIV6_SAVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
export const DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024
export const MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024
const INFLATE_PUSH_CHUNK_BYTES = 4 * 1024

export interface ZipEntry {
  name: string
  directory: boolean
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
}

export interface AutosaveZipEntry extends ZipEntry {
  name: string
  turn: number | null
}

export type InflateRaw = (bytes: Uint8Array) => Uint8Array

export interface ZipByteReader {
  size: number
  read: (offset: number, length: number) => Promise<Uint8Array>
}

export interface AutosaveZipIndex {
  zipEntryCount: number
  saveCount: number
  maxTurn: number | null
  latestSaveName: string | null
  latestSaveTurn: number | null
  latestSaveCompressedSizeBytes: number | null
  latestSaveUncompressedSizeBytes: number | null
  missingTurnEstimate: number | null
  saveEntries?: AutosaveZipEntry[]
}

export interface AutosaveZipIndexOptions {
  includeEntries?: boolean
}

export interface ZipParseLimits {
  maxEntries?: number
  maxCentralDirectoryBytes?: number
}

export interface ZipEntryReadLimits {
  maxCompressedSizeBytes?: number
  maxUncompressedSizeBytes?: number
  rangeChunkSizeBytes?: number
}

interface EndOfCentralDirectory {
  totalEntries: number
  centralDirectorySize: number
  centralDirectoryOffset: number
}

export function parseAutosaveZipIndex(bytes: Uint8Array, options: AutosaveZipIndexOptions = {}): AutosaveZipIndex {
  const zipEntries = parseZipEntries(bytes)
  return createAutosaveZipIndex(zipEntries, options)
}

export async function parseAutosaveZipIndexFromReader(reader: ZipByteReader, options: AutosaveZipIndexOptions = {}): Promise<AutosaveZipIndex> {
  const zipEntries = await parseZipEntriesFromReader(reader)
  return createAutosaveZipIndex(zipEntries, options)
}

export function createAutosaveZipIndex(zipEntries: readonly ZipEntry[], options: AutosaveZipIndexOptions = {}): AutosaveZipIndex {
  const saveEntries = listAutosaveZipEntries(zipEntries)
  const latestSave = pickLatestAutosaveZipEntry(zipEntries)
  const maxTurn = saveEntries.reduce<number | null>((max, entry) => {
    if (entry.turn == null) return max
    return max == null ? entry.turn : Math.max(max, entry.turn)
  }, null)

  const result: AutosaveZipIndex = {
    zipEntryCount: zipEntries.length,
    saveCount: saveEntries.length,
    maxTurn,
    latestSaveName: latestSave?.name ?? null,
    latestSaveTurn: latestSave?.turn ?? null,
    latestSaveCompressedSizeBytes: latestSave?.compressedSize ?? null,
    latestSaveUncompressedSizeBytes: latestSave?.uncompressedSize ?? null,
    missingTurnEstimate: maxTurn == null ? null : Math.max(0, maxTurn - saveEntries.length),
  }

  if (options.includeEntries) result.saveEntries = saveEntries
  return result
}

export function listAutosaveZipEntries(entries: readonly ZipEntry[]): AutosaveZipEntry[] {
  return entries
    .filter(entry => !entry.directory && /\.Civ6Save$/i.test(entry.name))
    .map(entry => ({
      ...entry,
      turn: extractAutosaveTurn(entry.name),
    }))
    .sort(compareSaveEntries)
}

export function pickLatestAutosaveZipEntry(entries: readonly ZipEntry[]): AutosaveZipEntry | null {
  return listAutosaveZipEntries(entries).at(-1) ?? null
}

export function readZipEntryData(bytes: Uint8Array, entry: ZipEntry, inflateRaw?: InflateRaw): Uint8Array {
  const dataOffset = getZipEntryDataOffset(bytes, entry)
  ensureRange(bytes, dataOffset, entry.compressedSize, 'zip entry data')
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize)

  return inflateZipEntryData(compressed, entry, inflateRaw)
}

export async function readZipEntryDataFromReader(
  reader: ZipByteReader,
  entry: ZipEntry,
  limits: ZipEntryReadLimits = {},
): Promise<Uint8Array> {
  const maxCompressedSizeBytes = limits.maxCompressedSizeBytes ?? MAX_CIV6_SAVE_COMPRESSED_BYTES
  const maxUncompressedSizeBytes = limits.maxUncompressedSizeBytes ?? MAX_CIV6_SAVE_UNCOMPRESSED_BYTES
  const rangeChunkSizeBytes = limits.rangeChunkSizeBytes ?? DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES
  validateByteLimit(maxCompressedSizeBytes, 'compressed zip entry limit')
  validateByteLimit(maxUncompressedSizeBytes, 'uncompressed zip entry limit')
  validateRangeChunkSize(rangeChunkSizeBytes)
  if (entry.compressedSize > maxCompressedSizeBytes) {
    throw new Error(`Zip entry compressed size exceeds ${maxCompressedSizeBytes} bytes`)
  }
  if (entry.uncompressedSize > maxUncompressedSizeBytes) {
    throw new Error(`Zip entry uncompressed size exceeds ${maxUncompressedSizeBytes} bytes`)
  }

  const localHeader = await readZipRange(reader, entry.localHeaderOffset, 30, 'local file header')
  if (readUint32(localHeader, 0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid local file header signature at offset ${entry.localHeaderOffset}`)
  }

  const fileNameLength = readUint16(localHeader, 26)
  const extraLength = readUint16(localHeader, 28)
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength

  if (entry.compressionMethod === ZIP_METHOD_STORE) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new Error('Stored zip entry size does not match its declaration')
    return readStoredZipEntryFromReader(reader, dataOffset, entry.uncompressedSize, rangeChunkSizeBytes)
  }
  if (entry.compressionMethod !== ZIP_METHOD_DEFLATE) {
    throw new Error(`Unsupported zip compression method ${entry.compressionMethod}`)
  }

  return inflateZipEntryFromReader(reader, dataOffset, entry, rangeChunkSizeBytes)
}

function inflateZipEntryData(compressed: Uint8Array, entry: ZipEntry, inflateRaw?: InflateRaw): Uint8Array {
  if (entry.compressionMethod === ZIP_METHOD_STORE) return compressed.slice()
  if (entry.compressionMethod === ZIP_METHOD_DEFLATE) {
    if (!inflateRaw) throw new Error('Zip entry is deflated, but no inflateRaw function was provided')
    return inflateRaw(compressed)
  }

  throw new Error(`Unsupported zip compression method ${entry.compressionMethod}`)
}

export function parseZipEntries(bytes: Uint8Array, limits: ZipParseLimits = {}): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes)
  validateCentralDirectoryLimits(eocd, limits)
  const centralDirectory = bytes.subarray(eocd.centralDirectoryOffset, eocd.centralDirectoryOffset + eocd.centralDirectorySize)
  return parseZipEntriesFromCentralDirectory(centralDirectory, eocd)
}

export async function parseZipEntriesFromReader(reader: ZipByteReader, limits: ZipParseLimits = {}): Promise<ZipEntry[]> {
  const eocd = await findEndOfCentralDirectoryFromReader(reader)
  validateCentralDirectoryLimits(eocd, limits)
  const centralDirectory = await readZipRange(reader, eocd.centralDirectoryOffset, eocd.centralDirectorySize, 'central directory')
  return parseZipEntriesFromCentralDirectory(centralDirectory, eocd)
}

async function readStoredZipEntryFromReader(
  reader: ZipByteReader,
  dataOffset: number,
  size: number,
  rangeChunkSizeBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    const length = Math.min(rangeChunkSizeBytes, size - offset)
    output.set(await readZipRange(reader, dataOffset + offset, length, 'zip entry data'), offset)
    offset += length
  }
  return output
}

async function inflateZipEntryFromReader(
  reader: ZipByteReader,
  dataOffset: number,
  entry: ZipEntry,
  rangeChunkSizeBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(entry.uncompressedSize)
  let outputOffset = 0
  const inflate = new Inflate((chunk) => {
    if (outputOffset + chunk.length > entry.uncompressedSize) {
      throw new Error('Inflated zip entry exceeds its declared uncompressed size')
    }
    output.set(chunk, outputOffset)
    outputOffset += chunk.length
  })

  let compressedOffset = 0
  while (compressedOffset < entry.compressedSize) {
    const rangeLength = Math.min(rangeChunkSizeBytes, entry.compressedSize - compressedOffset)
    const range = await readZipRange(reader, dataOffset + compressedOffset, rangeLength, 'zip entry data')
    let rangeOffset = 0
    while (rangeOffset < range.length) {
      const pushLength = Math.min(INFLATE_PUSH_CHUNK_BYTES, range.length - rangeOffset)
      rangeOffset += pushLength
      const final = compressedOffset + rangeOffset === entry.compressedSize
      inflate.push(range.subarray(rangeOffset - pushLength, rangeOffset), final)
    }
    compressedOffset += rangeLength
  }
  if (entry.compressedSize === 0) inflate.push(new Uint8Array(), true)
  if (outputOffset !== entry.uncompressedSize) {
    throw new Error(`Inflated zip entry size ${outputOffset} does not match declared size ${entry.uncompressedSize}`)
  }
  return output
}

function validateCentralDirectoryLimits(eocd: EndOfCentralDirectory, limits: ZipParseLimits): void {
  const maxEntries = limits.maxEntries ?? MAX_AUTOSAVE_ZIP_ENTRY_COUNT
  const maxCentralDirectoryBytes = limits.maxCentralDirectoryBytes ?? MAX_AUTOSAVE_ZIP_CENTRAL_DIRECTORY_BYTES
  validateByteLimit(maxEntries, 'zip entry count limit')
  validateByteLimit(maxCentralDirectoryBytes, 'zip central directory limit')
  if (eocd.totalEntries > maxEntries) throw new Error(`Zip contains more than ${maxEntries} entries`)
  if (eocd.centralDirectorySize > maxCentralDirectoryBytes) {
    throw new Error(`Zip central directory exceeds ${maxCentralDirectoryBytes} bytes`)
  }
}

function validateByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} ${value}`)
}

function validateRangeChunkSize(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES) {
    throw new Error(`Zip entry range chunk size must be between 1 and ${MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES} bytes`)
  }
}

function parseZipEntriesFromCentralDirectory(bytes: Uint8Array, eocd: EndOfCentralDirectory): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  const endOffset = eocd.centralDirectorySize

  for (let index = 0; index < eocd.totalEntries; index += 1) {
    ensureRange(bytes, offset, 46, 'central directory header')
    const absoluteOffset = eocd.centralDirectoryOffset + offset
    if (readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid central directory signature at offset ${absoluteOffset}`)
    }

    const flags = readUint16(bytes, offset + 8)
    const compressionMethod = readUint16(bytes, offset + 10)
    const compressedSize = readUint32(bytes, offset + 20)
    const uncompressedSize = readUint32(bytes, offset + 24)
    const fileNameLength = readUint16(bytes, offset + 28)
    const extraLength = readUint16(bytes, offset + 30)
    const commentLength = readUint16(bytes, offset + 32)
    const localHeaderOffset = readUint32(bytes, offset + 42)
    const fileNameOffset = offset + 46
    const nextOffset = fileNameOffset + fileNameLength + extraLength + commentLength

    ensureRange(bytes, fileNameOffset, fileNameLength, 'central directory file name')
    if (nextOffset > endOffset) throw new Error('Central directory entry exceeds declared directory size')

    const name = decodeZipFileName(bytes.subarray(fileNameOffset, fileNameOffset + fileNameLength), Boolean(flags & 0x0800))
    entries.push({
      name,
      directory: name.endsWith('/'),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    })
    offset = nextOffset
  }

  return entries
}

async function findEndOfCentralDirectoryFromReader(reader: ZipByteReader): Promise<EndOfCentralDirectory> {
  const length = Math.min(reader.size, MAX_EOCD_SEARCH_BYTES)
  const offset = reader.size - length
  const bytes = await readZipRange(reader, offset, length, 'zip end')
  return findEndOfCentralDirectory(bytes, offset, reader.size)
}

function findEndOfCentralDirectory(bytes: Uint8Array, baseOffset = 0, fileSize = bytes.length): EndOfCentralDirectory {
  const minOffset = Math.max(0, bytes.length - MAX_EOCD_SEARCH_BYTES)
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readUint32(bytes, offset) !== EOCD_SIGNATURE) continue

    const commentLength = readUint16(bytes, offset + 20)
    const endOffset = baseOffset + offset + 22 + commentLength
    if (offset + 22 + commentLength > bytes.length || endOffset > fileSize) continue

    const diskNumber = readUint16(bytes, offset + 4)
    const centralDirectoryDisk = readUint16(bytes, offset + 6)
    const totalEntriesOnDisk = readUint16(bytes, offset + 8)
    const totalEntries = readUint16(bytes, offset + 10)
    const centralDirectorySize = readUint32(bytes, offset + 12)
    const centralDirectoryOffset = readUint32(bytes, offset + 16)

    if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
      throw new Error('Multi-disk zip files are not supported')
    }
    if (
      totalEntries === ZIP64_SENTINEL_16
      || totalEntriesOnDisk === ZIP64_SENTINEL_16
      || centralDirectorySize === ZIP64_SENTINEL_32
      || centralDirectoryOffset === ZIP64_SENTINEL_32
    ) {
      throw new Error('Zip64 files are not supported yet')
    }
    if (totalEntries !== totalEntriesOnDisk) throw new Error('Multi-disk zip entry counts are not supported')
    if (centralDirectoryOffset + centralDirectorySize > fileSize) throw new Error('Central directory exceeds file size')

    return {
      totalEntries,
      centralDirectorySize,
      centralDirectoryOffset,
    }
  }

  throw new Error('Could not find zip central directory')
}

async function readZipRange(reader: ZipByteReader, offset: number, length: number, label: string): Promise<Uint8Array> {
  ensureReaderRange(reader.size, offset, length, label)
  if (length === 0) return new Uint8Array()

  const bytes = await reader.read(offset, length)
  if (bytes.length !== length) {
    throw new Error(`Could not read complete ${label} range ${offset}:${offset + length}`)
  }
  return bytes
}

function ensureReaderRange(size: number, offset: number, length: number, label: string) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid zip reader size ${size}`)
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`Invalid ${label} range ${offset}:${offset + length}`)
  }
}

function extractAutosaveTurn(name: string): number | null {
  const baseName = name.split(/[\\/]/).at(-1) ?? name
  const stem = baseName.replace(/\.Civ6Save$/i, '')
  const matches = [...stem.matchAll(/\d+/g)]
  const value = matches.at(-1)?.[0]
  if (!value) return null

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function getZipEntryDataOffset(bytes: Uint8Array, entry: ZipEntry): number {
  const offset = entry.localHeaderOffset
  ensureRange(bytes, offset, 30, 'local file header')
  if (readUint32(bytes, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid local file header signature at offset ${offset}`)
  }

  const fileNameLength = readUint16(bytes, offset + 26)
  const extraLength = readUint16(bytes, offset + 28)
  return offset + 30 + fileNameLength + extraLength
}

function compareSaveEntries(left: AutosaveZipEntry, right: AutosaveZipEntry): number {
  if (left.turn != null && right.turn != null && left.turn !== right.turn) return left.turn - right.turn
  if (left.turn != null && right.turn == null) return 1
  if (left.turn == null && right.turn != null) return -1
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}

function decodeZipFileName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

function readUint16(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 2, 'uint16')
  const first = bytes[offset]
  const second = bytes[offset + 1]
  if (first == null || second == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return first | (second << 8)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, 'uint32')
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first == null || second == null || third == null || fourth == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`Invalid ${label} range ${offset}:${offset + length}`)
  }
}
|||||||
=======
||||||| Common ancestor
=======
import { Inflate } from 'fflate'

>>>>>>> Current commit: chore: cleanup and simplify setup
const EOCD_SIGNATURE = 0x06054B50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034B50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014B50
const ZIP64_SENTINEL_16 = 0xFFFF
const ZIP64_SENTINEL_32 = 0xFFFFFFFF
const MAX_EOCD_SEARCH_BYTES = 65_535 + 22
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8

export const MAX_AUTOSAVE_ZIP_ENTRY_COUNT = 4_096
export const MAX_AUTOSAVE_ZIP_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024
export const MAX_CIV6_SAVE_COMPRESSED_BYTES = 64 * 1024 * 1024
export const MAX_CIV6_SAVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
export const DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024
export const MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024
const INFLATE_PUSH_CHUNK_BYTES = 4 * 1024

export interface ZipEntry {
  name: string
  directory: boolean
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
}

export interface AutosaveZipEntry extends ZipEntry {
  name: string
  turn: number | null
}

export type InflateRaw = (bytes: Uint8Array) => Uint8Array

export interface ZipByteReader {
  size: number
  read: (offset: number, length: number) => Promise<Uint8Array>
}

export interface AutosaveZipIndex {
  zipEntryCount: number
  saveCount: number
  maxTurn: number | null
  latestSaveName: string | null
  latestSaveTurn: number | null
  latestSaveCompressedSizeBytes: number | null
  latestSaveUncompressedSizeBytes: number | null
  missingTurnEstimate: number | null
  saveEntries?: AutosaveZipEntry[]
}

export interface AutosaveZipIndexOptions {
  includeEntries?: boolean
}

export interface ZipParseLimits {
  maxEntries?: number
  maxCentralDirectoryBytes?: number
}

export interface ZipEntryReadLimits {
  maxCompressedSizeBytes?: number
  maxUncompressedSizeBytes?: number
  rangeChunkSizeBytes?: number
}

interface EndOfCentralDirectory {
  totalEntries: number
  centralDirectorySize: number
  centralDirectoryOffset: number
}

export function parseAutosaveZipIndex(bytes: Uint8Array, options: AutosaveZipIndexOptions = {}): AutosaveZipIndex {
  const zipEntries = parseZipEntries(bytes)
  return createAutosaveZipIndex(zipEntries, options)
}

export async function parseAutosaveZipIndexFromReader(reader: ZipByteReader, options: AutosaveZipIndexOptions = {}): Promise<AutosaveZipIndex> {
  const zipEntries = await parseZipEntriesFromReader(reader)
  return createAutosaveZipIndex(zipEntries, options)
}

export function createAutosaveZipIndex(zipEntries: readonly ZipEntry[], options: AutosaveZipIndexOptions = {}): AutosaveZipIndex {
  const saveEntries = listAutosaveZipEntries(zipEntries)
  const latestSave = pickLatestAutosaveZipEntry(zipEntries)
  const maxTurn = saveEntries.reduce<number | null>((max, entry) => {
    if (entry.turn == null) return max
    return max == null ? entry.turn : Math.max(max, entry.turn)
  }, null)

  const result: AutosaveZipIndex = {
    zipEntryCount: zipEntries.length,
    saveCount: saveEntries.length,
    maxTurn,
    latestSaveName: latestSave?.name ?? null,
    latestSaveTurn: latestSave?.turn ?? null,
    latestSaveCompressedSizeBytes: latestSave?.compressedSize ?? null,
    latestSaveUncompressedSizeBytes: latestSave?.uncompressedSize ?? null,
    missingTurnEstimate: maxTurn == null ? null : Math.max(0, maxTurn - saveEntries.length),
  }

  if (options.includeEntries) result.saveEntries = saveEntries
  return result
}

export function listAutosaveZipEntries(entries: readonly ZipEntry[]): AutosaveZipEntry[] {
  return entries
    .filter(entry => !entry.directory && /\.Civ6Save$/i.test(entry.name))
    .map(entry => ({
      ...entry,
      turn: extractAutosaveTurn(entry.name),
    }))
    .sort(compareSaveEntries)
}

export function pickLatestAutosaveZipEntry(entries: readonly ZipEntry[]): AutosaveZipEntry | null {
  return listAutosaveZipEntries(entries).at(-1) ?? null
}

export function readZipEntryData(bytes: Uint8Array, entry: ZipEntry, inflateRaw?: InflateRaw): Uint8Array {
  const dataOffset = getZipEntryDataOffset(bytes, entry)
  ensureRange(bytes, dataOffset, entry.compressedSize, 'zip entry data')
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize)

  return inflateZipEntryData(compressed, entry, inflateRaw)
}

export async function readZipEntryDataFromReader(
  reader: ZipByteReader,
  entry: ZipEntry,
  limits: ZipEntryReadLimits = {},
): Promise<Uint8Array> {
  const maxCompressedSizeBytes = limits.maxCompressedSizeBytes ?? MAX_CIV6_SAVE_COMPRESSED_BYTES
  const maxUncompressedSizeBytes = limits.maxUncompressedSizeBytes ?? MAX_CIV6_SAVE_UNCOMPRESSED_BYTES
  const rangeChunkSizeBytes = limits.rangeChunkSizeBytes ?? DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES
  validateByteLimit(maxCompressedSizeBytes, 'compressed zip entry limit')
  validateByteLimit(maxUncompressedSizeBytes, 'uncompressed zip entry limit')
  validateRangeChunkSize(rangeChunkSizeBytes)
  if (entry.compressedSize > maxCompressedSizeBytes) {
    throw new Error(`Zip entry compressed size exceeds ${maxCompressedSizeBytes} bytes`)
  }
  if (entry.uncompressedSize > maxUncompressedSizeBytes) {
    throw new Error(`Zip entry uncompressed size exceeds ${maxUncompressedSizeBytes} bytes`)
  }

  const localHeader = await readZipRange(reader, entry.localHeaderOffset, 30, 'local file header')
  if (readUint32(localHeader, 0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid local file header signature at offset ${entry.localHeaderOffset}`)
  }

  const fileNameLength = readUint16(localHeader, 26)
  const extraLength = readUint16(localHeader, 28)
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength

  if (entry.compressionMethod === ZIP_METHOD_STORE) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new Error('Stored zip entry size does not match its declaration')
    return readStoredZipEntryFromReader(reader, dataOffset, entry.uncompressedSize, rangeChunkSizeBytes)
  }
  if (entry.compressionMethod !== ZIP_METHOD_DEFLATE) {
    throw new Error(`Unsupported zip compression method ${entry.compressionMethod}`)
  }

  return inflateZipEntryFromReader(reader, dataOffset, entry, rangeChunkSizeBytes)
}

function inflateZipEntryData(compressed: Uint8Array, entry: ZipEntry, inflateRaw?: InflateRaw): Uint8Array {
  if (entry.compressionMethod === ZIP_METHOD_STORE) return compressed.slice()
  if (entry.compressionMethod === ZIP_METHOD_DEFLATE) {
    if (!inflateRaw) throw new Error('Zip entry is deflated, but no inflateRaw function was provided')
    return inflateRaw(compressed)
  }

  throw new Error(`Unsupported zip compression method ${entry.compressionMethod}`)
}

export function parseZipEntries(bytes: Uint8Array, limits: ZipParseLimits = {}): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes)
  validateCentralDirectoryLimits(eocd, limits)
  const centralDirectory = bytes.subarray(eocd.centralDirectoryOffset, eocd.centralDirectoryOffset + eocd.centralDirectorySize)
  return parseZipEntriesFromCentralDirectory(centralDirectory, eocd)
}

export async function parseZipEntriesFromReader(reader: ZipByteReader, limits: ZipParseLimits = {}): Promise<ZipEntry[]> {
  const eocd = await findEndOfCentralDirectoryFromReader(reader)
  validateCentralDirectoryLimits(eocd, limits)
  const centralDirectory = await readZipRange(reader, eocd.centralDirectoryOffset, eocd.centralDirectorySize, 'central directory')
  return parseZipEntriesFromCentralDirectory(centralDirectory, eocd)
}

async function readStoredZipEntryFromReader(
  reader: ZipByteReader,
  dataOffset: number,
  size: number,
  rangeChunkSizeBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    const length = Math.min(rangeChunkSizeBytes, size - offset)
    output.set(await readZipRange(reader, dataOffset + offset, length, 'zip entry data'), offset)
    offset += length
  }
  return output
}

async function inflateZipEntryFromReader(
  reader: ZipByteReader,
  dataOffset: number,
  entry: ZipEntry,
  rangeChunkSizeBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(entry.uncompressedSize)
  let outputOffset = 0
  const inflate = new Inflate((chunk) => {
    if (outputOffset + chunk.length > entry.uncompressedSize) {
      throw new Error('Inflated zip entry exceeds its declared uncompressed size')
    }
    output.set(chunk, outputOffset)
    outputOffset += chunk.length
  })

  let compressedOffset = 0
  while (compressedOffset < entry.compressedSize) {
    const rangeLength = Math.min(rangeChunkSizeBytes, entry.compressedSize - compressedOffset)
    const range = await readZipRange(reader, dataOffset + compressedOffset, rangeLength, 'zip entry data')
    let rangeOffset = 0
    while (rangeOffset < range.length) {
      const pushLength = Math.min(INFLATE_PUSH_CHUNK_BYTES, range.length - rangeOffset)
      rangeOffset += pushLength
      const final = compressedOffset + rangeOffset === entry.compressedSize
      inflate.push(range.subarray(rangeOffset - pushLength, rangeOffset), final)
    }
    compressedOffset += rangeLength
  }
  if (entry.compressedSize === 0) inflate.push(new Uint8Array(), true)
  if (outputOffset !== entry.uncompressedSize) {
    throw new Error(`Inflated zip entry size ${outputOffset} does not match declared size ${entry.uncompressedSize}`)
  }
  return output
}

function validateCentralDirectoryLimits(eocd: EndOfCentralDirectory, limits: ZipParseLimits): void {
  const maxEntries = limits.maxEntries ?? MAX_AUTOSAVE_ZIP_ENTRY_COUNT
  const maxCentralDirectoryBytes = limits.maxCentralDirectoryBytes ?? MAX_AUTOSAVE_ZIP_CENTRAL_DIRECTORY_BYTES
  validateByteLimit(maxEntries, 'zip entry count limit')
  validateByteLimit(maxCentralDirectoryBytes, 'zip central directory limit')
  if (eocd.totalEntries > maxEntries) throw new Error(`Zip contains more than ${maxEntries} entries`)
  if (eocd.centralDirectorySize > maxCentralDirectoryBytes) {
    throw new Error(`Zip central directory exceeds ${maxCentralDirectoryBytes} bytes`)
  }
}

function validateByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} ${value}`)
}

function validateRangeChunkSize(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES) {
    throw new Error(`Zip entry range chunk size must be between 1 and ${MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES} bytes`)
  }
}

function parseZipEntriesFromCentralDirectory(bytes: Uint8Array, eocd: EndOfCentralDirectory): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  const endOffset = eocd.centralDirectorySize

  for (let index = 0; index < eocd.totalEntries; index += 1) {
    ensureRange(bytes, offset, 46, 'central directory header')
    const absoluteOffset = eocd.centralDirectoryOffset + offset
    if (readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid central directory signature at offset ${absoluteOffset}`)
    }

    const flags = readUint16(bytes, offset + 8)
    const compressionMethod = readUint16(bytes, offset + 10)
    const compressedSize = readUint32(bytes, offset + 20)
    const uncompressedSize = readUint32(bytes, offset + 24)
    const fileNameLength = readUint16(bytes, offset + 28)
    const extraLength = readUint16(bytes, offset + 30)
    const commentLength = readUint16(bytes, offset + 32)
    const localHeaderOffset = readUint32(bytes, offset + 42)
    const fileNameOffset = offset + 46
    const nextOffset = fileNameOffset + fileNameLength + extraLength + commentLength

    ensureRange(bytes, fileNameOffset, fileNameLength, 'central directory file name')
    if (nextOffset > endOffset) throw new Error('Central directory entry exceeds declared directory size')

    const name = decodeZipFileName(bytes.subarray(fileNameOffset, fileNameOffset + fileNameLength), Boolean(flags & 0x0800))
    entries.push({
      name,
      directory: name.endsWith('/'),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    })
    offset = nextOffset
  }

  return entries
}

async function findEndOfCentralDirectoryFromReader(reader: ZipByteReader): Promise<EndOfCentralDirectory> {
  const length = Math.min(reader.size, MAX_EOCD_SEARCH_BYTES)
  const offset = reader.size - length
  const bytes = await readZipRange(reader, offset, length, 'zip end')
  return findEndOfCentralDirectory(bytes, offset, reader.size)
}

function findEndOfCentralDirectory(bytes: Uint8Array, baseOffset = 0, fileSize = bytes.length): EndOfCentralDirectory {
  const minOffset = Math.max(0, bytes.length - MAX_EOCD_SEARCH_BYTES)
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readUint32(bytes, offset) !== EOCD_SIGNATURE) continue

    const commentLength = readUint16(bytes, offset + 20)
    const endOffset = baseOffset + offset + 22 + commentLength
    if (offset + 22 + commentLength > bytes.length || endOffset > fileSize) continue

    const diskNumber = readUint16(bytes, offset + 4)
    const centralDirectoryDisk = readUint16(bytes, offset + 6)
    const totalEntriesOnDisk = readUint16(bytes, offset + 8)
    const totalEntries = readUint16(bytes, offset + 10)
    const centralDirectorySize = readUint32(bytes, offset + 12)
    const centralDirectoryOffset = readUint32(bytes, offset + 16)

    if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
      throw new Error('Multi-disk zip files are not supported')
    }
    if (
      totalEntries === ZIP64_SENTINEL_16
      || totalEntriesOnDisk === ZIP64_SENTINEL_16
      || centralDirectorySize === ZIP64_SENTINEL_32
      || centralDirectoryOffset === ZIP64_SENTINEL_32
    ) {
      throw new Error('Zip64 files are not supported yet')
    }
    if (totalEntries !== totalEntriesOnDisk) throw new Error('Multi-disk zip entry counts are not supported')
    if (centralDirectoryOffset + centralDirectorySize > fileSize) throw new Error('Central directory exceeds file size')

    return {
      totalEntries,
      centralDirectorySize,
      centralDirectoryOffset,
    }
  }

  throw new Error('Could not find zip central directory')
}

async function readZipRange(reader: ZipByteReader, offset: number, length: number, label: string): Promise<Uint8Array> {
  ensureReaderRange(reader.size, offset, length, label)
  if (length === 0) return new Uint8Array()

  const bytes = await reader.read(offset, length)
  if (bytes.length !== length) {
    throw new Error(`Could not read complete ${label} range ${offset}:${offset + length}`)
  }
  return bytes
}

function ensureReaderRange(size: number, offset: number, length: number, label: string) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid zip reader size ${size}`)
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`Invalid ${label} range ${offset}:${offset + length}`)
  }
}

function extractAutosaveTurn(name: string): number | null {
  const baseName = name.split(/[\\/]/).at(-1) ?? name
  const stem = baseName.replace(/\.Civ6Save$/i, '')
  const matches = [...stem.matchAll(/\d+/g)]
  const value = matches.at(-1)?.[0]
  if (!value) return null

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function getZipEntryDataOffset(bytes: Uint8Array, entry: ZipEntry): number {
  const offset = entry.localHeaderOffset
  ensureRange(bytes, offset, 30, 'local file header')
  if (readUint32(bytes, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid local file header signature at offset ${offset}`)
  }

  const fileNameLength = readUint16(bytes, offset + 26)
  const extraLength = readUint16(bytes, offset + 28)
  return offset + 30 + fileNameLength + extraLength
}

function compareSaveEntries(left: AutosaveZipEntry, right: AutosaveZipEntry): number {
  if (left.turn != null && right.turn != null && left.turn !== right.turn) return left.turn - right.turn
  if (left.turn != null && right.turn == null) return 1
  if (left.turn == null && right.turn != null) return -1
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}

function decodeZipFileName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

function readUint16(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 2, 'uint16')
  const first = bytes[offset]
  const second = bytes[offset + 1]
  if (first == null || second == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return first | (second << 8)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, 'uint32')
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first == null || second == null || third == null || fourth == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`Invalid ${label} range ${offset}:${offset + length}`)
  }
}
>>>>>>> Current commit: feat: catalog
