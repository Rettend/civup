import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import { matches, matchParticipants, players, tournamentMatches } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { getStoredGameModeContext } from '../services/match/draft-data.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { clampPageIndex } from '../services/response/pagination.ts'
import { formatDisplayRatingChange, formatUnrankedResultMarker } from './rating-change.ts'

export type PlayerHistoryModeFilter = 'all' | GameMode

export const PLAYER_HISTORY_PAGE_SIZE = 10
const PLAYER_HISTORY_RENDERED_LINE_BUDGET = 30
const LEADING_INDENT_GUARD = '\u200B'
const PLAYER_ROW_INDENT = '\u00A0\u00A0\u00A0'
const LEADER_ICON_WIDTH_PX = 22
const LEADER_ICON_GAP_PX = 5
const INTER_TEAM_COLUMN_GAP_PX = 24
const MIN_TEAM_COLUMN_WIDTH_PX = 120

const DEFAULT_ASCII_CHARACTER_WIDTH = 7
const DEFAULT_NON_ASCII_CHARACTER_WIDTH = 8

const WIDE_NAME_CHARACTER_WIDTH = 17
const HANGUL_CHARACTER_WIDTH = 15.5
const EMOJI_CHARACTER_WIDTH = 22

const SINGLE_WORD_NAME_WIDTH_ADJUSTMENT = -5
const NAME_SPACE_EXTRA_WIDTH = 2
const INITIALISM_SPACE_EXTRA_WIDTH = -0.5
const ALNUM_NAME_LENGTH_BASE = 7
const ALNUM_NAME_LENGTH_EXTRA_WIDTH = 1.5
const ALNUM_NAME_MAX_WIDTH_ADJUSTMENT = 3
const COMPOUND_NAME_LENGTH_BASE = 12
const COMPOUND_NAME_LENGTH_EXTRA_WIDTH = 1.5
const COMPOUND_NAME_SEPARATOR_EXTRA_WIDTH = 1.5

const PAD_UNITS = [
  { value: '\u00A0', widthPx: 4 },
  { value: '\u2009', widthPx: 2 },
  { value: '\u200A', widthPx: 1 },
] as const

const CHARACTER_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 4,
  '!': 3,
  '?': 7.25,
  '"': 5,
  '#': 10.25,
  '$': 8.75,
  '%': 11.5,
  '&': 9.75,
  "'": 1.75,
  '(': 4,
  ')': 4,
  '*': 5.75,
  '+': 7.5,
  ',': 3,
  '-': 6.25,
  '.': 3,
  '/': 5,
  '0': 9.25,
  '1': 5,
  '2': 8.25,
  '3': 8.5,
  '4': 8.5,
  '5': 8.25,
  '6': 8.25,
  '7': 7.25,
  '8': 8.25,
  '9': 8.25,
  ':': 3,
  ';': 3,
  '<': 7.5,
  '=': 7.5,
  '>': 7.5,
  '@': 15,
  'A': 10.25,
  'B': 9.75,
  'C': 10.25,
  'D': 10.5,
  'E': 8.75,
  'F': 8.5,
  'G': 10.5,
  'H': 10.5,
  'I': 3,
  'J': 7.5,
  'K': 9.5,
  'L': 8.5,
  'M': 13.75,
  'N': 11,
  'O': 11,
  'P': 9.5,
  'Q': 11,
  'R': 9.75,
  'S': 8.5,
  'T': 8.5,
  'U': 10.75,
  'V': 9.5,
  'W': 13.5,
  'X': 9.25,
  'Y': 9.5,
  'Z': 8.5,
  '[': 4.25,
  '\\': 5,
  ']': 4.25,
  '^': 6.75,
  '_': 7.75,
  '`': 3.5,
  'a': 7.75,
  'b': 8.5,
  'c': 7.5,
  'd': 8.5,
  'e': 8,
  'f': 4.75,
  'g': 7.75,
  'h': 8.5,
  'i': 2.75,
  'j': 2.75,
  'k': 7.5,
  'l': 3.25,
  'm': 13.5,
  'n': 8.25,
  'o': 8.25,
  'p': 8.5,
  'q': 8.5,
  'r': 5.5,
  's': 6.5,
  't': 5.5,
  'u': 8.25,
  'v': 7.25,
  'w': 11.5,
  'x': DEFAULT_ASCII_CHARACTER_WIDTH,
  'y': 7.25,
  'z': 6.5,
  '{': 5,
  '|': 3,
  '}': 5,
  '~': 7.5,
} as const

