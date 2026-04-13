import type { Database } from '@civup/db'
import type { CompetitiveTier, GameMode } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { formatLeaderboardModeLabel, formatModeLabel, getLeader } from '@civup/game'
import { createRating, displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { projectLineupDisplayRating } from '../services/leaderboard/team-rating.ts'
import { getStoredGameModeContext } from '../services/match/draft-data.ts'
import { projectRankedTierForScore } from '../services/ranked/role-sync.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { formatDisplayRatingChange } from './rating-change.ts'

const TOP_LEADERS_LIMIT = 5
const RECENT_MATCH_GROUP_LIMIT = 4
const DISCORD_FIELD_LIMIT = 1024

type TeamStatsGameMode = '2v2' | '3v3' | '4v4' | '5v5' | '6v6'

interface TeamModeContext {
  gameMode: TeamStatsGameMode
  leaderboardMode: 'duo' | 'squad'
  fieldLabel: string
}

interface TeamParticipantRow {
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
  completedAt: number | null
  isOld: boolean
}

interface TeamMatchGroup {
  matchId: string
  completedAt: number | null
  rows: TeamParticipantRow[]
}

interface TeamRatingVisual {
  tier: CompetitiveTier | null
  roleId: string | null
  label: string | null
}

export async function teamCardEmbed(
  db: Database,
  kv: KVNamespace,
  guildId: string | null,
  playerIds: string[],
): Promise<Embed> {
  const uniquePlayerIds = [...new Set(playerIds)]
  const modeContext = resolveTeamModeContext(uniquePlayerIds.length)
  const [playerRows, ratingRows, displaySeason] = await Promise.all([
    db
      .select({ id: players.id, displayName: players.displayName, avatarUrl: players.avatarUrl })
      .from(players)
      .where(inArray(players.id, uniquePlayerIds)),
    db
      .select()
      .from(playerRatings)
      .where(and(
        inArray(playerRatings.playerId, uniquePlayerIds),
        eq(playerRatings.mode, modeContext.leaderboardMode),
      )),
    getDisplaySeason(db),
  ])

  const playerById = new Map(playerRows.map(player => [player.id, player]))
  const ratingByPlayerId = new Map(ratingRows.map(row => [row.playerId, row]))
  const lineupRatings: PlayerRating[] = uniquePlayerIds.map((playerId) => {
    const ratingRow = ratingByPlayerId.get(playerId)
    if (!ratingRow) return createRating(playerId)
    return { playerId, mu: ratingRow.mu, sigma: ratingRow.sigma }
  })

  const projectedRating = Math.round(projectLineupDisplayRating(lineupRatings))
  const visual = guildId
    ? await projectRankedTierForScore({ db, kv, guildId, mode: modeContext.leaderboardMode, score: projectedRating })
    : { tier: null, roleId: null, label: null }

  const conditions = [
    eq(matches.status, 'completed'),
    eq(matches.gameMode, modeContext.gameMode),
    inArray(matchParticipants.playerId, uniquePlayerIds),
  ]
  if (displaySeason?.id) conditions.push(eq(matches.seasonId, displaySeason.id))

  const participantRows = await db
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
      completedAt: matches.completedAt,
      isOld: matches.isOld,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(...conditions))
    .orderBy(desc(matches.completedAt), desc(matches.id))

  const commonMatches = buildCommonMatches(participantRows, uniquePlayerIds)
  const gamesPlayed = commonMatches.length
  const wins = commonMatches.filter(match => (match.rows[0]?.placement ?? null) === 1).length
  const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0
  const topLeaders = summarizeLeaderStats(commonMatches.flatMap(match => match.rows.map(row => ({
    civId: row.civId,
    placement: row.placement,
  })))).slice(0, TOP_LEADERS_LIMIT)
  const recentMatchesValue = buildRecentTeamMatchesValue(commonMatches.slice(0, RECENT_MATCH_GROUP_LIMIT))

  const embed = new Embed()
    .title('Stats')
    .description(buildTeamDescription(uniquePlayerIds, visual))
    .color(0xC8AA6E)

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []

  if (gamesPlayed === 0) {
    fields.push({
      name: 'Overview',
      value: 'No games played yet.',
      inline: false,
    })
  }
  else {
    fields.push({
      name: modeContext.fieldLabel,
      value: [
        `Rating: ${formatProjectedRating(visual, projectedRating)}`,
        `Games: ${gamesPlayed}`,
        `Wins: ${wins} (${winRate}%)`,
      ].join('\n'),
      inline: true,
    })
  }

  if (topLeaders.length > 0) {
    fields.push({
      name: 'Top Leaders',
      value: topLeaders.map(formatLeaderStatLine).join('\n'),
      inline: false,
    })
  }

  if (recentMatchesValue) {
    fields.push({
      name: 'Recent Matches',
      value: recentMatchesValue,
      inline: false,
    })
  }

  const footerText = uniquePlayerIds
    .map(playerId => playerById.get(playerId)?.displayName ?? `<@${playerId}>`)
    .join(' + ')
  embed.footer({
    text: footerText,
    icon_url: playerById.get(uniquePlayerIds[0] ?? '')?.avatarUrl ?? undefined,
  })
  embed.fields(...fields)

  return embed
}

function buildTeamDescription(playerIds: string[], visual: TeamRatingVisual): string {
  const parts = [playerIds.map(playerId => `<@${playerId}>`).join(' + ')]
  const roleMention = formatProjectedRoleMention(visual)
  if (roleMention) parts.push(roleMention)
  return parts.join(' - ')
}

