import type { Database } from '@civup/db'
import type { SQL } from 'drizzle-orm'
import { matchParticipants, matchPlayerCivStatContributions, matches, playerCivStats, playerRatings, players, tournamentMatches } from '@civup/db'
import { redDeathLeaderMap } from '@civup/game'
import { DEFAULT_MU, DEFAULT_SIGMA, displayRating } from '@civup/rating'
import { and, eq, inArray, or, sql } from 'drizzle-orm'

export const PLAYER_CIV_MIN_RANK_GAMES = 5
export const PLAYER_CIV_SERVER_AVG_MIN_GAMES = 10
export const PLAYER_CIV_RANK_PRIOR_GAMES = 10

const GLOBAL_RATING_SCOPE = 'global'
const DEFAULT_GLOBAL_RATING = displayRating(DEFAULT_MU, DEFAULT_SIGMA)
const PLAYER_CIV_STRICT_RANK_PRIOR_GAMES = PLAYER_CIV_RANK_PRIOR_GAMES * 2
const PLAYER_CIV_RANK_GLOBAL_RATING_SCALE = 500
const PLAYER_CIV_RANK_GLOBAL_RATING_CAP = 0.2
const PLAYER_CIV_RANK_VOLUME_CAP = 0.02
const PLAYER_CIV_RANK_VOLUME_FULL_GAMES = 25

export interface PlayerCivStatsFilter {
  seasonId?: string | null
  mode?: string | null
}

export interface PlayerCivStatSummary {
  playerId: string
  civId: string
  picks: number
  wins: number
}

export interface PlayerCivRankingSummary {
  civId: string
  serverPicks: number
  serverWins: number
  serverWinRatePct: number | null
  playerAdjustedWinRatePct: number | null
  playerAdjustedWinRateRank: number | null
  playerWinRateRank: number | null
  playerGamesRank: number | null
}

export interface PlayerCivRankedPlayerSummary extends PlayerCivStatSummary {
  displayName: string | null
  adjustedWinRatePct: number
  adjustedWinRateRank: number
}

interface PlayerCivStatContributionEntry {
  seasonId: string
  gameMode: string
  playerId: string
  civId: string
  picks: number
  wins: number
}

interface PlayerCivRankEntry extends PlayerCivStatSummary {
  globalRating: number
}

interface MatchPlayerCivStatContribution {
  entries: PlayerCivStatContributionEntry[]
}

interface ParsedDraftData {
  redDeath?: unknown
  civBlitz?: unknown
}

const EMPTY_SEASON_ID = ''
const INSERT_CHUNK_SIZE = 100

export function playerCivStatsFilter(input: PlayerCivStatsFilter): { seasonId: string | null, mode: string | null } {
  return {
    seasonId: normalizeFilterPart(input.seasonId),
    mode: normalizeFilterPart(input.mode),
  }
}

export async function listPlayerCivStats(
  db: Database,
  filter: PlayerCivStatsFilter,
  playerId: string,
): Promise<PlayerCivStatSummary[]> {
  const conditions = buildPlayerCivStatConditions(filter, eq(playerCivStats.playerId, playerId))
  const rows = await db
    .select({
      civId: playerCivStats.civId,
      picks: sql<number>`sum(${playerCivStats.picks})`,
      wins: sql<number>`sum(${playerCivStats.wins})`,
    })
    .from(playerCivStats)
    .where(and(...conditions))
    .groupBy(playerCivStats.civId)

  return rows.map(row => ({
    playerId,
    civId: row.civId,
    picks: normalizeCount(row.picks),
    wins: normalizeCount(row.wins),
  }))
}

