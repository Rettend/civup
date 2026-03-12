import type { GameMode } from './types.ts'
import { allLeaderIds } from './leaders.ts'
import { defaultPlayerCount } from './mode.ts'

const VERSUS_DEFAULT_LEADER_POOL_BASE = 16
const VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER = 4
const VERSUS_MINIMUM_LEADER_POOL_BASE = 6

const FFA_DEFAULT_PLAYER_FLOOR = 6
const FFA_DEFAULT_POOL_MULTIPLIER = 4

export const MAX_LEADER_POOL_SIZE = allLeaderIds.length

/** Default leader pool size for a mode before any lobby override. */
export function getDefaultLeaderPoolSize(
  mode: GameMode,
  playerCount: number = defaultPlayerCount(mode),
): number {
  if (mode !== 'ffa') {
    const fullLobbyPlayerCount = Math.max(1, defaultPlayerCount(mode))
    return Math.min(
      MAX_LEADER_POOL_SIZE,
      VERSUS_DEFAULT_LEADER_POOL_BASE + fullLobbyPlayerCount * VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER,
    )
  }

  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))
  const scaledPlayerCount = Math.max(FFA_DEFAULT_PLAYER_FLOOR, normalizedPlayerCount)
  return Math.min(MAX_LEADER_POOL_SIZE, scaledPlayerCount * FFA_DEFAULT_POOL_MULTIPLIER)
}

/** Smallest playable leader pool for a finished draft lobby. */
export function getMinimumLeaderPoolSize(mode: GameMode, playerCount: number): number {
  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))

  if (mode === 'ffa') return normalizedPlayerCount * 2
  return VERSUS_MINIMUM_LEADER_POOL_BASE + normalizedPlayerCount
}

/** Resolve a lobby override against the mode default. */
export function resolveLeaderPoolSize(
  mode: GameMode,
  playerCount: number,
  leaderPoolSize: number | null | undefined,
): number {
  return leaderPoolSize ?? getDefaultLeaderPoolSize(mode, playerCount)
}

/** Pick a random unique leader subset from the full roster. */
export function sampleLeaderPool(
  leaderPoolSize: number,
  random: () => number = Math.random,
): string[] {
  if (!Number.isInteger(leaderPoolSize) || leaderPoolSize <= 0 || leaderPoolSize > MAX_LEADER_POOL_SIZE) {
    throw new Error(`Leader pool size must be between 1 and ${MAX_LEADER_POOL_SIZE}.`)
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
