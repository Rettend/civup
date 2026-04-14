import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { LeaderboardModeSnapshot, LeaderboardSnapshotRow } from '../leaderboard/snapshot.ts'
import { playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { displayRating, getLeaderboardMinGames, RANKED_ROLE_MIN_GAMES } from '@civup/rating'
import { and, eq, gt } from 'drizzle-orm'
import { playerRatingSeeds } from '@civup/db'
import { ensureLeaderboardModeSnapshots } from '../leaderboard/snapshot.ts'
import { getCurrentRankAssignments, previewRankedRoles } from '../ranked/role-sync.ts'
import { getConfiguredRankedRoleId, getConfiguredRankedRoleLabel, getLowestRankedRoleTier, getRankedRoleConfig, hasConfiguredRankedRoleTier } from '../ranked/roles.ts'

const EARN_CUMULATIVE_PERCENT_ANCHORS = [0.015, 0.055, 0.155, 0.355] as const
const KEEP_CUMULATIVE_PERCENT_BUFFER_PER_TIER = 0.005
const TIER_UNLOCK_MIN_PLAYER_ANCHORS = [80, 40, 20, 8] as const

export interface PlayerRatingSummary {
  playerId: string
  mode: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

export interface PlayerRankModeSummary {
  mode: LeaderboardMode
  tier: CompetitiveTier | null
  tierLabel: string | null
  tierRoleId: string | null
  rating: number | null
  gamesPlayed: number
  wins: number
  eligible: boolean
}

export interface PlayerRankProfile {
  overallTier: CompetitiveTier | null
  overallRoleId: string | null
  overallLabel: string | null
  modes: Record<LeaderboardMode, PlayerRankModeSummary>
}

export async function getPlayerStatsRankProfile(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
): Promise<{ rankProfile: PlayerRankProfile, ratingRows: PlayerRatingSummary[] }> {
  const [ratingRows, leaderboardSnapshots, currentAssignments, config, seedOverrides] = await Promise.all([
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    ensureLeaderboardModeSnapshots(db, kv),
    getCurrentRankAssignments(kv, guildId),
    getRankedRoleConfig(kv, guildId),
    db
      .select({ playerId: playerRatingSeeds.playerId, mode: playerRatingSeeds.mode })
      .from(playerRatingSeeds)
      .innerJoin(playerRatings, and(
        eq(playerRatings.playerId, playerRatingSeeds.playerId),
        eq(playerRatings.mode, playerRatingSeeds.mode),
      ))
      .where(and(
        eq(playerRatingSeeds.eligibleForRanked, true),
        gt(playerRatings.gamesPlayed, 0),
      )),
  ])

  const ratingByMode = new Map(ratingRows.flatMap((row) => {
    const mode = parseLeaderboardMode(row.mode)
    return mode ? [[mode, row] as const] : []
  }))
  const fallbackTier = getLowestRankedRoleTier(config)
  const maxModeGamesByPlayerId = buildMaxModeGamesByPlayerId(leaderboardSnapshots)
  const protectedUnlockPopulationCountsByMode = countProtectedUnlockPlayersByMode(
    currentAssignments,
    config,
    fallbackTier,
    maxModeGamesByPlayerId,
  )
  const rankedEligibilityOverrideKeys = new Set(seedOverrides.flatMap((row) => {
    const mode = parseLeaderboardMode(row.mode)
    return mode ? [rankEligibilityOverrideKey(row.playerId, mode)] : []
  }))

  const overallTier = resolveOverallTier(currentAssignments.byPlayerId[playerId] ?? null, config)
  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const eligible = (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode)
      || rankedEligibilityOverrideKeys.has(rankEligibilityOverrideKey(playerId, mode))
    const tier = resolveModeTier({
      playerId,
      mode,
      snapshot: leaderboardSnapshots.get(mode) ?? null,
      config,
      protectedUnlockPopulationCount: protectedUnlockPopulationCountsByMode.get(mode) ?? 0,
      rankedEligibilityOverrideKeys,
    })

    return [mode, {
      mode,
      tier,
      tierLabel: tier ? getConfiguredRankedRoleLabel(config, tier) : 'Unranked',
      tierRoleId: tier ? getConfiguredRankedRoleId(config, tier) : null,
      rating: ratingRow ? Math.round(displayRating(ratingRow.mu, ratingRow.sigma)) : null,
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      eligible,
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  return {
    rankProfile: {
      overallTier,
      overallRoleId: overallTier ? getConfiguredRankedRoleId(config, overallTier) : null,
      overallLabel: overallTier ? getConfiguredRankedRoleLabel(config, overallTier) : 'Unranked',
      modes,
    },
    ratingRows,
  }
}

export async function getPlayerRankProfile(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  now = Date.now(),
): Promise<PlayerRankProfile> {
  const preview = await previewRankedRoles({ db, kv, guildId, now, playerIds: [playerId], includePlayerIdentities: false })
  const [ratingRows, config] = await Promise.all([
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getRankedRoleConfig(kv, guildId),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  const ratingByMode = new Map(ratingRows.flatMap((row) => {
    const mode = parseLeaderboardMode(row.mode)
    return mode ? [[mode, row] as const] : []
  }))

  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const eligible = (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode)
    const tier = previewPlayer?.ladderTiers[mode] ?? null

    return [mode, {
      mode,
      tier,
      tierLabel: tier ? getConfiguredRankedRoleLabel(config, tier) : 'Unranked',
      tierRoleId: tier ? getConfiguredRankedRoleId(config, tier) : null,
      rating: ratingRow ? Math.round(displayRating(ratingRow.mu, ratingRow.sigma)) : null,
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      eligible,
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  const fallbackTier = getLowestRankedRoleTier(config)
  const overallTier = previewPlayer?.assignment.tier ?? fallbackTier
  return {
    overallTier,
    overallRoleId: overallTier ? getConfiguredRankedRoleId(config, overallTier) : null,
    overallLabel: overallTier ? getConfiguredRankedRoleLabel(config, overallTier) : 'Unranked',
    modes,
  }
}

function resolveOverallTier(
  assignment: { tier: CompetitiveTier } | null,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): CompetitiveTier | null {
  if (assignment && hasConfiguredRankedRoleTier(config, assignment.tier)) return assignment.tier
  return getLowestRankedRoleTier(config)
}

function buildMaxModeGamesByPlayerId(
  leaderboardSnapshots: Map<LeaderboardMode, LeaderboardModeSnapshot>,
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const snapshot of leaderboardSnapshots.values()) {
    for (const row of snapshot.rows) {
      if (!isDiscordSnowflake(row.playerId)) continue
      totals.set(row.playerId, Math.max(totals.get(row.playerId) ?? 0, row.gamesPlayed))
    }
  }
  return totals
}

function countProtectedUnlockPlayersByMode(
  previousAssignments: Awaited<ReturnType<typeof getCurrentRankAssignments>>,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  fallbackTier: CompetitiveTier | null,
  maxModeGamesByPlayerId: Map<string, number>,
): Map<LeaderboardMode, number> {
  const counts = new Map<LeaderboardMode, number>()
  for (const mode of LEADERBOARD_MODES) counts.set(mode, 0)

  for (const [playerId, assignment] of Object.entries(previousAssignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    if (!hasConfiguredRankedRoleTier(config, assignment.tier)) continue
    if (fallbackTier && assignment.tier === fallbackTier) continue
    if ((assignment.protectedUntilTotalGames ?? 0) <= (maxModeGamesByPlayerId.get(playerId) ?? 0)) continue
    if (!assignment.sourceMode || !LEADERBOARD_MODES.includes(assignment.sourceMode)) continue
    counts.set(assignment.sourceMode, (counts.get(assignment.sourceMode) ?? 0) + 1)
  }

  return counts
}

function resolveModeTier(input: {
  playerId: string
  mode: LeaderboardMode
  snapshot: LeaderboardModeSnapshot | null
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>
  protectedUnlockPopulationCount: number
  rankedEligibilityOverrideKeys: Set<string>
}): CompetitiveTier | null {
  const snapshotRows = input.snapshot?.rows ?? []
  if (snapshotRows.length === 0) return null

  const rankedEntries = snapshotRows
    .filter(row => row.gamesPlayed >= getLeaderboardMinGames(input.mode) || input.rankedEligibilityOverrideKeys.has(rankEligibilityOverrideKey(row.playerId, input.mode)))
    .filter(row => isDiscordSnowflake(row.playerId))
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)

  const qualifiedPlayerIds = new Set(snapshotRows
    .filter(row => row.gamesPlayed >= RANKED_ROLE_MIN_GAMES || input.rankedEligibilityOverrideKeys.has(rankEligibilityOverrideKey(row.playerId, input.mode)))
    .map(row => row.playerId))

  if (!qualifiedPlayerIds.has(input.playerId)) return null

  const rankedCount = rankedEntries.length
  if (rankedCount === 0) return null

  const playerIndex = rankedEntries.findIndex(entry => entry.playerId === input.playerId)
  if (playerIndex < 0) return null

  const unlockPopulationCount = Math.max(rankedCount, input.protectedUnlockPopulationCount)
  let start = 0
  for (const threshold of buildRankedTierThresholds(input.config)) {
    if (unlockPopulationCount < threshold.unlockMinPlayers) continue

    let size = Math.round(rankedCount * threshold.earnPercent)
    if (threshold.minimumCountWhenUnlocked > 0) size = Math.max(threshold.minimumCountWhenUnlocked, size)
    size = Math.max(0, Math.min(size, rankedCount - start))

    if (playerIndex >= start && playerIndex < start + size) return threshold.tier
    start += size
  }

  return getLowestRankedRoleTier(input.config)
}

function buildRankedTierThresholds(config: Awaited<ReturnType<typeof getRankedRoleConfig>>) {
  const prestigeTierCount = Math.max(0, config.tiers.length - 1)
  if (prestigeTierCount <= 0) return []

  let previousEarnPercent = 0
  return Array.from({ length: prestigeTierCount }, (_value, index) => {
    const progress = prestigeTierCount <= 1 ? 1 : index / (prestigeTierCount - 1)
    const cumulativeEarnPercent = interpolatePositiveAnchors(EARN_CUMULATIVE_PERCENT_ANCHORS, progress)
    const threshold = {
      tier: `tier${index + 1}` as CompetitiveTier,
      earnPercent: Math.max(0, cumulativeEarnPercent - previousEarnPercent),
      keepCumulativePercent: Math.min(1, cumulativeEarnPercent + (KEEP_CUMULATIVE_PERCENT_BUFFER_PER_TIER * (index + 1))),
      unlockMinPlayers: Math.max(0, Math.round(interpolatePositiveAnchors(TIER_UNLOCK_MIN_PLAYER_ANCHORS, progress))),
      minimumCountWhenUnlocked: index < Math.min(2, prestigeTierCount) ? 1 : 0,
    }
    previousEarnPercent = cumulativeEarnPercent
    return threshold
  })
}

function compareLadderEntry(
  left: { playerId: string, score: number, lastPlayedAt: number | null },
  right: { playerId: string, score: number, lastPlayedAt: number | null },
): number {
  if (right.score !== left.score) return right.score - left.score
  if ((right.lastPlayedAt ?? 0) !== (left.lastPlayedAt ?? 0)) return (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)
  return left.playerId.localeCompare(right.playerId)
}

function interpolatePositiveAnchors(values: readonly number[], progress: number): number {
  if (values.length === 0) return 0
  if (values.length === 1) return values[0] ?? 0

  const bounded = Math.max(0, Math.min(1, progress))
  const scaled = bounded * (values.length - 1)
  const leftIndex = Math.floor(scaled)
  const rightIndex = Math.min(values.length - 1, leftIndex + 1)
  const mix = scaled - leftIndex
  const left = values[leftIndex] ?? values[0] ?? 0
  const right = values[rightIndex] ?? left
  if (left <= 0 || right <= 0) return left + (right - left) * mix
  return Math.exp(Math.log(left) + (Math.log(right) - Math.log(left)) * mix)
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}

function rankEligibilityOverrideKey(playerId: string, mode: LeaderboardMode): string {
  return `${playerId}:${mode}`
}
