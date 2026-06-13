import type { Database } from '@civup/db'
import type { GameMode, LeaderboardMode } from '@civup/game'
import type { PlayerRankProfile, PlayerRatingSummary } from '../services/player/rank.ts'
import { matches, matchParticipants, playerRatings, players, tournamentMatches } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader, LEADERBOARD_MODES, toLeaderboardMode } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { loadPlayerCivRankingSummaries } from '../services/leaderboard/player-civ-stats.ts'
import { getStoredGameModeContext } from '../services/match/draft-data.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { formatDisplayRatingChange } from './rating-change.ts'

export type StatsModeFilter = 'all' | GameMode

const TOP_LEADERS_LIMIT = 5
const COMMON_PLAYERS_LIMIT = 5
const MATCH_ID_BATCH_SIZE = 90

interface CompletedPlayerMatchRow {
  matchId: string
  playerId: string
  team: number | null
  placement: number | null
  civId: string | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  gameMode: string
  draftData: string | null
  isOld: boolean
  isTournament: boolean
}

interface CommonPlayerStat {
  playerId: string
  displayName: string
  games: number
  wins: number
}

interface LeaderStat {
  civId: string
  games: number
  wins: number
}

export interface ModeRatingSnapshotRow {
  gameMode: string
  draftData: string | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

interface CommonPlayerQuerySegment {
  relationship: 'teammate' | 'opponent'
  didWin: boolean
  matchIds: string[]
  teamFilter:
    | { type: 'all-others' }
    | { type: 'same-team', team: number }
    | { type: 'other-team', team: number }
}

export async function playerCardEmbed(
  db: Database,
  playerId: string,
  modeFilter: StatsModeFilter = 'all',
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

  const displayName = player?.displayName ?? `<@${playerId}>`

  const requestedModeLabel = modeFilter === 'all' ? null : formatModeLabel(modeFilter, modeFilter)
  const rankProfile = options.rankProfile ?? null
  const visibleModes = options.visibleModes ?? LEADERBOARD_MODES

  const embed = new Embed()
    .title('Stats')
    .description(buildPlayerCardDescription(playerId, requestedModeLabel, rankProfile))
    .color(0xC8AA6E)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  const ratingModes = getRatingModes(modeFilter, visibleModes)

  const completedMatchesWhere = buildCompletedMatchesWhereClause(playerId, modeFilter, displaySeason?.id ?? null)

  const completedParticipationRowsRaw = await db
    .select({
      matchId: matchParticipants.matchId,
      playerId: matchParticipants.playerId,
      team: matchParticipants.team,
      placement: matchParticipants.placement,
      civId: matchParticipants.civId,
      ratingBeforeMu: matchParticipants.ratingBeforeMu,
      ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
      ratingAfterMu: matchParticipants.ratingAfterMu,
      ratingAfterSigma: matchParticipants.ratingAfterSigma,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
      isOld: matches.isOld,
      tournamentSessionId: tournamentMatches.sessionId,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .leftJoin(tournamentMatches, or(eq(tournamentMatches.matchId, matches.id), eq(tournamentMatches.sessionId, matches.id)))
    .where(completedMatchesWhere)
    .orderBy(desc(matches.createdAt), desc(matches.id))
  const completedParticipationRows = completedParticipationRowsRaw.map(({ tournamentSessionId, ...row }) => ({
    ...row,
    isTournament: tournamentSessionId != null,
  }))
  const completedParticipations = await hydrateModeRatingSnapshotsFromEvents(db, completedParticipationRows)
  const ffaRatingWins = countFfaRatingWins(completedParticipations)

  for (const mode of ratingModes) {
    const ratingRow = ratings.find(r => r.mode === mode)
    if (!ratingRow || ratingRow.gamesPlayed === 0) continue

    fields.push({
      name: formatLeaderboardModeLabel(mode, mode),
      value: formatModeStats(rankProfile?.modes[mode], ratingRow, mode, { ffaRatingWins }),
      inline: true,
    })
  }

  const leaderStats = summarizeLeaderStats(completedParticipations)
  const topPlayedLeaders = sortLeaderStatsByGames(leaderStats)
    .slice(0, TOP_LEADERS_LIMIT)

  if (topPlayedLeaders.length > 0) {
    const topLeaderRankings = await loadPlayerCivRankingSummaries(db, {
      seasonId: displaySeason?.id ?? null,
      mode: modeFilter === 'all' ? null : modeFilter,
    }, playerId, topPlayedLeaders.map(stat => stat.civId))
    const fieldName = requestedModeLabel ? `Top Played Leaders (${requestedModeLabel})` : 'Top Played Leaders'
    fields.push({
      name: fieldName,
      value: topPlayedLeaders.map(stat => formatLeaderStatLine(stat, topLeaderRankings.get(stat.civId)?.playerAdjustedWinRateRank ?? null)).join('\n'),
      inline: false,
    })
  }

  const commonPlayers = await summarizeCommonPlayers(db, playerId, completedParticipations)

  if (commonPlayers.teammates.length > 0) {
    const fieldName = requestedModeLabel ? `Common Teammates (${requestedModeLabel})` : 'Common Teammates'
    fields.push({
      name: fieldName,
      value: commonPlayers.teammates.map(formatCommonPlayerStatLine).join('\n'),
      inline: false,
    })
  }

  if (commonPlayers.opponents.length > 0) {
    const fieldName = requestedModeLabel ? `Common Opponents (${requestedModeLabel})` : 'Common Opponents'
    fields.push({
      name: fieldName,
      value: commonPlayers.opponents.map(formatCommonPlayerStatLine).join('\n'),
      inline: false,
    })
  }

  const recentParticipations = completedParticipations.slice(0, 5)

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
      value: 'No games played yet.',
      inline: false,
    })
  }