interface PlayerHistoryTargetRow {
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
  createdAt: number
  completedAt: number | null
}

interface PlayerHistoryParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  placement: number | null
  civId: string | null
  displayName: string | null
}

interface PlayerHistoryPage {
  startIndex: number
  rows: PlayerHistoryTargetRow[]
}

interface PlayerHistoryProfile {
  displayName: string
  avatarUrl: string | null
}

export async function playerHistoryPageEmbed(
  db: Database,
  playerId: string,
  modeFilter: PlayerHistoryModeFilter = 'all',
  options: {
    pageIndex?: number
    pageSize?: number
  } = {},
): Promise<{ embed: Embed, pageIndex: number, pageCount: number, totalRows: number }> {
  const pageSize = normalizePageSize(options.pageSize)
  const displaySeason = await getDisplaySeason(db)
  const seasonId = displaySeason?.id ?? null
  const targetRows = await loadPlayerHistoryRows(db, playerId, modeFilter, seasonId)
  const layoutCosts = await loadHistoryLayoutCosts(db, targetRows.map(row => row.matchId))
  const pages = paginateHistoryRows(targetRows, layoutCosts, pageSize)
  const totalRows = targetRows.length
  const pageCount = Math.max(1, pages.length)
  const pageIndex = clampPageIndex(options.pageIndex ?? 0, pageCount)
  const page = pages[pageIndex] ?? { startIndex: 0, rows: [] }
  const hydratedRows = await hydrateModeRatingSnapshotsFromEvents(db, page.rows)
  const participants = await loadHistoryParticipants(db, hydratedRows.map(row => row.matchId))
  const player = await loadPlayerProfile(db, playerId)
  const modeLabel = modeFilter === 'all' ? null : formatModeLabel(modeFilter, modeFilter)
  const title = modeLabel ? `Match History (${modeLabel})` : 'Match History'
  const embed = new Embed()
    .title(title)
    .color(0xC8AA6E)

  const fields = formatHistoryFields(hydratedRows, participants, playerId)
  if (fields.length > 0) embed.fields(...fields)
  else embed.description('No completed matches yet.')
  embed.footer({
    text: formatHistoryFooter(player.displayName, pageIndex, pageCount, totalRows, page.rows.length, page.startIndex),
    icon_url: player.avatarUrl ?? undefined,
  })

  return { embed, pageIndex, pageCount, totalRows }
}

function isAsciiCharacter(char: string): boolean {
  return /^[\x20-\x7E]$/u.test(char)
}

async function loadPlayerHistoryRows(
  db: Database,
  playerId: string,
  modeFilter: PlayerHistoryModeFilter,
  seasonId: string | null,
): Promise<PlayerHistoryTargetRow[]> {
  const rows = await db
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
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .leftJoin(tournamentMatches, or(eq(tournamentMatches.matchId, matches.id), eq(tournamentMatches.sessionId, matches.id)))
    .where(buildPlayerHistoryWhere(playerId, modeFilter, seasonId))
    .orderBy(desc(sql`coalesce(${matches.completedAt}, ${matches.createdAt})`), desc(matches.createdAt), desc(matches.id))

  return rows.map(({ tournamentSessionId, ...row }) => ({
    ...row,
    isTournament: tournamentSessionId != null,
  }))
}

