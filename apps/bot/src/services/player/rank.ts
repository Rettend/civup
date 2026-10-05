import type { CurrentRankAssignment, RankedRolePlayerPreview } from '../ranked/role-sync.ts'
import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { and, eq, getTableColumns } from 'drizzle-orm'
import { divisionRankStates, playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { displayRating, getLeaderboardMinGames, resolveOverallRank, visiblePublicRating } from '@civup/rating'
import { buildLeaderboardRankByPlayer } from '../leaderboard/rank.ts'
import { getStoredLeaderboardModeSnapshots } from '../leaderboard/snapshot.ts'
import { currentRankAssignmentsKey, normalizeRankedRoleAssignments, previewRankedRoles } from '../ranked/role-sync.ts'
import {
  getAssignedRankRoleId,
  getConfiguredDivisionLabel,
  getConfiguredRankedRoleId,
  getConfiguredRankedRoleLabel,
  getLowestRankedRoleTier,
  getRankedRoleConfig,
} from '../ranked/roles.ts'
import { projectPublicRatingDecay } from '../season/decay.ts'
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
  divisionMinimum?: number | null
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
  overallRating?: number | null
  divisionRoleIdsByMinimum?: Record<string, string>
  unrankedRoleId?: string | null
  roleIdsByTier?: Record<string, string | null>
  labelsByTier?: Record<string, string | null>
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
): Promise<{
  rankProfile: PlayerRankProfile
  ratingRows: PlayerRatingSummary[]
  rankedRoleRepair: PlayerRankedRoleRepair | null
}> {
  const [preview, ratingRows, season] = await Promise.all([
    previewRankedRoles({
      db,
      kv,
      guildId,
      now,
      playerIds: [playerId],
      includePlayerIdentities: false,
      fullRosterGraceCaps: false,
    }),
    db
      .select({ ...getTableColumns(playerRatings), divisionResult: divisionRankStates.resultJson })
      .from(playerRatings)
      .leftJoin(
        divisionRankStates,
        and(eq(divisionRankStates.playerId, playerRatings.playerId), eq(divisionRankStates.guildId, guildId)),
      )
      .where(eq(playerRatings.playerId, playerId)),
    getDisplaySeason(db),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  const saved = preview.config.divisionPolicy
    ? previewPlayer?.previousAssignment
    : normalizeRankedRoleAssignments(await kv.get(currentRankAssignmentsKey(guildId), 'json')).byPlayerId[playerId]
  const publicEra = season?.ratingSystem === 'rp' && season.publicReadsEnabled
  const displayRatings = await projectPublicRatingDecay(db, ratingRows, now, season)
  let displayPlayer =
    publicEra && !preview.config.divisionPolicy && previewPlayer && saved
      ? { ...previewPlayer, managed: !saved.unranked, assignment: saved }
      : previewPlayer
  const coherent = ratingRows[0]?.divisionResult
    ? (JSON.parse(ratingRows[0].divisionResult) as ReturnType<typeof resolveOverallRank>)
    : null
  if (coherent?.policyVersion === 'best-mode-one-division-v2' && displayPlayer)
    displayPlayer = {
      ...displayPlayer,
      managed: !!coherent.band,
      assignment: {
        ...displayPlayer.assignment,
        tier: coherent.band?.tier ?? 'tier5',
        unranked: !coherent.band,
        divisionMinimum: coherent.band?.minimum ?? null,
        sourceMode: coherent.sourceMode,
        policyVersion: coherent.policyVersion,
        overallRating: coherent.overallRating,
      },
    }
  const rankProfile = buildPlayerRankProfile(displayPlayer, displayRatings, preview.config, publicEra)
  if (publicEra) await attachPublicLeaderboardPositions(kv, rankProfile, playerId, season.seasonNumber)
  return {
    rankProfile,
    ratingRows: displayRatings,
    rankedRoleRepair: buildPlayerRankedRoleRepair(
      publicEra && previewPlayer ? { ...previewPlayer, previousAssignment: saved ?? null } : previewPlayer,
      preview.config,
    ),
  }
}

export async function getPlayerRankProfile(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  now = Date.now(),
): Promise<PlayerRankProfile> {
  if ((await getRankedRoleConfig(kv, guildId)).divisionPolicy)
    return (await getPlayerStatsRankProfile(db, kv, guildId, playerId, now)).rankProfile
  const [preview, ratingRows, season] = await Promise.all([
    previewRankedRoles({
      db,
      kv,
      guildId,
      now,
      playerIds: [playerId],
      includePlayerIdentities: false,
      fullRosterGraceCaps: false,
    }),
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getDisplaySeason(db),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  const publicEra = season?.ratingSystem === 'rp' && season.publicReadsEnabled
  const profile = buildPlayerRankProfile(
    previewPlayer,
    await projectPublicRatingDecay(db, ratingRows, now, season),
    preview.config,
    publicEra,
  )
  if (publicEra) await attachPublicLeaderboardPositions(kv, profile, playerId, season.seasonNumber)
  return profile
}

async function attachPublicLeaderboardPositions(
  kv: KVNamespace,
  profile: PlayerRankProfile,
  playerId: string,
  seasonNumber: number,
) {
  const modes = LEADERBOARD_MODES.filter(
    mode => mode !== 'red-death' && profile.modes[mode].gamesPlayed >= getLeaderboardMinGames(mode),
  )
  const snapshots = await getStoredLeaderboardModeSnapshots(kv, modes)
  for (const mode of LEADERBOARD_MODES) {
    const snapshot = snapshots.get(mode)
    profile.modes[mode].rank =
      snapshot?.ratingSystem === 'rp' && snapshot.seasonNumber === seasonNumber
        ? (buildLeaderboardRankByPlayer(snapshot).get(playerId) ?? null)
        : null
  }
}

function buildPlayerRankProfile(
  previewPlayer: RankedRolePlayerPreview | null,
  ratingRows: PlayerRatingSummary[],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  publicEra = false,
): PlayerRankProfile {
  const ratingByMode = new Map(
    ratingRows.flatMap(row => {
      const mode = parseLeaderboardMode(row.mode)
      return mode ? [[mode, row] as const] : []
    }),
  )

  const modes = Object.fromEntries(
    LEADERBOARD_MODES.map(mode => {
      const ratingRow = ratingByMode.get(mode)
      const global = ratingRows.find(row => row.mode === 'global')
      const modeBand =
        config.divisionPolicy && ratingRow?.publicRating != null && mode !== 'red-death'
          ? resolveOverallRank({
              modes: [
                {
                  mode,
                  rating: ratingRow.publicRating,
                  effectiveGames: ratingRow.effectiveGames,
                  heldMinimum: ratingRow.publicBadge,
                },
              ],
              recent: { at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 },
              lifetimeEliteWins: global?.winsVsTier1 ?? 0,
              lifetimeHighRankWins: global?.winsVsTier2Plus ?? 0,
              now: 0,
            }).band
          : null
      const tier = config.divisionPolicy ? (modeBand?.tier ?? null) : (previewPlayer?.ladderTiers[mode] ?? null)
      if (publicEra && ratingRow && ratingRow.publicRating == null) throw new Error('Public rating data is incomplete.')

      return [
        mode,
        {
          mode,
          tier,
          ...(config.divisionPolicy ? { divisionMinimum: modeBand?.minimum ?? null } : {}),
          tierLabel: modeBand
            ? getConfiguredDivisionLabel(config, modeBand.minimum)
            : tier
              ? getConfiguredRankedRoleLabel(config, tier)
              : 'Unranked',
          tierRoleId: modeBand
            ? (config.divisionPolicy!.roleIdsByMinimum[modeBand.minimum] ?? null)
            : tier
              ? getConfiguredRankedRoleId(config, tier)
              : null,
          rating: ratingRow
            ? publicEra
              ? visiblePublicRating(ratingRow.publicRating!)
              : Math.round(displayRating(ratingRow.mu, ratingRow.sigma))
            : null,
          gamesPlayed: ratingRow?.gamesPlayed ?? 0,
          wins: ratingRow?.wins ?? 0,
          rank: previewPlayer?.ladderRanks[mode] ?? null,
          eligible: config.divisionPolicy ? !!modeBand : (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode),
        } satisfies PlayerRankModeSummary,
      ]
    }),
  ) as Record<LeaderboardMode, PlayerRankModeSummary>

  const fallbackTier = getLowestRankedRoleTier(config)
  const overall = normalizeOverallAssignment(
    previewPlayer?.managed ? previewPlayer.assignment : null,
    previewPlayer?.managed ? fallbackTier : null,
  )

  return {
    ...(previewPlayer?.assignment.policyVersion === 'best-mode-one-division-v2' && overall?.tier === 'tier1'
      ? {
          overallRating: Math.max(
            ...Object.values(modes)
              .filter(mode => mode.tier === 'tier1' && mode.rating != null)
              .map(mode => mode.rating!),
          ),
        }
      : {}),
    divisionRoleIdsByMinimum: config.divisionPolicy?.roleIdsByMinimum,
    overallTier: overall?.tier ?? null,
    unrankedRoleId: config.unrankedRoleId,
    roleIdsByTier: Object.fromEntries(config.tiers.map((slot, index) => [`tier${index + 1}`, slot.roleId])),
    labelsByTier: Object.fromEntries(config.tiers.map((slot, index) => [`tier${index + 1}`, slot.label])),
    overallRoleId: previewPlayer?.managed
      ? getAssignedRankRoleId(config, previewPlayer.assignment)
      : (config.unrankedRoleId ?? null),
    overallLabel: config.divisionPolicy
      ? getConfiguredDivisionLabel(config, previewPlayer?.assignment.divisionMinimum ?? -1)
      : overall?.tier
        ? getConfiguredRankedRoleLabel(config, overall.tier)
        : 'Unranked',
    modes,
  }
}

function buildPlayerRankedRoleRepair(
  previewPlayer: RankedRolePlayerPreview | null,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): PlayerRankedRoleRepair | null {
  if (config.divisionPolicy) return null
  const assignment = previewPlayer?.previousAssignment
  if (!assignment) return null

  const desiredRoleId = getAssignedRankRoleId(config, assignment)
  if (!desiredRoleId) return null

  const managedRoleIds = new Set(config.tiers.flatMap(tier => (tier.roleId ? [tier.roleId] : [])))
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
