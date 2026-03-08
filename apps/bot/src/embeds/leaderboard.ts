import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { playerRatings } from '@civup/db'
import { formatLeaderboardModeLabel } from '@civup/game'
import { buildLeaderboard } from '@civup/rating'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'

const MODE_COLORS: Record<LeaderboardMode, number> = {
  duel: 0xEF4444,
  teamers: 0x8B5CF6,
  ffa: 0xF59E0B,
}

export async function leaderboardEmbed(
  db: Database,
  mode: LeaderboardMode,
  options: {
    titlePrefix?: string
  } = {},
): Promise<Embed> {
  const rows = await db
    .select()
    .from(playerRatings)
    .where(eq(playerRatings.mode, mode))

  const entries = buildLeaderboard(rows)
  const top25 = entries.slice(0, 25)

  if (top25.length === 0) {
    return new Embed()
      .title(formatLeaderboardTitle(mode, options.titlePrefix))
      .description('No players with enough games to rank yet.')
      .color(MODE_COLORS[mode])
  }

  const lines = top25.map((entry, i) => {
    const rank = i + 1
    const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : ''
    const rating = Math.round(entry.displayRating)
    const winPct = Math.round(entry.winRate * 100)
    return `${formatPlacementCode(rank)} ${medal}<@${entry.playerId}> — **${rating}** (${entry.wins}/${entry.gamesPlayed}, ${winPct}%)`
  })

  return new Embed()
    .title(formatLeaderboardTitle(mode, options.titlePrefix))
    .description(lines.join('\n'))
    .color(MODE_COLORS[mode])
}

function formatLeaderboardTitle(mode: LeaderboardMode, titlePrefix?: string): string {
  const baseTitle = `${formatLeaderboardModeLabel(mode, mode)} Leaderboard`
  return titlePrefix ? `${titlePrefix} ${baseTitle}` : baseTitle
}

function formatPlacementCode(placement: number): string {
  return `\`${`#${placement}`.padEnd(4, ' ')}\``
}