async function loadHistoryLayoutCosts(db: Database, matchIds: readonly string[]): Promise<Map<string, number>> {
  const participantsByMatchId = new Map<string, Array<{ team: number | null }>>()
  const uniqueMatchIds = [...new Set(matchIds)]
  for (const batch of chunk(uniqueMatchIds, 90)) {
    const rows = await db
      .select({ matchId: matchParticipants.matchId, team: matchParticipants.team })
      .from(matchParticipants)
      .where(inArray(matchParticipants.matchId, batch))
    for (const row of rows) {
      const participants = participantsByMatchId.get(row.matchId) ?? []
      participants.push({ team: row.team })
      participantsByMatchId.set(row.matchId, participants)
    }
  }

  return new Map([...participantsByMatchId.entries()].map(([matchId, participants]) => [matchId, estimateHistoryRowCost(participants)]))
}

async function loadHistoryParticipants(db: Database, matchIds: readonly string[]): Promise<PlayerHistoryParticipantRow[]> {
  const uniqueMatchIds = [...new Set(matchIds)]
  const rows: PlayerHistoryParticipantRow[] = []
  for (const batch of chunk(uniqueMatchIds, 90)) {
    rows.push(...await db
      .select({
        matchId: matchParticipants.matchId,
        playerId: matchParticipants.playerId,
        team: matchParticipants.team,
        placement: matchParticipants.placement,
        civId: matchParticipants.civId,
        displayName: players.displayName,
      })
      .from(matchParticipants)
      .leftJoin(players, eq(matchParticipants.playerId, players.id))
      .where(inArray(matchParticipants.matchId, batch)))
  }
  return rows
}

async function loadPlayerProfile(db: Database, playerId: string): Promise<PlayerHistoryProfile> {
  const [row] = await db
    .select({ displayName: players.displayName, avatarUrl: players.avatarUrl })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1)
  return {
    displayName: formatPlainPlayerName(row?.displayName ?? null, playerId),
    avatarUrl: row?.avatarUrl ?? null,
  }
}

function buildPlayerHistoryWhere(playerId: string, modeFilter: PlayerHistoryModeFilter, seasonId: string | null) {
  const conditions = [
    eq(matchParticipants.playerId, playerId),
    eq(matches.status, 'completed'),
  ]
  if (seasonId) conditions.push(eq(matches.seasonId, seasonId))
  if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))
  return and(...conditions)
}

function paginateHistoryRows(
  rows: readonly PlayerHistoryTargetRow[],
  layoutCosts: ReadonlyMap<string, number>,
  pageSize: number,
): PlayerHistoryPage[] {
  const pages: PlayerHistoryPage[] = []
  let current: PlayerHistoryTargetRow[] = []
  let currentStartIndex = 0
  let currentCost = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const cost = Math.max(2, layoutCosts.get(row.matchId) ?? 2)
    const wouldExceedMatchCount = current.length >= pageSize
    const wouldExceedBudget = current.length > 0 && currentCost + cost > PLAYER_HISTORY_RENDERED_LINE_BUDGET
    if (wouldExceedMatchCount || wouldExceedBudget) {
      pages.push({ startIndex: currentStartIndex, rows: current })
      current = []
      currentStartIndex = index
      currentCost = 0
    }

    current.push(row)
    currentCost += cost
  }

  if (current.length > 0) pages.push({ startIndex: currentStartIndex, rows: current })
  return pages
}

function estimateHistoryRowCost(participants: readonly { team: number | null }[]): number {
  const renderedPlayerRows = estimateRenderedPlayerRows(participants)
  return renderedPlayerRows + 1
}

function estimateRenderedPlayerRows(participants: readonly { team: number | null }[]): number {
  if (participants.length === 0) return 1
  const groups = new Map<number | null, number>()
  for (const participant of participants) groups.set(participant.team, (groups.get(participant.team) ?? 0) + 1)
  if (groups.size <= 1 || groups.has(null)) return participants.length
  return Math.max(1, ...groups.values())
}

