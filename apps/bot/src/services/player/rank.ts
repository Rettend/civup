import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { PublicRank, PublicRankDivision } from '@civup/rating'
import type { CurrentRankAssignment, RankedRolePlayerPreview } from '../ranked/role-sync.ts'
import type { StatsContext } from '../stats/context.ts'
import { scopedPlayerRatings as playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { formatPublicRankLabel, getLeaderboardMinGames, publicRank, resolvePublicRating, roleRating } from '@civup/rating'
import { and, eq } from 'drizzle-orm'
import { previewRankedRoles } from '../ranked/role-sync.ts'
import { getConfiguredRankedRoleId, getConfiguredRankedRoleLabel, getLowestRankedRoleTier, getRankedRoleCalculationConfig, getRankedRoleConfig } from '../ranked/roles.ts'

export interface PlayerRatingSummary {
  playerId: string
  mode: string
  mu: number
  sigma: number
  publicRating: number | null
  gamesPlayed: number
  wins: number
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
  lastPlayedAt: number | null
}

export interface PlayerRankModeSummary {
  mode: LeaderboardMode
  tier: CompetitiveTier | null
  tierLabel: string | null
  tierRoleId: string | null
  division: PublicRankDivision
  rating: number | null
  gamesPlayed: number
  wins: number
  rank: number | null
  eligible: boolean
}

export interface PlayerRankProfile {
  overallTier: CompetitiveTier | null
  overallRoleId: string | null
  overallLabel: string | null
  overallRating: number | null
  overallDivision: PublicRankDivision
  modes: Record<LeaderboardMode, PlayerRankModeSummary>
}

export interface PlayerRankedRoleRepair {
  desiredRoleId: string
  managedRoleIds: string[]
}

export async function getPlayerStatsRankProfile(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  playerId: string,
  now = Date.now(),
): Promise<{ rankProfile: PlayerRankProfile, ratingRows: PlayerRatingSummary[], rankedRoleRepair: PlayerRankedRoleRepair | null }> {
  const style = await getRankedRoleCalculationConfig(kv, statsContext.guildId, statsContext.primaryGuildId)
  const [preview, ratingRows] = await Promise.all([
    previewRankedRoles({ db, kv, guildId: statsContext.guildId, statsContext, now, playerIds: [playerId], includePlayerIdentities: false, fullRosterGraceCaps: false, configOverride: style.config }),
    db.select().from(playerRatings).where(and(eq(playerRatings.statsKey, statsContext.statsKey), eq(playerRatings.playerId, playerId))),
  ])

  const previewPlayer = style.valid ? preview.playerPreviews.find(player => player.playerId === playerId) ?? null : null
  return {
    rankProfile: buildPlayerRankProfile(previewPlayer, ratingRows, preview.config, style.usesPrimaryStyle),
    ratingRows,
    rankedRoleRepair: style.valid && !style.usesPrimaryStyle ? buildPlayerRankedRoleRepair(previewPlayer, preview.config) : null,
  }
}

export async function getPlayerRankProfile(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  playerId: string,
  now = Date.now(),
): Promise<PlayerRankProfile> {
  const style = await getRankedRoleCalculationConfig(kv, statsContext.guildId, statsContext.primaryGuildId)
  const [preview, ratingRows] = await Promise.all([
    previewRankedRoles({ db, kv, guildId: statsContext.guildId, statsContext, now, playerIds: [playerId], includePlayerIdentities: false, fullRosterGraceCaps: false, configOverride: style.config }),
    db.select().from(playerRatings).where(and(eq(playerRatings.statsKey, statsContext.statsKey), eq(playerRatings.playerId, playerId))),
  ])

  const previewPlayer = style.valid ? preview.playerPreviews.find(player => player.playerId === playerId) ?? null : null
  return buildPlayerRankProfile(previewPlayer, ratingRows, preview.config, style.usesPrimaryStyle)
}

function buildPlayerRankProfile(
  previewPlayer: RankedRolePlayerPreview | null,
  ratingRows: PlayerRatingSummary[],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  suppressRoleMentions = false,
): PlayerRankProfile {
  const ratingByMode = new Map(ratingRows.flatMap((row) => {
    const mode = parseLeaderboardMode(row.mode)
    return mode ? [[mode, row] as const] : []
  }))
  const globalRating = ratingRows.find(row => row.mode === 'global') ?? null

  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const eligible = (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode)
    const resolvedRating = ratingRow ? resolvePublicRating(ratingRow.publicRating, ratingRow.mu) : null
    const rank = eligible && resolvedRating != null ? publicRank(resolvedRating) : null
    const tier = rank?.tier ?? null
    const tierLabel = tier ? getConfiguredRankedRoleLabel(config, tier) : null

    return [mode, {
      mode,
      tier,
      tierLabel: rank && tierLabel ? formatPublicRankLabel(tierLabel, rank) : 'Unranked',
      tierRoleId: tier && !suppressRoleMentions ? getConfiguredRankedRoleId(config, tier) : null,
      division: rank?.division ?? null,
      rating: resolvedRating == null ? null : Math.round(resolvedRating),
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      rank: previewPlayer?.ladderRanks[mode] ?? null,
      eligible,
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  const fallbackTier = getLowestRankedRoleTier(config)
  const overall = normalizeOverallAssignment(previewPlayer?.managed ? previewPlayer.assignment : null, previewPlayer?.managed ? fallbackTier : null)
  const overallRating = globalRating ? globalRating.publicRating ?? roleRating(globalRating.mu, globalRating.sigma) : null
  const overallRank = overall?.tier && overallRating != null
    ? publicRankForAssignedTier(overallRating, overall.tier)
    : null
  const overallTierLabel = overall?.tier ? getConfiguredRankedRoleLabel(config, overall.tier) : null

  return {
    overallTier: overall?.tier ?? null,
    overallRoleId: overall?.tier && !suppressRoleMentions ? getConfiguredRankedRoleId(config, overall.tier) : null,
    overallLabel: overallRank && overallTierLabel ? formatPublicRankLabel(overallTierLabel, overallRank) : 'Unranked',
    overallRating: overallRating == null ? null : Math.round(overallRating),
    overallDivision: overallRank?.division ?? null,
    modes,
  }
}

function publicRankForAssignedTier(rating: number, assignedTier: CompetitiveTier): Pick<PublicRank, 'division'> {
  const natural = publicRank(rating)
  if (natural.tier === assignedTier) return natural
  const assignedNumber = tierNumber(assignedTier)
  const naturalNumber = tierNumber(natural.tier)
  if (assignedNumber == null || naturalNumber == null || assignedNumber === 1 || assignedNumber === 5) return { division: null }
  return { division: assignedNumber < naturalNumber ? 3 : 1 }
}

function tierNumber(tier: CompetitiveTier): number | null {
  const value = Number(/^tier(\d+)$/i.exec(tier)?.[1])
  return Number.isFinite(value) ? Math.round(value) : null
}

function buildPlayerRankedRoleRepair(
  previewPlayer: RankedRolePlayerPreview | null,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): PlayerRankedRoleRepair | null {
  const assignment = previewPlayer?.previousAssignment
  if (!assignment) return null

  const desiredRoleId = getConfiguredRankedRoleId(config, assignment.tier)
  if (!desiredRoleId) return null

  const managedRoleIds = new Set(config.tiers.flatMap(tier => tier.roleId ? [tier.roleId] : []))
  if (assignment.appliedRoleId) managedRoleIds.add(assignment.appliedRoleId)

  return {
    desiredRoleId,
    managedRoleIds: [...managedRoleIds],
  }
}

function normalizeOverallAssignment(
  assignment: CurrentRankAssignment | null,
  fallbackTier: CompetitiveTier | null,
): { tier: CompetitiveTier } | null {
  if (assignment) return { tier: assignment.tier }
  if (fallbackTier) return { tier: fallbackTier }
  return null
}