export async function loadPlayerCivRankingSummaries(
  db: Database,
  filter: PlayerCivStatsFilter,
  playerId: string,
  civIds: readonly string[],
): Promise<Map<string, PlayerCivRankingSummary>> {
  const uniqueCivIds = [...new Set(civIds)].filter(civId => civId.length > 0)
  if (uniqueCivIds.length === 0) return new Map()

  const conditions = buildPlayerCivStatConditions(filter, inArray(playerCivStats.civId, uniqueCivIds))
  const rows = await db
    .select({
      playerId: playerCivStats.playerId,
      civId: playerCivStats.civId,
      picks: sql<number>`sum(${playerCivStats.picks})`,
      wins: sql<number>`sum(${playerCivStats.wins})`,
      globalMu: sql<number | null>`max(${playerRatings.mu})`,
      globalSigma: sql<number | null>`max(${playerRatings.sigma})`,
    })
    .from(playerCivStats)
    .leftJoin(playerRatings, and(
      eq(playerRatings.playerId, playerCivStats.playerId),
      eq(playerRatings.mode, GLOBAL_RATING_SCOPE),
    ))
    .where(and(...conditions))
    .groupBy(playerCivStats.playerId, playerCivStats.civId)

  const byCivId = new Map<string, PlayerCivRankEntry[]>()
  for (const row of rows) {
    const entries = byCivId.get(row.civId) ?? []
    entries.push({
      playerId: row.playerId,
      civId: row.civId,
      picks: normalizeCount(row.picks),
      wins: normalizeCount(row.wins),
      globalRating: playerCivGlobalRating(row.globalMu, row.globalSigma),
    })
    byCivId.set(row.civId, entries)
  }

  return new Map(uniqueCivIds.map((civId) => {
    const entries = byCivId.get(civId) ?? []
    return [civId, summarizeRanking(civId, playerId, entries)]
  }))
}

export async function listTopPlayerCivRankings(
  db: Database,
  filter: PlayerCivStatsFilter,
  civId: string,
  limit: number,
): Promise<PlayerCivRankedPlayerSummary[]> {
  if (civId.length === 0 || limit <= 0) return []

  const conditions = buildPlayerCivStatConditions(filter, eq(playerCivStats.civId, civId))
  const rows = await db
    .select({
      playerId: playerCivStats.playerId,
      displayName: players.displayName,
      picks: sql<number>`sum(${playerCivStats.picks})`,
      wins: sql<number>`sum(${playerCivStats.wins})`,
      globalMu: sql<number | null>`max(${playerRatings.mu})`,
      globalSigma: sql<number | null>`max(${playerRatings.sigma})`,
    })
    .from(playerCivStats)
    .leftJoin(players, eq(players.id, playerCivStats.playerId))
    .leftJoin(playerRatings, and(
      eq(playerRatings.playerId, playerCivStats.playerId),
      eq(playerRatings.mode, GLOBAL_RATING_SCOPE),
    ))
    .where(and(...conditions))
    .groupBy(playerCivStats.playerId)

  const entries = rows.map(row => ({
    playerId: row.playerId,
    displayName: row.displayName,
    civId,
    picks: normalizeCount(row.picks),
    wins: normalizeCount(row.wins),
    globalRating: playerCivGlobalRating(row.globalMu, row.globalSigma),
  }))
  const serverPicks = entries.reduce((sum, entry) => sum + entry.picks, 0)
  const serverWins = entries.reduce((sum, entry) => sum + entry.wins, 0)
  if (serverPicks < PLAYER_CIV_SERVER_AVG_MIN_GAMES) return []

  const serverWinRate = serverWins / serverPicks
  return entries
    .filter(entry => entry.picks >= PLAYER_CIV_MIN_RANK_GAMES)
    .sort((left, right) => compareByLeaderRank(left, right, serverWinRate))
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry,
      adjustedWinRatePct: round(rankAdjustedWinRate(entry, serverWinRate) * 100, 1),
      adjustedWinRateRank: index + 1,
    }))
}

