export type RandomSource = () => number

export function createSeededRandom(seed: string | number): RandomSource {
  const seedText = String(seed)
  let hash = 2166136261
  for (let index = 0; index < seedText.length; index++) {
    hash ^= seedText.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  let state = hash >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}
