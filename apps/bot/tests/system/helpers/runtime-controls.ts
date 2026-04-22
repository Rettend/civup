export interface RuntimeControls {
  clock: {
    freeze: (now: number) => number
    advance: (ms: number) => number
    now: () => number
    reset: () => void
  }
  random: {
    seed: (value: number | string) => void
    next: () => number
    reset: () => void
  }
  restore: () => void
}

const REAL_DATE_NOW = Date.now
const REAL_MATH_RANDOM = Math.random

let activeClockOwner: symbol | null = null
let activeFrozenNow: number | null = null
let activeRandomOwner: symbol | null = null
let activeRandomState: number | null = null

function normalizeNow(value: number) {
  return Math.max(1, Math.round(value))
}

function hashSeed(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function nextRandom() {
  if (activeRandomState == null) return REAL_MATH_RANDOM()
  activeRandomState = (Math.imul(activeRandomState, 1664525) + 1013904223) >>> 0
  return activeRandomState / 0x100000000
}

function syncClockGlobal() {
  Date.now = activeClockOwner == null || activeFrozenNow == null
    ? REAL_DATE_NOW
    : () => activeFrozenNow!
}

function syncRandomGlobal() {
  Math.random = activeRandomOwner == null || activeRandomState == null
    ? REAL_MATH_RANDOM
    : () => nextRandom()
}

export function createRuntimeControls(): RuntimeControls {
  const owner = Symbol('runtime-controls')

  return {
    clock: {
      freeze(now) {
        activeClockOwner = owner
        activeFrozenNow = normalizeNow(now)
        syncClockGlobal()
        return activeFrozenNow
      },
      advance(ms) {
        const baseNow = activeClockOwner === owner && activeFrozenNow != null
          ? activeFrozenNow
          : REAL_DATE_NOW()
        activeClockOwner = owner
        activeFrozenNow = normalizeNow(baseNow + ms)
        syncClockGlobal()
        return activeFrozenNow
      },
      now() {
        return activeClockOwner === owner && activeFrozenNow != null
          ? activeFrozenNow
          : REAL_DATE_NOW()
      },
      reset() {
        if (activeClockOwner !== owner) return
        activeClockOwner = null
        activeFrozenNow = null
        syncClockGlobal()
      },
    },
    random: {
      seed(value) {
        activeRandomOwner = owner
        activeRandomState = typeof value === 'number'
          ? (Math.round(value) >>> 0)
          : hashSeed(value)
        syncRandomGlobal()
      },
      next() {
        return nextRandom()
      },
      reset() {
        if (activeRandomOwner !== owner) return
        activeRandomOwner = null
        activeRandomState = null
        syncRandomGlobal()
      },
    },
    restore() {
      if (activeClockOwner === owner) {
        activeClockOwner = null
        activeFrozenNow = null
      }
      if (activeRandomOwner === owner) {
        activeRandomOwner = null
        activeRandomState = null
      }
      syncClockGlobal()
      syncRandomGlobal()
    },
  }
}