  embed.footer({ text: displayName, icon_url: player?.avatarUrl ?? undefined })
  embed.fields(...fields)

  return embed
}

function buildPlayerCardDescription(playerId: string, requestedModeLabel: string | null, rankProfile: PlayerRankProfile | null): string {
  const parts = [`<@${playerId}>`]

  if (rankProfile?.overallRoleId) parts.push(`<@&${rankProfile.overallRoleId}>`)
  else if (rankProfile?.overallLabel) parts.push(rankProfile.overallLabel)

  if (requestedModeLabel) parts.push(requestedModeLabel)
  return parts.join(' - ')
}

function formatModeRating(mode: PlayerRankProfile['modes'][LeaderboardMode] | undefined, fallbackRating: number): string {
  if (!mode) return String(fallbackRating)
  const label = formatRankedRoleMention(mode)
  const rating = mode.rating ?? fallbackRating
  return label ? `${label} (${rating})` : String(rating)
}

export function formatModeStats(
  modeSummary: PlayerRankProfile['modes'][LeaderboardMode] | undefined,
  ratingRow: PlayerRatingSummary,
  mode: LeaderboardMode,
  stats: { ffaRatingWins: number },
): string {
  const rating = Math.round(displayRating(ratingRow.mu, ratingRow.sigma))
  const lines = [
    `Rating: ${formatModeRating(modeSummary, rating)}`,
  ]

  const rank = formatModeRank(modeSummary)
  if (rank) lines.push(`Rank: ${rank}`)

  lines.push(`Games: ${ratingRow.gamesPlayed}`)
  if (mode === 'ffa') {
    const firstPlaces = ratingRow.wins
    lines.push(`1st Place: ${firstPlaces} (${formatPercent(firstPlaces, ratingRow.gamesPlayed)}%)`)
    lines.push(`Win: ${stats.ffaRatingWins} (${formatPercent(stats.ffaRatingWins, ratingRow.gamesPlayed)}%)`)
  }
  else {
    lines.push(`Wins: ${ratingRow.wins} (${formatPercent(ratingRow.wins, ratingRow.gamesPlayed)}%)`)
  }

  return lines.join('\n')
}

function formatModeRank(mode: PlayerRankProfile['modes'][LeaderboardMode] | undefined): string | null {
  return mode?.rank == null ? null : `#${mode.rank}`
}

function formatPercent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0
}

function formatRankedRoleMention(mode: PlayerRankProfile['modes'][LeaderboardMode]): string | null {
  if (mode.tierRoleId) return `<@&${mode.tierRoleId}>`
  const label = mode.tierLabel?.trim()
  return label || null
}

export function getRatingModes(modeFilter: StatsModeFilter, visibleModes: readonly LeaderboardMode[]): readonly LeaderboardMode[] {
  if (modeFilter === 'all') return visibleModes
  const mode = toLeaderboardMode(modeFilter)
  return mode && visibleModes.includes(mode) ? [mode] : []
}

function buildCompletedMatchesWhereClause(playerId: string, modeFilter: StatsModeFilter, seasonId: string | null) {
  const conditions = [
    eq(matchParticipants.playerId, playerId),
    eq(matches.status, 'completed'),
  ]

  if (seasonId) conditions.push(eq(matches.seasonId, seasonId))
  if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))
  return and(...conditions)
}

export function countFfaRatingWins(matchesPlayed: readonly ModeRatingSnapshotRow[]): number {
  let ratingWins = 0

  for (const match of matchesPlayed) {
    if (getStoredGameModeContext(match.gameMode, match.draftData)?.leaderboardMode !== 'ffa') continue
    if (
      match.ratingBeforeMu == null
      || match.ratingBeforeSigma == null
      || match.ratingAfterMu == null
      || match.ratingAfterSigma == null
    ) {
      continue
    }

    const before = displayRating(match.ratingBeforeMu, match.ratingBeforeSigma)
    const after = displayRating(match.ratingAfterMu, match.ratingAfterSigma)
    if (after > before) ratingWins += 1
  }

  return ratingWins
}

