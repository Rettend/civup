<<<<<<< New base: fix: mod resolve
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js'
import { getLeader } from '@civup/game'
import { CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import { buildActivitySessionHeaders, getActivitySessionToken } from './activity-session'

export const PLAYER_DATA_EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const EXPORT_ENDPOINT = '/api/activity/admin/player-data-export'
const EXPORT_ESTIMATE_ENDPOINT = '/api/activity/admin/player-data-export-estimate'
const EXPORT_UPLOAD_ENDPOINT = '/api/uploads/player-data-export'
const EXPORT_VERSION = 1
const EXPORT_PARENT_PAGE_SIZE = 50
const MAX_RATINGS_PER_PAGE = 1_000
const MAX_PARTICIPANTS_PER_PAGE = 2_000
const MAX_BANS_PER_PAGE = 5_000
const MAX_EXPORT_PAGES = 10_000
const MAX_WORKSHEET_DATA_ROWS = 1_048_575
const MAX_TOTAL_SOURCE_ROWS = 500_000
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const DAY_MS = 24 * 60 * 60 * 1000

export interface PlayerDataExportPlayer {
  id: string
  displayName: string
  createdAt: number
}

export interface PlayerDataExportRating {
  playerId: string
  mode: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

export interface PlayerDataExportMatch {
  id: string
  gameMode: string
  status: string
  isOld: boolean
  seasonId: string | null
  createdAt: number
  completedAt: number | null
}

export interface PlayerDataExportParticipant {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

export interface PlayerDataExportBan {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

export interface PlayerDataExportSource {
  generatedAt: number
  cutoffAt: number
  players: PlayerDataExportPlayer[]
  ratings: PlayerDataExportRating[]
  matches: PlayerDataExportMatch[]
  participants: PlayerDataExportParticipant[]
  bans: PlayerDataExportBan[]
}

export type PlayerDataExportProgress = {
  phase: 'players' | 'matches' | 'workbook'
  players: number
  ratings: number
  matches: number
  participants: number
  bans: number
}

export type PlayerDataExportState
  = | { status: 'idle' }
    | { status: 'estimating' }
    | { status: 'estimate', estimate: PlayerDataExportEstimate }
    | ({ status: 'loading' } & PlayerDataExportProgress)
    | {
      status: 'ready'
      filename: string
      url: string
      players: number
      matches: number
    }
    | { status: 'error', message: string, retry: 'estimate' | 'export' }

export interface PlayerDataExportEstimate {
  version: typeof EXPORT_VERSION
  estimatedAt: number
  rows: {
    players: number
    ratings: number
    matches: number
    participants: number
    storedBans: number
  }
  dataPageRequests: number
  workerRequests: number
  d1RowsRead: {
    lowEstimate: number
    highEstimate: number
  }
  dailyFreeAllowance: {
    workerRequests: number
    d1RowsRead: number
  }
}

export interface PlayerDataExportFile {
  blob: Blob
  filename: string
  source: PlayerDataExportSource
}

export type XlsxCellValue = string | number | boolean | XlsxDateValue | null | undefined

export interface XlsxDateValue {
  type: 'date'
  value: number
}

export interface StreamingXlsxWorksheet {
  name: string
  columns: readonly string[]
  columnCount?: number
  rowCount: number
  rows: () => IterableIterator<readonly XlsxCellValue[]>
}

interface ExportRequestOptions {
  fetchImpl?: typeof fetch
  onProgress?: (progress: PlayerDataExportProgress) => void
}

export interface PublishedPlayerDataExport {
  filename: string
  url: string
}

export async function fetchPlayerDataExportEstimate(fetchImpl: typeof fetch = fetch): Promise<PlayerDataExportEstimate> {
  const response = await fetchImpl(EXPORT_ESTIMATE_ENDPOINT, {
    cache: 'no-store',
    headers: buildActivitySessionHeaders({ Accept: 'application/json' }),
  })
  if (response.status === 401) throw new Error('Your session expired. Reopen the Activity and try the export again.')
  if (response.status === 403) throw new Error('Player data export is only available to server administrators.')

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readPayloadError(payload) ?? `Player data export estimate failed (${response.status}).`)
  const estimate = parseExportEstimate(payload)
  if (!estimate) throw new Error('Player data export estimate returned malformed data.')
  return estimate
}

interface ExportPageBase {
  version: number
  generatedAt: number
  cutoffAt: number
  phase: 'players' | 'matches'
  nextCursor: string | null
}

interface PlayerExportPage extends ExportPageBase {
  phase: 'players'
  players: PlayerDataExportPlayer[]
  ratings: PlayerDataExportRating[]
}

interface MatchExportPage extends ExportPageBase {
  phase: 'matches'
  matches: PlayerDataExportMatch[]
  participants: PlayerDataExportParticipant[]
  bans: PlayerDataExportBan[]
}

type ExportPage = PlayerExportPage | MatchExportPage

interface OverviewLeaderAggregate {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
  placementTotal: number
  placementCount: number
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

export async function createPlayerDataExport(options: ExportRequestOptions = {}): Promise<PlayerDataExportFile> {
  const source = await fetchPlayerDataExport(options)
  options.onProgress?.(progressFor(source, 'workbook'))
  const blob = await createPlayerDataWorkbook(source)
  return {
    blob,
    filename: `export-${new Date(source.generatedAt).toISOString().slice(0, 10)}.xlsx`,
    source,
  }
}

export async function publishPlayerDataExport(
  file: PlayerDataExportFile,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedPlayerDataExport> {
  const response = await fetchImpl(`${EXPORT_UPLOAD_ENDPOINT}?filename=${encodeURIComponent(file.filename)}`, {
    method: 'POST',
    cache: 'no-store',
    headers: buildActivitySessionHeaders({
      Accept: 'application/json',
      'Content-Type': PLAYER_DATA_EXPORT_CONTENT_TYPE,
    }),
    body: file.blob,
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readPayloadError(payload) ?? `Export download preparation failed (${response.status}).`)
  if (!payload || typeof payload !== 'object') throw new Error('Export download preparation returned malformed data.')
  const filename = (payload as { filename?: unknown }).filename
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('Export download preparation returned malformed data.')

  const url = new URL(`${EXPORT_UPLOAD_ENDPOINT}/download`, window.location.origin)
  const sessionToken = getActivitySessionToken()
  if (sessionToken) url.searchParams.set(CIVUP_ACTIVITY_SESSION_QUERY_PARAM, sessionToken)
  return { filename, url: url.toString() }
}

export async function fetchPlayerDataExport(options: ExportRequestOptions = {}): Promise<PlayerDataExportSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const source: PlayerDataExportSource = {
    generatedAt: 0,
    cutoffAt: 0,
    players: [],
    ratings: [],
    matches: [],
    participants: [],
    bans: [],
  }
  const seenPlayerIds = new Set<string>()
  const seenMatchIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let pageCount = 0
  let matchPhaseStarted = false

  do {
    if (pageCount >= MAX_EXPORT_PAGES) throw new Error('Player data export returned too many pages.')
    const url = cursor == null ? EXPORT_ENDPOINT : `${EXPORT_ENDPOINT}?cursor=${encodeURIComponent(cursor)}`
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: buildActivitySessionHeaders({ Accept: 'application/json' }),
    })
    if (response.status === 401) throw new Error('Your session expired. Reopen the Activity and try the export again.')
    if (response.status === 403) throw new Error('Player data export is only available to server administrators.')

    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(readPayloadError(payload) ?? `Player data export failed (${response.status}).`)
    const page = parseExportPage(payload)
    if (!page) throw new Error('Player data export returned malformed data.')

    if (pageCount === 0) {
      source.generatedAt = page.generatedAt
      source.cutoffAt = page.cutoffAt
      if (page.phase !== 'players') throw new Error('Player data export started in an invalid phase.')
    }
    else if (page.generatedAt !== source.generatedAt || page.cutoffAt !== source.cutoffAt) {
      throw new Error('Player data export cutoff changed between pages.')
    }

    assertCanAppendPage(source, page)
    if (page.phase === 'players') {
      if (matchPhaseStarted) throw new Error('Player data export returned to the player phase.')
      appendUniqueParents(source.players, page.players, seenPlayerIds, row => row.id, 'player')
      appendRows(source.ratings, page.ratings)
    }
    else {
      matchPhaseStarted = true
      appendUniqueParents(source.matches, page.matches, seenMatchIds, row => row.id, 'match')
      appendRows(source.participants, page.participants)
      appendRows(source.bans, page.bans)
    }

    options.onProgress?.(progressFor(source, page.phase))
    cursor = page.nextCursor
    if (page.phase === 'players' && cursor == null) throw new Error('Player data export ended before the match phase.')
    if (cursor != null) {
      if (seenCursors.has(cursor)) throw new Error('Player data export repeated a cursor.')
      seenCursors.add(cursor)
    }
    pageCount += 1
  } while (cursor != null)

  if (!matchPhaseStarted) throw new Error('Player data export did not include the match phase.')
  return source
}

export async function createPlayerDataWorkbook(source: PlayerDataExportSource): Promise<Blob> {
  assertSourceRowLimits(source)
  sortPlayerDataExportSource(source)
  const worksheets = buildPlayerDataWorksheets(source)
  return createStreamingXlsxWorkbook(worksheets)
}

export function buildPlayerDataWorksheets(source: PlayerDataExportSource): StreamingXlsxWorksheet[] {
  const lastMatchAtByPlayerId = buildLastMatchAtByPlayerId(source.matches, source.participants)
  const overviewRows = buildOverviewRows(source)

  return [
    worksheetFromRows('overview', ['Overview'], overviewRows),
    {
      name: 'players',
      columns: ['player_id', 'display_name', 'created_at_utc', 'last_match_at_utc'],
      rowCount: source.players.length,
      rows: function* () {
        for (const player of source.players) {
          yield [player.id, player.displayName, formatTimestampMs(player.createdAt), formatTimestampMs(lastMatchAtByPlayerId.get(player.id))]
        }
      },
    },
    {
      name: 'ratings',
      columns: ['player_id', 'mode', 'mu', 'sigma', 'games_played', 'wins', 'last_played_at_utc'],
      rowCount: source.ratings.length,
      rows: function* () {
        for (const rating of source.ratings) {
          yield [rating.playerId, rating.mode, rating.mu, rating.sigma, rating.gamesPlayed, rating.wins, formatTimestampMs(rating.lastPlayedAt)]
        }
      },
    },
    {
      name: 'matches',
      columns: ['match_id', 'game_mode', 'status', 'old_bot', 'season_id', 'created_at_utc', 'completed_at_utc'],
      rowCount: source.matches.length,
      rows: function* () {
        for (const match of source.matches) {
          yield [match.id, match.gameMode, match.status, match.isOld, match.seasonId, formatTimestampMs(match.createdAt), formatTimestampMs(match.completedAt)]
        }
      },
    },
    {
      name: 'match_participants',
      columns: ['match_id', 'player_id', 'team', 'civ_id', 'placement', 'rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'],
      rowCount: source.participants.length,
      rows: function* () {
        for (const participant of source.participants) {
          yield [
            participant.matchId,
            participant.playerId,
            participant.team,
            participant.civId,
            participant.placement,
            participant.ratingBeforeMu,
            participant.ratingBeforeSigma,
            participant.ratingAfterMu,
            participant.ratingAfterSigma,
          ]
        }
      },
    },
    {
      name: 'match_bans',
      columns: ['match_id', 'phase', 'civ_id', 'banned_by_player_id'],
      rowCount: source.bans.length,
      rows: function* () {
        for (const ban of source.bans) yield [ban.matchId, ban.phase, ban.civId, ban.bannedBy]
      },
    },
  ]
}

async function createStreamingXlsxWorkbook(worksheets: StreamingXlsxWorksheet[]): Promise<Blob> {
  if (worksheets.length === 0) throw new Error('XLSX workbook needs at least one worksheet.')
  const safeWorksheets = worksheets.map((worksheet, index) => ({
    ...worksheet,
    name: sanitizeSheetName(worksheet.name, index),
  }))
  const zipWriter = new ZipWriter(new BlobWriter(PLAYER_DATA_EXPORT_CONTENT_TYPE), {
    bufferedWrite: false,
    level: 6,
  })

  await zipWriter.add('[Content_Types].xml', new TextReader(contentTypesXml(safeWorksheets.length)))
  await zipWriter.add('_rels/.rels', new TextReader(rootRelationshipsXml()))
  await zipWriter.add('xl/workbook.xml', new TextReader(workbookXml(safeWorksheets)))
  await zipWriter.add('xl/styles.xml', new TextReader(stylesXml()))
  await zipWriter.add('xl/_rels/workbook.xml.rels', new TextReader(workbookRelationshipsXml(safeWorksheets.length)))
  for (let index = 0; index < safeWorksheets.length; index += 1) {
    await zipWriter.add(`xl/worksheets/sheet${index + 1}.xml`, worksheetXmlStream(safeWorksheets[index]!))
  }
  const blob = await zipWriter.close()
  return blob.type === PLAYER_DATA_EXPORT_CONTENT_TYPE
    ? blob
    : new Blob([blob], { type: PLAYER_DATA_EXPORT_CONTENT_TYPE })
}

function worksheetXmlStream(worksheet: StreamingXlsxWorksheet): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const rows = worksheet.rows()
  let stage: 'start' | 'header' | 'rows' | 'end' | 'closed' = 'start'
  let rowNumber = 0

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 'start') {
        const lastColumn = columnName(Math.max(worksheet.columnCount ?? worksheet.columns.length, 1) - 1)
        const totalRows = worksheet.rowCount + 1
        controller.enqueue(encoder.encode(`${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${totalRows}"/><sheetData>`))
        stage = 'header'
        return
      }
      if (stage === 'header') {
        rowNumber = 1
        controller.enqueue(encoder.encode(rowXml(worksheet.columns, rowNumber)))
        stage = 'rows'
        return
      }
      if (stage === 'rows') {
        const next = rows.next()
        if (!next.done) {
          rowNumber += 1
          controller.enqueue(encoder.encode(rowXml(next.value, rowNumber)))
          return
        }
        stage = 'end'
      }
      if (stage === 'end') {
        controller.enqueue(encoder.encode('</sheetData></worksheet>'))
        stage = 'closed'
        return
      }
      controller.close()
    },
  })
}

