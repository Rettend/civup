import type { Database, matchBans, matches, matchParticipants, playerRatingSeeds, playerRatings, players } from '@civup/db'
import type { XlsxCellValue, XlsxWorksheet } from './xlsx.ts'
import { asc } from 'drizzle-orm'
import { getLeader } from '@civup/game'
import { displayRating } from '@civup/rating'
import { matchBans as matchBansTable, matches as matchesTable, matchParticipants as matchParticipantsTable, playerRatingSeeds as playerRatingSeedsTable, playerRatings as playerRatingsTable, players as playersTable } from '@civup/db'
import { createXlsxWorkbook, xlsxDateFromUnixMs } from './xlsx.ts'

export const PLAYER_DATA_EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface PlayerDataExportFile {
  filename: string
  contentType: string
  data: Uint8Array
  counts: Record<string, number>
}

type PlayerRow = typeof players.$inferSelect
type PlayerRatingRow = typeof playerRatings.$inferSelect
type PlayerRatingSeedRow = typeof playerRatingSeeds.$inferSelect
type MatchRow = typeof matches.$inferSelect
type MatchParticipantRow = typeof matchParticipants.$inferSelect
type MatchBanRow = typeof matchBans.$inferSelect

interface ExportMatchBanRow {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

interface OverviewLeaderAggregate {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
  placementTotal: number
  placementCount: number
  pickedMatchIds: Set<string>
  bannedMatchIds: Set<string>
}

interface OverviewLeaderSummary {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
  winRatePct: number | null
  averagePlacement: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

interface ParsedDraftData {
  state?: {
    bans?: Array<{
      civId?: unknown
      seatIndex?: unknown
      stepIndex?: unknown
    }>
    seats?: Array<{
      playerId?: unknown
    }>
  }
}

export async function buildPlayerDataExport(db: Database, options: { now?: Date } = {}): Promise<PlayerDataExportFile> {
  const now = options.now ?? new Date()
  const worksheets = await buildPlayerDataExportSheets(db, { now })
  const data = await createXlsxWorkbook(worksheets)

  return {
    filename: `export-${formatFilenameDate(now)}.xlsx`,
    contentType: PLAYER_DATA_EXPORT_CONTENT_TYPE,
    data,
    counts: Object.fromEntries(worksheets.map(worksheet => [worksheet.name, worksheet.rows.length])),
  }
}

export async function buildPlayerDataExportSheets(db: Database, options: { now?: Date } = {}): Promise<XlsxWorksheet[]> {
  const now = options.now ?? new Date()
  const [playerRows, ratingRows, seedRows, matchRows, participantRows, banRows] = await Promise.all([
    db.select().from(playersTable).orderBy(asc(playersTable.id)),
    db.select().from(playerRatingsTable).orderBy(asc(playerRatingsTable.playerId), asc(playerRatingsTable.mode)),
    db.select().from(playerRatingSeedsTable).orderBy(asc(playerRatingSeedsTable.playerId), asc(playerRatingSeedsTable.mode)),
    db.select().from(matchesTable).orderBy(asc(matchesTable.createdAt), asc(matchesTable.id)),
    db.select().from(matchParticipantsTable).orderBy(asc(matchParticipantsTable.matchId), asc(matchParticipantsTable.team), asc(matchParticipantsTable.playerId)),
    db.select().from(matchBansTable).orderBy(asc(matchBansTable.matchId), asc(matchBansTable.phase), asc(matchBansTable.civId)),
  ])
  const displayNameByPlayerId = new Map(playerRows.map(player => [player.id, player.displayName]))
  const lastMatchAtByPlayerId = buildLastMatchAtByPlayerId(matchRows, participantRows)
  const exportBanRows = buildExportBanRows(banRows, matchRows)

  return [
    overviewWorksheet({
      now,
      playerRows,
      ratingRows,
      seedRows,
      matchRows,
      participantRows,
      banRows: exportBanRows,
    }),
    playersWorksheet(playerRows, lastMatchAtByPlayerId),
    ratingsWorksheet(ratingRows, displayNameByPlayerId),
    ratingSeedsWorksheet(seedRows, displayNameByPlayerId),
    matchesWorksheet(matchRows),
    matchParticipantsWorksheet(participantRows, displayNameByPlayerId),
    matchBansWorksheet(exportBanRows, displayNameByPlayerId),
  ]
}

function overviewWorksheet(input: {
  now: Date
  playerRows: PlayerRow[]
  ratingRows: PlayerRatingRow[]
  seedRows: PlayerRatingSeedRow[]
  matchRows: MatchRow[]
  participantRows: MatchParticipantRow[]
  banRows: ExportMatchBanRow[]
}): XlsxWorksheet {
  const completedMatchRows = input.matchRows.filter(match => match.status === 'completed')
  const completedMatchIds = new Set(completedMatchRows.map(match => match.id))
  const completedParticipants = input.participantRows.filter(participant => completedMatchIds.has(participant.matchId))
  const completedBans = input.banRows.filter(ban => completedMatchIds.has(ban.matchId))
  const participantsByMatch = groupParticipantsByMatch(input.participantRows)
  const firstCompletedAt = minTimestamp(completedMatchRows.map(match => match.completedAt))
  const lastCompletedAt = maxTimestamp(completedMatchRows.map(match => match.completedAt))
  const recent7d = buildRecentActivity(completedMatchRows, participantsByMatch, input.now, 7)
  const recent30d = buildRecentActivity(completedMatchRows, participantsByMatch, input.now, 30)
  const modeRows = buildModeRows(completedMatchRows)
  const weeklyRows = buildWeeklyActivityRows(completedMatchRows, participantsByMatch)
  const leaderRows = buildLeaderOverview(completedMatchRows, completedParticipants, completedBans)
  const rows: XlsxCellValue[][] = [
    [],
    ['Summary'],
    ['Metric', 'Value'],
    ['Generated at', formatTimestampMs(input.now.getTime())],
    ['Stored players', input.playerRows.length],
    ['Players with matches', new Set(input.participantRows.map(participant => participant.playerId)).size],
    ['Ratings', input.ratingRows.length],
    ['Rating seeds', input.seedRows.length],
    ['Matches', input.matchRows.length],
    ['Completed matches', completedMatchRows.length],
    ['Old bot matches', input.matchRows.filter(match => match.isOld).length],
    ['Player-games in completed matches', completedParticipants.length],
    ['Recorded bans in completed matches', completedBans.length],
    ['First completed match', formatTimestampMs(firstCompletedAt)],
    ['Last completed match', formatTimestampMs(lastCompletedAt)],
    [],
    ['Recent Activity'],
    ['Window', 'Completed matches', 'Unique players'],
    ['Last 7 days', recent7d.completedMatches, recent7d.uniquePlayers],
    ['Last 30 days', recent30d.completedMatches, recent30d.uniquePlayers],
  ]

  rows.push([], ['Mode Breakdown'], ['Mode', 'Completed matches'])
  for (const row of modeRows) rows.push([row.gameMode, row.completedMatches])

  rows.push([], ['Weekly Activity'], ['ISO week', 'Week start', 'Completed matches', 'Unique players'])
  for (const row of weeklyRows) rows.push([row.isoWeek, xlsxDateFromUnixMs(row.weekStartAt), row.completedMatches, row.uniquePlayers])

  rows.push([], ['Top Picked Leaders'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate'])
  for (const row of leaderRows.mostPicked) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct)])

