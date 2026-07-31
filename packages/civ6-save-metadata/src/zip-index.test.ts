import { describe, expect, test } from 'bun:test'
import { deflateSync } from 'fflate'
import {
  DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES,
  MAX_AUTOSAVE_ZIP_ENTRY_COUNT,
  MAX_CIV6_SAVE_COMPRESSED_BYTES,
  MAX_CIV6_SAVE_UNCOMPRESSED_BYTES,
  parseZipEntries,
  readZipEntryDataFromReader,
  type ZipByteReader,
  type ZipEntry,
} from './zip-index.ts'

describe('bounded zip metadata reads', () => {
  test('rejects excessive central-directory entry counts before reading entries', () => {
    const bytes = new Uint8Array(22)
    writeUint32(bytes, 0, 0x06054B50)
    writeUint16(bytes, 8, MAX_AUTOSAVE_ZIP_ENTRY_COUNT + 1)
    writeUint16(bytes, 10, MAX_AUTOSAVE_ZIP_ENTRY_COUNT + 1)

    expect(() => parseZipEntries(bytes)).toThrow(`Zip contains more than ${MAX_AUTOSAVE_ZIP_ENTRY_COUNT} entries`)
  })

  test('rejects an oversized declared save before reading compressed data', async () => {
    const reader = createReader(new Uint8Array(0))
    const entry = createEntry({ uncompressedSize: MAX_CIV6_SAVE_UNCOMPRESSED_BYTES + 1 })

    await expect(readZipEntryDataFromReader(reader, entry)).rejects.toThrow(
      `Zip entry uncompressed size exceeds ${MAX_CIV6_SAVE_UNCOMPRESSED_BYTES} bytes`,
    )
  })

  test('stops a deflate stream whose actual output exceeds its declaration', async () => {
    const original = new Uint8Array(64 * 1024)
    const compressed = deflateSync(original, { level: 9 })
    const reader = createReader(withLocalHeader(compressed))
    const entry = createEntry({ compressedSize: compressed.length, uncompressedSize: 32 })

    await expect(readZipEntryDataFromReader(reader, entry)).rejects.toThrow(
      'Inflated zip entry exceeds its declared uncompressed size',
    )
  })

  test('reads a legitimate deflated save at its exact declared size', async () => {
    const original = new TextEncoder().encode('CIV6'.repeat(4_096))
    const compressed = deflateSync(original)
    const reader = createReader(withLocalHeader(compressed))
    const entry = createEntry({ compressedSize: compressed.length, uncompressedSize: original.length })

    expect(await readZipEntryDataFromReader(reader, entry)).toEqual(original)
  })

  test('reads stored saves incrementally with a practical bounded default operation count', async () => {
    const size = DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES * 2 + 123
    const reads: Array<{ offset: number, length: number }> = []
    const reader = createReader(withLocalHeader(new Uint8Array(size)), reads)
    const entry = createEntry({
      compressedSize: size,
      uncompressedSize: size,
      compressionMethod: 0,
    })

    expect((await readZipEntryDataFromReader(reader, entry)).length).toBe(size)
    const dataReads = reads.slice(1)
    expect(dataReads.map(read => read.length)).toEqual([
      DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES,
      DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES,
      123,
    ])
    expect(dataReads.every(read => read.length <= DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES)).toBe(true)
    expect(Math.ceil(MAX_CIV6_SAVE_COMPRESSED_BYTES / DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES)).toBe(8)
  })

  test('supports a smaller configured range chunk without changing output bounds', async () => {
    const rangeChunkSizeBytes = 1024 * 1024
    const size = rangeChunkSizeBytes * 2 + 7
    const reads: Array<{ offset: number, length: number }> = []
    const reader = createReader(withLocalHeader(new Uint8Array(size)), reads)
    const entry = createEntry({ compressedSize: size, uncompressedSize: size, compressionMethod: 0 })

    expect((await readZipEntryDataFromReader(reader, entry, { rangeChunkSizeBytes })).length).toBe(size)
    expect(reads.slice(1).map(read => read.length)).toEqual([rangeChunkSizeBytes, rangeChunkSizeBytes, 7])
  })
})

function createEntry(overrides: Partial<ZipEntry>): ZipEntry {
  return {
    name: 'AutoSave_001.Civ6Save',
    directory: false,
    compressedSize: 0,
    uncompressedSize: 0,
    compressionMethod: 8,
    localHeaderOffset: 0,
    ...overrides,
  }
}

function withLocalHeader(compressed: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(30 + compressed.length)
  writeUint32(bytes, 0, 0x04034B50)
  bytes.set(compressed, 30)
  return bytes
}

function createReader(bytes: Uint8Array, reads: Array<{ offset: number, length: number }> = []): ZipByteReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      reads.push({ offset, length })
      return bytes.slice(offset, offset + length)
    },
  }
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xFF
  bytes[offset + 1] = (value >>> 8) & 0xFF
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xFF
  bytes[offset + 1] = (value >>> 8) & 0xFF
  bytes[offset + 2] = (value >>> 16) & 0xFF
  bytes[offset + 3] = (value >>> 24) & 0xFF
}
