import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import { matches, matchParticipants, players, tournamentMatches } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { HISTORY_ALIGNMENT_SAMPLE_CHARS, HISTORY_ALIGNMENT_SAMPLE_SOURCE } from '../dev/history-alignment-samples.generated.ts'
import { getStoredGameModeContext } from '../services/match/draft-data.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { clampPageIndex } from '../services/response/pagination.ts'
import { formatDisplayRatingChange } from './rating-change.ts'

export type PlayerHistoryModeFilter = 'all' | GameMode

export const PLAYER_HISTORY_PAGE_SIZE = 10
const PLAYER_HISTORY_RENDERED_LINE_BUDGET = 30
const LEADING_INDENT_GUARD = '\u200B'
const PLAYER_ROW_INDENT = '\u00A0\u00A0\u00A0'
const LEADER_ICON_WIDTH_PX = 22
const LEADER_ICON_GAP_PX = 5
const INTER_TEAM_COLUMN_GAP_PX = 24
const MIN_TEAM_COLUMN_WIDTH_PX = 120
const NBSP_WIDTH_PX = 4
const ALIGNMENT_ANCHOR_NAME = 'xxxxxxxxxx'
const ALIGNMENT_ANCHOR_LABEL = 'anchor'
const ALIGNMENT_TEST_COLUMN_WIDTH_PX = 280
const DEFAULT_ASCII_CHARACTER_WIDTH = 7
const DEFAULT_NON_ASCII_CHARACTER_WIDTH = 8

const CHARACTER_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 4,
  '!': 2.5,
  '"': 7,
  '#': 10,
  '%': 10,
  '&': 10,
  "'": 2.5,
  '(': 2.5,
  ')': 2.5,
  ',': 2.5,
  '-': 5,
  '.': 2.5,
  '/': 5,
  '0': 9.5,
  '1': 5,
  '2': 8.25,
  '3': 8.5,
  '4': 8.5,
  '5': 8.25,
  '6': 8.25,
  '7': 7.5,
  '8': 8.25,
  '9': 8.25,
  ':': 2.5,
  ';': 2.5,
  '@': 10,
  'A': 10.25,
  'B': 10,
  'C': 10.25,
  'D': 10.5,
  'E': 9,
  'F': 8.5,
  'G': 10.5,
  'H': 10.5,
  'I': 3,
  'J': 7.5,
  'K': 9.5,
  'L': 8.5,
  'M': 14,
  'N': 11,
  'O': 11,
  'P': 10,
  'Q': 11,
  'R': 10,
  'S': 8.5,
  'T': 8.5,
  'U': 11,
  'V': 10,
  'W': 13.5,
  'X': 9.5,
  'Y': 9.5,
  'Z': 8.5,
  '[': 2.5,
  '\\': 5,
  ']': 2.5,
  '_': 5,
  '`': 2.5,
  'a': 8,
  'b': 8.5,
  'c': 7.5,
  'd': 8.5,
  'e': 8.25,
  'f': 5,
  'g': 8,
  'h': 8.5,
  'i': 2.5,
  'j': 2.5,
  'k': 7.5,
  'l': 3,
  'm': 13.5,
  'n': 8.25,
  'o': 8.25,
  'p': 8.5,
  'q': 8.5,
  'r': 5.5,
  's': 6.5,
  't': 5.5,
  'u': 8.25,
  'v': 7,
  'w': 11.5,
  'x': DEFAULT_ASCII_CHARACTER_WIDTH,
  'y': 7,
  'z': 6.5,
  '{': 2.5,
  '|': 2.5,
  '}': 2.5,
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

