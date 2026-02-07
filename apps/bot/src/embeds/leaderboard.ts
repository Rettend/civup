import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { playerRatings } from '@civup/db'
import { buildLeaderboard } from '@civup/rating'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'

const MODE_LABELS: Record<LeaderboardMode, string> = {
  ffa: 'FFA',
  duel: 'Duel',
  teamers: 'Teamers (2v2 + 3v3)',
}

const MODE_COLORS: Record<LeaderboardMode, number> = {
  ffa: 0xF59E0B,
  duel: 0xEF4444,
  teamers: 0x8B5CF6,
}

export async function leaderboardEmbed(db: Database, mode: LeaderboardMode): Promise<Embed> {
  const rows = await db
    .select()
    .from(playerRatings)
    .where(eq(playerRatings.mode, mode))

  const entries = buildLeaderboard(rows)
  const top25 = entries.slice(0, 25)

  if (top25.length === 0) {
    return new Embed()
      .title(`${MODE_LABELS[mode]} Leaderboard`)
      .description('No players with enough games to rank yet.')
      .color(MODE_COLORS[mode])
  }

  const lines = top25.map((entry, i) => {
    const rank = i + 1
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`
    const rating = Math.round(entry.displayRating)
    const winPct = Math.round(entry.winRate * 100)
    return `${medal} <@${entry.playerId}> — **${rating}** (${entry.gamesPlayed}G, ${winPct}% WR)`
  })

  return new Embed()
    .title(`${MODE_LABELS[mode]} Leaderboard`)
    .description(lines.join('\n'))
    .color(MODE_COLORS[mode])
    .footer({ text: `Top ${top25.length} players with 5+ games` })
    .timestamp(new Date().toISOString())
}
