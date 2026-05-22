import type { Database } from '@civup/db'
import type { GameMode, LeaderboardMode } from '@civup/game'
import type { PlayerRankProfile, PlayerRatingSummary } from '../services/player/rank.ts'
import type { PlayerCivRankingSummary, PlayerCivStatSummary } from '../services/leaderboard/player-civ-stats.ts'
import { playerRatings, players } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader, LEADERBOARD_MODES, toLeaderboardMode } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { listPlayerCivStats, loadPlayerCivRankingSummaries, PLAYER_CIV_MIN_RANK_GAMES, PLAYER_CIV_SERVER_AVG_MIN_GAMES } from '../services/leaderboard/player-civ-stats.ts'
import { getDisplaySeason } from '../services/season/index.ts'

export type LeadersModeFilter = 'all' | GameMode

const TOP_LEADER_LIMIT = 10
const COMPARISON_LIMIT = 5
const FIELD_VALUE_LIMIT = 1024

interface LeaderComparisonRow {
  stat: PlayerCivStatSummary
  ranking: PlayerCivRankingSummary
  playerWinRatePct: number
  diffPct: number
}

export async function playerLeadersEmbed(
  db: Database,
  playerId: string,
  modeFilter: LeadersModeFilter = 'all',
  options: {
    rankProfile?: PlayerRankProfile | null
    ratingRows?: readonly PlayerRatingSummary[]
    visibleModes?: readonly LeaderboardMode[]
  } = {},
): Promise<Embed> {
  const [player, displaySeason, ratings] = await Promise.all([
    db
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1)
      .then(rows => rows[0] ?? null),
    getDisplaySeason(db),
    options.ratingRows
      ? Promise.resolve(options.ratingRows)
      : db
          .select()
          .from(playerRatings)
          .where(eq(playerRatings.playerId, playerId)),
  ])

  const requestedModeLabel = modeFilter === 'all' ? null : formatModeLabel(modeFilter, modeFilter)
  const rankProfile = options.rankProfile ?? null
  const visibleModes = options.visibleModes ?? LEADERBOARD_MODES
  const playerCivFilter = {
    seasonId: displaySeason?.id ?? null,
    mode: modeFilter === 'all' ? null : modeFilter,
  }

  const leaderStats = await listPlayerCivStats(db, playerCivFilter, playerId)
  const topPlayedLeaders = sortLeaderStatsByGames(leaderStats).slice(0, TOP_LEADER_LIMIT)
  const bestLeaders = sortLeaderStatsByWinRate(leaderStats.filter(stat => stat.picks >= PLAYER_CIV_MIN_RANK_GAMES)).slice(0, TOP_LEADER_LIMIT)
  const rankings = await loadPlayerCivRankingSummaries(db, playerCivFilter, playerId, leaderStats.map(stat => stat.civId))
  const comparisonRows = buildComparisonRows(leaderStats, rankings)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  const modeSummary = formatModeSummary(ratings, rankProfile, modeFilter, visibleModes)
  if (modeSummary) fields.push({ name: 'Mode Summary', value: modeSummary, inline: false })

  fields.push({
    name: requestedModeLabel ? `Top Played Leaders (${requestedModeLabel})` : 'Top Played Leaders',
    value: formatLeaderList(topPlayedLeaders, rankings, 'games') || 'No leaders played yet.',
    inline: false,
  })
  fields.push({
    name: requestedModeLabel ? `Best Leaders (${requestedModeLabel})` : 'Best Leaders',
    value: formatLeaderList(bestLeaders, rankings, 'winrate') || `No leaders with ${PLAYER_CIV_MIN_RANK_GAMES}+ games yet.`,
    inline: false,
  })
  fields.push({
    name: requestedModeLabel ? `Better Than Server Avg (${requestedModeLabel})` : 'Better Than Server Avg',
    value: formatComparisonList(comparisonRows.filter(row => row.diffPct > 0).sort((a, b) => b.diffPct - a.diffPct).slice(0, COMPARISON_LIMIT))
      || `No leaders with ${PLAYER_CIV_MIN_RANK_GAMES}+ games and ${PLAYER_CIV_SERVER_AVG_MIN_GAMES}+ server games above average.`,
    inline: false,
  })
  fields.push({
    name: requestedModeLabel ? `Worse Than Server Avg (${requestedModeLabel})` : 'Worse Than Server Avg',
    value: formatComparisonList(comparisonRows.filter(row => row.diffPct < 0).sort((a, b) => a.diffPct - b.diffPct).slice(0, COMPARISON_LIMIT))
      || `No leaders with ${PLAYER_CIV_MIN_RANK_GAMES}+ games and ${PLAYER_CIV_SERVER_AVG_MIN_GAMES}+ server games below average.`,
    inline: false,
  })

  const displayName = player?.displayName ?? `<@${playerId}>`
  return new Embed()
    .title('Leaders')
    .description(buildLeadersDescription(playerId, requestedModeLabel, rankProfile))
    .color(0xC8AA6E)
    .footer({ text: displayName, icon_url: player?.avatarUrl ?? undefined })
    .fields(...fields)
}

function buildLeadersDescription(playerId: string, requestedModeLabel: string | null, rankProfile: PlayerRankProfile | null): string {
  const parts = [`<@${playerId}>`]
  if (rankProfile?.overallRoleId) parts.push(`<@&${rankProfile.overallRoleId}>`)
  else if (rankProfile?.overallLabel) parts.push(rankProfile.overallLabel)
  if (requestedModeLabel) parts.push(requestedModeLabel)
  return parts.join(' - ')
}