export function playerHistoryAlignmentTestEmbeds(): Embed[] {
  const sampleGroups = buildAlignmentSampleGroups([...HISTORY_ALIGNMENT_SAMPLE_CHARS])
  const leftCivs = [
    'byzantium-theodora',
    'babylon-hammurabi',
    'japan-hojo-tokimune',
    'phoenicia-ahiram',
    'macedon-alexander',
  ]
  const rightCivs = [
    'france-catherine-de-medici-magnificence',
    'inca-pachacuti',
    'korea-seondeok',
    'korea-sejong',
    'egypt-cleopatra-egyptian',
  ]

  return [
    ...sampleGroups.map(group => alignmentTestEmbed(group.title, group.description, group.samples, leftCivs, rightCivs)),
    alignmentTestEmbed('Wide Script Widths', 'Representative wide glyph rows; other rare special characters are intentionally not exhaustive.', [
      { left: '漢漢漢漢漢漢', right: 'CJK ideograph' },
      { left: 'ああああああ', right: 'hiragana' },
      { left: 'カカカカカカ', right: 'katakana' },
      { left: '한한한한한한', right: 'hangul' },
      { left: 'ＡＡＡＡＡＡ', right: 'full-width latin' },
    ], leftCivs, rightCivs),
    alignmentTestEmbed('Symbol Widths', 'Rows repeat common symbols.', [
      { left: '!!!!!!!!!!', right: 'exclamation' },
      { left: '??????????', right: 'question' },
      { left: '@@@@@@@@@@', right: 'at' },
      { left: '##########', right: 'hash' },
      { left: '%%%%%%%%%%', right: 'percent' },
      { left: '&&&&&&&&&&', right: 'ampersand' },
      { left: '----------', right: 'dash' },
      { left: '__________', right: 'underscore' },
      { left: '//////////', right: 'slash' },
      { left: '\\\\\\\\\\', right: 'backslash' },
      { left: '..........', right: 'period' },
      { left: ',,,,,,,,,,', right: 'comma' },
      { left: '::::::::::', right: 'colon' },
      { left: ';;;;;;;;;;', right: 'semicolon' },
      { left: '||||||||||', right: 'pipe' },
      { left: '(((((((((', right: 'open parens' },
      { left: ')))))))))', right: 'close parens' },
    ], leftCivs, rightCivs),
    alignmentTestEmbed('Realistic Names', 'Rows use names similar to actual history output.', [
      { left: 'Rettend', right: 'short normal' },
      { left: 'Hman', right: 'very short' },
      { left: 'mmmmmmmmmm', right: 'many m' },
      { left: 'iiiiiiiiii', right: 'many i' },
      { left: 'WWWWWWWWWW', right: 'many W' },
      { left: 'Dev Leader Bot 14', right: 'bot 14' },
      { left: 'Test Player 10', right: 'player 10' },
      { left: 'Catherine Main', right: 'medium' },
      { left: 'Long Player Name 888', right: 'long digits' },
      { left: 'MiWiMiWiMiWi', right: 'mixed wide' },
      { left: 'l1I|!.,', right: 'narrow mix' },
    ], leftCivs, rightCivs),
  ]
}

function buildAlignmentSampleGroups(chars: readonly string[]): Array<{ title: string, description: string, samples: Array<{ left: string, right: string }> }> {
  const uniqueChars = [...new Set(chars)].filter(char => char.length > 0 && !isControlCharacter(char))
  const lowercase = uniqueChars.filter(char => /^[a-z]$/u.test(char)).sort((a, b) => a.localeCompare(b))
  const uppercase = uniqueChars.filter(char => /^[A-Z]$/u.test(char)).sort((a, b) => a.localeCompare(b))
  const numbers = uniqueChars.filter(char => /^[0-9]$/u.test(char)).sort((a, b) => a.localeCompare(b))

  return [
    { title: 'PPL Lowercase Widths', description: 'Lowercase characters found in cached PPL display names.', samples: sampleRepeatedChars(lowercase, 'lower') },
    { title: 'PPL Uppercase Widths', description: 'Uppercase characters found in cached PPL display names.', samples: sampleRepeatedChars(uppercase, 'upper') },
    { title: 'PPL Number Widths', description: 'Number characters found in cached PPL display names.', samples: sampleRepeatedChars(numbers, 'number') },
  ].filter(group => group.samples.length > 0)
}

function alignmentTestEmbed(
  title: string,
  description: string,
  samples: ReadonlyArray<{ left: string, right: string }>,
  leftCivs: readonly string[],
  rightCivs: readonly string[],
): Embed {
  return new Embed()
    .title(`History Alignment Test - ${title}`)
    .description(description)
    .color(0xC8AA6E)
    .fields(...chunk([...samples].slice(0, 100), 4).map((group, index) => ({
      name: `${sampleSourceLabel()} - Rows ${index * 4 + 1}-${index * 4 + group.length}`,
      value: formatAlignmentTestColumns(
        [ALIGNMENT_ANCHOR_NAME, ...group.map(sample => sample.left)],
        [ALIGNMENT_ANCHOR_LABEL, ...group.map(sample => sample.right)],
        leftCivs,
        rightCivs,
      ),
      inline: false,
    })))
}

