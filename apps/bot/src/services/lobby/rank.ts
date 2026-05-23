import type { CompetitiveTier, GameMode, LeaderDataVersion } from '@civup/game'
import type { RankedRoleAssignments } from '../ranked/role-sync.ts'
import { DEFAULT_LEADER_POOL_RANK_TIER, getDefaultLeaderPoolSize, resolveAverageLeaderPoolRankTier } from '@civup/game'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'

export interface LobbyRankSnapshot {
  tier: CompetitiveTier
  leaderPoolSize: number | null
}

export async function buildLobbyRankSnapshot(
  kv: KVNamespace,
  guildId: string | null | undefined,
  playerIds: readonly string[],
  options: {
    mode: GameMode
    playerCount: number
    leaderDataVersion: LeaderDataVersion
    redDeath: boolean
    assignments?: RankedRoleAssignments | null
  },
): Promise<LobbyRankSnapshot | null> {
  if (options.redDeath) return null

  const tier = await resolveLobbyRankTier(kv, guildId, playerIds, options.assignments)
  return {
    tier,
    leaderPoolSize: getDefaultLeaderPoolSize(options.mode, options.playerCount, options.leaderDataVersion, tier),
  }
}

export async function resolveLobbyRankTier(
  kv: KVNamespace,
  guildId: string | null | undefined,
  playerIds: readonly string[],
  assignments?: RankedRoleAssignments | null,
): Promise<CompetitiveTier> {
  const resolvedAssignments = assignments === undefined && guildId
    ? await getCurrentRankAssignments(kv, guildId)
    : assignments ?? null
  const tiers = playerIds.map(playerId => resolvedAssignments?.byPlayerId[playerId]?.tier ?? null)
  if (tiers.every(tier => tier == null)) return DEFAULT_LEADER_POOL_RANK_TIER
  return resolveAverageLeaderPoolRankTier(tiers)
}
