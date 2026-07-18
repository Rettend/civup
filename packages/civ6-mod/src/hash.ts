const CIV_BLITZ_MOD_NAMESPACE = 'b837e78e-9b77-4a72-a47a-57a8a0c52b40'

export function sha1Hex(value: string): string {
  return [...sha1(new TextEncoder().encode(value))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function civBlitzModUuid(value: string): string {
  const namespace = uuidBytes(CIV_BLITZ_MOD_NAMESPACE)
  const name = new TextEncoder().encode(value)
  const bytes = new Uint8Array(namespace.length + name.length)
  bytes.set(namespace)
  bytes.set(name, namespace.length)
  const digest = sha1(bytes).slice(0, 16)
  digest[6] = (digest[6]! & 0x0F) | 0x50
  digest[8] = (digest[8]! & 0x3F) | 0x80
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sha1(input: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(input)
  bytes[input.length] = 0x80
  const bitLength = input.length * 8
  const view = new DataView(bytes.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xEFCDAB89
  let h2 = 0x98BADCFE
  let h3 = 0x10325476
  let h4 = 0xC3D2E1F0
  const words = new Uint32Array(80)

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!, 1)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let index = 0; index < 80; index += 1) {
      const f = index < 20
        ? (b & c) | (~b & d)
        : index < 40
          ? b ^ c ^ d
          : index < 60
            ? (b & c) | (b & d) | (c & d)
            : b ^ c ^ d
      const k = index < 20 ? 0x5A827999 : index < 40 ? 0x6ED9EBA1 : index < 60 ? 0x8F1BBCDC : 0xCA62C1D6
      const temporary = (rotateLeft(a, 5) + f + e + k + words[index]!) >>> 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temporary
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const output = new Uint8Array(20)
  const outputView = new DataView(output.buffer)
  ;[h0, h1, h2, h3, h4].forEach((word, index) => outputView.setUint32(index * 4, word, false))
  return output
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '')
  const output = new Uint8Array(16)
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return output
}
