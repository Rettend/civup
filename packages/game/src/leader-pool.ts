import type { RandomSource } from './random.ts'
import type { CompetitiveTier, GameMode, LeaderDataVersion } from './types.ts'
import { DEFAULT_BANS_PER_TEAM, normalizeBansPerTeam } from './constants.ts'
import { getLeaderIds } from './leader-registry.ts'
import { defaultPlayerCount, teamCount } from './mode.ts'
import { competitiveTierNumber } from './types.ts'

const VERSUS_DEFAULT_LEADER_POOL_BASE = 24
const VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER = 4

const FFA_DEFAULT_PLAYER_FLOOR = 6
const FFA_DEFAULT_POOL_MULTIPLIER = 6
const FFA_MINIMUM_POOL_MULTIPLIER = 3
const LEADER_POOL_RANK_STEP_SIZE = 2
const VERSUS_DEFAULT_RANK_NUMBER = 5
const FFA_DEFAULT_RANK_NUMBER = 3

export const DEFAULT_LEADER_POOL_RANK_TIER: CompetitiveTier = 'tier5'

export const MAX_LEADER_POOL_SIZE = Math.max(getLeaderIds('live').length, getLeaderIds('beta').length)

export function getMaxLeaderPoolSize(version: LeaderDataVersion = 'live'): number {
  return getLeaderIds(version).length
}

/** Default leader pool size for a mode before any lobby override. */
export function getDefaultLeaderPoolSize(
  mode: GameMode,
  playerCount: number = defaultPlayerCount(mode),
  version: LeaderDataVersion = 'live',
  rankTier: CompetitiveTier | null | undefined = DEFAULT_LEADER_POOL_RANK_TIER,
): number {
  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))
  const maxLeaderPoolSize = getMaxLeaderPoolSize(version)
  const baseSize = mode === 'ffa'
    ? Math.max(FFA_DEFAULT_PLAYER_FLOOR, normalizedPlayerCount) * FFA_DEFAULT_POOL_MULTIPLIER
    : VERSUS_DEFAULT_LEADER_POOL_BASE + normalizedPlayerCount * VERSUS_DEFAULT_LEADER_POOL_PER_PLAYER
  const adjustedSize = baseSize + getLeaderPoolRankAdjustment(mode, rankTier)
  const minimumSize = getMinimumLeaderPoolSize(mode, normalizedPlayerCount)

  return Math.min(maxLeaderPoolSize, Math.max(minimumSize, adjustedSize))
}

/** Smallest playable leader pool for a finished draft lobby. */
export function getMinimumLeaderPoolSize(mode: GameMode, playerCount: number, bansPerTeam: number = DEFAULT_BANS_PER_TEAM): number {
  const normalizedPlayerCount = Math.max(1, Math.round(playerCount))

  if (mode === 'ffa') return normalizedPlayerCount * FFA_MINIMUM_POOL_MULTIPLIER
  return normalizedPlayerCount + teamCount(mode, normalizedPlayerCount) * normalizeBansPerTeam(bansPerTeam)
}

/** Resolve a lobby override against the mode default. */
export function resolveLeaderPoolSize(
  mode: GameMode,
  playerCount: number,
  leaderPoolSize: number | null | undefined,
  version: LeaderDataVersion = 'live',
  rankTier: CompetitiveTier | null | undefined = DEFAULT_LEADER_POOL_RANK_TIER,
): number {
  return leaderPoolSize ?? getDefaultLeaderPoolSize(mode, playerCount, version, rankTier)
}

export function resolveAverageLeaderPoolRankTier(tiers: readonly (CompetitiveTier | null | undefined)[]): CompetitiveTier {
  if (tiers.length === 0) return DEFAULT_LEADER_POOL_RANK_TIER

  const averageRank = tiers.reduce((total, tier) => total + leaderPoolRankNumber(tier), 0) / tiers.length
  return rankNumberToLeaderPoolTier(Math.round(averageRank))
}

export function formatLeaderPoolRankLabel(tier: CompetitiveTier | null | undefined): string {
  return `rank${leaderPoolRankNumber(tier)}`
}

function getLeaderPoolRankAdjustment(mode: GameMode, tier: CompetitiveTier | null | undefined): number {
  const baseline = mode === 'ffa' ? FFA_DEFAULT_RANK_NUMBER : VERSUS_DEFAULT_RANK_NUMBER
  return (leaderPoolRankNumber(tier) - baseline) * LEADER_POOL_RANK_STEP_SIZE
}

function leaderPoolRankNumber(tier: CompetitiveTier | null | undefined): number {
  const number = tier ? competitiveTierNumber(tier) : null
  if (number == null) return VERSUS_DEFAULT_RANK_NUMBER
  return Math.max(1, Math.min(5, number))
}

function rankNumberToLeaderPoolTier(rank: number): CompetitiveTier {
  const clamped = Math.max(1, Math.min(5, Math.round(rank)))
  return `tier${clamped}`
}

/** Pick a random unique leader subset from the full roster. */
export function sampleLeaderPool(
  leaderPoolSize: number,
  random: RandomSource = Math.random,
  version: LeaderDataVersion = 'live',
  excludedLeaderIds: readonly string[] = [],
): string[] {
  const allLeaderIds = getEligibleLeaderIds(version, excludedLeaderIds)
  const maxLeaderPoolSize = allLeaderIds.length
  if (!Number.isInteger(leaderPoolSize) || leaderPoolSize <= 0 || leaderPoolSize > maxLeaderPoolSize) {
    throw new Error(`Only ${maxLeaderPoolSize} eligible leaders remain after automatic exclusions; reduce the leader pool or exclusions.`)
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

export function getEligibleLeaderIds(
  version: LeaderDataVersion = 'live',
  excludedLeaderIds: readonly string[] = [],
): string[] {
  const allLeaderIds = getLeaderIds(version)
  const available = new Set(allLeaderIds)
  const excluded = new Set<string>()
  for (const leaderId of excludedLeaderIds) {
    if (!available.has(leaderId)) throw new Error(`Leader ${leaderId} is not available in the selected leader data version.`)
    excluded.add(leaderId)
  }
  return allLeaderIds.filter(leaderId => !excluded.has(leaderId))
}