function formatHistoryFields(
  rows: readonly PlayerHistoryTargetRow[],
  participants: readonly PlayerHistoryParticipantRow[],
  targetPlayerId: string,
): Array<{ name: string, value: string, inline: false }> {
  const participantsByMatchId = new Map<string, PlayerHistoryParticipantRow[]>()
  for (const participant of participants) {
    const list = participantsByMatchId.get(participant.matchId) ?? []
    list.push(participant)
    participantsByMatchId.set(participant.matchId, list)
  }

  return rows
    .map(row => ({
      name: formatHistoryFieldName(row),
      value: preserveLeadingIndent(formatPlayerList(row, participantsByMatchId.get(row.matchId) ?? [], targetPlayerId)),
      inline: false,
    }))
}

function formatHistoryFieldName(row: PlayerHistoryTargetRow): string {
  return [
    formatPlacementCode(row.placement),
    formatRatingChange(row),
    '-',
    formatHistoryModeLabel(row),
    '-',
    `\`${formatHistoryDate(row.completedAt ?? row.createdAt)}\``,
  ].join(' ')
}

function formatPlayerList(
  row: PlayerHistoryTargetRow,
  participants: readonly PlayerHistoryParticipantRow[],
  targetPlayerId: string,
): string {
  const sorted = sortParticipants(participants)
  if (sorted.length === 0) return formatLeaderIcon(row.civId, row.isOld)

  const grouped = groupParticipantsByTeam(sorted)
  if (grouped.length <= 1) {
    return sorted
      .map(participant => `${PLAYER_ROW_INDENT}${formatPlacementCode(participant.placement)} ${formatPlayerEntry(participant, row.isOld, targetPlayerId).text}`)
      .join('\n')
  }

  return formatTeamColumns(grouped, targetPlayerId, row.isOld)
}

function formatTeamColumns(
  groups: Array<{ team: number | null, participants: PlayerHistoryParticipantRow[] }>,
  targetPlayerId: string,
  isOld: boolean,
): string {
  const columns = groups.map(group => sortTeamParticipants(group.participants, targetPlayerId).map(participant => formatPlayerEntry(participant, isOld, targetPlayerId)))
  const columnWidths = columns.slice(0, -1).map(column => Math.max(MIN_TEAM_COLUMN_WIDTH_PX, Math.max(0, ...column.map(entry => entry.visibleWidth)) + INTER_TEAM_COLUMN_GAP_PX))
  const maxRows = Math.max(0, ...columns.map(column => column.length))
  const lines: string[] = []

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const cells = columns.map(column => column[rowIndex] ?? null)
    lines.push(`${PLAYER_ROW_INDENT}${cells.map((cell, index) => {
      if (index === cells.length - 1) return cell?.text ?? ''
      return padColumn(cell, columnWidths[index] ?? MIN_TEAM_COLUMN_WIDTH_PX)
    }).join('')}`.trimEnd())
  }

  return lines.join('\n')
}

function sortTeamParticipants(participants: readonly PlayerHistoryParticipantRow[], targetPlayerId: string): PlayerHistoryParticipantRow[] {
  return [...participants].sort((left, right) => {
    if (left.playerId === targetPlayerId) return -1
    if (right.playerId === targetPlayerId) return 1
    return formatPlainPlayerName(left.displayName, left.playerId).localeCompare(formatPlainPlayerName(right.displayName, right.playerId))
  })
}

function groupParticipantsByTeam(participants: readonly PlayerHistoryParticipantRow[]): Array<{ team: number | null, participants: PlayerHistoryParticipantRow[] }> {
  const groups = new Map<number | null, PlayerHistoryParticipantRow[]>()
  for (const participant of participants) {
    const list = groups.get(participant.team) ?? []
    list.push(participant)
    groups.set(participant.team, list)
  }
  return [...groups.entries()]
    .map(([team, participants]) => ({ team, participants }))
    .sort((left, right) => normalizePlacement(left.team) - normalizePlacement(right.team))
}

