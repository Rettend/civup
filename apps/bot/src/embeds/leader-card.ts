import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import { matches, matchParticipants, tournamentMatches } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader } from '@civup/game'
import { Embed } from 'discord-hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { leaderEmojiImageUrl, leaderEmojiMention } from '../constants/leader-emojis.ts'
import { listTopPlayerCivRankings } from '../services/leaderboard/player-civ-stats.ts'

export type LeaderStatsModeFilter = 'all' | GameMode

const TOP_LIMIT = 5
const MIN_MATCHUP_GAMES = 2
const MATCH_ID_BATCH_SIZE = 90
const LEADER_MODE_ORDER = ['duel', 'duo', 'squad', 'ffa'] as const

type LeaderMode = typeof LEADER_MODE_ORDER[number]

interface TargetLeaderRow {
  matchId: string
  playerId: string
  team: number | null
  placement: number | null
  gameMode: string
}

interface MatchParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  placement: number | null
  civId: string | null
}

interface RelationStat {
  civId: string
  games: number
  wins: number
}

interface ModeStat {
  mode: LeaderMode
  games: number
  wins: number
  totalMatches: number
}

interface TotalStat {
  games: number
  wins: number
  totalMatches: number
}

interface MatchCountSummary {
  total: number
  modes: Map<string, number>
}

export async function leaderStatsEmbed(db: Database, leaderId: string, modeFilter: LeaderStatsModeFilter = 'all'): Promise<Embed> {
  const leader = resolveLeader(leaderId)
  const [targetRows, matchCounts, bestPlayers] = await Promise.all([
    loadTargetLeaderRows(db, leaderId, modeFilter),
    loadCompletedMatchCounts(db, modeFilter),
    listTopPlayerCivRankings(db, { mode: modeFilter === 'all' ? null : modeFilter }, leaderId, TOP_LIMIT),
  ])
  const participantRows = await loadParticipantRows(db, targetRows.map(row => row.matchId))
  const stats = buildLeaderStats(targetRows, participantRows, matchCounts)
  const modeLabel = modeFilter === 'all' ? null : formatModeLabel(modeFilter, modeFilter)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = [
    {
      name: 'Overview',
      value: formatOverview(stats.total),
      inline: true,
    },
  ]

  fields.push(...formatModeFields(stats.modes))

  fields.push({ name: 'Best Players', value: formatBestPlayerList(bestPlayers), inline: false })

  fields.push(
    { name: 'Most Faced', value: formatRelationList(sortByGames(stats.against).slice(0, TOP_LIMIT)), inline: false },
    { name: 'Best Against', value: formatRelationList(sortByWinRate(stats.against, 'desc').slice(0, TOP_LIMIT)), inline: false },
    { name: 'Worst Against', value: formatRelationList(sortByWinRate(stats.against, 'asc').slice(0, TOP_LIMIT)), inline: false },
    { name: 'Most With', value: formatRelationList(sortByGames(stats.with).slice(0, TOP_LIMIT)), inline: false },
    { name: 'Best With', value: formatRelationList(sortByWinRate(stats.with, 'desc').slice(0, TOP_LIMIT)), inline: false },
    { name: 'Worst With', value: formatRelationList(sortByWinRate(stats.with, 'asc').slice(0, TOP_LIMIT)), inline: false },
  )

  const emoji = leaderEmojiMention(leaderId)
  const thumbnailUrl = leaderEmojiImageUrl(leaderId)
  const leaderName = thumbnailUrl ? leader.name : emoji ? `${emoji} ${leader.name}` : leader.name
  const embed = new Embed()
    .title('Leader Stats')
    .description([leaderName, leader.civilization, modeLabel].filter(Boolean).join(' - '))
    .color(0xC8AA6E)
    .fields(...fields)

  if (thumbnailUrl) embed.thumbnail({ url: thumbnailUrl })
  return embed
}

async function loadTargetLeaderRows(db: Database, leaderId: string, modeFilter: LeaderStatsModeFilter): Promise<TargetLeaderRow[]> {
  const conditions = [
    eq(matchParticipants.civId, leaderId),
    eq(matches.status, 'completed'),
    eligibleStoredMatchCondition(),
    excludeTournamentMatchesCondition(),
  ]
  if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))

  return db
    .select({
      matchId: matchParticipants.matchId,
      playerId: matchParticipants.playerId,
      team: matchParticipants.team,
      placement: matchParticipants.placement,
      gameMode: matches.gameMode,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(...conditions))
}