export async function reconcilePlayerCivStatMatchContribution(
  db: Database,
  matchId: string,
  updatedAt = Date.now(),
): Promise<void> {
  const [matchRaw] = await db
    .select({
      id: matches.id,
      status: matches.status,
      draftData: matches.draftData,
      gameMode: matches.gameMode,
      seasonId: matches.seasonId,
      tournamentSessionId: tournamentMatches.sessionId,
    })
    .from(matches)
    .leftJoin(tournamentMatches, or(eq(tournamentMatches.matchId, matches.id), eq(tournamentMatches.sessionId, matches.id)))
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!matchRaw || matchRaw.tournamentSessionId != null || matchRaw.status !== 'completed') {
    await replacePlayerCivStatMatchContribution(db, matchId, { entries: [] }, updatedAt)
    return
  }

  const participants = await db
    .select({
      playerId: matchParticipants.playerId,
      civId: matchParticipants.civId,
      placement: matchParticipants.placement,
    })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  await reconcilePlayerCivStatMatchContributionFromRows(db, matchRaw, participants, { updatedAt })
}

export async function reconcilePlayerCivStatMatchContributionFromRows(
  db: Database,
  match: { id: string, status?: string | null, draftData: string | null, gameMode: string, seasonId: string | null },
  participants: readonly { playerId: string, civId: string | null, placement: number | null }[],
  options: { updatedAt?: number, previous?: 'load' | 'empty' } = {},
): Promise<void> {
  const updatedAt = options.updatedAt ?? Date.now()
  const next = match.status != null && match.status !== 'completed'
    ? { entries: [] }
    : buildMatchPlayerCivStatContribution(match, participants)
  await replacePlayerCivStatMatchContribution(db, match.id, next, updatedAt, options.previous ?? 'load')
}

export async function removePlayerCivStatMatchContribution(
  db: Database,
  matchId: string,
  updatedAt = Date.now(),
): Promise<void> {
  await replacePlayerCivStatMatchContribution(db, matchId, { entries: [] }, updatedAt)
}

export async function backfillPlayerCivStatsFromHistory(
  db: Database,
  updatedAt = Date.now(),
): Promise<{ scannedCompletedMatchCount: number, scannedParticipantRowCount: number, contributionRowCount: number, aggregateRowCount: number }> {
  const [matchRows, participantRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        draftData: matches.draftData,
        gameMode: matches.gameMode,
        seasonId: matches.seasonId,
      })
      .from(matches)
      .where(and(eq(matches.status, 'completed'), excludeTournamentMatchesCondition())),
    db
      .select({
        matchId: matchParticipants.matchId,
        playerId: matchParticipants.playerId,
        civId: matchParticipants.civId,
        placement: matchParticipants.placement,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(eq(matches.status, 'completed'), excludeTournamentMatchesCondition())),
  ])

  const participantsByMatchId = new Map<string, Array<{ playerId: string, civId: string | null, placement: number | null }>>()
  for (const row of participantRows) {
    const rows = participantsByMatchId.get(row.matchId) ?? []
    rows.push({ playerId: row.playerId, civId: row.civId, placement: row.placement })
    participantsByMatchId.set(row.matchId, rows)
  }

  const aggregateByKey = new Map<string, PlayerCivStatContributionEntry>()
  const contributionRows: Array<typeof matchPlayerCivStatContributions.$inferInsert> = []

  for (const match of matchRows) {
    const contribution = buildMatchPlayerCivStatContribution(match, participantsByMatchId.get(match.id) ?? [])
    addPlayerCivContributionToAggregates(aggregateByKey, contribution.entries)

    if (contribution.entries.length > 0) {
      contributionRows.push({
        matchId: match.id,
        contributionsJson: serializeContributionEntries(contribution.entries),
        updatedAt,
      })
    }
  }

  await db.delete(matchPlayerCivStatContributions)
  await db.delete(playerCivStats)

  for (let index = 0; index < contributionRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = contributionRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) await db.insert(matchPlayerCivStatContributions).values(chunk)
  }

  const aggregateRows = [...aggregateByKey.values()].filter(entry => entry.picks > 0 || entry.wins > 0)
  for (let index = 0; index < aggregateRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = aggregateRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) {
      await db.insert(playerCivStats).values(chunk.map(entry => ({
        seasonId: entry.seasonId,
        gameMode: entry.gameMode,
        playerId: entry.playerId,
        civId: entry.civId,
        picks: entry.picks,
        wins: entry.wins,
        updatedAt,
      })))
    }
  }

  return {
    scannedCompletedMatchCount: matchRows.length,
    scannedParticipantRowCount: participantRows.length,
    contributionRowCount: contributionRows.length,
    aggregateRowCount: aggregateRows.length,
  }
}

