import { constants, inflateSync } from 'node:zlib'
import { BinaryReader, concatBytes, indexOfBytes, readU32Le } from '../binary/reader.ts'

const CHUNK_SIZE = 65536
const CIV6_MAGIC = [0x43, 0x49, 0x56, 0x36] as const
const END_COMPRESSED = [0x00, 0x00, 0xFF, 0xFF, 0x02, 0x00, 0x00, 0x00] as const

const DATA_TYPES = {
  BOOLEAN: 1,
  INTEGER: 2,
  POINTER: 3,
  STRING: 5,
  UTF_STRING: 6,
  OBJECT: 10,
  ARRAY: 11,
  TIMESTAMP: 20,
  COMPRESSED: 24,
} as const

const GAME_RANDOM_SEED_MARKER = 0x04EE548C
const MAP_RANDOM_SEED_MARKER = 0x96C5C77C

export interface CivReplayCompressedBlob {
  index: number
  sourceOffset: number
  sourceLength: number
  deflatedSizeBytes: number
  inflatedSizeBytes: number
  bytes: Uint8Array
}

export interface CivReplaySavePacketParse {
  packetArrayCount: number
  compressedBlobs: CivReplayCompressedBlob[]
  stateBlob: CivReplayCompressedBlob
  timestamp: string | null
  gameRandomSeed: number | null
  mapRandomSeed: number | null
}

interface PacketHeader {
  marker: number
  type: number
  length: number
  found: number
  info: number
}

export function parseCivReplaySavePackets(bytes: Uint8Array): CivReplaySavePacketParse {
  const parser = new CivReplayPacketParser(bytes)
  return parser.parse()
}

class CivReplayPacketParser {
  private readonly reader: BinaryReader
  private readonly compressedBlobs: CivReplayCompressedBlob[] = []
  private packetArrayCount = 0
  private timestamp: bigint | null = null
  private gameRandomSeed: number | null = null
  private mapRandomSeed: number | null = null

  constructor(private readonly bytes: Uint8Array) {
    this.reader = new BinaryReader(bytes, 'Civ6Save')
  }

  parse(): CivReplaySavePacketParse {
    this.assertMagic()
    this.reader.offset = 4

    this.reader.skip(4)
    this.parsePacketArray()

    this.reader.skip(4)
    this.reader.skip(4)
    this.parsePacketArray()

    this.reader.skip(4)
    this.parsePacketArray()

    this.reader.skip(4)
    this.parsePacketArray()

    const nestedArrayCount = this.reader.readU32()
    for (let index = 0; index < nestedArrayCount; index += 1) {
      this.reader.skip(4)
      this.parsePacketArray()
    }

    this.parsePacketArray()

    this.reader.skip(4)
    const finalEnd = this.reader.indexOf(END_COMPRESSED)
    if (finalEnd < 0) throw new Error(`Could not find final CivReplay compressed payload marker at offset ${this.reader.offset}`)
    const syntheticPacketLength = finalEnd - this.reader.offset + 4 + 12
    this.readCompressed(syntheticPacketLength)

    const stateBlob = this.compressedBlobs.at(-1)
    if (!stateBlob) throw new Error('CivReplay parser did not extract a state blob')

    return {
      packetArrayCount: this.packetArrayCount,
      compressedBlobs: this.compressedBlobs,
      stateBlob,
      timestamp: this.timestamp == null ? null : this.timestamp.toString(),
      gameRandomSeed: this.gameRandomSeed,
      mapRandomSeed: this.mapRandomSeed,
    }
  }

  private assertMagic() {
    for (let index = 0; index < CIV6_MAGIC.length; index += 1) {
      if (this.bytes[index] !== CIV6_MAGIC[index]) throw new Error('Not a Civilization 6 save file')
    }
  }

  private parsePacketArray() {
    const count = this.reader.readU32()
    this.packetArrayCount += 1
    for (let index = 0; index < count; index += 1) this.parseEntry(null)
  }

  private parseEntry(arrayIndex: number | null) {
    const marker = arrayIndex == null ? this.reader.readU32() : arrayIndex
    const type = this.reader.readU32()
    const length = this.reader.readU24()
    const found = this.reader.readU8()
    const info = this.reader.readU32()
    const header: PacketHeader = { marker, type, length, found, info }

    switch (header.type) {
      case DATA_TYPES.BOOLEAN:
      case DATA_TYPES.INTEGER:
      case DATA_TYPES.POINTER:
        this.readIntLike(header.marker)
        return
      case 0x15:
      case 0x0D:
        this.reader.skip(8)
        return
      case 4:
      case DATA_TYPES.STRING:
        this.reader.skip(header.length ? header.length : 4)
        return
      case DATA_TYPES.UTF_STRING:
        this.reader.skip(header.length * 2)
        return
      case DATA_TYPES.TIMESTAMP:
        this.timestamp = this.reader.readU64()
        return
      case DATA_TYPES.COMPRESSED:
        this.reader.skip(12)
        this.readCompressed(header.length)
        return
      case DATA_TYPES.OBJECT:
        this.readArray(false)
        return
      case DATA_TYPES.ARRAY:
        this.readArray(true)
        return
      default:
        throw new Error(`Unsupported CivReplay packet type ${header.type} at offset ${this.reader.offset - 12}`)
    }
  }

  private readIntLike(marker: number) {
    const value = this.reader.readU32()
    if (marker === GAME_RANDOM_SEED_MARKER) this.gameRandomSeed = toInt32(value)
    if (marker === MAP_RANDOM_SEED_MARKER) this.mapRandomSeed = toInt32(value)
  }

  private readArray(isArray: boolean) {
    const count = this.reader.readU32()
    for (let index = 0; index < count; index += 1) this.parseEntry(isArray ? index : null)
  }

  private readCompressed(packetLength: number) {
    const sourceOffset = this.reader.offset
    let remaining = packetLength - 12
    if (remaining <= 0) throw new Error(`Invalid CivReplay compressed packet length ${packetLength} at offset ${sourceOffset}`)

    const chunks: Uint8Array[] = []
    while (remaining > 0) {
      const chunkLength = Math.min(remaining, CHUNK_SIZE)
      chunks.push(this.reader.readBytes(chunkLength))
      remaining -= chunkLength

      if (remaining === 0) break
      this.reader.skip(4)
      remaining -= 4
      if (remaining < 0) throw new Error(`Invalid CivReplay compressed chunk accounting at offset ${sourceOffset}`)
    }

    const finalMarkerOffset = this.reader.offset - 4
    if (readU32Le(this.bytes, finalMarkerOffset) !== 0xFFFF0000) {
      throw new Error(`Invalid CivReplay compressed final marker at offset ${finalMarkerOffset}`)
    }

    const deflated = concatBytes(chunks)
    const inflated = new Uint8Array(inflateSync(deflated, { finishFlush: constants.Z_SYNC_FLUSH }))
    this.compressedBlobs.push({
      index: this.compressedBlobs.length,
      sourceOffset,
      sourceLength: this.reader.offset - sourceOffset,
      deflatedSizeBytes: deflated.length,
      inflatedSizeBytes: inflated.length,
      bytes: inflated,
    })
  }
}

function toInt32(value: number): number {
  return value | 0
}

export function findCivReplayCompressedEnd(bytes: Uint8Array, from: number): number {
  return indexOfBytes(bytes, END_COMPRESSED, from)
}