function sampleRepeatedChars(chars: readonly string[], label: string): Array<{ left: string, right: string }> {
  return chars.map(char => ({
    left: repeatedSampleText(char),
    right: `${label} ${visibleCharacterLabel(char)}`,
  }))
}

function repeatedSampleText(char: string): string {
  if (char === ' ') return 'x x x x x'
  return char.repeat(char.codePointAt(0)! > 0x7F ? 6 : 10)
}

function visibleCharacterLabel(char: string): string {
  if (char === ' ') return '[space]'
  return char
}

function sampleSourceLabel(): string {
  const sampleSource = String(HISTORY_ALIGNMENT_SAMPLE_SOURCE.source)
  const source = sampleSource === 'fallback' ? 'fallback' : 'ppl'
  return `${source} chars`
}

function isAsciiCharacter(char: string): boolean {
  return /^[\x20-\x7E]$/u.test(char)
}

function isControlCharacter(char: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(char)
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
      .map(participant => `${PLAYER_ROW_INDENT}${formatPlacementCode(participant.placement)} ${formatPlayerEntry(participant, row.isOld).text}`)
      .join('\n')
  }

  return formatTeamColumns(grouped, targetPlayerId, row.isOld)
}

function formatTeamColumns(
  groups: Array<{ team: number | null, participants: PlayerHistoryParticipantRow[] }>,
  targetPlayerId: string,
  isOld: boolean,
): string {
  const columns = groups.map(group => sortTeamParticipants(group.participants, targetPlayerId).map(participant => formatPlayerEntry(participant, isOld)))
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

function formatPlayerEntry(participant: PlayerHistoryParticipantRow, isOld: boolean): { text: string, visibleWidth: number } {
  const rawName = formatPlainPlayerName(participant.displayName, participant.playerId)
  const name = escapeMarkdown(rawName)
  return {
    text: `${formatLeaderIcon(participant.civId, isOld)} ${name}`,
    visibleWidth: LEADER_ICON_WIDTH_PX + LEADER_ICON_GAP_PX + estimateTextWidth(rawName),
  }
}

function padColumn(entry: { text: string, visibleWidth: number } | null, widthPx: number): string {
  if (!entry) return '\u00A0'.repeat(Math.ceil(widthPx / NBSP_WIDTH_PX))
  const padWidthPx = Math.max(INTER_TEAM_COLUMN_GAP_PX, widthPx - entry.visibleWidth)
  return `${entry.text}${'\u00A0'.repeat(Math.ceil(padWidthPx / NBSP_WIDTH_PX))}`
}

function formatAlignmentTestColumns(leftNames: readonly string[], rightNames: readonly string[], leftCivs: readonly string[], rightCivs: readonly string[]): string {
  const leftEntries = leftNames.map((name, index) => formatTestEntry(name, leftCivs[index % leftCivs.length]!))
  const rightEntries = rightNames.map((name, index) => formatTestEntry(name, rightCivs[index % rightCivs.length]!))
  const columnWidth = ALIGNMENT_TEST_COLUMN_WIDTH_PX
  const lines = leftEntries.map((left, index) => `${PLAYER_ROW_INDENT}${padColumn(left, columnWidth)}│ ${rightEntries[index]?.text ?? ''}`)
  return preserveLeadingIndent(lines.join('\n'))
}

function formatTestEntry(name: string, civId: string): { text: string, visibleWidth: number } {
  return {
    text: `${formatLeaderIcon(civId, false)} ${escapeMarkdown(name)}`,
    visibleWidth: LEADER_ICON_WIDTH_PX + LEADER_ICON_GAP_PX + estimateTextWidth(name),
  }
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
  return width
}

function estimateCharacterWidth(char: string): number {
  const explicitWidth = CHARACTER_WIDTHS[char]
  if (explicitWidth != null) return explicitWidth
  if (/\s/u.test(char)) return CHARACTER_WIDTHS[' '] ?? 4
  if (isEmojiLikeCharacter(char)) return 14
  if (isWideNameCharacter(char)) return 13
  if (!isAsciiCharacter(char)) return DEFAULT_NON_ASCII_CHARACTER_WIDTH
  return DEFAULT_ASCII_CHARACTER_WIDTH
}

function isEmojiLikeCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (codePoint >= 0x1F1E6 && codePoint <= 0x1FAFF)
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
