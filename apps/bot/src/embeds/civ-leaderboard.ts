import type { CivLeaderboardSnapshot, CivLeaderboardSnapshotRow } from '../services/leaderboard/civ-snapshot.ts'
import { Embed } from 'discord-hono'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'

export type CivLeaderboardBoard = 'picked' | 'winrate' | 'banned'

export const CIV_LEADERBOARD_BOARDS: readonly CivLeaderboardBoard[] = ['picked', 'winrate', 'banned']
export const CIV_LEADERBOARD_TOP_LIMIT = 25

const DISCORD_EMBEDS_TOTAL_CHAR_LIMIT = 6000

const BOARD_COLORS: Record<CivLeaderboardBoard, number> = {
  picked: 0x2563EB,
  winrate: 0x16A34A,
  banned: 0xDC2626,
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
  const rows = rowsForBoard(board, snapshot.rows).slice(0, CIV_LEADERBOARD_TOP_LIMIT)
  const title = formatCivLeaderboardTitle(board, options.titlePrefix)

  if (rows.length === 0) {
    return new Embed()
      .title(title)
      .description(emptyDescriptionForBoard(board))
      .color(BOARD_COLORS[board])
  }

  return new Embed()
    .title(title)
    .description(rows.map((row, index) => formatRow(board, row, index + 1, snapshot.completedMatchCount)).join('\n'))
    .color(BOARD_COLORS[board])
}

function rowsForBoard(
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

function formatRow(board: CivLeaderboardBoard, row: CivLeaderboardSnapshotRow, rank: number, completedMatchCount: number): string {
  const leader = formatLeader(row)
  const pickRate = formatBoldPercent(ratePct(row.picks, completedMatchCount))
  const banRate = formatBoldPercent(row.banRatePct)
  const winRate = formatBoldPercent(row.winRatePct)

  if (board === 'picked') {
    return `${formatPlacementCode(rank)} ${leader} — ${pickRate} Pick, ${winRate} WR, ${banRate} Ban`
  }

  if (board === 'winrate') {
    return `${formatPlacementCode(rank)} ${leader} — ${winRate} WR, ${pickRate} Pick, ${banRate} Ban`
  }

  return `${formatPlacementCode(rank)} ${leader} — ${banRate} Ban, ${pickRate} Pick, ${winRate} WR`
}

function formatLeader(row: CivLeaderboardSnapshotRow): string {
  const emoji = leaderEmojiMention(row.civId)
  const leaderName = row.leaderName || row.civId
  return `${emoji ? `${emoji} ` : ''}${leaderName}`
}

function formatCivLeaderboardTitle(board: CivLeaderboardBoard, titlePrefix?: string): string {
  const baseTitle = board === 'picked'
    ? 'Top Picked Leaders'
    : board === 'winrate'
      ? 'Top Win Rate Leaders'
      : 'Top Banned Leaders'
  return titlePrefix ? `${titlePrefix} ${baseTitle}` : baseTitle
}

function emptyDescriptionForBoard(board: CivLeaderboardBoard): string {
  if (board === 'picked') return 'No completed matches with picked leaders yet.'
  if (board === 'winrate') return 'No completed matches with picked leaders yet.'
  return 'No recorded draft bans yet.'
}

function formatPercent(value: number | null): string {
  return value == null ? 'n/a' : `${value}%`
}

function formatBoldPercent(value: number | null): string {
  const formatted = formatPercent(value)
  return value == null ? formatted : `**${formatted}**`
}

function ratePct(count: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((count / total) * 1000) / 10
}

function formatPlacementCode(placement: number): string {
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function embedTextLength(embed: Embed): number {
  const json = embed.toJSON() as {
    title?: unknown
    description?: unknown
  }

  return stringLength(json.title) + stringLength(json.description)
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}
