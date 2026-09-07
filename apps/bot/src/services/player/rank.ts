import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { CurrentRankAssignment, RankedRolePlayerPreview } from '../ranked/role-sync.ts'
import { playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { displayRating, getLeaderboardMinGames, visiblePublicRating } from '@civup/rating'
import { eq } from 'drizzle-orm'
import { currentRankAssignmentsKey, normalizeRankedRoleAssignments, previewRankedRoles } from '../ranked/role-sync.ts'
import { projectPublicRatingDecay } from '../season/decay.ts'
import { getConfiguredRankedRoleId, getConfiguredRankedRoleLabel, getLowestRankedRoleTier, getRankedRoleConfig } from '../ranked/roles.ts'
import { getDisplaySeason } from '../season/index.ts'

export interface PlayerRatingSummary {
  playerId: string
  mode: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
  lastPlayedAt: number | null
  publicRating?: number | null
  publicBadge?: number | null
  lifetimeGamesPlayed?: number
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
  unrankedRoleId?: string | null
  roleIdsByTier?: Record<string, string | null>
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
  guildId: string,
  playerId: string,
  now = Date.now(),
): Promise<{ rankProfile: PlayerRankProfile, ratingRows: PlayerRatingSummary[], rankedRoleRepair: PlayerRankedRoleRepair | null }> {
  const [preview, ratingRows, season, savedAssignments] = await Promise.all([
    previewRankedRoles({ db, kv, guildId, now, playerIds: [playerId], includePlayerIdentities: false, fullRosterGraceCaps: false }),
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getDisplaySeason(db),
    kv.get(currentRankAssignmentsKey(guildId), 'json').then(normalizeRankedRoleAssignments),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  const saved = savedAssignments.byPlayerId[playerId]
  const publicEra = season?.ratingSystem === 'rp' && season.publicReadsEnabled
  const displayRatings = await projectPublicRatingDecay(db, ratingRows, now, season)
  const displayPlayer = publicEra && previewPlayer && saved
    ? { ...previewPlayer, managed: !saved.unranked, assignment: saved }
    : previewPlayer
  return {
    rankProfile: buildPlayerRankProfile(displayPlayer, displayRatings, preview.config, publicEra),
    ratingRows: displayRatings,
    rankedRoleRepair: buildPlayerRankedRoleRepair(publicEra && previewPlayer ? { ...previewPlayer, previousAssignment: saved ?? null } : previewPlayer, preview.config),
  }
}

export async function getPlayerRankProfile(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  now = Date.now(),
): Promise<PlayerRankProfile> {
  const [preview, ratingRows, season] = await Promise.all([
    previewRankedRoles({ db, kv, guildId, now, playerIds: [playerId], includePlayerIdentities: false, fullRosterGraceCaps: false }),
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getDisplaySeason(db),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  return buildPlayerRankProfile(previewPlayer, await projectPublicRatingDecay(db, ratingRows, now, season), preview.config, season?.ratingSystem === 'rp' && season.publicReadsEnabled)
}

function buildPlayerRankProfile(
  previewPlayer: RankedRolePlayerPreview | null,
  ratingRows: PlayerRatingSummary[],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  publicEra = false,
): PlayerRankProfile {
  const ratingByMode = new Map(ratingRows.flatMap((row) => {
    const mode = parseLeaderboardMode(row.mode)
    return mode ? [[mode, row] as const] : []
  }))

  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const tier = previewPlayer?.ladderTiers[mode] ?? null
    if (publicEra && ratingRow && ratingRow.publicRating == null) throw new Error('Public rating data is incomplete.')

    return [mode, {
      mode,
      tier,
      tierLabel: tier ? getConfiguredRankedRoleLabel(config, tier) : 'Unranked',
      tierRoleId: tier ? getConfiguredRankedRoleId(config, tier) : null,
      rating: ratingRow ? publicEra ? visiblePublicRating(ratingRow.publicRating!) : Math.round(displayRating(ratingRow.mu, ratingRow.sigma)) : null,
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
    unrankedRoleId: config.unrankedRoleId,
    roleIdsByTier: Object.fromEntries(config.tiers.map((slot, index) => [`tier${index + 1}`, slot.roleId])),
    overallRoleId: overall?.tier ? getConfiguredRankedRoleId(config, overall.tier) : config.unrankedRoleId ?? null,
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

  const desiredRoleId = assignment.unranked ? config.unrankedRoleId : getConfiguredRankedRoleId(config, assignment.tier)
  if (!desiredRoleId) return null

  const managedRoleIds = new Set(config.tiers.flatMap(tier => tier.roleId ? [tier.roleId] : []))
  if (config.unrankedRoleId) managedRoleIds.add(config.unrankedRoleId)
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