async function summarizeCommonPlayers(
  db: Database,
  playerId: string,
  matchesPlayed: CompletedPlayerMatchRow[],
): Promise<{ teammates: CommonPlayerStat[], opponents: CommonPlayerStat[] }> {
  if (matchesPlayed.length === 0) return { teammates: [], opponents: [] }

  const teammates = new Map<string, CommonPlayerStat>()
  const opponents = new Map<string, CommonPlayerStat>()

  for (const segment of buildCommonPlayerQuerySegments(matchesPlayed)) {
    for (const batch of chunk(segment.matchIds, MATCH_ID_BATCH_SIZE)) {
      const rows = await queryCommonPlayerCounts(db, playerId, batch, segment)
      const target = segment.relationship === 'teammate' ? teammates : opponents
      mergeCommonPlayerCounts(target, rows, segment.didWin)
    }
  }

  const topTeammates = summarizeCommonPlayerStats(teammates)
    .slice(0, COMMON_PLAYERS_LIMIT)
  const topOpponents = summarizeCommonPlayerStats(opponents)
    .slice(0, COMMON_PLAYERS_LIMIT)

  return { teammates: topTeammates, opponents: topOpponents }
}

function summarizeCommonPlayerStats(byPlayerId: Map<string, CommonPlayerStat>): CommonPlayerStat[] {
  return [...byPlayerId.values()]
    .sort((a, b) => {
      const gamesDiff = b.games - a.games
      if (gamesDiff !== 0) return gamesDiff

      const winsDiff = b.wins - a.wins
      if (winsDiff !== 0) return winsDiff

      const nameDiff = a.displayName.localeCompare(b.displayName)
      if (nameDiff !== 0) return nameDiff

      return a.playerId.localeCompare(b.playerId)
    })
}

async function queryCommonPlayerCounts(
  db: Database,
  playerId: string,
  matchIds: string[],
  segment: CommonPlayerQuerySegment,
): Promise<Array<{ playerId: string, displayName: string | null, games: number }>> {
  const conditions = [
    inArray(matchParticipants.matchId, matchIds),
    sql`${matchParticipants.playerId} <> ${playerId}`,
  ]

  if (segment.teamFilter.type === 'same-team') {
    conditions.push(eq(matchParticipants.team, segment.teamFilter.team))
  }
  else if (segment.teamFilter.type === 'other-team') {
    conditions.push(sql`${matchParticipants.team} is not null and ${matchParticipants.team} <> ${segment.teamFilter.team}`)
  }

  const rows = await db
    .select({
      playerId: matchParticipants.playerId,
      displayName: players.displayName,
      games: sql<number>`count(*)`,
    })
    .from(matchParticipants)
    .leftJoin(players, eq(matchParticipants.playerId, players.id))
    .where(and(...conditions))
    .groupBy(matchParticipants.playerId, players.displayName)

  return rows.map(row => ({
    playerId: row.playerId,
    displayName: row.displayName,
    games: Number(row.games),
  }))
}

function buildCommonPlayerQuerySegments(matchesPlayed: CompletedPlayerMatchRow[]): CommonPlayerQuerySegment[] {
  const grouped = new Map<string, CommonPlayerQuerySegment>()

  for (const match of matchesPlayed) {
    const didWin = match.placement === 1
    if (match.team == null) {
      appendCommonPlayerQuerySegment(grouped, {
        relationship: 'opponent',
        didWin,
        matchId: match.matchId,
        teamFilter: { type: 'all-others' },
      })
      continue
    }

    appendCommonPlayerQuerySegment(grouped, {
      relationship: 'teammate',
      didWin,
      matchId: match.matchId,
      teamFilter: { type: 'same-team', team: match.team },
    })
    appendCommonPlayerQuerySegment(grouped, {
      relationship: 'opponent',
      didWin,
      matchId: match.matchId,
      teamFilter: { type: 'other-team', team: match.team },
    })
  }

  return [...grouped.values()]
}

function appendCommonPlayerQuerySegment(
  grouped: Map<string, CommonPlayerQuerySegment>,
  input: {
    relationship: 'teammate' | 'opponent'
    didWin: boolean
    matchId: string
    teamFilter: CommonPlayerQuerySegment['teamFilter']
  },
): void {
  const key = `${input.relationship}:${input.didWin ? 1 : 0}:${formatCommonPlayerQueryTeamFilterKey(input.teamFilter)}`
  const current = grouped.get(key) ?? {
    relationship: input.relationship,
    didWin: input.didWin,
    matchIds: [],
    teamFilter: input.teamFilter,
  }
  current.matchIds.push(input.matchId)
  grouped.set(key, current)
}

