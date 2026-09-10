import type { Database } from '@civup/db'
import type { PublicRatingSnapshot } from '@civup/rating'
import type { GameMode, LeaderboardMode } from '@civup/game'
import type { PlayerRankProfile, PlayerRatingSummary } from '../services/player/rank.ts'
import { matches, matchParticipants, playerRatingEvents, players, tournamentMatches } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader, LEADERBOARD_MODES, toLeaderboardMode } from '@civup/game'
import { displayRating, formatPublicRankRating, getLeaderboardMinGames, publicRatingBadgeRank, visiblePublicRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { getStoredGameModeContext } from '../services/match/draft-data.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import type { SeasonSelection } from '../services/season/selection.ts'
import { resolveSeasonSelection } from '../services/season/selection.ts'
import { loadSelectedSeasonRatings } from '../services/season/ratings.ts'
import { historicalModeRankLabel, loadSeasonStandings } from '../services/season/standings.ts'
import { formatDisplayRatingChange, formatPublicRatingSnapshotChange, formatUnrankedResultMarker } from './rating-change.ts'

export type StatsModeFilter = 'all' | GameMode

const COMMON_PLAYERS_LIMIT = 8
const RECENT_MATCHES_LIMIT = 8
const MATCH_ID_BATCH_SIZE = 90

interface CompletedPlayerMatchRow {
  matchId: string
  team: number | null
  placement: number | null
  createdAt: number
}

interface RecentPlayerMatchRow {
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
    season?: SeasonSelection
    historicalRoleIds?: Record<string, string | null>
    historicalRoleLabels?: Record<string, string>
    unrankedRoleId?: string | null
    kv?: KVNamespace
  } = {},
): Promise<Embed> {
  const selected = await resolveSeasonSelection(db, options.season ?? 'current')
  const displaySeason = selected.season
  const historical = displaySeason != null && !displaySeason.active
  const [player, ratings] = await Promise.all([
    db
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1)
      .then(rows => rows[0] ?? null),
    !displaySeason && !selected.allTime && options.ratingRows
      ? Promise.resolve(options.ratingRows)
      : loadSelectedSeasonRatings(db, selected, [playerId]),
  ])

  const displayName = player?.displayName ?? `<@${playerId}>`

  const requestedModeLabel = modeFilter === 'all' ? null : formatModeLabel(modeFilter, modeFilter)
  const rankProfile = historical ? null : options.rankProfile ?? null
  const historicalStandings = historical ? await loadSeasonStandings(db, options.kv, displaySeason.id) : null
  const historicalPositions = Object.fromEntries((historicalStandings?.modes ?? []).flatMap(row => row.playerId === playerId && row.position != null ? [[row.mode, row.position]] : []))
  let historicalRank: string | null = null
  if (historical) {
    const peak = historicalStandings?.peaks.find(row => row.playerId === playerId)
    const roleId = peak ? options.historicalRoleIds?.[peak.tier] : null
    historicalRank = roleId ? `<@&${roleId}>` : peak ? options.historicalRoleLabels?.[peak.tier] ?? `S${displaySeason.seasonNumber} Role ${peak.tier.slice(4)}` : options.unrankedRoleId ? `<@&${options.unrankedRoleId}>` : 'Unranked'
  }
  const visibleModes = options.visibleModes ?? LEADERBOARD_MODES

  const embed = new Embed()
    .title(`Stats${displaySeason || selected.allTime ? ` - ${selected.label}` : ''}`)
    .description(historical
      ? [`<@${playerId}>`, historicalRank, requestedModeLabel].filter(Boolean).join(' - ')
      : buildPlayerCardDescription(playerId, requestedModeLabel, rankProfile))
    .color(0xC8AA6E)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []
  const ratingModes = getRatingModes(modeFilter, visibleModes)

  const completedParticipationRows = await listCompletedPlayerMatchSummaries(db, playerId, modeFilter, displaySeason?.id ?? null)
  const ffaRatingRows = ratingModes.includes('ffa')
    ? await listFfaRatingWinSnapshotRows(db, playerId, displaySeason?.id ?? null)
    : []
  const ffaRatingWins = countFfaRatingWins(ffaRatingRows)

  for (const mode of ratingModes) {
    const ratingRow = ratings.find(r => r.mode === mode)
    if (!ratingRow) continue
    const lifetimeGames = 'lifetimeGamesPlayed' in ratingRow ? ratingRow.lifetimeGamesPlayed : ratingRow.gamesPlayed
    if (ratingRow.gamesPlayed === 0 && !lifetimeGames && ratingRow.effectiveGames === 0) continue

    fields.push({
      name: formatLeaderboardModeLabel(mode, mode),
      value: formatModeStats(rankProfile?.modes[mode], ratingRow, mode, { labelsByTier: rankProfile?.labelsByTier, ffaRatingWins, position: historicalPositions[mode], historicalRankLabel: historical ? historicalModeRankLabel(historicalStandings?.modes.find(row => row.playerId === playerId && row.mode === mode), displaySeason.seasonNumber, options.historicalRoleIds, options.unrankedRoleId, options.historicalRoleLabels) : undefined, publicEra: displaySeason?.ratingSystem === 'rp' || (selected.allTime && ratingRow.publicRating != null), currentRatingLabel: selected.allTime, roleIdsByTier: rankProfile?.roleIdsByTier, unrankedRoleId: rankProfile?.unrankedRoleId }),
      inline: true,
    })
  }

  const commonPlayers = await summarizeCommonPlayers(db, playerId, completedParticipationRows)

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

  const recentParticipations = await hydrateModeRatingSnapshotsFromEvents(
    db,
    await listRecentPlayerMatches(db, playerId, completedParticipationRows.slice(0, RECENT_MATCHES_LIMIT).map(row => row.matchId)),
  )

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

