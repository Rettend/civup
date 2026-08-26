import { BinaryReader } from '../binary/reader.ts'

export class CivReplayStateReader {
  private readonly reader: BinaryReader

  constructor(private readonly bytes: Uint8Array, private readonly section: string) {
    this.reader = new BinaryReader(bytes, `CivReplay ${section}`)
  }

  get sourceBytes(): Uint8Array {
    return this.bytes
  }

  get offset(): number {
    return this.reader.offset
  }

  set offset(value: number) {
    this.guard(() => {
      this.reader.offset = value
    })
  }

  get length(): number {
    return this.reader.length
  }

  skip(count: number) {
    this.guard(() => this.reader.skip(count))
  }

  readU8(): number {
    return this.guard(() => this.reader.readU8())
  }

  readU16(): number {
    return this.guard(() => this.reader.readU16())
  }

  readU24(): number {
    return this.guard(() => this.reader.readU24())
  }

  readI16(): number {
    const value = this.readU16()
    return value & 0x8000 ? value - 0x10000 : value
  }

  readU32(): number {
    return this.guard(() => this.reader.readU32())
  }

  readString(sizeCount: 1 | 2 | 3 | 4 = 4): string {
    return this.guard(() => {
      const byteLength = this.readCount(sizeCount)
      const bytes = this.reader.readBytes(byteLength)
      return new TextDecoder().decode(bytes)
    })
  }

  readCount(sizeCount: 1 | 2 | 3 | 4): number {
    if (sizeCount === 1) return this.readU8()
    if (sizeCount === 2) return this.readU16()
    if (sizeCount === 3) return this.readU24()
    return this.readU32()
  }

  indexOf(pattern: readonly number[], from = this.offset): number {
    return this.guard(() => this.reader.indexOf(pattern, from))
  }

  peekU32(offset = this.offset): number {
    return this.guard(() => this.reader.readU32At(offset))
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown reader error'
      throw new Error(`${this.section} at offset ${this.reader.offset}: ${message}`)
    }
  }
}
