import type { TeamLeaderboardBucket, TeamLeaderboardSnapshotRow } from '../services/leaderboard/team-snapshot.ts'
import { formatLeaderboardModeLabel } from '@civup/game'
import { Embed } from 'discord-hono'
import { getTeamLeaderboardBucketContext, TEAM_LEADERBOARD_MIN_GAMES } from '../services/leaderboard/team-snapshot.ts'

const TEAM_LEADERBOARD_COLORS = {
  'duo': 0x06B6D4,
  'squad': 0x8B5CF6,
} as const

export function teamLeaderboardEmbed(
  bucket: TeamLeaderboardBucket,
  rows: readonly TeamLeaderboardSnapshotRow[],
  options: {
    titlePrefix?: string
  } = {},
): Embed {
  const entries = rows
    .filter(row => row.gamesPlayed >= TEAM_LEADERBOARD_MIN_GAMES)
    .slice(0, 25)
  const context = getTeamLeaderboardBucketContext(bucket)

  if (entries.length === 0) {
    return new Embed()
      .title(formatTeamLeaderboardTitle(bucket, options.titlePrefix))
      .description('No teams with enough games to rank yet.')
      .color(TEAM_LEADERBOARD_COLORS[context.leaderboardMode])
  }

  const lines = entries.map((entry, index) => {
    const rank = index + 1
    const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : ''
    const winRate = Math.round((entry.wins / entry.gamesPlayed) * 100)
    const team = entry.playerIds.map(playerId => `<@${playerId}>`).join(' + ')
    return `${formatPlacementCode(rank)} ${medal}${team} — **${entry.displayRating}** (${entry.wins}/${entry.gamesPlayed}, ${winRate}%)`
  })

  return new Embed()
    .title(formatTeamLeaderboardTitle(bucket, options.titlePrefix))
    .description(lines.join('\n'))
    .color(TEAM_LEADERBOARD_COLORS[context.leaderboardMode])
}

function formatTeamLeaderboardTitle(bucket: TeamLeaderboardBucket, titlePrefix?: string): string {
  const context = getTeamLeaderboardBucketContext(bucket)
  const modeLabel = formatLeaderboardModeLabel(context.leaderboardMode, context.leaderboardMode)
  const sizeLabel = context.gameMode === '2v2' ? '' : ` ${context.gameMode}`
  const title = `${modeLabel}${sizeLabel} Team Leaderboard`
  return titlePrefix ? `${titlePrefix} ${title}` : title
}

function formatPlacementCode(placement: number): string {
  return `\`${`#${placement}`.padEnd(4, ' ')}\``
}