  rows.push([], ['Top Banned Leaders'], ['Leader', 'Civilization', 'Bans', 'Picks'])
  for (const row of leaderRows.mostBanned) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.bans, row.picks])

  rows.push([], ['Best Win Rates (min 10 picks)'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate', 'Average placement'])
  for (const row of leaderRows.bestWinRatesMin10) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct), row.averagePlacement])

  return {
    name: 'overview',
    columns: ['Overview'],
    rows,
  }
}

function playersWorksheet(rows: PlayerRow[], lastMatchAtByPlayerId: Map<string, number>): XlsxWorksheet {
  return {
    name: 'players',
    columns: ['player_id', 'display_name', 'created_at_utc', 'last_match_at_utc'],
    rows: rows.map(player => [
      player.id,
      player.displayName,
      formatTimestampMs(player.createdAt),
      formatTimestampMs(lastMatchAtByPlayerId.get(player.id)),
    ]),
  }
}

function ratingsWorksheet(rows: PlayerRatingRow[], displayNameByPlayerId: Map<string, string>): XlsxWorksheet {
  return {
    name: 'ratings',
    columns: ['player_id', 'display_name', 'mode', 'rating', 'mu', 'sigma', 'games_played', 'wins', 'last_played_at_utc'],
    rows: rows.map(rating => [
      rating.playerId,
      displayNameByPlayerId.get(rating.playerId) ?? null,
      rating.mode,
      formatDisplayRating(rating.mu, rating.sigma),
      rating.mu,
      rating.sigma,
      rating.gamesPlayed,
      rating.wins,
      formatTimestampMs(rating.lastPlayedAt),
    ]),
  }
}

