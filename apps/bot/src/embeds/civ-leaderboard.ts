import type { CivLeaderboardSnapshot, CivLeaderboardSnapshotRow } from '../services/leaderboard/civ-snapshot.ts'
import { Embed } from 'discord-hono'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'

export type CivLeaderboardBoard = 'picked' | 'winrate' | 'banned'

export const CIV_LEADERBOARD_BOARDS: readonly CivLeaderboardBoard[] = ['picked', 'winrate', 'banned']
export const CIV_LEADERBOARD_PAGE_SIZE = 20
export const CIV_LEADERBOARD_TOP_LIMIT = 25
export const CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT = 2100

const DISCORD_EMBEDS_TOTAL_CHAR_LIMIT = 6000

const BOARD_COLORS: Record<CivLeaderboardBoard, number> = {
  picked: 0x2563EB,
  winrate: 0x16A34A,
  banned: 0xDC2626,
}

const BOARD_TITLES: Record<CivLeaderboardBoard, string> = {
  picked: 'Top Picked Leaders',
  winrate: 'Top Win Rate Leaders',
  banned: 'Top Banned Leaders',
}

const BOARD_PAGE_TITLES: Record<CivLeaderboardBoard, string> = {
  picked: 'Picked Leaders',
  winrate: 'Win Rate Leaders',
  banned: 'Banned Leaders',
}

const EMPTY_DESCRIPTIONS: Record<CivLeaderboardBoard, string> = {
  picked: 'No completed matches with picked leaders yet.',
  winrate: 'No completed matches with picked leaders yet.',
  banned: 'No recorded draft bans yet.',
}

const STAT_EMOJIS = {
  picked: '🖱️',
  winrate: '🏆',
  banned: '🚫',
} as const

const STAT_ORDER: Record<CivLeaderboardBoard, readonly CivLeaderboardBoard[]> = {
  picked: ['picked', 'winrate', 'banned'],
  winrate: ['winrate', 'picked', 'banned'],
  banned: ['banned', 'picked', 'winrate'],
}

const STAT_PERCENT_WIDTH = 5

const MODE_SCOPE_TITLE_LABELS: Record<CivLeaderboardSnapshot['modeScope'], string | null> = {
  all: null,
  duel: 'Duel',
  duo: 'Duo',
  squad: 'Squad',
}

export function parseCivLeaderboardBoard(value: string | undefined): CivLeaderboardBoard | null {
  if (value === 'picked' || value === 'winrate' || value === 'banned') return value
  return null
}

export function civLeaderboardEmbeds(
  snapshot: CivLeaderboardSnapshot,
  options: {
    titlePrefix?: string
  } = {},
): Embed[] {
  return CIV_LEADERBOARD_BOARDS.map(board => civLeaderboardEmbed(board, snapshot, options))
}

export function civLeaderboardEmbedGroups(
  snapshot: CivLeaderboardSnapshot,
  options: {
    titlePrefix?: string
  } = {},
): Embed[][] {
  const groups: Embed[][] = []
  let currentGroup: Embed[] = []
  let currentLength = 0

  for (const embed of civLeaderboardEmbeds(snapshot, options)) {
    const embedLength = embedTextLength(embed)
    if (currentGroup.length > 0 && currentLength + embedLength > DISCORD_EMBEDS_TOTAL_CHAR_LIMIT) {
      groups.push(currentGroup)
      currentGroup = []
      currentLength = 0
    }

    currentGroup.push(embed)
    currentLength += embedLength
  }

  if (currentGroup.length > 0) groups.push(currentGroup)
  return groups
}

export function civLeaderboardEmbed(
  board: CivLeaderboardBoard,
  snapshot: CivLeaderboardSnapshot,
  options: {
    titlePrefix?: string
  } = {},
): Embed {
  const rows = civLeaderboardRowsForBoard(board, snapshot.rows).slice(0, CIV_LEADERBOARD_TOP_LIMIT)
  const title = formatCivLeaderboardTitle(board, resolveTitleScopeLabel(snapshot, options.titlePrefix))

  if (rows.length === 0) {
    return new Embed()
      .title(title)
      .description(emptyDescriptionForBoard(board))
      .color(BOARD_COLORS[board])
      .footer({ text: formatFooter(snapshot) })
  }

  const description = formatBoardDescription(board, rows)

  return new Embed()
    .title(title)
    .description(description)
    .color(BOARD_COLORS[board])
    .footer({ text: formatFooter(snapshot) })
}

export function civLeaderboardPageEmbed(
  board: CivLeaderboardBoard,
  snapshot: CivLeaderboardSnapshot,
  options: {
    pageIndex?: number
    pageSize?: number
    titlePrefix?: string
  } = {},
): { embed: Embed, pageIndex: number, pageCount: number, totalRows: number } {
  const pageSize = normalizePageSize(options.pageSize)
  const allRows = civLeaderboardRowsForBoard(board, snapshot.rows)
  const pageCount = Math.max(1, Math.ceil(allRows.length / pageSize))
  const pageIndex = clampPageIndex(options.pageIndex ?? 0, pageCount)
  const startIndex = pageStartIndex(pageIndex, pageCount, allRows.length, pageSize)
  const rows = allRows.slice(startIndex, startIndex + pageSize)
  const title = formatCivLeaderboardPageTitle(board, resolveTitleScopeLabel(snapshot, options.titlePrefix))

  if (rows.length === 0) {
    const embed = new Embed()
      .title(title)
      .description(emptyDescriptionForBoard(board))
      .color(BOARD_COLORS[board])
      .footer({ text: formatFooter(snapshot) })
    return { embed, pageIndex, pageCount, totalRows: allRows.length }
  }

  const startRank = startIndex + 1
  const endRank = startIndex + rows.length
  const description = formatBoardDescription(board, rows, startRank)
  const embed = new Embed()
    .title(title)
    .description(description)
    .color(BOARD_COLORS[board])
    .footer({ text: `${formatFooter(snapshot)} | Page ${pageIndex + 1}/${pageCount} - ${startRank}-${endRank} of ${allRows.length}` })

  return { embed, pageIndex, pageCount, totalRows: allRows.length }
}