function sortParticipants(participants: readonly PlayerHistoryParticipantRow[]): PlayerHistoryParticipantRow[] {
  return [...participants].sort((left, right) => {
    const placementDiff = normalizePlacement(left.placement) - normalizePlacement(right.placement)
    if (placementDiff !== 0) return placementDiff
    const teamDiff = normalizePlacement(left.team) - normalizePlacement(right.team)
    if (teamDiff !== 0) return teamDiff
    return formatPlainPlayerName(left.displayName, left.playerId).localeCompare(formatPlainPlayerName(right.displayName, right.playerId))
  })
}

function formatPlayerEntry(participant: PlayerHistoryParticipantRow, isOld: boolean, targetPlayerId: string): { text: string, visibleWidth: number } {
  const rawName = formatPlainPlayerName(participant.displayName, participant.playerId)
  const escapedName = escapeMarkdown(rawName)
  const name = participant.playerId === targetPlayerId ? `**${escapedName}**` : escapedName
  return {
    text: `${formatLeaderIcon(participant.civId, isOld)} ${name}`,
    visibleWidth: LEADER_ICON_WIDTH_PX + LEADER_ICON_GAP_PX + estimateTextWidth(rawName),
  }
}

function padColumn(entry: { text: string, visibleWidth: number } | null, widthPx: number): string {
  if (!entry) return formatPadding(widthPx)
  const padWidthPx = Math.max(INTER_TEAM_COLUMN_GAP_PX, widthPx - entry.visibleWidth)
  return `${entry.text}${formatPadding(padWidthPx)}`
}

function formatPadding(widthPx: number): string {
  let remainingPx = Math.max(0, Math.ceil(widthPx))
  let padding = ''
  for (const unit of PAD_UNITS) {
    const count = Math.floor(remainingPx / unit.widthPx)
    if (count > 0) padding += unit.value.repeat(count)
    remainingPx -= count * unit.widthPx
  }
  return padding
}

function preserveLeadingIndent(value: string): string {
  return value
    .split('\n')
    .map(line => line.startsWith(PLAYER_ROW_INDENT) ? `${LEADING_INDENT_GUARD}${line}` : line)
    .join('\n')
}

function estimateTextWidth(value: string): number {
  let width = 0
  for (const char of value) width += estimateCharacterWidth(char)
  return width + estimateNaturalNameAdjustment(value)
}

function estimateNaturalNameAdjustment(value: string): number {
  if (isRepeatedSingleCharacter(value)) return 0

  const chars = [...value]
  const spaceCount = chars.filter(char => char === ' ').length
  if (spaceCount > 0 && isSpacedInitialism(value)) return spaceCount * INITIALISM_SPACE_EXTRA_WIDTH
  if (spaceCount > 0) return spaceCount * NAME_SPACE_EXTRA_WIDTH
  if (/^[A-Za-z0-9]+$/u.test(value)) return estimateAlnumNameAdjustment(chars.length)
  if (/^[A-Za-z0-9_-]+$/u.test(value)) return estimateCompoundNameAdjustment(chars.length, chars.filter(char => char === '_' || char === '-').length)
  return 0
}

function estimateAlnumNameAdjustment(length: number): number {
  return Math.min(
    ALNUM_NAME_MAX_WIDTH_ADJUSTMENT,
    SINGLE_WORD_NAME_WIDTH_ADJUSTMENT + Math.max(0, length - ALNUM_NAME_LENGTH_BASE) * ALNUM_NAME_LENGTH_EXTRA_WIDTH,
  )
}

function estimateCompoundNameAdjustment(length: number, separatorCount: number): number {
  return Math.max(0, length - COMPOUND_NAME_LENGTH_BASE) * COMPOUND_NAME_LENGTH_EXTRA_WIDTH + separatorCount * COMPOUND_NAME_SEPARATOR_EXTRA_WIDTH
}

function isSpacedInitialism(value: string): boolean {
  const parts = value.split(' ')
  return parts.length > 1 && parts.every(part => /^[A-Za-z0-9]$/u.test(part))
}

