import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { PlayerRankModeSummary, PlayerRankProfile } from '../services/player/rank.ts'
import type { SeasonRankHistoryEntry, SeasonRankHistoryModeSummary } from '../services/season/snapshot-roles.ts'
import { players } from '@civup/db'
import { formatLeaderboardModeLabel, LEADERBOARD_MODES } from '@civup/game'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { formatSeasonShortName } from '../services/season/index.ts'

export async function rankEmbed(
  db: Database,
  playerId: string,
  rankProfile: PlayerRankProfile,
  options: {
    activeSeason: { id: string, seasonNumber: number, name: string } | null
    seasonHistory: SeasonRankHistoryEntry[]
    visibleModes?: readonly LeaderboardMode[]
  },
): Promise<Embed> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)

  const displayName = player?.displayName ?? `<@${playerId}>`
  const activeSeason = options.activeSeason
  const visibleModes = options.visibleModes ?? LEADERBOARD_MODES

  const pastSeasons = activeSeason
    ? options.seasonHistory.filter(entry => entry.seasonId !== activeSeason.id)
    : options.seasonHistory

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  if (activeSeason) {
    pushSeasonFields(fields, formatSeasonShortName(activeSeason.seasonNumber), {
      duel: rankProfile.modes.duel.rating != null ? rankProfile.modes.duel : undefined,
      duo: rankProfile.modes.duo.rating != null ? rankProfile.modes.duo : undefined,
      squad: rankProfile.modes.squad.rating != null ? rankProfile.modes.squad : undefined,
      ffa: rankProfile.modes.ffa.rating != null ? rankProfile.modes.ffa : undefined,
    }, visibleModes, { emptyValue: 'No ranked games yet.' })
  }

  for (const season of pastSeasons) {
    pushSeasonFields(fields, formatSeasonShortName(season.seasonNumber), season.modes, visibleModes)
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
  if (mode.rating == null) return 'No ranked games yet.'

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
  seasonLabel: string,
  modes: Partial<Record<LeaderboardMode, PlayerRankModeSummary | SeasonRankHistoryModeSummary | undefined>>,
  visibleModeOrder: readonly LeaderboardMode[],
  options: { emptyValue?: string } = {},
): boolean {
  const visibleModes = visibleModeOrder
    .map(mode => ({ mode, summary: modes[mode] }))
    .filter((entry): entry is { mode: LeaderboardMode, summary: PlayerRankModeSummary | SeasonRankHistoryModeSummary } => {
      return !!entry.summary && entry.summary.rating != null
    })

  if (visibleModes.length === 0) {
    if (!options.emptyValue) return false
    pushInlineSeasonRow(fields, seasonLabel, [{ name: '\u200B', value: options.emptyValue, inline: true }])
    return true
  }

  for (let index = 0; index < visibleModes.length; index += 2) {
    const chunk = visibleModes.slice(index, index + 2)
    pushInlineSeasonRow(fields, seasonLabel, chunk.map(entry => ({
      name: formatLeaderboardModeLabel(entry.mode, entry.mode),
      value: formatModeSummary(entry.summary),
      inline: true,
    })))
  }

  return true
}

function pushInlineSeasonRow(
  fields: Array<{ name: string, value: string, inline?: boolean }>,
  seasonLabel: string,
  rowFields: Array<{ name: string, value: string, inline?: boolean }>,
): void {
  fields.push({ name: seasonLabel, value: '\u200B', inline: true })
  fields.push(...rowFields)
  while (fields.length % 3 !== 0) fields.push({ name: '\u200B', value: '\u200B', inline: true })
}
