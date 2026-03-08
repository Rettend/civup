import type { Database } from '@civup/db'
import { players } from '@civup/db'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'
import type { PlayerRankModeSummary, PlayerRankProfile } from '../services/player-rank.ts'

const MODE_LABELS = {
  ffa: 'FFA',
  duel: 'Duel',
  teamers: 'Teamers',
} as const

export async function rankEmbed(
  db: Database,
  playerId: string,
  rankProfile: PlayerRankProfile,
): Promise<Embed> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)

  const displayName = player?.displayName ?? `<@${playerId}>`
  const fields = [
    { name: MODE_LABELS.ffa, value: formatModeSummary(rankProfile.modes.ffa), inline: true },
    { name: MODE_LABELS.duel, value: formatModeSummary(rankProfile.modes.duel), inline: true },
    { name: MODE_LABELS.teamers, value: formatModeSummary(rankProfile.modes.teamers), inline: true },
  ] as const

  const embed = new Embed()
    .title(`${displayName}'s Rank`)
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

function formatModeSummary(mode: PlayerRankModeSummary): string {
  if (mode.rating == null) return 'No games played yet.'

  const winRate = mode.gamesPlayed > 0
    ? Math.round((mode.wins / mode.gamesPlayed) * 100)
    : 0

  return [
    `Tier: **${mode.tierLabel ?? 'Unranked'}**`,
    `Rating: **${mode.rating}**`,
    `Games: ${mode.gamesPlayed} (${winRate}% wins)`,
  ].join('\n')
}
