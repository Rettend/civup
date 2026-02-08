import type { Database } from '@civup/db'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { desc, eq } from 'drizzle-orm'

export async function playerCardEmbed(db: Database, playerId: string): Promise<Embed> {
  // Fetch player info
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)

  const displayName = player?.displayName ?? `<@${playerId}>`

  // Fetch all ratings
  const ratings = await db
    .select()
    .from(playerRatings)
    .where(eq(playerRatings.playerId, playerId))

  const embed = new Embed()
    .title(`${displayName}'s Stats`)
    .color(0xC8AA6E) // gold accent

  if (player?.avatarUrl) {
    embed.thumbnail({ url: player.avatarUrl })
  }

  if (ratings.length === 0) {
    embed.description('No games played yet. Use `/lfg join` to start!')
    return embed
  }

  // Rating fields per mode
  for (const mode of LEADERBOARD_MODES) {
    const r = ratings.find(r => r.mode === mode)
    if (!r) continue

    const dr = displayRating(r.mu, r.sigma)
    const winRate = r.gamesPlayed > 0
      ? Math.round((r.wins / r.gamesPlayed) * 100)
      : 0

    embed.fields({
      name: mode.toUpperCase(),
      value: [
        `Rating: **${Math.round(dr)}**`,
        `Games: ${r.gamesPlayed}`,
        `Wins: ${r.wins} (${winRate}%)`,
      ].join('\n'),
      inline: true,
    })
  }

  // Recent matches (last 5)
  const recentParticipations = await db
    .select({
      matchId: matchParticipants.matchId,
      placement: matchParticipants.placement,
      civId: matchParticipants.civId,
      ratingBeforeMu: matchParticipants.ratingBeforeMu,
      ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
      ratingAfterMu: matchParticipants.ratingAfterMu,
      ratingAfterSigma: matchParticipants.ratingAfterSigma,
      gameMode: matches.gameMode,
      completedAt: matches.completedAt,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(eq(matchParticipants.playerId, playerId))
    .orderBy(desc(matches.completedAt))
    .limit(5)

  if (recentParticipations.length > 0) {
    const lines = recentParticipations.map((m) => {
      let line = `**${m.gameMode.toUpperCase()}**`
      if (m.civId) line += ` ${m.civId}`
      if (m.placement !== null) line += ` — #${m.placement}`

      if (m.ratingAfterMu !== null && m.ratingAfterSigma !== null
        && m.ratingBeforeMu !== null && m.ratingBeforeSigma !== null) {
        const delta = displayRating(m.ratingAfterMu, m.ratingAfterSigma)
          - displayRating(m.ratingBeforeMu, m.ratingBeforeSigma)
        const sign = delta >= 0 ? '+' : ''
        line += ` (${sign}${Math.round(delta)})`
      }

      return line
    })

    embed.fields({
      name: 'Recent Matches',
      value: lines.join('\n'),
    })
  }

  embed.timestamp(new Date().toISOString())
  return embed
}