function formatBoardDescription(
  board: CivLeaderboardBoard,
  rows: readonly CivLeaderboardSnapshotRow[],
  startRank = 1,
): string {
  const lines: string[] = []
  let length = 0

  for (let index = 0; index < rows.length; index++) {
    const line = formatRow(board, rows[index]!, startRank + index)
    const nextLength = length + (lines.length > 0 ? 1 : 0) + line.length
    if (nextLength > CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT) break

    lines.push(line)
    length = nextLength
  }

  return lines.length > 0 ? lines.join('\n') : emptyDescriptionForBoard(board)
}

export function civLeaderboardRowsForBoard(
  board: CivLeaderboardBoard,
  rows: readonly CivLeaderboardSnapshotRow[],
): CivLeaderboardSnapshotRow[] {
  if (board === 'picked') {
    return [...rows]
      .filter(row => row.picks > 0)
      .sort((left, right) => right.picks - left.picks || right.wins - left.wins || left.civId.localeCompare(right.civId))
  }

  if (board === 'winrate') {
    return [...rows]
      .filter(row => row.picks > 0 && row.winRatePct != null)
      .sort((left, right) => (right.winRatePct ?? 0) - (left.winRatePct ?? 0) || right.picks - left.picks || left.civId.localeCompare(right.civId))
  }

  return [...rows]
    .filter(row => row.bans > 0)
    .sort((left, right) => right.bans - left.bans || right.picks - left.picks || left.civId.localeCompare(right.civId))
}

function formatRow(board: CivLeaderboardBoard, row: CivLeaderboardSnapshotRow, rank: number): string {
  const leader = formatLeader(row)
  const stats = {
    picked: formatCodePercent(row.pickRatePct),
    winrate: formatCodePercent(row.winRatePct),
    banned: formatCodePercent(row.banRatePct),
  }
  const statText = STAT_ORDER[board].map(stat => formatStat(stat, stats[stat])).join(' ')
  return `${formatPlacementCode(rank)} ${statText} — ${leader}`
}

function formatLeader(row: CivLeaderboardSnapshotRow): string {
  const emoji = leaderEmojiMention(row.civId)
  const leaderName = row.leaderName || row.civId
  return `${emoji ? `${emoji} ` : ''}${leaderName}`
}

function formatStat(stat: CivLeaderboardBoard, value: string): string {
  return `${STAT_EMOJIS[stat]} ${value}`
}

function formatCivLeaderboardTitle(board: CivLeaderboardBoard, titleScopeLabel?: string): string {
  const baseTitle = BOARD_TITLES[board]
  return formatTitleWithScope(baseTitle, titleScopeLabel)
}

function formatCivLeaderboardPageTitle(board: CivLeaderboardBoard, titleScopeLabel?: string): string {
  const baseTitle = BOARD_PAGE_TITLES[board]
  return formatTitleWithScope(baseTitle, titleScopeLabel)
}

function resolveTitleScopeLabel(snapshot: CivLeaderboardSnapshot, override?: string): string | undefined {
  return override ?? MODE_SCOPE_TITLE_LABELS[snapshot.modeScope] ?? undefined
}

function formatTitleWithScope(baseTitle: string, titleScopeLabel?: string): string {
  return titleScopeLabel ? `${baseTitle} (${titleScopeLabel})` : baseTitle
}

function emptyDescriptionForBoard(board: CivLeaderboardBoard): string {
  return EMPTY_DESCRIPTIONS[board]
}

function formatPercent(value: number | null): string {
  return value == null ? 'n/a' : `${value}%`
}

function formatCodePercent(value: number | null): string {
  return `\`${formatPercent(value).padEnd(STAT_PERCENT_WIDTH, ' ')}\``
}

function formatFooter(snapshot: CivLeaderboardSnapshot): string {
  const gamesLabel = snapshot.completedMatchCount === 1 ? 'Game' : 'Games'
  return `${snapshot.label} - ${snapshot.completedMatchCount} ${gamesLabel}`
}

function normalizePageSize(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return CIV_LEADERBOARD_PAGE_SIZE
  return Math.max(1, Math.floor(value))
}

function clampPageIndex(pageIndex: number, pageCount: number): number {
  if (!Number.isFinite(pageIndex)) return 0
  return Math.min(Math.max(0, Math.floor(pageIndex)), Math.max(1, pageCount) - 1)
}

function pageStartIndex(pageIndex: number, pageCount: number, totalRows: number, pageSize: number): number {
  if (pageIndex >= pageCount - 1) return Math.max(0, totalRows - pageSize)
  return pageIndex * pageSize
}

function formatPlacementCode(placement: number): string {
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function embedTextLength(embed: Embed): number {
  const json = embed.toJSON() as {
    title?: unknown
    description?: unknown
    footer?: { text?: unknown }
  }

  return stringLength(json.title) + stringLength(json.description) + stringLength(json.footer?.text)
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}