function rowXml(row: readonly XlsxCellValue[], rowNumber: number): string {
  let cells = ''
  for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
    cells += cellXml(row[columnIndex], rowNumber, columnIndex)
  }
  return `<row r="${rowNumber}">${cells}</row>`
}

function cellXml(value: XlsxCellValue, rowNumber: number, columnIndex: number): string {
  const reference = `${columnName(columnIndex)}${rowNumber}`
  if (value === null || value === undefined) return `<c r="${reference}"/>`
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`
  if (typeof value === 'object' && value.type === 'date') return `<c r="${reference}" s="1"><v>${value.value}</v></c>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(String(value))}</t></is></c>`
}

function contentTypesXml(sheetCount: number): string {
  let worksheetOverrides = ''
  for (let index = 0; index < sheetCount; index += 1) {
    worksheetOverrides += `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  }
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheetOverrides}</Types>`
}

function rootRelationshipsXml(): string {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
}

function workbookXml(worksheets: StreamingXlsxWorksheet[]): string {
  let sheets = ''
  for (let index = 0; index < worksheets.length; index += 1) {
    sheets += `<sheet name="${escapeXmlAttribute(worksheets[index]!.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  }
  return `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`
}

function workbookRelationshipsXml(sheetCount: number): string {
  let relationships = ''
  for (let index = 0; index < sheetCount; index += 1) {
    relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  }
  relationships += `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
}

function stylesXml(): string {
  return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function buildOverviewRows(source: PlayerDataExportSource): XlsxCellValue[][] {
  const completedMatches = source.matches.filter(match => match.status === 'completed')
  const completedMatchIds = new Set(completedMatches.map(match => match.id))
  const completedParticipants = source.participants.filter(participant => completedMatchIds.has(participant.matchId))
  const completedBans = source.bans.filter(ban => completedMatchIds.has(ban.matchId))
  const participantsByMatch = groupParticipantsByMatch(source.participants)
  const recent7d = buildRecentActivity(completedMatches, participantsByMatch, source.generatedAt, 7)
  const recent30d = buildRecentActivity(completedMatches, participantsByMatch, source.generatedAt, 30)
  const modeRows = buildModeRows(completedMatches)
  const weeklyRows = buildWeeklyActivityRows(completedMatches, participantsByMatch)
  const leaderRows = buildLeaderOverview(completedParticipants, completedBans)
  const rows: XlsxCellValue[][] = [
    [],
    ['Summary'],
    ['Metric', 'Value'],
    ['Generated at', formatTimestampMs(source.generatedAt)],
    ['Stored players', source.players.length],
    ['Players with matches', new Set(source.participants.map(participant => participant.playerId)).size],
    ['Ratings', source.ratings.length],
    ['Matches', source.matches.length],
    ['Completed matches', completedMatches.length],
    ['Old bot matches', source.matches.filter(match => match.isOld).length],
    ['Player-games in completed matches', completedParticipants.length],
    ['Recorded bans in completed matches', completedBans.length],
    ['First completed match', formatTimestampMs(minTimestamp(completedMatches, match => match.completedAt))],
    ['Last completed match', formatTimestampMs(maxTimestamp(completedMatches, match => match.completedAt))],
    [],
    ['Recent Activity'],
    ['Window', 'Completed matches', 'Unique players'],
    ['Last 7 days', recent7d.completedMatches, recent7d.uniquePlayers],
    ['Last 30 days', recent30d.completedMatches, recent30d.uniquePlayers],
  ]

  rows.push([], ['Mode Breakdown'], ['Mode', 'Completed matches'])
  for (const row of modeRows) rows.push([row.gameMode, row.completedMatches])
  rows.push([], ['Weekly Activity'], ['ISO week', 'Week start', 'Completed matches', 'Unique players'])
  for (const row of weeklyRows) rows.push([row.isoWeek, formatTimestampMs(row.weekStartAt), row.completedMatches, row.uniquePlayers])
  rows.push([], ['Top Picked Leaders'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate'])
  for (const row of leaderRows.mostPicked) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct)])
  rows.push([], ['Top Banned Leaders'], ['Leader', 'Civilization', 'Bans', 'Picks', 'Wins', 'Win rate'])
  for (const row of leaderRows.mostBanned) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.bans, row.picks, row.wins, formatPercent(row.winRatePct)])
  rows.push([], ['Best Win Rates (min 10 picks)'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate', 'Average placement'])
  for (const row of leaderRows.bestWinRatesMin10) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct), row.averagePlacement])
  return rows
}

function sortPlayerDataExportSource(source: PlayerDataExportSource): void {
  source.players.sort((left, right) => left.id.localeCompare(right.id))
  source.ratings.sort((left, right) => left.playerId.localeCompare(right.playerId) || left.mode.localeCompare(right.mode))
  source.matches.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  const matchOrder = new Map<string, number>()
  for (let index = 0; index < source.matches.length; index += 1) matchOrder.set(source.matches[index]!.id, index)
  source.participants.sort((left, right) => (
    compareMatchOrder(left.matchId, right.matchId, matchOrder)
    || compareNullableNumber(left.team, right.team)
    || left.playerId.localeCompare(right.playerId)
    || (left.civId ?? '').localeCompare(right.civId ?? '')
    || compareNullableNumber(left.placement, right.placement)
    || compareNullableNumber(left.ratingBeforeMu, right.ratingBeforeMu)
    || compareNullableNumber(left.ratingBeforeSigma, right.ratingBeforeSigma)
    || compareNullableNumber(left.ratingAfterMu, right.ratingAfterMu)
    || compareNullableNumber(left.ratingAfterSigma, right.ratingAfterSigma)
  ))
  source.bans.sort((left, right) => (
    compareMatchOrder(left.matchId, right.matchId, matchOrder)
    || left.phase - right.phase
    || left.civId.localeCompare(right.civId)
    || left.bannedBy.localeCompare(right.bannedBy)
  ))
}

function compareMatchOrder(leftId: string, rightId: string, matchOrder: Map<string, number>): number {
  return (matchOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (matchOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER)
    || leftId.localeCompare(rightId)
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === right) return 0
  if (left == null) return -1
  if (right == null) return 1
  return left - right
}

function worksheetFromRows(name: string, columns: readonly string[], rows: XlsxCellValue[][]): StreamingXlsxWorksheet {
  let columnCount = columns.length
  for (const row of rows) {
    if (row.length > columnCount) columnCount = row.length
  }
  return {
    name,
    columns,
    columnCount,
    rowCount: rows.length,
    rows: function* () {
      for (const row of rows) yield row
    },
  }
}

function groupParticipantsByMatch(rows: PlayerDataExportParticipant[]): Map<string, PlayerDataExportParticipant[]> {
  const result = new Map<string, PlayerDataExportParticipant[]>()
  for (const row of rows) {
    const existing = result.get(row.matchId)
    if (existing) existing.push(row)
    else result.set(row.matchId, [row])
  }
  return result
}

function buildLastMatchAtByPlayerId(matches: PlayerDataExportMatch[], participants: PlayerDataExportParticipant[]): Map<string, number> {
  const matchAtById = new Map<string, number>()
  for (const match of matches) matchAtById.set(match.id, match.completedAt ?? match.createdAt)
  const result = new Map<string, number>()
  for (const participant of participants) {
    const matchAt = matchAtById.get(participant.matchId)
    if (matchAt == null) continue
    const current = result.get(participant.playerId)
    if (current == null || matchAt > current) result.set(participant.playerId, matchAt)
  }
  return result
}

function buildRecentActivity(
  matches: PlayerDataExportMatch[],
  participantsByMatch: Map<string, PlayerDataExportParticipant[]>,
  generatedAt: number,
  days: number,
): { completedMatches: number, uniquePlayers: number } {
  const cutoff = generatedAt - days * DAY_MS
  const playerIds = new Set<string>()
  let completedMatches = 0
  for (const match of matches) {
    if (match.isOld || match.completedAt == null || match.completedAt < cutoff) continue
    completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) playerIds.add(participant.playerId)
  }
  return { completedMatches, uniquePlayers: playerIds.size }
}

function buildModeRows(matches: PlayerDataExportMatch[]): Array<{ gameMode: string, completedMatches: number }> {
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.gameMode, (counts.get(match.gameMode) ?? 0) + 1)
  return Array.from(counts, ([gameMode, completedMatches]) => ({ gameMode, completedMatches }))
    .sort((left, right) => right.completedMatches - left.completedMatches || left.gameMode.localeCompare(right.gameMode))
}

function buildWeeklyActivityRows(
  matches: PlayerDataExportMatch[],
  participantsByMatch: Map<string, PlayerDataExportParticipant[]>,
): Array<{ isoWeek: string, weekStartAt: number, completedMatches: number, uniquePlayers: number }> {
  const buckets = new Map<string, { weekStartAt: number, completedMatches: number, playerIds: Set<string> }>()
  for (const match of matches) {
    if (match.isOld || match.completedAt == null) continue
    const week = getIsoWeekBucket(match.completedAt)
    const bucket = buckets.get(week.isoWeek) ?? { weekStartAt: week.weekStartAt, completedMatches: 0, playerIds: new Set<string>() }
    bucket.completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) bucket.playerIds.add(participant.playerId)
    buckets.set(week.isoWeek, bucket)
  }
  return Array.from(buckets, ([isoWeek, bucket]) => ({
    isoWeek,
    weekStartAt: bucket.weekStartAt,
    completedMatches: bucket.completedMatches,
    uniquePlayers: bucket.playerIds.size,
  })).sort((left, right) => left.weekStartAt - right.weekStartAt)
}

function buildLeaderOverview(
  participants: PlayerDataExportParticipant[],
  bans: PlayerDataExportBan[],
): { mostPicked: OverviewLeaderSummary[], mostBanned: OverviewLeaderSummary[], bestWinRatesMin10: OverviewLeaderSummary[] } {
  const aggregates = new Map<string, OverviewLeaderAggregate>()
  for (const participant of participants) {
    if (!participant.civId) continue
    const aggregate = getLeaderAggregate(aggregates, participant.civId)
    aggregate.picks += 1
    if (participant.placement === 1) aggregate.wins += 1
    if (participant.placement != null) {
      aggregate.placementTotal += participant.placement
      aggregate.placementCount += 1
    }
  }
  for (const ban of bans) getLeaderAggregate(aggregates, ban.civId).bans += 1
  const summaries = Array.from(aggregates.values(), toLeaderSummary)
  return {
    mostPicked: summaries.filter(row => row.picks > 0).sort((left, right) => right.picks - left.picks || right.wins - left.wins || left.civId.localeCompare(right.civId)).slice(0, 10),
    mostBanned: summaries.filter(row => row.bans > 0).sort((left, right) => right.bans - left.bans || right.picks - left.picks || left.civId.localeCompare(right.civId)).slice(0, 10),
    bestWinRatesMin10: summaries.filter(row => row.picks >= 10 && row.winRatePct != null).sort((left, right) => (right.winRatePct ?? 0) - (left.winRatePct ?? 0) || right.picks - left.picks || left.civId.localeCompare(right.civId)).slice(0, 10),
  }
}

function getLeaderAggregate(aggregates: Map<string, OverviewLeaderAggregate>, civId: string): OverviewLeaderAggregate {
  const existing = aggregates.get(civId)
  if (existing) return existing
  const meta = resolveLeaderMeta(civId)
  const aggregate: OverviewLeaderAggregate = {
    civId,
    leaderName: meta.leaderName,
    civilizationName: meta.civilizationName,
    picks: 0,
    bans: 0,
    wins: 0,
    placementTotal: 0,
    placementCount: 0,
  }
  aggregates.set(civId, aggregate)
  return aggregate
}

function resolveLeaderMeta(civId: string): { leaderName: string, civilizationName: string } {
  try {
    const leader = getLeader(civId)
    return { leaderName: leader.name, civilizationName: leader.civilization }
  }
  catch {
    try {
      const leader = getLeader(civId, 'beta')
      return { leaderName: leader.name, civilizationName: leader.civilization }
    }
    catch {
      return { leaderName: '', civilizationName: '' }
    }
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
    winRatePct: row.picks > 0 ? round(row.wins / row.picks * 100, 1) : null,
    averagePlacement: row.placementCount > 0 ? round(row.placementTotal / row.placementCount, 2) : null,
  }
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
  const weekNumber = Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return { isoWeek: `${isoYear}-W${String(weekNumber).padStart(2, '0')}`, weekStartAt: weekStart.getTime() }
}

function minTimestamp<T>(rows: T[], select: (row: T) => number | null): number | null {
  let result: number | null = null
  for (const row of rows) {
    const value = select(row)
    if (value != null && Number.isFinite(value) && (result == null || value < result)) result = value
  }
  return result
}

function maxTimestamp<T>(rows: T[], select: (row: T) => number | null): number | null {
  let result: number | null = null
  for (const row of rows) {
    const value = select(row)
    if (value != null && Number.isFinite(value) && (result == null || value > result)) result = value
  }
  return result
}

function parseExportPage(payload: unknown): ExportPage | null {
  if (!isRecord(payload)) return null
  if (payload.version !== EXPORT_VERSION) return null
  if (!isSafeTimestamp(payload.generatedAt) || !isSafeTimestamp(payload.cutoffAt)) return null
  if (payload.phase !== 'players' && payload.phase !== 'matches') return null
  if (payload.nextCursor !== null && (typeof payload.nextCursor !== 'string' || payload.nextCursor.length === 0 || payload.nextCursor.length > 1024)) return null

  const base = {
    version: EXPORT_VERSION,
    generatedAt: payload.generatedAt,
    cutoffAt: payload.cutoffAt,
    phase: payload.phase,
    nextCursor: payload.nextCursor,
  }
  if (payload.phase === 'players') {
    if (!Array.isArray(payload.players) || payload.players.length > EXPORT_PARENT_PAGE_SIZE || !payload.players.every(isExportPlayer)) return null
    if (!Array.isArray(payload.ratings) || payload.ratings.length > MAX_RATINGS_PER_PAGE || !payload.ratings.every(isExportRating)) return null
    return { ...base, phase: 'players', players: payload.players, ratings: payload.ratings }
  }
  if (!Array.isArray(payload.matches) || payload.matches.length > EXPORT_PARENT_PAGE_SIZE || !payload.matches.every(isExportMatch)) return null
  if (!Array.isArray(payload.participants) || payload.participants.length > MAX_PARTICIPANTS_PER_PAGE || !payload.participants.every(isExportParticipant)) return null
  if (!Array.isArray(payload.bans) || payload.bans.length > MAX_BANS_PER_PAGE || !payload.bans.every(isExportBan)) return null
  return { ...base, phase: 'matches', matches: payload.matches, participants: payload.participants, bans: payload.bans }
}

function parseExportEstimate(payload: unknown): PlayerDataExportEstimate | null {
  if (!hasExactKeys(payload, ['version', 'estimatedAt', 'rows', 'dataPageRequests', 'workerRequests', 'd1RowsRead', 'dailyFreeAllowance'])) return null
  if (payload.version !== EXPORT_VERSION || !isSafeTimestamp(payload.estimatedAt)) return null
  if (!hasExactKeys(payload.rows, ['players', 'ratings', 'matches', 'participants', 'storedBans'])) return null
  if (!hasExactKeys(payload.d1RowsRead, ['lowEstimate', 'highEstimate'])) return null
  if (!hasExactKeys(payload.dailyFreeAllowance, ['workerRequests', 'd1RowsRead'])) return null

  if (!isNonnegativeSafeInteger(payload.rows.players)
    || !isNonnegativeSafeInteger(payload.rows.ratings)
    || !isNonnegativeSafeInteger(payload.rows.matches)
    || !isNonnegativeSafeInteger(payload.rows.participants)
    || !isNonnegativeSafeInteger(payload.rows.storedBans)
    || !isNonnegativeSafeInteger(payload.dataPageRequests)
    || !isNonnegativeSafeInteger(payload.workerRequests)
    || !isNonnegativeSafeInteger(payload.d1RowsRead.lowEstimate)
    || !isNonnegativeSafeInteger(payload.d1RowsRead.highEstimate)
    || !isNonnegativeSafeInteger(payload.dailyFreeAllowance.workerRequests)
    || !isNonnegativeSafeInteger(payload.dailyFreeAllowance.d1RowsRead)) return null
  if (payload.dataPageRequests === 0 || payload.dailyFreeAllowance.workerRequests === 0 || payload.dailyFreeAllowance.d1RowsRead === 0) return null
  if (payload.d1RowsRead.highEstimate < payload.d1RowsRead.lowEstimate) return null

  return {
    version: EXPORT_VERSION,
    estimatedAt: payload.estimatedAt,
    rows: {
      players: payload.rows.players,
      ratings: payload.rows.ratings,
      matches: payload.rows.matches,
      participants: payload.rows.participants,
      storedBans: payload.rows.storedBans,
    },
    dataPageRequests: payload.dataPageRequests,
    workerRequests: payload.workerRequests,
    d1RowsRead: {
      lowEstimate: payload.d1RowsRead.lowEstimate,
      highEstimate: payload.d1RowsRead.highEstimate,
    },
    dailyFreeAllowance: {
      workerRequests: payload.dailyFreeAllowance.workerRequests,
      d1RowsRead: payload.dailyFreeAllowance.d1RowsRead,
    },
  }
}

function assertCanAppendPage(source: PlayerDataExportSource, page: ExportPage): void {
  assertSourceRowLimits({
    players: { length: source.players.length + (page.phase === 'players' ? page.players.length : 0) },
    ratings: { length: source.ratings.length + (page.phase === 'players' ? page.ratings.length : 0) },
    matches: { length: source.matches.length + (page.phase === 'matches' ? page.matches.length : 0) },
    participants: { length: source.participants.length + (page.phase === 'matches' ? page.participants.length : 0) },
    bans: { length: source.bans.length + (page.phase === 'matches' ? page.bans.length : 0) },
  })
}

function assertSourceRowLimits(source: {
  players: { length: number }
  ratings: { length: number }
  matches: { length: number }
  participants: { length: number }
  bans: { length: number }
}): void {
  const sheets = [
    ['players', source.players.length],
    ['ratings', source.ratings.length],
    ['matches', source.matches.length],
    ['match_participants', source.participants.length],
    ['match_bans', source.bans.length],
  ] as const
  for (const [name, count] of sheets) {
    if (count > MAX_WORKSHEET_DATA_ROWS) throw new Error(`Player data export exceeds the Excel row limit for ${name}.`)
  }

  const totalRows = sheets.reduce((total, [, count]) => total + count, 0)
  if (totalRows > MAX_TOTAL_SOURCE_ROWS) {
    throw new Error('Player data export is too large to build safely in this browser.')
  }
}

function isExportPlayer(value: unknown): value is PlayerDataExportPlayer {
  if (!hasExactKeys(value, ['id', 'displayName', 'createdAt'])) return false
  return isNonemptyString(value.id) && typeof value.displayName === 'string' && isSafeTimestamp(value.createdAt)
}

function isExportRating(value: unknown): value is PlayerDataExportRating {
  if (!hasExactKeys(value, ['playerId', 'mode', 'mu', 'sigma', 'gamesPlayed', 'wins', 'lastPlayedAt'])) return false
  return isNonemptyString(value.playerId)
    && isNonemptyString(value.mode)
    && isFiniteNumber(value.mu)
    && isFiniteNumber(value.sigma)
    && isSafeInteger(value.gamesPlayed)
    && isSafeInteger(value.wins)
    && isNullableTimestamp(value.lastPlayedAt)
}

function isExportMatch(value: unknown): value is PlayerDataExportMatch {
  if (!hasExactKeys(value, ['id', 'gameMode', 'status', 'isOld', 'seasonId', 'createdAt', 'completedAt'])) return false
  return isNonemptyString(value.id)
    && isNonemptyString(value.gameMode)
    && isNonemptyString(value.status)
    && typeof value.isOld === 'boolean'
    && (value.seasonId === null || typeof value.seasonId === 'string')
    && isSafeTimestamp(value.createdAt)
    && isNullableTimestamp(value.completedAt)
}

function isExportParticipant(value: unknown): value is PlayerDataExportParticipant {
  if (!hasExactKeys(value, ['matchId', 'playerId', 'team', 'civId', 'placement', 'ratingBeforeMu', 'ratingBeforeSigma', 'ratingAfterMu', 'ratingAfterSigma'])) return false
  return isNonemptyString(value.matchId)
    && isNonemptyString(value.playerId)
    && isNullableSafeInteger(value.team)
    && (value.civId === null || typeof value.civId === 'string')
    && isNullableSafeInteger(value.placement)
    && isNullableFiniteNumber(value.ratingBeforeMu)
    && isNullableFiniteNumber(value.ratingBeforeSigma)
    && isNullableFiniteNumber(value.ratingAfterMu)
    && isNullableFiniteNumber(value.ratingAfterSigma)
}

function isExportBan(value: unknown): value is PlayerDataExportBan {
  if (!hasExactKeys(value, ['matchId', 'civId', 'bannedBy', 'phase'])) return false
  return isNonemptyString(value.matchId) && isNonemptyString(value.civId) && isNonemptyString(value.bannedBy) && isSafeInteger(value.phase)
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  if (actualKeys.length !== keys.length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isSafeInteger(value)
}

function isSafeTimestamp(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isSafeTimestamp(value)
}

function appendRows<T>(target: T[], rows: T[]): void {
  for (const row of rows) target.push(row)
}

function appendUniqueParents<T>(target: T[], rows: T[], seen: Set<string>, getId: (row: T) => string, label: string): void {
  for (const row of rows) {
    const id = getId(row)
    if (seen.has(id)) throw new Error(`Player data export repeated ${label} ${id}.`)
    seen.add(id)
    target.push(row)
  }
}

function progressFor(source: PlayerDataExportSource, phase: PlayerDataExportProgress['phase']): PlayerDataExportProgress {
  return {
    phase,
    players: source.players.length,
    ratings: source.ratings.length,
    matches: source.matches.length,
    participants: source.participants.length,
    bans: source.bans.length,
  }
}

function readPayloadError(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.error === 'string' && payload.error.trim().length > 0 ? payload.error : null
}

function formatTimestampMs(timestampMs: number | null | undefined): XlsxCellValue {
  if (timestampMs == null) return null
  return {
    type: 'date',
    value: Math.round(((timestampMs / 86_400_000) + 25_569) * 86_400) / 86_400,
  }
}

function formatPercent(value: number | null): string {
  return value == null ? '' : `${value}%`
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function columnName(index: number): string {
  if (index < 0) return ''
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function sanitizeSheetName(name: string, index: number): string {
  const safeName = name.replace(/[\\/?:*[\]]/g, ' ').trim()
  return (safeName.length > 0 ? safeName : `Sheet ${index + 1}`).slice(0, 31)
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\v\f\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
|||||||
=======
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js'
import { getLeader } from '@civup/game'
import { buildActivitySessionHeaders } from './activity-session'

export const PLAYER_DATA_EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const EXPORT_ENDPOINT = '/api/activity/admin/player-data-export'
const EXPORT_VERSION = 1
const EXPORT_PARENT_PAGE_SIZE = 50
const MAX_RATINGS_PER_PAGE = 1_000
const MAX_PARTICIPANTS_PER_PAGE = 2_000
const MAX_BANS_PER_PAGE = 5_000
const MAX_EXPORT_PAGES = 10_000
const MAX_WORKSHEET_DATA_ROWS = 1_048_575
const MAX_TOTAL_SOURCE_ROWS = 500_000
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const DAY_MS = 24 * 60 * 60 * 1000

export interface PlayerDataExportPlayer {
  id: string
  displayName: string
  createdAt: number
}

export interface PlayerDataExportRating {
  playerId: string
  mode: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

export interface PlayerDataExportMatch {
  id: string
  gameMode: string
  status: string
  isOld: boolean
  seasonId: string | null
  createdAt: number
  completedAt: number | null
}

export interface PlayerDataExportParticipant {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

export interface PlayerDataExportBan {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

export interface PlayerDataExportSource {
  generatedAt: number
  cutoffAt: number
  players: PlayerDataExportPlayer[]
  ratings: PlayerDataExportRating[]
  matches: PlayerDataExportMatch[]
  participants: PlayerDataExportParticipant[]
  bans: PlayerDataExportBan[]
}

export type PlayerDataExportProgress = {
  phase: 'players' | 'matches' | 'workbook'
  players: number
  ratings: number
  matches: number
  participants: number
  bans: number
}

export type PlayerDataExportState
  = | { status: 'idle' }
    | ({ status: 'loading' } & PlayerDataExportProgress)
    | {
      status: 'ready'
      filename: string
      url: string
      players: number
      matches: number
    }
    | { status: 'error', message: string }

export interface PlayerDataExportFile {
  blob: Blob
  filename: string
  source: PlayerDataExportSource
}

export type XlsxCellValue = string | number | boolean | XlsxDateValue | null | undefined

export interface XlsxDateValue {
  type: 'date'
  value: number
}

export interface StreamingXlsxWorksheet {
  name: string
  columns: readonly string[]
  columnCount?: number
  rowCount: number
  rows: () => IterableIterator<readonly XlsxCellValue[]>
}

interface ExportRequestOptions {
  fetchImpl?: typeof fetch
  onProgress?: (progress: PlayerDataExportProgress) => void
}

interface ExportPageBase {
  version: number
  generatedAt: number
  cutoffAt: number
  phase: 'players' | 'matches'
  nextCursor: string | null
}

interface PlayerExportPage extends ExportPageBase {
  phase: 'players'
  players: PlayerDataExportPlayer[]
  ratings: PlayerDataExportRating[]
}

interface MatchExportPage extends ExportPageBase {
  phase: 'matches'
  matches: PlayerDataExportMatch[]
  participants: PlayerDataExportParticipant[]
  bans: PlayerDataExportBan[]
}

type ExportPage = PlayerExportPage | MatchExportPage

interface OverviewLeaderAggregate {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
  placementTotal: number
  placementCount: number
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

export async function createPlayerDataExport(options: ExportRequestOptions = {}): Promise<PlayerDataExportFile> {
  const source = await fetchPlayerDataExport(options)
  options.onProgress?.(progressFor(source, 'workbook'))
  const blob = await createPlayerDataWorkbook(source)
  return {
    blob,
    filename: `export-${new Date(source.generatedAt).toISOString().slice(0, 10)}.xlsx`,
    source,
  }
}

export async function fetchPlayerDataExport(options: ExportRequestOptions = {}): Promise<PlayerDataExportSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const source: PlayerDataExportSource = {
    generatedAt: 0,
    cutoffAt: 0,
    players: [],
    ratings: [],
    matches: [],
    participants: [],
    bans: [],
  }
  const seenPlayerIds = new Set<string>()
  const seenMatchIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let pageCount = 0
  let matchPhaseStarted = false

  do {
    if (pageCount >= MAX_EXPORT_PAGES) throw new Error('Player data export returned too many pages.')
    const url = cursor == null ? EXPORT_ENDPOINT : `${EXPORT_ENDPOINT}?cursor=${encodeURIComponent(cursor)}`
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: buildActivitySessionHeaders({ Accept: 'application/json' }),
    })
    if (response.status === 401) throw new Error('Your CivUp session expired. Reopen CivUp and try the export again.')
    if (response.status === 403) throw new Error('Player data export is only available to Activity data admins.')

    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(readPayloadError(payload) ?? `Player data export failed (${response.status}).`)
    const page = parseExportPage(payload)
    if (!page) throw new Error('Player data export returned malformed data.')

    if (pageCount === 0) {
      source.generatedAt = page.generatedAt
      source.cutoffAt = page.cutoffAt
      if (page.phase !== 'players') throw new Error('Player data export started in an invalid phase.')
    }
    else if (page.generatedAt !== source.generatedAt || page.cutoffAt !== source.cutoffAt) {
      throw new Error('Player data export cutoff changed between pages.')
    }

    assertCanAppendPage(source, page)
    if (page.phase === 'players') {
      if (matchPhaseStarted) throw new Error('Player data export returned to the player phase.')
      appendUniqueParents(source.players, page.players, seenPlayerIds, row => row.id, 'player')
      appendRows(source.ratings, page.ratings)
    }
    else {
      matchPhaseStarted = true
      appendUniqueParents(source.matches, page.matches, seenMatchIds, row => row.id, 'match')
      appendRows(source.participants, page.participants)
      appendRows(source.bans, page.bans)
    }

    options.onProgress?.(progressFor(source, page.phase))
    cursor = page.nextCursor
    if (page.phase === 'players' && cursor == null) throw new Error('Player data export ended before the match phase.')
    if (cursor != null) {
      if (seenCursors.has(cursor)) throw new Error('Player data export repeated a cursor.')
      seenCursors.add(cursor)
    }
    pageCount += 1
  } while (cursor != null)

  if (!matchPhaseStarted) throw new Error('Player data export did not include the match phase.')
  return source
}

export async function createPlayerDataWorkbook(source: PlayerDataExportSource): Promise<Blob> {
  assertSourceRowLimits(source)
  sortPlayerDataExportSource(source)
  const worksheets = buildPlayerDataWorksheets(source)
  return createStreamingXlsxWorkbook(worksheets)
}

export function buildPlayerDataWorksheets(source: PlayerDataExportSource): StreamingXlsxWorksheet[] {
  const lastMatchAtByPlayerId = buildLastMatchAtByPlayerId(source.matches, source.participants)
  const overviewRows = buildOverviewRows(source)

  return [
    worksheetFromRows('overview', ['Overview'], overviewRows),
    {
      name: 'players',
      columns: ['player_id', 'display_name', 'created_at_utc', 'last_match_at_utc'],
      rowCount: source.players.length,
      rows: function* () {
        for (const player of source.players) {
          yield [player.id, player.displayName, formatTimestampMs(player.createdAt), formatTimestampMs(lastMatchAtByPlayerId.get(player.id))]
        }
      },
    },
    {
      name: 'ratings',
      columns: ['player_id', 'mode', 'mu', 'sigma', 'games_played', 'wins', 'last_played_at_utc'],
      rowCount: source.ratings.length,
      rows: function* () {
        for (const rating of source.ratings) {
          yield [rating.playerId, rating.mode, rating.mu, rating.sigma, rating.gamesPlayed, rating.wins, formatTimestampMs(rating.lastPlayedAt)]
        }
      },
    },
    {
      name: 'matches',
      columns: ['match_id', 'game_mode', 'status', 'old_bot', 'season_id', 'created_at_utc', 'completed_at_utc'],
      rowCount: source.matches.length,
      rows: function* () {
        for (const match of source.matches) {
          yield [match.id, match.gameMode, match.status, match.isOld, match.seasonId, formatTimestampMs(match.createdAt), formatTimestampMs(match.completedAt)]
        }
      },
    },
    {
      name: 'match_participants',
      columns: ['match_id', 'player_id', 'team', 'civ_id', 'placement', 'rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'],
      rowCount: source.participants.length,
      rows: function* () {
        for (const participant of source.participants) {
          yield [
            participant.matchId,
            participant.playerId,
            participant.team,
            participant.civId,
            participant.placement,
            participant.ratingBeforeMu,
            participant.ratingBeforeSigma,
            participant.ratingAfterMu,
            participant.ratingAfterSigma,
          ]
        }
      },
    },
    {
      name: 'match_bans',
      columns: ['match_id', 'phase', 'civ_id', 'banned_by_player_id'],
      rowCount: source.bans.length,
      rows: function* () {
        for (const ban of source.bans) yield [ban.matchId, ban.phase, ban.civId, ban.bannedBy]
      },
    },
  ]
}

export function triggerPlayerDataDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function createStreamingXlsxWorkbook(worksheets: StreamingXlsxWorksheet[]): Promise<Blob> {
  if (worksheets.length === 0) throw new Error('XLSX workbook needs at least one worksheet.')
  const safeWorksheets = worksheets.map((worksheet, index) => ({
    ...worksheet,
    name: sanitizeSheetName(worksheet.name, index),
  }))
  const zipWriter = new ZipWriter(new BlobWriter(PLAYER_DATA_EXPORT_CONTENT_TYPE), {
    bufferedWrite: false,
    level: 6,
  })

  await zipWriter.add('[Content_Types].xml', new TextReader(contentTypesXml(safeWorksheets.length)))
  await zipWriter.add('_rels/.rels', new TextReader(rootRelationshipsXml()))
  await zipWriter.add('xl/workbook.xml', new TextReader(workbookXml(safeWorksheets)))
  await zipWriter.add('xl/styles.xml', new TextReader(stylesXml()))
  await zipWriter.add('xl/_rels/workbook.xml.rels', new TextReader(workbookRelationshipsXml(safeWorksheets.length)))
  for (let index = 0; index < safeWorksheets.length; index += 1) {
    await zipWriter.add(`xl/worksheets/sheet${index + 1}.xml`, worksheetXmlStream(safeWorksheets[index]!))
  }
  const blob = await zipWriter.close()
  return blob.type === PLAYER_DATA_EXPORT_CONTENT_TYPE
    ? blob
    : new Blob([blob], { type: PLAYER_DATA_EXPORT_CONTENT_TYPE })
}

function worksheetXmlStream(worksheet: StreamingXlsxWorksheet): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const rows = worksheet.rows()
  let stage: 'start' | 'header' | 'rows' | 'end' | 'closed' = 'start'
  let rowNumber = 0

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 'start') {
        const lastColumn = columnName(Math.max(worksheet.columnCount ?? worksheet.columns.length, 1) - 1)
        const totalRows = worksheet.rowCount + 1
        controller.enqueue(encoder.encode(`${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${totalRows}"/><sheetData>`))
        stage = 'header'
        return
      }
      if (stage === 'header') {
        rowNumber = 1
        controller.enqueue(encoder.encode(rowXml(worksheet.columns, rowNumber)))
        stage = 'rows'
        return
      }
      if (stage === 'rows') {
        const next = rows.next()
        if (!next.done) {
          rowNumber += 1
          controller.enqueue(encoder.encode(rowXml(next.value, rowNumber)))
          return
        }
        stage = 'end'
      }
      if (stage === 'end') {
        controller.enqueue(encoder.encode('</sheetData></worksheet>'))
        stage = 'closed'
        return
      }
      controller.close()
    },
  })
}