async function replacePlayerCivStatMatchContribution(
  db: Database,
  matchId: string,
  next: MatchPlayerCivStatContribution,
  updatedAt: number,
  previousMode: 'load' | 'empty' = 'load',
): Promise<void> {
  const previous = previousMode === 'empty'
    ? { entries: [] }
    : await getPlayerCivStatMatchContribution(db, matchId)

  if (next.entries.length > 0) {
    const contributionsJson = serializeContributionEntries(next.entries)
    await db
      .insert(matchPlayerCivStatContributions)
      .values({ matchId, contributionsJson, updatedAt })
      .onConflictDoUpdate({
        target: matchPlayerCivStatContributions.matchId,
        set: { contributionsJson, updatedAt },
      })
    await applyPlayerCivStatAggregateDelta(db, previous, next, updatedAt)
    return
  }

  await db.delete(matchPlayerCivStatContributions).where(eq(matchPlayerCivStatContributions.matchId, matchId))
  await applyPlayerCivStatAggregateDelta(db, previous, next, updatedAt)
}

async function getPlayerCivStatMatchContribution(
  db: Database,
  matchId: string,
): Promise<MatchPlayerCivStatContribution> {
  const [row] = await db
    .select({ contributionsJson: matchPlayerCivStatContributions.contributionsJson })
    .from(matchPlayerCivStatContributions)
    .where(eq(matchPlayerCivStatContributions.matchId, matchId))
    .limit(1)

  return row ? { entries: parseContributionEntries(row.contributionsJson) } : { entries: [] }
}

async function applyPlayerCivStatAggregateDelta(
  db: Database,
  previous: MatchPlayerCivStatContribution,
  next: MatchPlayerCivStatContribution,
  updatedAt: number,
): Promise<void> {
  const deltas = diffContributionEntries(previous.entries, next.entries)
  if (deltas.length === 0) return

  for (const chunk of chunkArray(deltas, INSERT_CHUNK_SIZE)) {
    await db
      .insert(playerCivStats)
      .values(chunk.map(delta => ({
        seasonId: delta.seasonId,
        gameMode: delta.gameMode,
        playerId: delta.playerId,
        civId: delta.civId,
        picks: delta.picks,
        wins: delta.wins,
        updatedAt,
      })))
      .onConflictDoUpdate({
        target: [playerCivStats.seasonId, playerCivStats.gameMode, playerCivStats.playerId, playerCivStats.civId],
        set: {
          picks: sql<number>`max(0, ${playerCivStats.picks} + excluded.picks)`,
          wins: sql<number>`max(0, ${playerCivStats.wins} + excluded.wins)`,
          updatedAt,
        },
      })
  }

  const affectedSeasonIds = [...new Set(deltas.map(delta => delta.seasonId))]
  const affectedModes = [...new Set(deltas.map(delta => delta.gameMode))]
  const affectedCivIds = [...new Set(deltas.map(delta => delta.civId))]
  await db
    .delete(playerCivStats)
    .where(and(
      inArray(playerCivStats.seasonId, affectedSeasonIds),
      inArray(playerCivStats.gameMode, affectedModes),
      inArray(playerCivStats.civId, affectedCivIds),
      sql`${playerCivStats.picks} <= 0 and ${playerCivStats.wins} <= 0`,
    ))
}