export function buildPlayerCardDescription(playerId: string, requestedModeLabel: string | null, rankProfile: PlayerRankProfile | null): string {
  const parts = [`<@${playerId}>`]

  if (rankProfile?.overallRoleId) parts.push(`<@&${rankProfile.overallRoleId}>`)
  else if (rankProfile?.overallLabel) parts.push(rankProfile.overallLabel)
  if (rankProfile?.overallRating != null && Number.isFinite(rankProfile.overallRating) && parts.length > 1) parts[1] += ` · ${formatPublicRankRating(rankProfile.overallRating, rankProfile.overallTier)} RP`

  if (requestedModeLabel) parts.push(requestedModeLabel)
  return parts.join(' - ')
}

export function formatModeStats(
  modeSummary: PlayerRankProfile['modes'][LeaderboardMode] | undefined,
  ratingRow: PlayerRatingSummary,
  mode: LeaderboardMode,
  stats: { labelsByTier?: Record<string, string | null>, ffaRatingWins: number, position?: number, historicalRankLabel?: string | null, publicEra?: boolean, currentRatingLabel?: boolean, roleIdsByTier?: Record<string, string | null>, unrankedRoleId?: string | null },
): string {
  if (stats.publicEra && ratingRow.publicRating == null) throw new Error('Public rating data is incomplete.')
  const rating = stats.publicEra ? visiblePublicRating(ratingRow.publicRating!) : Math.round(displayRating(ratingRow.mu, ratingRow.sigma))
  const eligible = modeSummary?.eligible ?? (ratingRow.lifetimeGamesPlayed ?? ratingRow.gamesPlayed) >= getLeaderboardMinGames(mode)
  const badge = publicRatingBadgeRank(rating, stats.publicEra ? ratingRow.publicBadge : null)
  const roleId = stats.roleIdsByTier?.[badge.tier] ?? (modeSummary?.tier === badge.tier ? modeSummary.tierRoleId : null)
  const division = badge.label.match(/ (III|II|I)$/)?.[0] ?? ''
  const publicRank = eligible ? modeSummary?.divisionMinimum != null
    ? modeSummary.tierRoleId ? `<@&${modeSummary.tierRoleId}>` : modeSummary.tierLabel ?? badge.label
    : roleId ? `<@&${roleId}>${division}` : stats.labelsByTier?.[badge.tier] ? `${stats.labelsByTier[badge.tier]}${division}` : badge.label : stats.unrankedRoleId ? `<@&${stats.unrankedRoleId}>` : 'Unranked'
  const label = stats.historicalRankLabel !== undefined ? stats.historicalRankLabel
    : stats.publicEra ? publicRank : modeSummary ? formatRankedRoleMention(modeSummary) : eligible ? null : 'Unranked'
  const displayedTier = eligible ? modeSummary?.divisionMinimum != null ? modeSummary.tier : badge.tier : null
  const ratingText = stats.publicEra && stats.historicalRankLabel === undefined ? formatPublicRankRating(rating, displayedTier) : String(rating)
  const lines = [`${stats.currentRatingLabel ? 'Current: ' : ''}${label ? `${label} · ` : ''}${ratingText}${stats.publicEra ? ' RP' : ''}`]

  const rank = stats.position != null ? `#${stats.position}` : formatModeRank(modeSummary)
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

async function listCompletedPlayerMatchSummaries(
  db: Database,
  playerId: string,
  modeFilter: StatsModeFilter,
  seasonId: string | null,
): Promise<CompletedPlayerMatchRow[]> {
  const participations = await db
    .select({
      matchId: matchParticipants.matchId,
      team: matchParticipants.team,
      placement: matchParticipants.placement,
    })
    .from(matchParticipants)
    .where(eq(matchParticipants.playerId, playerId))

  if (participations.length === 0) return []

  const participationByMatchId = new Map(participations.map(row => [row.matchId, row]))
  const rows: CompletedPlayerMatchRow[] = []

  for (const batch of chunk(participations.map(row => row.matchId), MATCH_ID_BATCH_SIZE)) {
    const conditions = [
      inArray(matches.id, batch),
      eq(matches.status, 'completed'),
    ]
    if (seasonId) conditions.push(eq(matches.seasonId, seasonId))
    if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))

    const matchRows = await db
      .select({
        matchId: matches.id,
        createdAt: matches.createdAt,
      })
      .from(matches)
      .where(and(...conditions))

    for (const match of matchRows) {
      const participation = participationByMatchId.get(match.matchId)
      if (!participation) continue
      rows.push({
        matchId: match.matchId,
        team: participation.team,
        placement: participation.placement,
        createdAt: match.createdAt,
      })
    }
  }

  return rows.sort((left, right) => right.createdAt - left.createdAt || right.matchId.localeCompare(left.matchId))
}

