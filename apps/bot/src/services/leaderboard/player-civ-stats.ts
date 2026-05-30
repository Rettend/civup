import type { Database } from '@civup/db'
import type { SQL } from 'drizzle-orm'
import { matchParticipants, matchPlayerCivStatContributions, matches, playerCivStats, tournamentMatches } from '@civup/db'
import { redDeathLeaderMap } from '@civup/game'
import { and, eq, inArray, or, sql } from 'drizzle-orm'

export const PLAYER_CIV_MIN_RANK_GAMES = 3
export const PLAYER_CIV_SERVER_AVG_MIN_GAMES = 10

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
  playerWinRateRank: number | null
  playerGamesRank: number | null
}

interface PlayerCivStatContributionEntry {
  seasonId: string
  gameMode: string
  playerId: string
  civId: string
  picks: number
  wins: number
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
    })
    .from(playerCivStats)
    .where(and(...conditions))
    .groupBy(playerCivStats.playerId, playerCivStats.civId)

  const byCivId = new Map<string, PlayerCivStatSummary[]>()
  for (const row of rows) {
    const entries = byCivId.get(row.civId) ?? []
    entries.push({
      playerId: row.playerId,
      civId: row.civId,
      picks: normalizeCount(row.picks),
      wins: normalizeCount(row.wins),
    })
    byCivId.set(row.civId, entries)
  }

  return new Map(uniqueCivIds.map((civId) => {
    const entries = byCivId.get(civId) ?? []
    return [civId, summarizeRanking(civId, playerId, entries)]
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
  entries: PlayerCivStatSummary[],
): PlayerCivRankingSummary {
  const serverPicks = entries.reduce((sum, entry) => sum + entry.picks, 0)
  const serverWins = entries.reduce((sum, entry) => sum + entry.wins, 0)
  const playerEntry = entries.find(entry => entry.playerId === playerId) ?? null
  return {
    civId,
    serverPicks,
    serverWins,
    serverWinRatePct: serverPicks > 0 ? round((serverWins / serverPicks) * 100, 1) : null,
    playerWinRateRank: playerEntry && playerEntry.picks >= PLAYER_CIV_MIN_RANK_GAMES
      ? rankEntry(playerEntry, entries.filter(entry => entry.picks >= PLAYER_CIV_MIN_RANK_GAMES), compareByWinRate)
      : null,
    playerGamesRank: playerEntry
      ? rankEntry(playerEntry, entries, compareByGames)
      : null,
  }
}

function rankEntry(
  target: PlayerCivStatSummary,
  entries: PlayerCivStatSummary[],
  compare: (left: PlayerCivStatSummary, right: PlayerCivStatSummary) => number,
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