function formatModeSummary(
  ratings: readonly PlayerRatingSummary[],
  rankProfile: PlayerRankProfile | null,
  modeFilter: LeadersModeFilter,
  visibleModes: readonly LeaderboardMode[],
): string {
  const lines = getRatingModes(modeFilter, visibleModes).flatMap((mode) => {
    const ratingRow = ratings.find(row => row.mode === mode)
    if (!ratingRow || ratingRow.gamesPlayed === 0) return []

    const rating = Math.round(displayRating(ratingRow.mu, ratingRow.sigma))
    const rank = rankProfile?.modes[mode]?.rank
    const winRate = formatPercent(ratingRow.wins, ratingRow.gamesPlayed)
    const ratingText = rank == null ? String(rating) : `${rating} (#${rank})`
    const resultLabel = mode === 'ffa' ? '1st' : 'WR'
    return `${formatLeaderboardModeLabel(mode, mode)}: ${ratingText}, ${ratingRow.gamesPlayed}g, ${winRate}% ${resultLabel}`
  })

  return limitFieldLines(lines)
}

function getRatingModes(modeFilter: LeadersModeFilter, visibleModes: readonly LeaderboardMode[]): readonly LeaderboardMode[] {
  if (modeFilter === 'all') return visibleModes
  const mode = toLeaderboardMode(modeFilter)
  return mode && visibleModes.includes(mode) ? [mode] : []
}

function sortLeaderStatsByGames(stats: readonly PlayerCivStatSummary[]): PlayerCivStatSummary[] {
  return [...stats].sort((a, b) => {
    const gamesDiff = b.picks - a.picks
    if (gamesDiff !== 0) return gamesDiff

    const winsDiff = b.wins - a.wins
    if (winsDiff !== 0) return winsDiff

    return a.civId.localeCompare(b.civId)
  })
}

function sortLeaderStatsByWinRate(stats: readonly PlayerCivStatSummary[]): PlayerCivStatSummary[] {
  return [...stats].sort((a, b) => {
    const winRateDiff = (b.wins * a.picks) - (a.wins * b.picks)
    if (winRateDiff !== 0) return winRateDiff

    const gamesDiff = b.picks - a.picks
    if (gamesDiff !== 0) return gamesDiff

    const winsDiff = b.wins - a.wins
    if (winsDiff !== 0) return winsDiff

    return a.civId.localeCompare(b.civId)
  })
}

function buildComparisonRows(
  leaderStats: readonly PlayerCivStatSummary[],
  rankings: Map<string, PlayerCivRankingSummary>,
): LeaderComparisonRow[] {
  return leaderStats.flatMap((stat) => {
    if (stat.picks < PLAYER_CIV_MIN_RANK_GAMES) return []
    const ranking = rankings.get(stat.civId)
    if (!ranking || ranking.serverWinRatePct == null || ranking.serverPicks < PLAYER_CIV_SERVER_AVG_MIN_GAMES) return []

    const playerWinRatePct = round((stat.wins / stat.picks) * 100, 1)
    return [{
      stat,
      ranking,
      playerWinRatePct,
      diffPct: round(playerWinRatePct - ranking.serverWinRatePct, 1),
    }]
  })
}

function formatLeaderList(
  stats: readonly PlayerCivStatSummary[],
  rankings: Map<string, PlayerCivRankingSummary>,
  rankType: 'games' | 'winrate',
): string {
  return limitFieldLines(stats.map((stat) => {
    const ranking = rankings.get(stat.civId)
    const rank = rankType === 'games' ? ranking?.playerGamesRank : ranking?.playerWinRateRank
    return `${formatRank(rank)} ${formatRecord(stat.wins, stat.picks)} ${formatLeaderName(stat.civId)}`
  }))
}

function formatComparisonList(rows: readonly LeaderComparisonRow[]): string {
  return limitFieldLines(rows.map((row) => {
    const diff = `${row.diffPct > 0 ? '+' : ''}${row.diffPct}%`
    return `${formatRank(row.ranking.playerWinRateRank)} ${formatRecord(row.stat.wins, row.stat.picks)} ${formatLeaderName(row.stat.civId)} - server ${row.ranking.serverWinRatePct}% (${diff})`
  }))
}

function formatRank(rank: number | null | undefined): string {
  return rank == null ? '`#? `' : `\`${`#${rank}`.padEnd(3, ' ')}\``
}

function formatRecord(wins: number, games: number): string {
  const ratio = `${wins}/${games}`.padStart(5, ' ')
  const pct = `${formatPercent(wins, games)}%`.padStart(4, ' ')
  return `\`${ratio} ${pct}\``
}

function formatLeaderName(civId: string): string {
  try {
    const leader = getLeader(civId)
    const emoji = leaderEmojiMention(civId)
    return emoji ? `${emoji} ${leader.name}` : leader.name
  }
  catch {
    try {
      const leader = getLeader(civId, 'beta')
      const emoji = leaderEmojiMention(civId)
      return emoji ? `${emoji} ${leader.name}` : leader.name
    }
    catch {
      return civId
    }
  }
}

function formatPercent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0
}

function limitFieldLines(lines: readonly string[]): string {
  const kept: string[] = []
  let length = 0
  for (const line of lines) {
    const nextLength = length + (kept.length > 0 ? 1 : 0) + line.length
    if (nextLength > FIELD_VALUE_LIMIT) break
    kept.push(line)
    length = nextLength
  }
  return kept.join('\n')
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
