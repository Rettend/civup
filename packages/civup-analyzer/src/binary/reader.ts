export class BinaryReader {
  private offsetValue = 0

  constructor(private readonly bytes: Uint8Array, private readonly label = 'buffer') {}

  get offset(): number {
    return this.offsetValue
  }

  set offset(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.bytes.length) {
      throw new Error(`${this.label}: invalid offset ${value}`)
    }
    this.offsetValue = value
  }

  get length(): number {
    return this.bytes.length
  }

  remaining(): number {
    return this.bytes.length - this.offsetValue
  }

  skip(count: number) {
    this.ensure(count)
    this.offsetValue += count
  }

  readU8(): number {
    this.ensure(1)
    const value = this.bytes[this.offsetValue]
    this.offsetValue += 1
    return value!
  }

  readU16(): number {
    const value = this.readUIntLe(2)
    return value
  }

  readU24(): number {
    const value = this.readUIntLe(3)
    return value
  }

  readU32(): number {
    return this.readUIntLe(4) >>> 0
  }

  readU64(): bigint {
    this.ensure(8)
    const low = BigInt(this.readU32())
    const high = BigInt(this.readU32())
    return low | (high << 32n)
  }

  readBytes(count: number): Uint8Array {
    this.ensure(count)
    const value = this.bytes.subarray(this.offsetValue, this.offsetValue + count)
    this.offsetValue += count
    return value
  }

  readU32At(offset: number): number {
    this.ensureAt(offset, 4)
    return readU32Le(this.bytes, offset)
  }

  indexOf(pattern: readonly number[], from = this.offsetValue): number {
    return indexOfBytes(this.bytes, pattern, from)
  }

  private readUIntLe(count: 2 | 3 | 4): number {
    this.ensure(count)
    let value = 0
    for (let index = 0; index < count; index += 1) {
      value |= (this.bytes[this.offsetValue + index] ?? 0) << (index * 8)
    }
    this.offsetValue += count
    return value >>> 0
  }

  private ensure(count: number) {
    this.ensureAt(this.offsetValue, count)
  }

  private ensureAt(offset: number, count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${this.label}: invalid read length ${count}`)
    if (offset < 0 || offset + count > this.bytes.length) {
      throw new Error(`${this.label}: unexpected end at offset ${offset}, need ${count} bytes`)
    }
  }
}

export function readU32Le(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first == null || second == null || third == null || fourth == null) {
    throw new Error(`Unexpected end at offset ${offset}, need 4 bytes`)
  }
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0
}

export function indexOfBytes(bytes: Uint8Array, pattern: readonly number[], from = 0): number {
  for (let offset = Math.max(0, from); offset <= bytes.length - pattern.length; offset += 1) {
    let found = true
    for (let index = 0; index < pattern.length; index += 1) {
      if (bytes[offset + index] !== pattern[index]) {
        found = false
        break
      }
    }
    if (found) return offset
  }
  return -1
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