function formatCommonPlayerQueryTeamFilterKey(teamFilter: CommonPlayerQuerySegment['teamFilter']): string {
  if (teamFilter.type === 'all-others') return 'all'
  return `${teamFilter.type}:${teamFilter.team}`
}

function mergeCommonPlayerCounts(
  target: Map<string, CommonPlayerStat>,
  rows: Array<{ playerId: string, displayName: string | null, games: number }>,
  didWin: boolean,
): void {
  for (const row of rows) {
    const entry = target.get(row.playerId) ?? {
      playerId: row.playerId,
      displayName: formatPlainPlayerName(row.displayName, row.playerId),
      games: 0,
      wins: 0,
    }
    entry.games += row.games
    if (didWin) entry.wins += row.games
    target.set(row.playerId, entry)
  }
}

function summarizeLeaderStats(rows: Array<{ civId: string | null, placement: number | null }>): LeaderStat[] {
  const byLeader = new Map<string, LeaderStat>()

  for (const row of rows) {
    if (!row.civId) continue
    const entry = byLeader.get(row.civId) ?? { civId: row.civId, games: 0, wins: 0 }
    entry.games += 1
    if (row.placement === 1) entry.wins += 1
    byLeader.set(row.civId, entry)
  }

  return [...byLeader.values()]
}

function sortLeaderStatsByGames(stats: LeaderStat[]): LeaderStat[] {
  return [...stats].sort((a, b) => {
    const gamesDiff = b.games - a.games
    if (gamesDiff !== 0) return gamesDiff

    const winsDiff = b.wins - a.wins
    if (winsDiff !== 0) return winsDiff

    return a.civId.localeCompare(b.civId)
  })
}

function formatLeaderStatLine(stat: LeaderStat, rank: number | null = null): string {
  const winRate = Math.round((stat.wins / stat.games) * 100)
  const ratio = `${stat.wins}/${stat.games}`.padStart(5, ' ')
  const pct = `${winRate}%`.padStart(4, ' ')
  const rankPrefix = rank == null ? '' : `\`${`#${rank}`.padEnd(3, ' ')}\` `
  return `${rankPrefix}\`${ratio} ${pct}\` ${formatLeaderName(stat.civId)}`
}

function formatCommonPlayerStatLine(stat: CommonPlayerStat): string {
  const winRate = Math.round((stat.wins / stat.games) * 100)
  const ratio = `${stat.wins}/${stat.games}`.padStart(5, ' ')
  const pct = `${winRate}%`.padStart(4, ' ')
  return `\`${ratio} ${pct}\` ${stat.displayName}`
}

function formatRecentMatchLine(match: {
  placement: number | null
  civId: string | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  gameMode: string
  draftData: string | null
  isOld: boolean
  isTournament: boolean
}): string {
  const placement = formatPlacementCode(match.placement)
  const rating = formatRecentRatingChange(match)
  const modeLabel = formatRecentModeLabel(match.gameMode, match.draftData, match.isOld)
  const leader = formatRecentLeaderLabel(match.civId, match.isOld)
  return leader ? `${placement} ${rating} - ${modeLabel} ${leader}` : `${placement} ${rating} - ${modeLabel}`
}

function formatPlacementCode(placement: number | null): string {
  if (placement == null) return '`#? `'
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function formatRecentRatingChange(match: {
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  isTournament?: boolean
}): string {
  if (match.isTournament) return `${formatTournamentResultEmoji(match.placement)} \`Tournament\``
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

  return formatDisplayRatingChange(before, after)
}

function formatTournamentResultEmoji(placement: number | null): string {
  if (placement == null) return '❔'
  return placement === 1 ? '📈' : '📉'
}

function formatGameModeLabel(gameMode: string, draftData: string | null): string {
  const context = getStoredGameModeContext(gameMode, draftData)
  if (context) return context.label
  return formatModeLabel(gameMode, gameMode)
}

function formatRecentModeLabel(gameMode: string, draftData: string | null, isOld: boolean): string {
  const label = formatGameModeLabel(gameMode, draftData)
  return isOld ? `${label} [old]` : label
}

function formatLeaderName(civId: string | null): string {
  if (!civId) return '`[empty]`'
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

function formatRecentLeaderLabel(civId: string | null, isOld: boolean): string | null {
  if (!civId) return isOld ? null : formatLeaderName(civId)
  return formatLeaderName(civId)
}

function formatPlainPlayerName(displayName: string | null, playerId: string): string {
  const normalized = displayName?.replace(/\s+/g, ' ').trim()
  return normalized && normalized.length > 0 ? normalized : playerId
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}
