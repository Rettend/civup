import type { Database, matchBans, matches, matchParticipants, playerRatingSeeds, playerRatings, players } from '@civup/db'
import type { XlsxCellValue, XlsxWorksheet } from './xlsx.ts'
import { asc } from 'drizzle-orm'
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
  const worksheets = await buildPlayerDataExportSheets(db)
  const data = createXlsxWorkbook(worksheets)

  return {
    filename: `export-${formatFilenameDate(now)}.xlsx`,
    contentType: PLAYER_DATA_EXPORT_CONTENT_TYPE,
    data,
    counts: Object.fromEntries(worksheets.map(worksheet => [worksheet.name, worksheet.rows.length])),
  }
}

export async function buildPlayerDataExportSheets(db: Database): Promise<XlsxWorksheet[]> {
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
    playersWorksheet(playerRows, lastMatchAtByPlayerId),
    ratingsWorksheet(ratingRows, displayNameByPlayerId),
    ratingSeedsWorksheet(seedRows, displayNameByPlayerId),
    matchesWorksheet(matchRows),
    matchParticipantsWorksheet(participantRows, displayNameByPlayerId),
    matchBansWorksheet(exportBanRows, displayNameByPlayerId),
  ]
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
