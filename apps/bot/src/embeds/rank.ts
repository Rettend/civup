import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { PlayerRankModeSummary, PlayerRankProfile } from '../services/player-rank.ts'
import type { SeasonRankHistoryEntry, SeasonRankHistoryModeSummary } from '../services/season-snapshot-roles.ts'
import { players } from '@civup/db'
import { formatLeaderboardModeLabel, LEADERBOARD_MODES } from '@civup/game'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'

export async function rankEmbed(
  db: Database,
  playerId: string,
  rankProfile: PlayerRankProfile,
  options: {
    activeSeason: { id: string, seasonNumber: number, name: string } | null
    seasonHistory: SeasonRankHistoryEntry[]
  },
): Promise<Embed> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)

  const displayName = player?.displayName ?? `<@${playerId}>`
  const activeSeason = options.activeSeason
  const currentSeasonName = activeSeason?.name ?? 'Current Rank'

  const pastSeasons = activeSeason
    ? options.seasonHistory.filter(entry => entry.seasonId !== activeSeason.id)
    : options.seasonHistory

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  pushSeasonFields(fields, currentSeasonName, {
    ffa: rankProfile.modes.ffa.gamesPlayed > 0 ? rankProfile.modes.ffa : undefined,
    duel: rankProfile.modes.duel.gamesPlayed > 0 ? rankProfile.modes.duel : undefined,
    teamers: rankProfile.modes.teamers.gamesPlayed > 0 ? rankProfile.modes.teamers : undefined,
  })

  for (const season of pastSeasons) {
    pushSeasonFields(fields, season.seasonName, season.modes)
  }

  if (fields.length === 0) {
    fields.push({
      name: 'Rank History',
      value: 'No ranked season data yet.',
      inline: false,
    })
  }

  const embed = new Embed()
    .title('Rank')
    .description(buildRankDescription(playerId, rankProfile))
    .color(0xC8AA6E)

  embed.footer({ text: displayName, icon_url: player?.avatarUrl ?? undefined })
  embed.fields(...fields)
  return embed
}

function buildRankDescription(playerId: string, rankProfile: PlayerRankProfile): string {
  if (rankProfile.overallRoleId) return `<@${playerId}> - <@&${rankProfile.overallRoleId}>`
  if (rankProfile.overallLabel) return `<@${playerId}> - ${rankProfile.overallLabel}`
  return `<@${playerId}>`
}

function formatModeSummary(mode: PlayerRankModeSummary | SeasonRankHistoryModeSummary): string {
  if (mode.rating == null || mode.gamesPlayed <= 0) return 'No ranked games yet.'

  const winRate = mode.gamesPlayed > 0
    ? Math.round((mode.wins / mode.gamesPlayed) * 100)
    : 0

  return [
    `Rating: ${formatModeRole(mode)} (${mode.rating})`,
    `Games: ${mode.gamesPlayed}`,
    `Wins: ${mode.wins} (${winRate}%)`,
  ].join('\n')
}

function formatModeRole(mode: PlayerRankModeSummary | SeasonRankHistoryModeSummary): string {
  if (mode.tierRoleId) return `<@&${mode.tierRoleId}>`
  return mode.tierLabel ?? 'Unranked'
}

function pushSeasonFields(
  fields: Array<{ name: string, value: string, inline?: boolean }>,
  seasonName: string,
  modes: Partial<Record<LeaderboardMode, PlayerRankModeSummary | SeasonRankHistoryModeSummary | undefined>>,
): void {
  const visibleModes = LEADERBOARD_MODES
    .map(mode => ({ mode, summary: modes[mode] }))
    .filter((entry): entry is { mode: LeaderboardMode, summary: PlayerRankModeSummary | SeasonRankHistoryModeSummary } => {
      return !!entry.summary && entry.summary.gamesPlayed > 0
    })

  if (visibleModes.length === 0) return

  fields.push({
    name: seasonName,
    value: '\u200B',
    inline: false,
  })

  for (const entry of visibleModes) {
    fields.push({
      name: formatLeaderboardModeLabel(entry.mode, entry.mode),
      value: formatModeSummary(entry.summary),
      inline: true,
    })
  }
}