async function listFfaRatingWinSnapshotRows(
  db: Database,
  playerId: string,
  seasonId: string | null,
): Promise<ModeRatingSnapshotRow[]> {
  const conditions = [
    eq(playerRatingEvents.playerId, playerId),
    eq(playerRatingEvents.mode, 'ffa'),
    eq(matches.status, 'completed'),
  ]
  if (seasonId) conditions.push(eq(matches.seasonId, seasonId))

  return await db
    .select({
      gameMode: playerRatingEvents.gameMode,
      draftData: sql<string | null>`null`,
      ratingBeforeMu: playerRatingEvents.ratingBeforeMu,
      ratingBeforeSigma: playerRatingEvents.ratingBeforeSigma,
      ratingAfterMu: playerRatingEvents.ratingAfterMu,
      ratingAfterSigma: playerRatingEvents.ratingAfterSigma,
    })
    .from(playerRatingEvents)
    .innerJoin(matches, eq(playerRatingEvents.matchId, matches.id))
    .where(and(...conditions))
}

async function listRecentPlayerMatches(
  db: Database,
  playerId: string,
  matchIds: string[],
): Promise<RecentPlayerMatchRow[]> {
  if (matchIds.length === 0) return []

  const [participantRows, tournamentRows] = await Promise.all([
    db
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
        createdAt: matches.createdAt,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        eq(matchParticipants.playerId, playerId),
        inArray(matchParticipants.matchId, matchIds),
      )),
    db
      .select({
        matchId: tournamentMatches.matchId,
        sessionId: tournamentMatches.sessionId,
      })
      .from(tournamentMatches)
      .where(or(
        inArray(tournamentMatches.matchId, matchIds),
        inArray(tournamentMatches.sessionId, matchIds),
      )),
  ])

  const tournamentMatchIds = new Set<string>()
  for (const row of tournamentRows) {
    if (row.matchId) tournamentMatchIds.add(row.matchId)
    if (row.sessionId) tournamentMatchIds.add(row.sessionId)
  }

  return participantRows
    .map(({ createdAt, ...row }) => ({
      ...row,
      isTournament: tournamentMatchIds.has(row.matchId),
      createdAt,
    }))
    .sort((left, right) => right.createdAt - left.createdAt || right.matchId.localeCompare(left.matchId))
    .map(({ createdAt: _createdAt, ...row }) => row)
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
  gameMode: string
  draftData: string | null
  isTournament?: boolean
} & PublicRatingSnapshot): string {
  if (match.isTournament) return `${formatTournamentResultEmoji(match.placement)} \`Tournament\``
  if (getStoredGameModeContext(match.gameMode, match.draftData)?.civBlitz) return formatUnrankedResultMarker(match.placement)
  const publicChange = formatPublicRatingSnapshotChange(match)
  if (publicChange != null) return publicChange
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