function buildMatchPlayerCivStatContribution(
  match: { draftData: string | null, gameMode: string, seasonId: string | null },
  participants: readonly { playerId: string, civId: string | null, placement: number | null }[],
): MatchPlayerCivStatContribution {
  if (isRedDeathMatch(match.draftData) || isCivBlitzMatch(match.draftData)) return { entries: [] }

  const aggregateByKey = new Map<string, PlayerCivStatContributionEntry>()
  for (const participant of participants) {
    if (!participant.civId || isRedDeathFaction(participant.civId)) continue

    const seasonId = normalizeSeasonId(match.seasonId)
    const key = contributionKey(seasonId, match.gameMode, participant.playerId, participant.civId)
    const aggregate = aggregateByKey.get(key) ?? {
      seasonId,
      gameMode: match.gameMode,
      playerId: participant.playerId,
      civId: participant.civId,
      picks: 0,
      wins: 0,
    }
    aggregate.picks += 1
    if (participant.placement === 1) aggregate.wins += 1
    aggregateByKey.set(key, aggregate)
  }

  return {
    entries: [...aggregateByKey.values()]
      .filter(entry => entry.picks > 0 || entry.wins > 0)
      .sort(compareContributionEntries),
  }
}

function summarizeRanking(
  civId: string,
  playerId: string,
  entries: PlayerCivRankEntry[],
): PlayerCivRankingSummary {
  const serverPicks = entries.reduce((sum, entry) => sum + entry.picks, 0)
  const serverWins = entries.reduce((sum, entry) => sum + entry.wins, 0)
  const playerEntry = entries.find(entry => entry.playerId === playerId) ?? null
  const serverWinRate = serverPicks > 0 ? serverWins / serverPicks : null
  const adjustedEligibleEntries = serverWinRate == null || serverPicks < PLAYER_CIV_SERVER_AVG_MIN_GAMES
    ? []
    : entries.filter(entry => entry.picks >= PLAYER_CIV_MIN_RANK_GAMES)
  return {
    civId,
    serverPicks,
    serverWins,
    serverWinRatePct: serverPicks > 0 ? round((serverWins / serverPicks) * 100, 1) : null,
    playerAdjustedWinRatePct: playerEntry && serverWinRate != null && serverPicks >= PLAYER_CIV_SERVER_AVG_MIN_GAMES && playerEntry.picks >= PLAYER_CIV_MIN_RANK_GAMES
      ? round(rankAdjustedWinRate(playerEntry, serverWinRate) * 100, 1)
      : null,
    playerAdjustedWinRateRank: playerEntry && serverWinRate != null && serverPicks >= PLAYER_CIV_SERVER_AVG_MIN_GAMES && playerEntry.picks >= PLAYER_CIV_MIN_RANK_GAMES
      ? rankEntry(playerEntry, adjustedEligibleEntries, (left, right) => compareByLeaderRank(left, right, serverWinRate))
      : null,
    playerWinRateRank: playerEntry && playerEntry.picks >= PLAYER_CIV_MIN_RANK_GAMES
      ? rankEntry(playerEntry, entries.filter(entry => entry.picks >= PLAYER_CIV_MIN_RANK_GAMES), compareByWinRate)
      : null,
    playerGamesRank: playerEntry
      ? rankByGamesPlayed(playerEntry, entries)
      : null,
  }
}

function rankByGamesPlayed<T extends PlayerCivStatSummary>(target: T, entries: T[]): number {
  return entries.reduce((rank, entry) => rank + (entry.picks > target.picks ? 1 : 0), 1)
}

function rankEntry<T extends PlayerCivStatSummary>(
  target: T,
  entries: T[],
  compare: (left: T, right: T) => number,
): number | null {
  const sorted = [...entries].sort(compare)
  const index = sorted.findIndex(entry => entry.playerId === target.playerId)
  return index >= 0 ? index + 1 : null
}