function resolveTeamModeContext(playerCount: number): TeamModeContext {
  if (playerCount === 2) {
    return {
      gameMode: '2v2',
      leaderboardMode: 'duo',
      fieldLabel: formatLeaderboardModeLabel('duo', 'Duo'),
    }
  }
  if (playerCount === 3) {
    return {
      gameMode: '3v3',
      leaderboardMode: 'squad',
      fieldLabel: formatLeaderboardModeLabel('squad', 'Squad'),
    }
  }
  if (playerCount === 4) {
    return {
      gameMode: '4v4',
      leaderboardMode: 'squad',
      fieldLabel: formatLeaderboardModeLabel('squad', 'Squad'),
    }
  }
  if (playerCount === 5) {
    return {
      gameMode: '5v5',
      leaderboardMode: 'squad',
      fieldLabel: formatLeaderboardModeLabel('squad', 'Squad'),
    }
  }
  if (playerCount === 6) {
    return {
      gameMode: '6v6',
      leaderboardMode: 'squad',
      fieldLabel: formatLeaderboardModeLabel('squad', 'Squad'),
    }
  }
  throw new Error('Team stats require 2 to 6 players.')
}

function formatProjectedRating(visual: TeamRatingVisual, rating: number): string {
  if (visual.roleId) return `<@&${visual.roleId}> (${rating})`
  if (visual.label) return `${visual.label} (${rating})`
  return String(rating)
}

function formatProjectedRoleMention(visual: TeamRatingVisual): string | null {
  if (visual.roleId) return `<@&${visual.roleId}>`
  const label = visual.label?.trim()
  return label ? label : null
}

function buildCommonMatches(rows: TeamParticipantRow[], playerIds: string[]): TeamMatchGroup[] {
  const grouped = new Map<string, TeamMatchGroup>()

  for (const row of rows) {
    const current = grouped.get(row.matchId) ?? {
      matchId: row.matchId,
      completedAt: row.completedAt,
      rows: [],
    }
    current.rows.push(row)
    grouped.set(row.matchId, current)
  }

  return [...grouped.values()]
    .filter((match) => {
      if (match.rows.length !== playerIds.length) return false
      const team = match.rows[0]?.team
      if (team == null) return false
      if (!match.rows.every(row => row.team === team)) return false
      const rowIds = new Set(match.rows.map(row => row.playerId))
      return playerIds.every(playerId => rowIds.has(playerId))
    })
    .map(match => ({
      ...match,
      rows: playerIds.flatMap((playerId) => {
        const row = match.rows.find(candidate => candidate.playerId === playerId)
        return row ? [row] : []
      }),
    }))
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
}

function summarizeLeaderStats(rows: Array<{ civId: string | null, placement: number | null }>) {
  const byLeader = new Map<string, { civId: string, games: number, wins: number }>()

  for (const row of rows) {
    if (!row.civId) continue
    const entry = byLeader.get(row.civId) ?? { civId: row.civId, games: 0, wins: 0 }
    entry.games += 1
    if (row.placement === 1) entry.wins += 1
    byLeader.set(row.civId, entry)
  }

  return [...byLeader.values()]
    .sort((a, b) => {
      const gamesDiff = b.games - a.games
      if (gamesDiff !== 0) return gamesDiff

      const winsDiff = b.wins - a.wins
      if (winsDiff !== 0) return winsDiff

      return a.civId.localeCompare(b.civId)
    })
}

function formatLeaderStatLine(stat: { civId: string, games: number, wins: number }): string {
  const winRate = Math.round((stat.wins / stat.games) * 100)
  const ratio = `${stat.wins}/${stat.games}`.padStart(5, ' ')
  const pct = `${winRate}%`.padStart(4, ' ')
  return `\`${ratio} ${pct}\` ${formatLeaderName(stat.civId)}`
}

function buildRecentTeamMatchesValue(matches: TeamMatchGroup[]): string {
  const lines: string[] = []

  for (const match of matches) {
    const matchLines = match.rows.map((row, index) => formatRecentTeamMatchLine(row, index === 0))
    const nextValue = [...lines, ...matchLines].join('\n')
    if (nextValue.length > DISCORD_FIELD_LIMIT) break
    lines.push(...matchLines)
  }

  return lines.join('\n')
}

function formatRecentTeamMatchLine(match: TeamParticipantRow, includePlacement: boolean): string {
  const placement = includePlacement ? formatPlacementCode(match.placement) : formatBlankPlacementCode()
  const rating = formatRecentRatingChange(match)
  const modeLabel = formatRecentModeLabel(match.gameMode, match.draftData, match.isOld)
  const leader = formatRecentLeaderLabel(match.civId, match.isOld)
  return leader ? `${placement} ${rating} - ${modeLabel} ${leader}` : `${placement} ${rating} - ${modeLabel}`
}

function formatPlacementCode(placement: number | null): string {
  if (placement == null) return '`#? `'
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function formatBlankPlacementCode(): string {
  return `\`${''.padEnd(3, ' ')}\``
}

function formatRecentRatingChange(match: {
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}): string {
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
    return civId
  }
}

function formatRecentLeaderLabel(civId: string | null, isOld: boolean): string | null {
  if (!civId) return isOld ? null : formatLeaderName(civId)
  return formatLeaderName(civId)
}