function ratingSeedsWorksheet(rows: PlayerRatingSeedRow[], displayNameByPlayerId: Map<string, string>): XlsxWorksheet {
  return {
    name: 'rating_seeds',
    columns: ['player_id', 'display_name', 'mode', 'seed_rating', 'seed_mu', 'seed_sigma', 'eligible_for_ranked', 'fade_games_remaining', 'source', 'note', 'created_at_utc', 'updated_at_utc'],
    rows: rows.map(seed => [
      seed.playerId,
      displayNameByPlayerId.get(seed.playerId) ?? null,
      seed.mode,
      formatDisplayRating(seed.mu, seed.sigma),
      seed.mu,
      seed.sigma,
      seed.eligibleForRanked,
      seed.fadeGamesRemaining,
      seed.source,
      seed.note,
      formatTimestampMs(seed.createdAt),
      formatTimestampMs(seed.updatedAt),
    ]),
  }
}

function matchesWorksheet(rows: MatchRow[]): XlsxWorksheet {
  return {
    name: 'matches',
    columns: ['match_id', 'game_mode', 'status', 'old_bot', 'season_id', 'created_at_utc', 'completed_at_utc'],
    rows: rows.map(match => [
      match.id,
      match.gameMode,
      match.status,
      match.isOld,
      match.seasonId,
      formatTimestampMs(match.createdAt),
      formatTimestampMs(match.completedAt),
    ]),
  }
}

function matchParticipantsWorksheet(rows: MatchParticipantRow[], displayNameByPlayerId: Map<string, string>): XlsxWorksheet {
  return {
    name: 'match_participants',
    columns: ['match_id', 'player_id', 'display_name', 'team', 'civ_id', 'placement', 'rating_before', 'rating_after', 'rating_delta', 'rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'],
    rows: rows.map(participant => {
      const ratingBefore = formatDisplayRating(participant.ratingBeforeMu, participant.ratingBeforeSigma)
      const ratingAfter = formatDisplayRating(participant.ratingAfterMu, participant.ratingAfterSigma)
      return [
        participant.matchId,
        participant.playerId,
        displayNameByPlayerId.get(participant.playerId) ?? null,
        participant.team,
        participant.civId,
        participant.placement,
        ratingBefore,
        ratingAfter,
        ratingBefore == null || ratingAfter == null ? null : ratingAfter - ratingBefore,
        participant.ratingBeforeMu,
        participant.ratingBeforeSigma,
        participant.ratingAfterMu,
        participant.ratingAfterSigma,
      ]
    }),
  }
}

function matchBansWorksheet(rows: ExportMatchBanRow[], displayNameByPlayerId: Map<string, string>): XlsxWorksheet {
  return {
    name: 'match_bans',
    columns: ['match_id', 'phase', 'civ_id', 'banned_by_player_id', 'banned_by_display_name'],
    rows: rows.map(ban => [
      ban.matchId,
      ban.phase,
      ban.civId,
      ban.bannedBy,
      displayNameByPlayerId.get(ban.bannedBy) ?? null,
    ]),
  }
}

function groupParticipantsByMatch(rows: MatchParticipantRow[]): Map<string, MatchParticipantRow[]> {
  const result = new Map<string, MatchParticipantRow[]>()

  for (const row of rows) {
    const existing = result.get(row.matchId)
    if (existing) existing.push(row)
    else result.set(row.matchId, [row])
  }

  return result
}

function buildRecentActivity(
  matches: MatchRow[],
  participantsByMatch: Map<string, MatchParticipantRow[]>,
  now: Date,
  days: number,
): { completedMatches: number, uniquePlayers: number } {
  const cutoff = now.getTime() - (days * DAY_MS)
  const playerIds = new Set<string>()
  let completedMatches = 0

  for (const match of matches) {
    if (match.isOld || match.completedAt == null || match.completedAt < cutoff) continue
    completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) playerIds.add(participant.playerId)
  }

  return { completedMatches, uniquePlayers: playerIds.size }
}

function buildModeRows(matches: MatchRow[]): Array<{ gameMode: string, completedMatches: number }> {
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.gameMode, (counts.get(match.gameMode) ?? 0) + 1)

  return Array.from(counts.entries())
    .map(([gameMode, completedMatches]) => ({ gameMode, completedMatches }))
    .sort((left, right) => right.completedMatches - left.completedMatches || left.gameMode.localeCompare(right.gameMode))
}