function compareByWinRate(left: PlayerCivStatSummary, right: PlayerCivStatSummary): number {
  const winRateDiff = (right.wins * left.picks) - (left.wins * right.picks)
  if (winRateDiff !== 0) return winRateDiff
  return compareByGames(left, right)
}

function compareByLeaderRank(left: PlayerCivRankEntry, right: PlayerCivRankEntry, serverWinRate: number): number {
  const scoreDiff = leaderRankScore(right, serverWinRate) - leaderRankScore(left, serverWinRate)
  if (scoreDiff !== 0) return scoreDiff

  const adjustedDiff = rankAdjustedWinRate(right, serverWinRate) - rankAdjustedWinRate(left, serverWinRate)
  if (adjustedDiff !== 0) return adjustedDiff

  const ratingDiff = right.globalRating - left.globalRating
  if (ratingDiff !== 0) return ratingDiff

  return compareByGames(left, right)
}

function leaderRankScore(entry: PlayerCivRankEntry, serverWinRate: number): number {
  return rankAdjustedWinRate(entry, serverWinRate)
    + (rankConfidence(entry) * globalRatingBonus(entry.globalRating))
    + volumeBonus(entry.picks)
}

function rankAdjustedWinRate(entry: PlayerCivStatSummary, serverWinRate: number): number {
  return (entry.wins + (serverWinRate * PLAYER_CIV_STRICT_RANK_PRIOR_GAMES)) / (entry.picks + PLAYER_CIV_STRICT_RANK_PRIOR_GAMES)
}

function rankConfidence(entry: PlayerCivStatSummary): number {
  return entry.picks / (entry.picks + PLAYER_CIV_STRICT_RANK_PRIOR_GAMES)
}

function globalRatingBonus(globalRating: number): number {
  return clamp(
    ((globalRating - DEFAULT_GLOBAL_RATING) / PLAYER_CIV_RANK_GLOBAL_RATING_SCALE) * PLAYER_CIV_RANK_GLOBAL_RATING_CAP,
    -PLAYER_CIV_RANK_GLOBAL_RATING_CAP,
    PLAYER_CIV_RANK_GLOBAL_RATING_CAP,
  )
}

function volumeBonus(picks: number): number {
  return Math.min(Math.log1p(picks) / Math.log1p(PLAYER_CIV_RANK_VOLUME_FULL_GAMES), 1) * PLAYER_CIV_RANK_VOLUME_CAP
}