async function loadParticipantRows(db: Database, matchIds: readonly string[]): Promise<MatchParticipantRow[]> {
  const uniqueMatchIds = [...new Set(matchIds)]
  const rows: MatchParticipantRow[] = []
  for (const batch of chunk(uniqueMatchIds, MATCH_ID_BATCH_SIZE)) {
    rows.push(...await db
      .select({
        matchId: matchParticipants.matchId,
        playerId: matchParticipants.playerId,
        team: matchParticipants.team,
        placement: matchParticipants.placement,
        civId: matchParticipants.civId,
      })
      .from(matchParticipants)
      .where(inArray(matchParticipants.matchId, batch)))
  }
  return rows
}

async function loadCompletedMatchCounts(db: Database, modeFilter: LeaderStatsModeFilter): Promise<MatchCountSummary> {
  const conditions = [
    eq(matches.status, 'completed'),
    eligibleStoredMatchCondition(),
    excludeTournamentMatchesCondition(),
  ]
  if (modeFilter !== 'all') conditions.push(eq(matches.gameMode, modeFilter))

  const rows = await db
    .select({ gameMode: matches.gameMode, count: sql<number>`count(*)` })
    .from(matches)
    .where(and(...conditions))
    .groupBy(matches.gameMode)

  const modes = new Map<string, number>()
  let total = 0
  for (const row of rows) {
    const count = normalizeCount(row.count)
    const mode = toLeaderMode(row.gameMode)
    if (mode) modes.set(mode, (modes.get(mode) ?? 0) + count)
    total += count
  }

  return { total, modes }
}

function buildLeaderStats(
  targetRows: readonly TargetLeaderRow[],
  participantRows: readonly MatchParticipantRow[],
  matchCounts: MatchCountSummary,
) {
  const participantsByMatchId = new Map<string, MatchParticipantRow[]>()
  for (const row of participantRows) {
    const rows = participantsByMatchId.get(row.matchId) ?? []
    rows.push(row)
    participantsByMatchId.set(row.matchId, rows)
  }

  const total: TotalStat = { games: 0, wins: 0, totalMatches: matchCounts.total }
  const modes = new Map<string, ModeStat>()
  const against = new Map<string, RelationStat>()
  const withLeader = new Map<string, RelationStat>()

  for (const target of targetRows) {
    const targetWon = target.placement === 1
    total.games += 1
    if (targetWon) total.wins += 1

    const modeKey = toLeaderMode(target.gameMode)
    if (!modeKey) continue

    const mode = modes.get(modeKey) ?? {
      mode: modeKey,
      games: 0,
      wins: 0,
      totalMatches: matchCounts.modes.get(modeKey) ?? 0,
    }
    mode.games += 1
    if (targetWon) mode.wins += 1
    modes.set(modeKey, mode)

    for (const other of participantsByMatchId.get(target.matchId) ?? []) {
      if (!other.civId || other.playerId === target.playerId) continue
      const relation = getRelation(target, other)
      if (!relation) continue
      addRelationStat(relation === 'with' ? withLeader : against, other.civId, targetWon)
    }
  }

  return {
    total,
    modes: LEADER_MODE_ORDER.flatMap(mode => modes.get(mode) ?? []),
    against: [...against.values()],
    with: [...withLeader.values()],
  }
}

function getRelation(target: TargetLeaderRow, other: MatchParticipantRow): 'against' | 'with' | null {
  if (target.team == null) return 'against'
  if (other.team == null) return null
  return other.team === target.team ? 'with' : 'against'
}

function addRelationStat(stats: Map<string, RelationStat>, civId: string, didWin: boolean): void {
  const stat = stats.get(civId) ?? { civId, games: 0, wins: 0 }
  stat.games += 1
  if (didWin) stat.wins += 1
  stats.set(civId, stat)
}