function rowXml(row: readonly XlsxCellValue[], rowNumber: number): string {
  let cells = ''
  for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
    cells += cellXml(row[columnIndex], rowNumber, columnIndex)
  }
  return `<row r="${rowNumber}">${cells}</row>`
}

function cellXml(value: XlsxCellValue, rowNumber: number, columnIndex: number): string {
  const reference = `${columnName(columnIndex)}${rowNumber}`
  if (value === null || value === undefined) return `<c r="${reference}"/>`
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`
  if (typeof value === 'object' && value.type === 'date') return `<c r="${reference}" s="1"><v>${value.value}</v></c>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(String(value))}</t></is></c>`
}

function contentTypesXml(sheetCount: number): string {
  let worksheetOverrides = ''
  for (let index = 0; index < sheetCount; index += 1) {
    worksheetOverrides += `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  }
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheetOverrides}</Types>`
}

function rootRelationshipsXml(): string {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
}

function workbookXml(worksheets: StreamingXlsxWorksheet[]): string {
  let sheets = ''
  for (let index = 0; index < worksheets.length; index += 1) {
    sheets += `<sheet name="${escapeXmlAttribute(worksheets[index]!.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  }
  return `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`
}

function workbookRelationshipsXml(sheetCount: number): string {
  let relationships = ''
  for (let index = 0; index < sheetCount; index += 1) {
    relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  }
  relationships += `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
}

function stylesXml(): string {
  return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function buildOverviewRows(source: PlayerDataExportSource): XlsxCellValue[][] {
  const completedMatches = source.matches.filter(match => match.status === 'completed')
  const completedMatchIds = new Set(completedMatches.map(match => match.id))
  const completedParticipants = source.participants.filter(participant => completedMatchIds.has(participant.matchId))
  const completedBans = source.bans.filter(ban => completedMatchIds.has(ban.matchId))
  const participantsByMatch = groupParticipantsByMatch(source.participants)
  const recent7d = buildRecentActivity(completedMatches, participantsByMatch, source.generatedAt, 7)
  const recent30d = buildRecentActivity(completedMatches, participantsByMatch, source.generatedAt, 30)
  const modeRows = buildModeRows(completedMatches)
  const weeklyRows = buildWeeklyActivityRows(completedMatches, participantsByMatch)
  const leaderRows = buildLeaderOverview(completedParticipants, completedBans)
  const rows: XlsxCellValue[][] = [
    [],
    ['Summary'],
    ['Metric', 'Value'],
    ['Generated at', formatTimestampMs(source.generatedAt)],
    ['Stored players', source.players.length],
    ['Players with matches', new Set(source.participants.map(participant => participant.playerId)).size],
    ['Ratings', source.ratings.length],
    ['Matches', source.matches.length],
    ['Completed matches', completedMatches.length],
    ['Old bot matches', source.matches.filter(match => match.isOld).length],
    ['Player-games in completed matches', completedParticipants.length],
    ['Recorded bans in completed matches', completedBans.length],
    ['First completed match', formatTimestampMs(minTimestamp(completedMatches, match => match.completedAt))],
    ['Last completed match', formatTimestampMs(maxTimestamp(completedMatches, match => match.completedAt))],
    [],
    ['Recent Activity'],
    ['Window', 'Completed matches', 'Unique players'],
    ['Last 7 days', recent7d.completedMatches, recent7d.uniquePlayers],
    ['Last 30 days', recent30d.completedMatches, recent30d.uniquePlayers],
  ]

  rows.push([], ['Mode Breakdown'], ['Mode', 'Completed matches'])
  for (const row of modeRows) rows.push([row.gameMode, row.completedMatches])
  rows.push([], ['Weekly Activity'], ['ISO week', 'Week start', 'Completed matches', 'Unique players'])
  for (const row of weeklyRows) rows.push([row.isoWeek, formatTimestampMs(row.weekStartAt), row.completedMatches, row.uniquePlayers])
  rows.push([], ['Top Picked Leaders'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate'])
  for (const row of leaderRows.mostPicked) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct)])
  rows.push([], ['Top Banned Leaders'], ['Leader', 'Civilization', 'Bans', 'Picks', 'Wins', 'Win rate'])
  for (const row of leaderRows.mostBanned) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.bans, row.picks, row.wins, formatPercent(row.winRatePct)])
  rows.push([], ['Best Win Rates (min 10 picks)'], ['Leader', 'Civilization', 'Picks', 'Wins', 'Win rate', 'Average placement'])
  for (const row of leaderRows.bestWinRatesMin10) rows.push([row.leaderName || row.civId, row.civilizationName || null, row.picks, row.wins, formatPercent(row.winRatePct), row.averagePlacement])
  return rows
}

function sortPlayerDataExportSource(source: PlayerDataExportSource): void {
  source.players.sort((left, right) => left.id.localeCompare(right.id))
  source.ratings.sort((left, right) => left.playerId.localeCompare(right.playerId) || left.mode.localeCompare(right.mode))
  source.matches.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  const matchOrder = new Map<string, number>()
  for (let index = 0; index < source.matches.length; index += 1) matchOrder.set(source.matches[index]!.id, index)
  source.participants.sort((left, right) => (
    compareMatchOrder(left.matchId, right.matchId, matchOrder)
    || compareNullableNumber(left.team, right.team)
    || left.playerId.localeCompare(right.playerId)
    || (left.civId ?? '').localeCompare(right.civId ?? '')
    || compareNullableNumber(left.placement, right.placement)
    || compareNullableNumber(left.ratingBeforeMu, right.ratingBeforeMu)
    || compareNullableNumber(left.ratingBeforeSigma, right.ratingBeforeSigma)
    || compareNullableNumber(left.ratingAfterMu, right.ratingAfterMu)
    || compareNullableNumber(left.ratingAfterSigma, right.ratingAfterSigma)
  ))
  source.bans.sort((left, right) => (
    compareMatchOrder(left.matchId, right.matchId, matchOrder)
    || left.phase - right.phase
    || left.civId.localeCompare(right.civId)
    || left.bannedBy.localeCompare(right.bannedBy)
  ))
}

function compareMatchOrder(leftId: string, rightId: string, matchOrder: Map<string, number>): number {
  return (matchOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (matchOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER)
    || leftId.localeCompare(rightId)
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === right) return 0
  if (left == null) return -1
  if (right == null) return 1
  return left - right
}

function worksheetFromRows(name: string, columns: readonly string[], rows: XlsxCellValue[][]): StreamingXlsxWorksheet {
  let columnCount = columns.length
  for (const row of rows) {
    if (row.length > columnCount) columnCount = row.length
  }
  return {
    name,
    columns,
    columnCount,
    rowCount: rows.length,
    rows: function* () {
      for (const row of rows) yield row
    },
  }
}

function groupParticipantsByMatch(rows: PlayerDataExportParticipant[]): Map<string, PlayerDataExportParticipant[]> {
  const result = new Map<string, PlayerDataExportParticipant[]>()
  for (const row of rows) {
    const existing = result.get(row.matchId)
    if (existing) existing.push(row)
    else result.set(row.matchId, [row])
  }
  return result
}

function buildLastMatchAtByPlayerId(matches: PlayerDataExportMatch[], participants: PlayerDataExportParticipant[]): Map<string, number> {
  const matchAtById = new Map<string, number>()
  for (const match of matches) matchAtById.set(match.id, match.completedAt ?? match.createdAt)
  const result = new Map<string, number>()
  for (const participant of participants) {
    const matchAt = matchAtById.get(participant.matchId)
    if (matchAt == null) continue
    const current = result.get(participant.playerId)
    if (current == null || matchAt > current) result.set(participant.playerId, matchAt)
  }
  return result
}

function buildRecentActivity(
  matches: PlayerDataExportMatch[],
  participantsByMatch: Map<string, PlayerDataExportParticipant[]>,
  generatedAt: number,
  days: number,
): { completedMatches: number, uniquePlayers: number } {
  const cutoff = generatedAt - days * DAY_MS
  const playerIds = new Set<string>()
  let completedMatches = 0
  for (const match of matches) {
    if (match.isOld || match.completedAt == null || match.completedAt < cutoff) continue
    completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) playerIds.add(participant.playerId)
  }
  return { completedMatches, uniquePlayers: playerIds.size }
}

function buildModeRows(matches: PlayerDataExportMatch[]): Array<{ gameMode: string, completedMatches: number }> {
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.gameMode, (counts.get(match.gameMode) ?? 0) + 1)
  return Array.from(counts, ([gameMode, completedMatches]) => ({ gameMode, completedMatches }))
    .sort((left, right) => right.completedMatches - left.completedMatches || left.gameMode.localeCompare(right.gameMode))
}

function buildWeeklyActivityRows(
  matches: PlayerDataExportMatch[],
  participantsByMatch: Map<string, PlayerDataExportParticipant[]>,
): Array<{ isoWeek: string, weekStartAt: number, completedMatches: number, uniquePlayers: number }> {
  const buckets = new Map<string, { weekStartAt: number, completedMatches: number, playerIds: Set<string> }>()
  for (const match of matches) {
    if (match.isOld || match.completedAt == null) continue
    const week = getIsoWeekBucket(match.completedAt)
    const bucket = buckets.get(week.isoWeek) ?? { weekStartAt: week.weekStartAt, completedMatches: 0, playerIds: new Set<string>() }
    bucket.completedMatches += 1
    for (const participant of participantsByMatch.get(match.id) ?? []) bucket.playerIds.add(participant.playerId)
    buckets.set(week.isoWeek, bucket)
  }
  return Array.from(buckets, ([isoWeek, bucket]) => ({
    isoWeek,
    weekStartAt: bucket.weekStartAt,
    completedMatches: bucket.completedMatches,
    uniquePlayers: bucket.playerIds.size,
  })).sort((left, right) => left.weekStartAt - right.weekStartAt)
}

function buildLeaderOverview(
  participants: PlayerDataExportParticipant[],
  bans: PlayerDataExportBan[],
): { mostPicked: OverviewLeaderSummary[], mostBanned: OverviewLeaderSummary[], bestWinRatesMin10: OverviewLeaderSummary[] } {
  const aggregates = new Map<string, OverviewLeaderAggregate>()
  for (const participant of participants) {
    if (!participant.civId) continue
    const aggregate = getLeaderAggregate(aggregates, participant.civId)
    aggregate.picks += 1
    if (participant.placement === 1) aggregate.wins += 1
    if (participant.placement != null) {
      aggregate.placementTotal += participant.placement
      aggregate.placementCount += 1
    }
  }
  for (const ban of bans) getLeaderAggregate(aggregates, ban.civId).bans += 1
  const summaries = Array.from(aggregates.values(), toLeaderSummary)
  return {
    mostPicked: summaries.filter(row => row.picks > 0).sort((left, right) => right.picks - left.picks || right.wins - left.wins || left.civId.localeCompare(right.civId)).slice(0, 10),
    mostBanned: summaries.filter(row => row.bans > 0).sort((left, right) => right.bans - left.bans || right.picks - left.picks || left.civId.localeCompare(right.civId)).slice(0, 10),
    bestWinRatesMin10: summaries.filter(row => row.picks >= 10 && row.winRatePct != null).sort((left, right) => (right.winRatePct ?? 0) - (left.winRatePct ?? 0) || right.picks - left.picks || left.civId.localeCompare(right.civId)).slice(0, 10),
  }
}

function getLeaderAggregate(aggregates: Map<string, OverviewLeaderAggregate>, civId: string): OverviewLeaderAggregate {
  const existing = aggregates.get(civId)
  if (existing) return existing
  const meta = resolveLeaderMeta(civId)
  const aggregate: OverviewLeaderAggregate = {
    civId,
    leaderName: meta.leaderName,
    civilizationName: meta.civilizationName,
    picks: 0,
    bans: 0,
    wins: 0,
    placementTotal: 0,
    placementCount: 0,
  }
  aggregates.set(civId, aggregate)
  return aggregate
}

function resolveLeaderMeta(civId: string): { leaderName: string, civilizationName: string } {
  try {
    const leader = getLeader(civId)
    return { leaderName: leader.name, civilizationName: leader.civilization }
  }
  catch {
    try {
      const leader = getLeader(civId, 'beta')
      return { leaderName: leader.name, civilizationName: leader.civilization }
    }
    catch {
      return { leaderName: '', civilizationName: '' }
    }
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
    winRatePct: row.picks > 0 ? round(row.wins / row.picks * 100, 1) : null,
    averagePlacement: row.placementCount > 0 ? round(row.placementTotal / row.placementCount, 2) : null,
  }
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
  const weekNumber = Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return { isoWeek: `${isoYear}-W${String(weekNumber).padStart(2, '0')}`, weekStartAt: weekStart.getTime() }
}

function minTimestamp<T>(rows: T[], select: (row: T) => number | null): number | null {
  let result: number | null = null
  for (const row of rows) {
    const value = select(row)
    if (value != null && Number.isFinite(value) && (result == null || value < result)) result = value
  }
  return result
}

function maxTimestamp<T>(rows: T[], select: (row: T) => number | null): number | null {
  let result: number | null = null
  for (const row of rows) {
    const value = select(row)
    if (value != null && Number.isFinite(value) && (result == null || value > result)) result = value
  }
  return result
}

function parseExportPage(payload: unknown): ExportPage | null {
  if (!isRecord(payload)) return null
  if (payload.version !== EXPORT_VERSION) return null
  if (!isSafeTimestamp(payload.generatedAt) || !isSafeTimestamp(payload.cutoffAt)) return null
  if (payload.phase !== 'players' && payload.phase !== 'matches') return null
  if (payload.nextCursor !== null && (typeof payload.nextCursor !== 'string' || payload.nextCursor.length === 0 || payload.nextCursor.length > 1024)) return null

  const base = {
    version: EXPORT_VERSION,
    generatedAt: payload.generatedAt,
    cutoffAt: payload.cutoffAt,
    phase: payload.phase,
    nextCursor: payload.nextCursor,
  }
  if (payload.phase === 'players') {
    if (!Array.isArray(payload.players) || payload.players.length > EXPORT_PARENT_PAGE_SIZE || !payload.players.every(isExportPlayer)) return null
    if (!Array.isArray(payload.ratings) || payload.ratings.length > MAX_RATINGS_PER_PAGE || !payload.ratings.every(isExportRating)) return null
    return { ...base, phase: 'players', players: payload.players, ratings: payload.ratings }
  }
  if (!Array.isArray(payload.matches) || payload.matches.length > EXPORT_PARENT_PAGE_SIZE || !payload.matches.every(isExportMatch)) return null
  if (!Array.isArray(payload.participants) || payload.participants.length > MAX_PARTICIPANTS_PER_PAGE || !payload.participants.every(isExportParticipant)) return null
  if (!Array.isArray(payload.bans) || payload.bans.length > MAX_BANS_PER_PAGE || !payload.bans.every(isExportBan)) return null
  return { ...base, phase: 'matches', matches: payload.matches, participants: payload.participants, bans: payload.bans }
}

function assertCanAppendPage(source: PlayerDataExportSource, page: ExportPage): void {
  assertSourceRowLimits({
    players: { length: source.players.length + (page.phase === 'players' ? page.players.length : 0) },
    ratings: { length: source.ratings.length + (page.phase === 'players' ? page.ratings.length : 0) },
    matches: { length: source.matches.length + (page.phase === 'matches' ? page.matches.length : 0) },
    participants: { length: source.participants.length + (page.phase === 'matches' ? page.participants.length : 0) },
    bans: { length: source.bans.length + (page.phase === 'matches' ? page.bans.length : 0) },
  })
}

function assertSourceRowLimits(source: {
  players: { length: number }
  ratings: { length: number }
  matches: { length: number }
  participants: { length: number }
  bans: { length: number }
}): void {
  const sheets = [
    ['players', source.players.length],
    ['ratings', source.ratings.length],
    ['matches', source.matches.length],
    ['match_participants', source.participants.length],
    ['match_bans', source.bans.length],
  ] as const
  for (const [name, count] of sheets) {
    if (count > MAX_WORKSHEET_DATA_ROWS) throw new Error(`Player data export exceeds the Excel row limit for ${name}.`)
  }

  const totalRows = sheets.reduce((total, [, count]) => total + count, 0)
  if (totalRows > MAX_TOTAL_SOURCE_ROWS) {
    throw new Error('Player data export is too large to build safely in this browser.')
  }
}

function isExportPlayer(value: unknown): value is PlayerDataExportPlayer {
  if (!hasExactKeys(value, ['id', 'displayName', 'createdAt'])) return false
  return isNonemptyString(value.id) && typeof value.displayName === 'string' && isSafeTimestamp(value.createdAt)
}

function isExportRating(value: unknown): value is PlayerDataExportRating {
  if (!hasExactKeys(value, ['playerId', 'mode', 'mu', 'sigma', 'gamesPlayed', 'wins', 'lastPlayedAt'])) return false
  return isNonemptyString(value.playerId)
    && isNonemptyString(value.mode)
    && isFiniteNumber(value.mu)
    && isFiniteNumber(value.sigma)
    && isSafeInteger(value.gamesPlayed)
    && isSafeInteger(value.wins)
    && isNullableTimestamp(value.lastPlayedAt)
}

function isExportMatch(value: unknown): value is PlayerDataExportMatch {
  if (!hasExactKeys(value, ['id', 'gameMode', 'status', 'isOld', 'seasonId', 'createdAt', 'completedAt'])) return false
  return isNonemptyString(value.id)
    && isNonemptyString(value.gameMode)
    && isNonemptyString(value.status)
    && typeof value.isOld === 'boolean'
    && (value.seasonId === null || typeof value.seasonId === 'string')
    && isSafeTimestamp(value.createdAt)
    && isNullableTimestamp(value.completedAt)
}

function isExportParticipant(value: unknown): value is PlayerDataExportParticipant {
  if (!hasExactKeys(value, ['matchId', 'playerId', 'team', 'civId', 'placement', 'ratingBeforeMu', 'ratingBeforeSigma', 'ratingAfterMu', 'ratingAfterSigma'])) return false
  return isNonemptyString(value.matchId)
    && isNonemptyString(value.playerId)
    && isNullableSafeInteger(value.team)
    && (value.civId === null || typeof value.civId === 'string')
    && isNullableSafeInteger(value.placement)
    && isNullableFiniteNumber(value.ratingBeforeMu)
    && isNullableFiniteNumber(value.ratingBeforeSigma)
    && isNullableFiniteNumber(value.ratingAfterMu)
    && isNullableFiniteNumber(value.ratingAfterSigma)
}

function isExportBan(value: unknown): value is PlayerDataExportBan {
  if (!hasExactKeys(value, ['matchId', 'civId', 'bannedBy', 'phase'])) return false
  return isNonemptyString(value.matchId) && isNonemptyString(value.civId) && isNonemptyString(value.bannedBy) && isSafeInteger(value.phase)
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  if (actualKeys.length !== keys.length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isSafeInteger(value)
}

function isSafeTimestamp(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isSafeTimestamp(value)
}

function appendRows<T>(target: T[], rows: T[]): void {
  for (const row of rows) target.push(row)
}

function appendUniqueParents<T>(target: T[], rows: T[], seen: Set<string>, getId: (row: T) => string, label: string): void {
  for (const row of rows) {
    const id = getId(row)
    if (seen.has(id)) throw new Error(`Player data export repeated ${label} ${id}.`)
    seen.add(id)
    target.push(row)
  }
}

function progressFor(source: PlayerDataExportSource, phase: PlayerDataExportProgress['phase']): PlayerDataExportProgress {
  return {
    phase,
    players: source.players.length,
    ratings: source.ratings.length,
    matches: source.matches.length,
    participants: source.participants.length,
    bans: source.bans.length,
  }
}

function readPayloadError(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.error === 'string' && payload.error.trim().length > 0 ? payload.error : null
}

function formatTimestampMs(timestampMs: number | null | undefined): XlsxCellValue {
  if (timestampMs == null) return null
  return {
    type: 'date',
    value: Math.round(((timestampMs / 86_400_000) + 25_569) * 86_400) / 86_400,
  }
}

function formatPercent(value: number | null): string {
  return value == null ? '' : `${value}%`
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function columnName(index: number): string {
  if (index < 0) return ''
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function sanitizeSheetName(name: string, index: number): string {
  const safeName = name.replace(/[\\/?:*[\]]/g, ' ').trim()
  return (safeName.length > 0 ? safeName : `Sheet ${index + 1}`).slice(0, 31)
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\v\f\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
>>>>>>> Current commit: chore: cleanup and simplify setup
