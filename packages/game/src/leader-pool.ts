import type { RandomSource } from './random.ts'
import type { GameMode, LeaderDataVersion } from './types.ts'
import { getLeaderIds } from './leader-registry.ts'
import { defaultPlayerCount } from './mode.ts'

const VERSUS_DEFAULT_LEADER_POOL_BASE = 24
const VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER = 4
const VERSUS_MINIMUM_LEADER_POOL_BASE = 6

const FFA_DEFAULT_PLAYER_FLOOR = 6
const FFA_DEFAULT_POOL_MULTIPLIER = 6
const FFA_MINIMUM_POOL_MULTIPLIER = 3

export const MAX_LEADER_POOL_SIZE = Math.max(getLeaderIds('live').length, getLeaderIds('beta').length)

export function getMaxLeaderPoolSize(version: LeaderDataVersion = 'live'): number {
  return getLeaderIds(version).length
}

/** Default leader pool size for a mode before any lobby override. */
export function getDefaultLeaderPoolSize(
  mode: GameMode,
  playerCount: number = defaultPlayerCount(mode),
  version: LeaderDataVersion = 'live',
): number {
  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))
  const maxLeaderPoolSize = getMaxLeaderPoolSize(version)

  if (mode !== 'ffa') {
    return Math.min(
      maxLeaderPoolSize,
      VERSUS_DEFAULT_LEADER_POOL_BASE + normalizedPlayerCount * VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER,
    )
  }

  const scaledPlayerCount = Math.max(FFA_DEFAULT_PLAYER_FLOOR, normalizedPlayerCount)
  return Math.min(maxLeaderPoolSize, scaledPlayerCount * FFA_DEFAULT_POOL_MULTIPLIER)
}

/** Smallest playable leader pool for a finished draft lobby. */
export function getMinimumLeaderPoolSize(mode: GameMode, playerCount: number): number {
  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))

  if (mode === 'ffa') return normalizedPlayerCount * FFA_MINIMUM_POOL_MULTIPLIER
  return VERSUS_MINIMUM_LEADER_POOL_BASE + normalizedPlayerCount
}

/** Resolve a lobby override against the mode default. */
export function resolveLeaderPoolSize(
  mode: GameMode,
  playerCount: number,
  leaderPoolSize: number | null | undefined,
  version: LeaderDataVersion = 'live',
): number {
  return leaderPoolSize ?? getDefaultLeaderPoolSize(mode, playerCount, version)
}

/** Pick a random unique leader subset from the full roster. */
export function sampleLeaderPool(
  leaderPoolSize: number,
  random: RandomSource = Math.random,
  version: LeaderDataVersion = 'live',
): string[] {
  const allLeaderIds = getLeaderIds(version)
  const maxLeaderPoolSize = allLeaderIds.length
  if (!Number.isInteger(leaderPoolSize) || leaderPoolSize <= 0 || leaderPoolSize > maxLeaderPoolSize) {
    throw new Error(`Leader pool size must be between 1 and ${maxLeaderPoolSize}.`)
  }

  const pool = [...allLeaderIds]
  for (let index = 0; index < leaderPoolSize; index++) {
    const offset = Math.floor(random() * (pool.length - index))
    const swapIndex = index + offset
    const next = pool[swapIndex]
    if (!next) break
    pool[swapIndex] = pool[index]!
    pool[index] = next
  }

  return pool.slice(0, leaderPoolSize)
}