function formatOverview(total: TotalStat): string {
  if (total.games === 0) return 'Not enough leader data'
  return [
    `Picks: ${total.games} (${formatPercent(total.games, total.totalMatches)}%)`,
    `Wins: ${total.wins} (${formatPercent(total.wins, total.games)}%)`,
  ].join('\n')
}

function formatModeFields(modes: readonly ModeStat[]): Array<{ name: string, value: string, inline: true }> {
  return modes.map(mode => ({
    name: formatLeaderboardModeLabel(mode.mode, mode.mode),
    value: formatModeStat(mode),
    inline: true,
  }))
}

function formatModeStat(mode: ModeStat): string {
  return [
    `Picks: ${mode.games} (${formatPercent(mode.games, mode.totalMatches)}%)`,
    `Wins: ${mode.wins} (${formatPercent(mode.wins, mode.games)}%)`,
  ].join('\n')
}

function formatRelationList(stats: readonly RelationStat[]): string {
  const lines = stats
    .filter(stat => stat.games >= MIN_MATCHUP_GAMES)
    .map(stat => `${formatRecord(stat.wins, stat.games)} ${formatLeaderName(stat.civId)}`)
  return lines.length > 0 ? lines.join('\n') : 'Not enough matchup data'
}

function formatBestPlayerList(stats: Awaited<ReturnType<typeof listTopPlayerCivRankings>>): string {
  if (stats.length === 0) return 'Not enough player data'
  return stats
    .map(stat => `${formatRank(stat.adjustedWinRateRank)} ${formatRecord(stat.wins, stat.picks)} ${formatPlayerName(stat.displayName, stat.playerId)}`)
    .join('\n')
}

function formatRank(rank: number): string {
  return `\`${`#${rank}`.padEnd(3, ' ')}\``
}

function formatPlayerName(displayName: string | null, playerId: string): string {
  const name = displayName?.trim()
  return name && name.length > 0 ? name : `<@${playerId}>`
}

function sortByGames(stats: readonly RelationStat[]): RelationStat[] {
  return [...stats].sort((left, right) => right.games - left.games || right.wins - left.wins || left.civId.localeCompare(right.civId))
}

function sortByWinRate(stats: readonly RelationStat[], direction: 'asc' | 'desc'): RelationStat[] {
  return [...stats]
    .filter(stat => stat.games >= MIN_MATCHUP_GAMES)
    .sort((left, right) => {
      const winRateDiff = (right.wins * left.games) - (left.wins * right.games)
      if (winRateDiff !== 0) return direction === 'desc' ? winRateDiff : -winRateDiff
      const gamesDiff = right.games - left.games
      if (gamesDiff !== 0) return gamesDiff
      return left.civId.localeCompare(right.civId)
    })
}

function formatRecord(wins: number, games: number): string {
  const ratio = `${wins}/${games}`.padStart(5, ' ')
  const pct = `${formatPercent(wins, games)}%`.padStart(4, ' ')
  return `\`${ratio} ${pct}\``
}

function formatLeaderName(civId: string): string {
  const leader = resolveLeader(civId)
  const emoji = leaderEmojiMention(civId)
  return emoji ? `${emoji} ${leader.name}` : leader.name
}

function resolveLeader(civId: string) {
  try {
    return getLeader(civId)
  }
  catch {
    return getLeader(civId, 'beta')
  }
}

function toLeaderMode(gameMode: string): LeaderMode | null {
  if (gameMode === '1v1') return 'duel'
  if (gameMode === '2v2') return 'duo'
  if (gameMode === '3v3' || gameMode === '4v4' || gameMode === '5v5' || gameMode === '6v6') return 'squad'
  if (gameMode === 'ffa') return 'ffa'
  return null
}

function eligibleStoredMatchCondition() {
  return sql`case
    when ${matches.draftData} is null then 1
    when not json_valid(${matches.draftData}) then 1
    when coalesce(json_extract(${matches.draftData}, '$.redDeath'), 0) = 1 then 0
    when coalesce(json_extract(${matches.draftData}, '$.civBlitz'), 0) = 1 then 0
    else 1
  end = 1`
}

function excludeTournamentMatchesCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${matches.id}
       or ${tournamentMatches.sessionId} = ${matches.id}
  )`
}

function formatPercent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}
