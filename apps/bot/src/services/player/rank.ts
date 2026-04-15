import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { CurrentRankAssignment, RankedRolePlayerPreview } from '../ranked/role-sync.ts'
import { playerRatings } from '@civup/db'
import { LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { displayRating, getLeaderboardMinGames } from '@civup/rating'
import { eq } from 'drizzle-orm'
import { previewRankedRoles } from '../ranked/role-sync.ts'
import { getConfiguredRankedRoleId, getConfiguredRankedRoleLabel, getLowestRankedRoleTier, getRankedRoleConfig } from '../ranked/roles.ts'

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
  now = Date.now(),
): Promise<{ rankProfile: PlayerRankProfile, ratingRows: PlayerRatingSummary[] }> {
  const [preview, ratingRows, config] = await Promise.all([
    previewRankedRoles({ db, kv, guildId, now, playerIds: [playerId], includePlayerIdentities: false }),
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getRankedRoleConfig(kv, guildId),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  return {
    rankProfile: buildPlayerRankProfile(previewPlayer, ratingRows, config),
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
  const [preview, ratingRows, config] = await Promise.all([
    previewRankedRoles({ db, kv, guildId, now, playerIds: [playerId], includePlayerIdentities: false }),
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    getRankedRoleConfig(kv, guildId),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  return buildPlayerRankProfile(previewPlayer, ratingRows, config)
}

function buildPlayerRankProfile(
  previewPlayer: RankedRolePlayerPreview | null,
  ratingRows: PlayerRatingSummary[],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
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
      tierRoleId: tier ? getConfiguredRankedRoleId(config, tier) : null,
      rating: ratingRow ? Math.round(displayRating(ratingRow.mu, ratingRow.sigma)) : null,
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      eligible: (ratingRow?.gamesPlayed ?? 0) >= getLeaderboardMinGames(mode),
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  const fallbackTier = getLowestRankedRoleTier(config)
  const overall = normalizeOverallAssignment(previewPlayer?.assignment ?? null, fallbackTier)

  return {
    overallTier: overall?.tier ?? null,
    overallRoleId: overall?.tier ? getConfiguredRankedRoleId(config, overall.tier) : null,
    overallLabel: overall?.tier ? getConfiguredRankedRoleLabel(config, overall.tier) : 'Unranked',
    modes,
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
