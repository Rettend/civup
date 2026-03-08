import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { playerRatings } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { displayRating, LEADERBOARD_MIN_GAMES } from '@civup/rating'
import { eq } from 'drizzle-orm'
import { previewRankedRoles } from '../ranked/role-sync.ts'
import { getConfiguredRankedRoleLabel, getRankedRoleConfig } from '../ranked/roles.ts'

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

export async function getPlayerRankProfile(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  now = Date.now(),
): Promise<PlayerRankProfile> {
  const [ratingRows, preview, config] = await Promise.all([
    db.select().from(playerRatings).where(eq(playerRatings.playerId, playerId)),
    previewRankedRoles({ db, kv, guildId, now }),
    getRankedRoleConfig(kv, guildId),
  ])

  const previewPlayer = preview.playerPreviews.find(player => player.playerId === playerId) ?? null
  const ratingByMode = new Map(ratingRows.map(row => [row.mode as LeaderboardMode, row]))

  const modes = Object.fromEntries(LEADERBOARD_MODES.map((mode) => {
    const ratingRow = ratingByMode.get(mode)
    const eligible = (ratingRow?.gamesPlayed ?? 0) >= LEADERBOARD_MIN_GAMES
    const tier = previewPlayer?.ladderTiers[mode] ?? null

    return [mode, {
      mode,
      tier,
      tierLabel: tier && config.currentRoles[tier] ? getConfiguredRankedRoleLabel(config, tier) : 'Unranked',
      tierRoleId: tier && config.currentRoles[tier] ? config.currentRoles[tier] ?? null : null,
      rating: ratingRow ? Math.round(displayRating(ratingRow.mu, ratingRow.sigma)) : null,
      gamesPlayed: ratingRow?.gamesPlayed ?? 0,
      wins: ratingRow?.wins ?? 0,
      eligible,
    } satisfies PlayerRankModeSummary]
  })) as Record<LeaderboardMode, PlayerRankModeSummary>

  const overallTier = previewPlayer?.assignment.tier ?? null
  return {
    overallTier,
    overallRoleId: overallTier ? config.currentRoles[overallTier] ?? null : null,
    overallLabel: overallTier && config.currentRoles[overallTier] ? getConfiguredRankedRoleLabel(config, overallTier) : 'Unranked',
    modes,
  }
}
