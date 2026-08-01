import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { CurrentRankAssignment, RankedRolePlayerPreview } from '../ranked/role-sync.ts'
import type { StatsContext } from '../stats/context.ts'
import { scopedPlayerRatings as playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { getLeaderboardMinGames, resolvePublicRating } from '@civup/rating'
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

  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const tier = previewPlayer?.ladderTiers[mode] ?? null

    return [mode, {
      mode,
      tier,
      tierLabel: tier ? getConfiguredRankedRoleLabel(config, tier) : 'Unranked',
      tierRoleId: tier && !suppressRoleMentions ? getConfiguredRankedRoleId(config, tier) : null,
      rating: ratingRow ? Math.round(resolvePublicRating(ratingRow.publicRating, ratingRow.mu)) : null,
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      rank: previewPlayer?.ladderRanks[mode] ?? null,
      eligible: (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode),
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  const fallbackTier = getLowestRankedRoleTier(config)
  const overall = normalizeOverallAssignment(previewPlayer?.managed ? previewPlayer.assignment : null, previewPlayer?.managed ? fallbackTier : null)

  return {
    overallTier: overall?.tier ?? null,
    overallRoleId: overall?.tier && !suppressRoleMentions ? getConfiguredRankedRoleId(config, overall.tier) : null,
    overallLabel: overall?.tier ? getConfiguredRankedRoleLabel(config, overall.tier) : 'Unranked',
    modes,
  }
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