function isSpacedInitialism(value: string): boolean {
  const parts = value.split(' ')
  return parts.length > 1 && parts.every(part => /^[A-Za-z0-9]$/u.test(part))
}

function isRepeatedSingleCharacter(value: string): boolean {
  const chars = [...value]
  return chars.length > 1 && chars.every(char => char === chars[0])
}

function estimateCharacterWidth(char: string): number {
  const explicitWidth = CHARACTER_WIDTHS[char]
  if (explicitWidth != null) return explicitWidth
  if (/\s/u.test(char)) return CHARACTER_WIDTHS[' '] ?? 4
  if (isEmojiLikeCharacter(char)) return EMOJI_CHARACTER_WIDTH
  if (isHangulCharacter(char)) return HANGUL_CHARACTER_WIDTH
  if (isWideNameCharacter(char)) return WIDE_NAME_CHARACTER_WIDTH
  if (!isAsciiCharacter(char)) return DEFAULT_NON_ASCII_CHARACTER_WIDTH
  return DEFAULT_ASCII_CHARACTER_WIDTH
}

function isEmojiLikeCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (codePoint >= 0x1F1E6 && codePoint <= 0x1FAFF)
}

function isHangulCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (codePoint >= 0x1100 && codePoint <= 0x11FF) || (codePoint >= 0xAC00 && codePoint <= 0xD7AF)
}

function isWideNameCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11FF)
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7AF)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFF01 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
  )
}

function normalizePlacement(value: number | null): number {
  return value == null ? Number.MAX_SAFE_INTEGER : value
}

function formatPlacementCode(placement: number | null): string {
  if (placement == null) return '`#? `'
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function formatRatingChange(row: PlayerHistoryTargetRow): string {
  if (row.isTournament) return `${formatTournamentResultEmoji(row.placement)} \`Tournament\``
  if (getStoredGameModeContext(row.gameMode, row.draftData)?.civBlitz) return formatUnrankedResultMarker(row.placement)
  if (
    row.ratingBeforeMu == null
    || row.ratingBeforeSigma == null
    || row.ratingAfterMu == null
    || row.ratingAfterSigma == null
  ) {
    return '` ? ` ❔ `(   ?)`'
  }

  const before = displayRating(row.ratingBeforeMu, row.ratingBeforeSigma)
  const after = displayRating(row.ratingAfterMu, row.ratingAfterSigma)
  return formatDisplayRatingChange(before, after)
}

function formatTournamentResultEmoji(placement: number | null): string {
  if (placement == null) return '❔'
  return placement === 1 ? '📈' : '📉'
}

function formatHistoryModeLabel(row: PlayerHistoryTargetRow): string {
  const context = getStoredGameModeContext(row.gameMode, row.draftData)
  const label = context?.label ?? formatModeLabel(row.gameMode, row.gameMode)
  return row.isOld ? `${label} [old]` : label
}

function formatHistoryDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function formatLeaderIcon(civId: string | null, isOld: boolean): string {
  if (!civId) return isOld ? '❔' : '▫️'
  return leaderEmojiMention(civId) ?? '▫️'
}

function formatHistoryFooter(playerName: string, pageIndex: number, pageCount: number, totalRows: number, rowCount: number, pageStartIndex: number): string {
  if (totalRows <= 0) return `${playerName} - Page 1/1 - 0 matches`
  const start = pageStartIndex + 1
  const end = start + rowCount - 1
  return `${playerName} - Page ${pageIndex + 1}/${pageCount} - ${start}-${end} of ${totalRows}`
}

function formatPlainPlayerName(displayName: string | null, playerId: string): string {
  const normalized = displayName?.replace(/\s+/g, ' ').trim()
  return normalized && normalized.length > 0 ? normalized : playerId
}

function normalizePageSize(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return PLAYER_HISTORY_PAGE_SIZE
  return Math.max(PLAYER_HISTORY_PAGE_SIZE, Math.floor(value))
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_`~|])/g, '\\$1')
}

function normalizeCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}