function playerCivGlobalRating(mu: number | null, sigma: number | null): number {
  return displayRating(mu ?? DEFAULT_MU, sigma ?? DEFAULT_SIGMA)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function compareByGames(left: PlayerCivStatSummary, right: PlayerCivStatSummary): number {
  const picksDiff = right.picks - left.picks
  if (picksDiff !== 0) return picksDiff

  const winsDiff = right.wins - left.wins
  if (winsDiff !== 0) return winsDiff

  return left.playerId.localeCompare(right.playerId)
}

function excludeTournamentMatchesCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${matches.id}
       or ${tournamentMatches.sessionId} = ${matches.id}
  )`
}

function buildPlayerCivStatConditions(filter: PlayerCivStatsFilter, ...extraConditions: SQL[]): SQL[] {
  const normalized = playerCivStatsFilter(filter)
  return [
    ...extraConditions,
    ...(normalized.seasonId ? [eq(playerCivStats.seasonId, normalized.seasonId)] : []),
    ...(normalized.mode ? [eq(playerCivStats.gameMode, normalized.mode)] : []),
  ]
}

function addPlayerCivContributionToAggregates(
  aggregateByKey: Map<string, PlayerCivStatContributionEntry>,
  entries: readonly PlayerCivStatContributionEntry[],
): void {
  for (const entry of entries) {
    const key = contributionKey(entry.seasonId, entry.gameMode, entry.playerId, entry.civId)
    const aggregate = aggregateByKey.get(key) ?? { ...entry, picks: 0, wins: 0 }
    aggregate.picks += entry.picks
    aggregate.wins += entry.wins
    aggregateByKey.set(key, aggregate)
  }
}

function diffContributionEntries(
  previous: readonly PlayerCivStatContributionEntry[],
  next: readonly PlayerCivStatContributionEntry[],
): PlayerCivStatContributionEntry[] {
  const deltas = new Map<string, PlayerCivStatContributionEntry>()
  for (const entry of previous) {
    deltas.set(contributionKey(entry.seasonId, entry.gameMode, entry.playerId, entry.civId), {
      seasonId: entry.seasonId,
      gameMode: entry.gameMode,
      playerId: entry.playerId,
      civId: entry.civId,
      picks: -normalizeCount(entry.picks),
      wins: -normalizeCount(entry.wins),
    })
  }

  for (const entry of next) {
    const key = contributionKey(entry.seasonId, entry.gameMode, entry.playerId, entry.civId)
    const delta = deltas.get(key) ?? {
      seasonId: entry.seasonId,
      gameMode: entry.gameMode,
      playerId: entry.playerId,
      civId: entry.civId,
      picks: 0,
      wins: 0,
    }
    delta.picks += normalizeCount(entry.picks)
    delta.wins += normalizeCount(entry.wins)
    deltas.set(key, delta)
  }

  return [...deltas.values()]
    .filter(entry => entry.picks !== 0 || entry.wins !== 0)
    .sort(compareContributionEntries)
}

function serializeContributionEntries(entries: readonly PlayerCivStatContributionEntry[]): string {
  return JSON.stringify(entries
    .filter(entry => entry.picks > 0 || entry.wins > 0)
    .map(entry => ({
      seasonId: entry.seasonId,
      gameMode: entry.gameMode,
      playerId: entry.playerId,
      civId: entry.civId,
      picks: normalizeCount(entry.picks),
      wins: normalizeCount(entry.wins),
    }))
    .sort(compareContributionEntries))
}

function parseContributionEntries(raw: string): PlayerCivStatContributionEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<PlayerCivStatContributionEntry>
      if (typeof candidate.gameMode !== 'string' || candidate.gameMode.length === 0) return []
      if (typeof candidate.playerId !== 'string' || candidate.playerId.length === 0) return []
      if (typeof candidate.civId !== 'string' || candidate.civId.length === 0) return []
      const normalized = {
        seasonId: normalizeSeasonId(candidate.seasonId),
        gameMode: candidate.gameMode,
        playerId: candidate.playerId,
        civId: candidate.civId,
        picks: normalizeCount(candidate.picks),
        wins: normalizeCount(candidate.wins),
      }
      return normalized.picks === 0 && normalized.wins === 0 ? [] : [normalized]
    })
  }
  catch {
    return []
  }
}

function contributionKey(seasonId: string, gameMode: string, playerId: string, civId: string): string {
  return `${seasonId}\0${gameMode}\0${playerId}\0${civId}`
}

function compareContributionEntries(left: PlayerCivStatContributionEntry, right: PlayerCivStatContributionEntry): number {
  const seasonDiff = left.seasonId.localeCompare(right.seasonId)
  if (seasonDiff !== 0) return seasonDiff

  const modeDiff = left.gameMode.localeCompare(right.gameMode)
  if (modeDiff !== 0) return modeDiff

  const playerDiff = left.playerId.localeCompare(right.playerId)
  if (playerDiff !== 0) return playerDiff

  return left.civId.localeCompare(right.civId)
}

function isRedDeathFaction(civId: string): boolean {
  return redDeathLeaderMap.has(civId)
}

function isRedDeathMatch(draftData: string | null): boolean {
  return parseDraftData(draftData)?.redDeath === true
}

function isCivBlitzMatch(draftData: string | null): boolean {
  return parseDraftData(draftData)?.civBlitz === true
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    const parsed: unknown = JSON.parse(draftData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ParsedDraftData
  }
  catch {
    return null
  }
}

function normalizeFilterPart(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizeSeasonId(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : EMPTY_SEASON_ID
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