function buildWeeklyActivityRows(
  matches: MatchRow[],
  participantsByMatch: Map<string, MatchParticipantRow[]>,
): Array<{ isoWeek: string, weekStartAt: number, completedMatches: number, uniquePlayers: number }> {
  const buckets = new Map<string, { weekStartAt: number, completedMatches: number, playerIds: Set<string> }>()

  for (const match of matches) {
    if (match.isOld || match.completedAt == null) continue
    const week = getIsoWeekBucket(match.completedAt)
    const bucket = buckets.get(week.isoWeek) ?? {
      weekStartAt: week.weekStartAt,
      completedMatches: 0,
      playerIds: new Set<string>(),
    }
    bucket.completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) bucket.playerIds.add(participant.playerId)
    buckets.set(week.isoWeek, bucket)
  }

  return Array.from(buckets.entries())
    .map(([isoWeek, bucket]) => ({
      isoWeek,
      weekStartAt: bucket.weekStartAt,
      completedMatches: bucket.completedMatches,
      uniquePlayers: bucket.playerIds.size,
    }))
    .sort((left, right) => left.weekStartAt - right.weekStartAt)
}

function buildLeaderOverview(
  matches: MatchRow[],
  participants: MatchParticipantRow[],
  bans: ExportMatchBanRow[],
): { mostPicked: OverviewLeaderSummary[], mostBanned: OverviewLeaderSummary[], bestWinRatesMin10: OverviewLeaderSummary[] } {
  const matchIds = new Set(matches.map(match => match.id))
  const aggregates = new Map<string, OverviewLeaderAggregate>()

  for (const participant of participants) {
    if (!matchIds.has(participant.matchId) || !participant.civId) continue
    const aggregate = getLeaderAggregate(aggregates, participant.civId)
    aggregate.picks += 1
    aggregate.pickedMatchIds.add(participant.matchId)
    if (participant.placement === 1) aggregate.wins += 1
    if (typeof participant.placement === 'number') {
      aggregate.placementTotal += participant.placement
      aggregate.placementCount += 1
    }
  }

  for (const ban of bans) {
    if (!matchIds.has(ban.matchId)) continue
    const aggregate = getLeaderAggregate(aggregates, ban.civId)
    aggregate.bans += 1
    aggregate.bannedMatchIds.add(ban.matchId)
  }

  const summaries = Array.from(aggregates.values()).map(toLeaderSummary)
  return {
    mostPicked: summaries
      .filter(row => row.picks > 0)
      .sort((left, right) => right.picks - left.picks || right.wins - left.wins || left.civId.localeCompare(right.civId))
      .slice(0, 10),
    mostBanned: summaries
      .filter(row => row.bans > 0)
      .sort((left, right) => right.bans - left.bans || right.picks - left.picks || left.civId.localeCompare(right.civId))
      .slice(0, 10),
    bestWinRatesMin10: summaries
      .filter(row => row.picks >= 10 && row.winRatePct != null)
      .sort((left, right) => (right.winRatePct ?? 0) - (left.winRatePct ?? 0) || right.picks - left.picks || left.civId.localeCompare(right.civId))
      .slice(0, 10),
  }
}

function getLeaderAggregate(aggregates: Map<string, OverviewLeaderAggregate>, civId: string): OverviewLeaderAggregate {
  const existing = aggregates.get(civId)
  if (existing) return existing

  const meta = resolveLeaderMeta(civId)
  const created: OverviewLeaderAggregate = {
    civId,
    leaderName: meta.leaderName,
    civilizationName: meta.civilizationName,
    picks: 0,
    bans: 0,
    wins: 0,
    placementTotal: 0,
    placementCount: 0,
    pickedMatchIds: new Set<string>(),
    bannedMatchIds: new Set<string>(),
  }
  aggregates.set(civId, created)
  return created
}

function resolveLeaderMeta(civId: string): { leaderName: string, civilizationName: string } {
  try {
    const leader = getLeader(civId)
    return { leaderName: leader.name, civilizationName: leader.civilization }
  }
  catch {
    return { leaderName: '', civilizationName: '' }
  }
}

function toLeaderSummary(row: OverviewLeaderAggregate): OverviewLeaderSummary {
  return {
    civId: row.civId,
    leaderName: row.leaderName,
    civilizationName: row.civilizationName,
    picks: row.picks,
    bans: row.bans,
    wins: row.wins,
    winRatePct: row.picks > 0 ? round((row.wins / row.picks) * 100, 1) : null,
    averagePlacement: row.placementCount > 0 ? round(row.placementTotal / row.placementCount, 2) : null,
  }
}

