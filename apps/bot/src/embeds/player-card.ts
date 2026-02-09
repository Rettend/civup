import type { Database } from '@civup/db'
import type { GameMode, LeaderboardMode } from '@civup/game'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { getLeader, LEADERBOARD_MODES } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, desc, eq } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'

export type StatsModeFilter = 'all' | GameMode

const LEADERBOARD_MODE_LABELS: Record<LeaderboardMode, string> = {
  ffa: 'FFA',
  duel: 'Duel',
  teamers: 'Teamers',
}

const GAME_MODE_LABELS: Record<GameMode, string> = {
  ffa: 'FFA',
  duel: '1v1',
  '2v2': '2v2',
  '3v3': '3v3',
}

const TOP_LEADERS_LIMIT = 5

export async function playerCardEmbed(
  db: Database,
  playerId: string,
  modeFilter: StatsModeFilter = 'all',
): Promise<Embed> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)

  const displayName = player?.displayName ?? `<@${playerId}>`

  const ratings = await db
    .select()
    .from(playerRatings)
    .where(eq(playerRatings.playerId, playerId))

  const requestedModeLabel = modeFilter === 'all' ? null : GAME_MODE_LABELS[modeFilter]

  const embed = new Embed()
    .title(`${displayName}'s Stats`)
    .description(requestedModeLabel ? `<@${playerId}> - ${requestedModeLabel}` : `<@${playerId}>`)
    .color(0xC8AA6E)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  const ratingModes = getRatingModes(modeFilter)

  for (const mode of ratingModes) {
    const ratingRow = ratings.find(r => r.mode === mode)
    if (!ratingRow) continue

    const rating = displayRating(ratingRow.mu, ratingRow.sigma)
    const winRate = ratingRow.gamesPlayed > 0
      ? Math.round((ratingRow.wins / ratingRow.gamesPlayed) * 100)
      : 0

    fields.push({
      name: LEADERBOARD_MODE_LABELS[mode],
      value: [
        `Rating: **${Math.round(rating)}**`,
        `Games: ${ratingRow.gamesPlayed}`,
        `Wins: ${ratingRow.wins} (${winRate}%)`,
      ].join('\n'),
      inline: true,
    })
  }

  const completedMatchesWhere = buildCompletedMatchesWhereClause(playerId, modeFilter)

  const leaderRows = await db
    .select({
      civId: matchParticipants.civId,
      placement: matchParticipants.placement,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(completedMatchesWhere)

  const topLeaders = summarizeLeaderStats(leaderRows)
    .slice(0, TOP_LEADERS_LIMIT)

  if (topLeaders.length > 0) {
    const fieldName = requestedModeLabel ? `Top Leaders (${requestedModeLabel})` : 'Top Leaders'
    fields.push({
      name: fieldName,
      value: topLeaders.map(formatLeaderStatLine).join('\n'),
      inline: false,
    })
  }

  const recentParticipations = await db
    .select({
      placement: matchParticipants.placement,
      civId: matchParticipants.civId,
      ratingBeforeMu: matchParticipants.ratingBeforeMu,
      ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
      ratingAfterMu: matchParticipants.ratingAfterMu,
      ratingAfterSigma: matchParticipants.ratingAfterSigma,
      gameMode: matches.gameMode,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(completedMatchesWhere)
    .orderBy(desc(matches.completedAt))
    .limit(5)

  if (recentParticipations.length > 0) {
    fields.push({
      name: 'Recent Matches',
      value: recentParticipations.map(formatRecentMatchLine).join('\n'),
      inline: false,
    })
  }

  if (fields.length === 0) {
    fields.push({
      name: 'Overview',
      value: 'No games played yet. Use `/lfg create` to start!',
      inline: false,
    })
  }

  embed.fields(...fields)

  return embed
}

function getRatingModes(modeFilter: StatsModeFilter): readonly LeaderboardMode[] {
  if (modeFilter === 'all') return LEADERBOARD_MODES
  if (modeFilter === 'ffa') return ['ffa']
  if (modeFilter === 'duel') return ['duel']
  return ['teamers']
}

function buildCompletedMatchesWhereClause(playerId: string, modeFilter: StatsModeFilter) {
  if (modeFilter === 'all') {
    return and(
      eq(matchParticipants.playerId, playerId),
      eq(matches.status, 'completed'),
    )
  }

  return and(
    eq(matchParticipants.playerId, playerId),
    eq(matches.status, 'completed'),
    eq(matches.gameMode, modeFilter),
  )
}

function summarizeLeaderStats(rows: Array<{ civId: string | null, placement: number | null }>) {
  const byLeader = new Map<string, { civId: string, games: number, wins: number }>()

  for (const row of rows) {
    if (!row.civId) continue
    const entry = byLeader.get(row.civId) ?? { civId: row.civId, games: 0, wins: 0 }
    entry.games += 1
    if (row.placement === 1) entry.wins += 1
    byLeader.set(row.civId, entry)
  }

  return [...byLeader.values()]
    .sort((a, b) => {
      const gamesDiff = b.games - a.games
      if (gamesDiff !== 0) return gamesDiff

      const winsDiff = b.wins - a.wins
      if (winsDiff !== 0) return winsDiff

      return a.civId.localeCompare(b.civId)
    })
}

function formatLeaderStatLine(stat: { civId: string, games: number, wins: number }): string {
  const winRate = Math.round((stat.wins / stat.games) * 100)
  const ratio = `${stat.wins}/${stat.games}`.padStart(5, ' ')
  const pct = `${winRate}%`.padStart(4, ' ')
  return `\`${ratio} ${pct}\` ${formatLeaderName(stat.civId)}`
}

function formatRecentMatchLine(match: {
  placement: number | null
  civId: string | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  gameMode: string
}): string {
  const placement = formatPlacementCode(match.placement)
  const rating = formatRecentRatingChange(match)
  const modeLabel = formatGameModeLabel(match.gameMode)
  const leader = formatLeaderName(match.civId)
  return `${placement} ${rating} - ${modeLabel} ${leader}`
}

function formatPlacementCode(placement: number | null): string {
  if (placement == null) return '`#? `'
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function formatRecentRatingChange(match: {
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}): string {
  if (
    match.ratingBeforeMu == null
    || match.ratingBeforeSigma == null
    || match.ratingAfterMu == null
    || match.ratingAfterSigma == null
  ) {
    return '` ? ` ❔ `(   ?)`'
  }

  const before = displayRating(match.ratingBeforeMu, match.ratingBeforeSigma)
  const after = displayRating(match.ratingAfterMu, match.ratingAfterSigma)
  const delta = Math.round(after - before)
  const deltaText = `${delta >= 0 ? '+' : ''}${delta}`.padStart(3, ' ')
  const trendEmoji = delta >= 0 ? '📈' : '📉'
  const updatedElo = `(${String(Math.round(after)).padStart(4, ' ')})`

  return `\`${deltaText}\` ${trendEmoji} \`${updatedElo}\``
}

function formatGameModeLabel(gameMode: string): string {
  if (gameMode in GAME_MODE_LABELS) return GAME_MODE_LABELS[gameMode as GameMode]
  return gameMode.toUpperCase()
}

function formatLeaderName(civId: string | null): string {
  if (!civId) return '`[pending]`'
  try {
    const leader = getLeader(civId)
    const emoji = leaderEmojiMention(civId)
    return emoji ? `${emoji} ${leader.name}` : leader.name
  }
  catch {
    return civId
  }
}
