import type { CivBlitzModFile } from './types.ts'
import { CivBlitzModError } from './types.ts'

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034B50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014B50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054B50
const UTF8_FLAG = 0x0800
const STORED_METHOD = 0
const DOS_DATE_1980_01_01 = 0x0021
const MAX_ZIP_32 = 0xFFFF_FFFF

interface EncodedEntry {
  name: Uint8Array
  content: Uint8Array
  crc: number
  localOffset: number
}

export function createStoredZip(files: readonly CivBlitzModFile[]): Uint8Array {
  if (files.length > 0xFFFF) throw new CivBlitzModError('GENERATION_LIMIT', 'The generated mod contains too many files.', 413)
  const encoder = new TextEncoder()
  const entries: EncodedEntry[] = []
  let localSize = 0

  for (const file of files) {
    const name = encoder.encode(file.path)
    const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content
    if (name.length > 0xFFFF || content.length > MAX_ZIP_32) {
      throw new CivBlitzModError('GENERATION_LIMIT', 'A generated mod file exceeds the ZIP format limit.', 413)
    }
    entries.push({ name, content, crc: crc32(content), localOffset: localSize })
    localSize += 30 + name.length + content.length
  }

  const centralSize = entries.reduce((size, entry) => size + 46 + entry.name.length, 0)
  const totalSize = localSize + centralSize + 22
  if (localSize > MAX_ZIP_32 || centralSize > MAX_ZIP_32 || totalSize > MAX_ZIP_32) {
    throw new CivBlitzModError('GENERATION_LIMIT', 'The generated mod exceeds the ZIP format limit.', 413)
  }

  const output = new Uint8Array(totalSize)
  const view = new DataView(output.buffer)
  let offset = 0
  for (const entry of entries) {
    view.setUint32(offset, LOCAL_FILE_HEADER_SIGNATURE, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, UTF8_FLAG, true)
    view.setUint16(offset + 8, STORED_METHOD, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint16(offset + 12, DOS_DATE_1980_01_01, true)
    view.setUint32(offset + 14, entry.crc, true)
    view.setUint32(offset + 18, entry.content.length, true)
    view.setUint32(offset + 22, entry.content.length, true)
    view.setUint16(offset + 26, entry.name.length, true)
    view.setUint16(offset + 28, 0, true)
    output.set(entry.name, offset + 30)
    output.set(entry.content, offset + 30 + entry.name.length)
    offset += 30 + entry.name.length + entry.content.length
  }

  const centralOffset = offset
  for (const entry of entries) {
    view.setUint32(offset, CENTRAL_DIRECTORY_SIGNATURE, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 20, true)
    view.setUint16(offset + 8, UTF8_FLAG, true)
    view.setUint16(offset + 10, STORED_METHOD, true)
    view.setUint16(offset + 12, 0, true)
    view.setUint16(offset + 14, DOS_DATE_1980_01_01, true)
    view.setUint32(offset + 16, entry.crc, true)
    view.setUint32(offset + 20, entry.content.length, true)
    view.setUint32(offset + 24, entry.content.length, true)
    view.setUint16(offset + 28, entry.name.length, true)
    view.setUint16(offset + 30, 0, true)
    view.setUint16(offset + 32, 0, true)
    view.setUint16(offset + 34, 0, true)
    view.setUint16(offset + 36, 0, true)
    view.setUint32(offset + 38, 0, true)
    view.setUint32(offset + 42, entry.localOffset, true)
    output.set(entry.name, offset + 46)
    offset += 46 + entry.name.length
  }

  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true)
  view.setUint16(offset + 4, 0, true)
  view.setUint16(offset + 6, 0, true)
  view.setUint16(offset + 8, entries.length, true)
  view.setUint16(offset + 10, entries.length, true)
  view.setUint32(offset + 12, centralSize, true)
  view.setUint32(offset + 16, centralOffset, true)
  view.setUint16(offset + 20, 0, true)
  return output
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFF_FFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
  }
  return (crc ^ 0xFFFF_FFFF) >>> 0
}
