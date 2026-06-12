import type { Database } from '@civup/db'
import type { GameMode, LeaderboardMode } from '@civup/game'
import type { PlayerRankProfile, PlayerRatingSummary } from '../services/player/rank.ts'
import type { PlayerCivRankingSummary, PlayerCivStatSummary } from '../services/leaderboard/player-civ-stats.ts'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader, LEADERBOARD_MODES } from '@civup/game'
import { Embed } from 'discord-hono'
import { and, eq } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { listPlayerCivStats, loadPlayerCivRankingSummaries, PLAYER_CIV_MIN_RANK_GAMES } from '../services/leaderboard/player-civ-stats.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { countFfaRatingWins, formatModeStats, getRatingModes } from './player-card.ts'

export type LeadersModeFilter = 'all' | GameMode

const TOP_LEADER_LIMIT = 5
const HIGHEST_RANKED_LIMIT = 5
const FIELD_VALUE_LIMIT = 1024
const NOT_ENOUGH_LEADER_DATA = 'Not enough leader data'

interface LeaderRankRow {
  stat: PlayerCivStatSummary
  ranking: PlayerCivRankingSummary
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
  const rankRows = buildRankRows(leaderStats, rankings)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  const ratingModes = getRatingModes(modeFilter, visibleModes)
  const ffaRatingWins = ratingModes.includes('ffa')
    ? await countPlayerFfaRatingWins(db, playerId, modeFilter, displaySeason?.id ?? null)
    : 0

  for (const mode of ratingModes) {
    const ratingRow = ratings.find(row => row.mode === mode)
    if (!ratingRow || ratingRow.gamesPlayed === 0) continue

    fields.push({
      name: formatLeaderboardModeLabel(mode, mode),
      value: formatModeStats(rankProfile?.modes[mode], ratingRow, mode, { ffaRatingWins }),
      inline: true,
    })
  }

  const topPlayedValue = formatLeaderList(topPlayedLeaders, rankings, 'games')
  if (topPlayedValue) {
    fields.push({
      name: requestedModeLabel ? `Top Played Leaders (${requestedModeLabel})` : 'Top Played Leaders',
      value: topPlayedValue,
      inline: false,
    })
  }

  const bestValue = formatLeaderList(bestLeaders, rankings, 'winrate')
  if (bestValue) {
    fields.push({
      name: requestedModeLabel ? `Best Leaders (${requestedModeLabel})` : 'Best Leaders',
      value: bestValue,
      inline: false,
    })
  }

  const highestRankedValue = formatHighestRankedList(rankRows.slice(0, HIGHEST_RANKED_LIMIT))
  if (highestRankedValue) {
    fields.push({
      name: requestedModeLabel ? `Highest Ranked Leaders (${requestedModeLabel})` : 'Highest Ranked Leaders',
      value: highestRankedValue,
      inline: false,
    })
  }

  if (!bestValue && !highestRankedValue) {
    fields.push({
      name: requestedModeLabel ? `Leaders (${requestedModeLabel})` : 'Leaders',
      value: NOT_ENOUGH_LEADER_DATA,
      inline: false,
    })
  }

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

function buildRankRows(
  leaderStats: readonly PlayerCivStatSummary[],
  rankings: Map<string, PlayerCivRankingSummary>,
): LeaderRankRow[] {
  return leaderStats
    .flatMap((stat) => {
      const ranking = rankings.get(stat.civId)
      if (!ranking || ranking.playerAdjustedWinRateRank == null || ranking.playerAdjustedWinRatePct == null) return []
      return [{ stat, ranking }]
    })
    .sort((left, right) => {
      const rankDiff = left.ranking.playerAdjustedWinRateRank! - right.ranking.playerAdjustedWinRateRank!
      if (rankDiff !== 0) return rankDiff

      const adjustedDiff = (right.ranking.playerAdjustedWinRatePct ?? 0) - (left.ranking.playerAdjustedWinRatePct ?? 0)
      if (adjustedDiff !== 0) return adjustedDiff

      const gamesDiff = right.stat.picks - left.stat.picks
      if (gamesDiff !== 0) return gamesDiff

      const winsDiff = right.stat.wins - left.stat.wins
      if (winsDiff !== 0) return winsDiff

      return left.stat.civId.localeCompare(right.stat.civId)
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

function formatHighestRankedList(rows: readonly LeaderRankRow[]): string {
  return limitFieldLines(rows.map((row) => {
    const rank = row.ranking.playerAdjustedWinRateRank
    return `${formatRank(rank)} ${formatRecord(row.stat.wins, row.stat.picks)} ${formatLeaderName(row.stat.civId)} - Rank #${rank}`
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

async function countPlayerFfaRatingWins(db: Database, playerId: string, modeFilter: LeadersModeFilter, seasonId: string | null): Promise<number> {
  const rowsRaw = await db
    .select({
      matchId: matchParticipants.matchId,
      playerId: matchParticipants.playerId,
      ratingBeforeMu: matchParticipants.ratingBeforeMu,
      ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
      ratingAfterMu: matchParticipants.ratingAfterMu,
      ratingAfterSigma: matchParticipants.ratingAfterSigma,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(buildCompletedMatchesWhereClause(playerId, modeFilter, seasonId))

  return countFfaRatingWins(await hydrateModeRatingSnapshotsFromEvents(db, rowsRaw))
}

function buildCompletedMatchesWhereClause(playerId: string, modeFilter: LeadersModeFilter, seasonId: string | null) {
  const conditions = [
    eq(matchParticipants.playerId, playerId),
    eq(matches.status, 'completed'),
  ]

  if (seasonId) conditions.push(eq(matches.seasonId, seasonId))
  if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))
  return and(...conditions)
}