function formatPercent(value: number | null): string {
  return value == null ? '' : `${value}%`
}

function getIsoWeekBucket(timestampMs: number): { isoWeek: string, weekStartAt: number } {
  const source = new Date(timestampMs)
  const dayStart = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()))
  const weekday = dayStart.getUTCDay() || 7
  const weekStart = new Date(dayStart)
  weekStart.setUTCDate(dayStart.getUTCDate() - weekday + 1)

  const thursday = new Date(dayStart)
  thursday.setUTCDate(dayStart.getUTCDate() + 4 - weekday)

  const isoYear = thursday.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const weekNumber = Math.ceil((((thursday.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7)

  return {
    isoWeek: `${isoYear}-W${String(weekNumber).padStart(2, '0')}`,
    weekStartAt: weekStart.getTime(),
  }
}

function minTimestamp(values: Array<number | null>): number | null {
  const timestamps = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return timestamps.length > 0 ? Math.min(...timestamps) : null
}

function maxTimestamp(values: Array<number | null>): number | null {
  const timestamps = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return timestamps.length > 0 ? Math.max(...timestamps) : null
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function formatDisplayRating(mu: number | null | undefined, sigma: number | null | undefined): number | null {
  if (typeof mu !== 'number' || typeof sigma !== 'number') return null
  if (!Number.isFinite(mu) || !Number.isFinite(sigma)) return null
  return Math.round(displayRating(mu, sigma))
}

function formatTimestampMs(timestampMs: number | null | undefined): XlsxCellValue {
  if (timestampMs == null) return null
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return timestampMs
  return xlsxDateFromUnixMs(timestampMs)
}

function formatFilenameDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function buildExportBanRows(tableRows: MatchBanRow[], matchRows: MatchRow[]): ExportMatchBanRow[] {
  const rows: ExportMatchBanRow[] = []
  const seen = new Set<string>()

  for (const row of tableRows) {
    addExportBanRow(rows, seen, row)
  }

  for (const match of matchRows) {
    for (const row of extractDraftDataBanRows(match)) {
      addExportBanRow(rows, seen, row)
    }
  }

  return rows.sort((left, right) => {
    const matchCompare = left.matchId.localeCompare(right.matchId)
    if (matchCompare !== 0) return matchCompare
    if (left.phase !== right.phase) return left.phase - right.phase
    const civCompare = left.civId.localeCompare(right.civId)
    if (civCompare !== 0) return civCompare
    return left.bannedBy.localeCompare(right.bannedBy)
  })
}

function buildLastMatchAtByPlayerId(matchRows: MatchRow[], participantRows: MatchParticipantRow[]): Map<string, number> {
  const matchAtById = new Map(matchRows.map(match => [match.id, match.completedAt ?? match.createdAt]))
  const lastMatchAtByPlayerId = new Map<string, number>()

  for (const participant of participantRows) {
    const matchAt = matchAtById.get(participant.matchId)
    if (matchAt == null) continue
    const current = lastMatchAtByPlayerId.get(participant.playerId)
    if (current == null || matchAt > current) lastMatchAtByPlayerId.set(participant.playerId, matchAt)
  }

  return lastMatchAtByPlayerId
}

function addExportBanRow(rows: ExportMatchBanRow[], seen: Set<string>, row: ExportMatchBanRow): void {
  const key = `${row.matchId}\0${row.phase}\0${row.civId}\0${row.bannedBy}`
  if (seen.has(key)) return
  seen.add(key)
  rows.push(row)
}

function extractDraftDataBanRows(match: MatchRow): ExportMatchBanRow[] {
  const parsed = parseDraftData(match.draftData)
  const bans = parsed?.state?.bans
  const seats = parsed?.state?.seats
  if (!Array.isArray(bans) || !Array.isArray(seats)) return []

  return bans.flatMap((ban) => {
    if (typeof ban?.civId !== 'string' || ban.civId.length === 0) return []
    if (typeof ban.seatIndex !== 'number' || !Number.isInteger(ban.seatIndex)) return []
    if (typeof ban.stepIndex !== 'number' || !Number.isInteger(ban.stepIndex)) return []

    const bannedBy = seats[ban.seatIndex]?.playerId
    if (typeof bannedBy !== 'string' || bannedBy.length === 0) return []

    return [{
      matchId: match.id,
      civId: ban.civId,
      bannedBy,
      phase: ban.stepIndex,
    }]
  })
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    const parsed = JSON.parse(draftData) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ParsedDraftData
  }
  catch {
    return null
  }
}
