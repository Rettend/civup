import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, RatingUpdate, TeamInput } from '@civup/rating'
import type { DbBatchItem } from '../db/batch.ts'
import type { StatsContext } from '../stats/context.ts'
import { matches, matchParticipants, playerRatingEvents as legacyPlayerRatingEvents, playerRatings as legacyPlayerRatings, scopedPlayerRatingEvents as playerRatingEvents, scopedPlayerRatings as playerRatings, seasons, tournamentMatches } from '@civup/db'
import { GAME_MODES, isTeamMode, leaderboardModesToGameModes } from '@civup/game'
import { calculateRatings, createRating, displayRating, getLeaderboardMinGames, IMPORTED_GAME_EFFECTIVE_WEIGHT, seasonReset } from '@civup/rating'
import { and, asc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { runDbBatch } from '../db/batch.ts'
import { getStoredGameModeContext } from './draft-data.ts'
import { buildPermanentAllyFfaEffectiveRows, calculatePermanentAllyFfaRatingUpdates } from './permanent-ally.ts'

interface LeaderboardSnapshotRow {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
}

interface StoredSeasonRow {
  id: string
  startsAt: number
  softReset: boolean
}

interface StoredMatchRow {
  id: string
  gameMode: string
  draftData: string | null
  isOld: boolean
  createdAt: number
  completedAt: number | null
}

interface StoredParticipantRow {
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

interface HistoricalRatingEventRow {
  matchId: string
  matchCreatedAt: number
  matchCompletedAt: number | null
  playerId: string
  ratingAfterMu: number
  ratingAfterSigma: number
  gamesDelta: number
  winsDelta: number
  importedGamesDelta: number
  effectiveGamesDelta: number
  winsVsTier1Delta: number
  winsVsTier2PlusDelta: number
  effectiveWinsVsTier1Delta: number
  effectiveWinsVsTier2PlusDelta: number
}

interface RatingState {
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
  lastPlayedAt: number | null
}

interface SeasonProgress {
  value: number
}

interface RecalculateLeaderboardModeOptions {
  fromMatchId?: string
  includeFromMatch?: boolean
  includeActiveBoundary?: boolean
  extraAffectedPlayerIds?: readonly string[]
}

interface RecalculateGlobalRatingsOptions extends RecalculateLeaderboardModeOptions {
  opponentTierByPlayerId?: ReadonlyMap<string, string>
}

const MISSING_RATING_SNAPSHOTS_MESSAGE = 'has missing rating snapshots'
const GLOBAL_RATING_SCOPE = 'global'
const D1_SAFE_IN_LIST_CHUNK_SIZE = 80
const REPLAY_WRITE_BATCH_SIZE = 100

type RatingScope = LeaderboardMode | typeof GLOBAL_RATING_SCOPE

export function buildRankByPlayer(rows: LeaderboardSnapshotRow[], mode: LeaderboardMode): Map<string, number> {
  const ranked = rows
    .filter(row => row.gamesPlayed >= getLeaderboardMinGames(mode))
    .map(row => ({
      playerId: row.playerId,
      display: displayRating(row.mu, row.sigma),
    }))
    .sort((a, b) => b.display - a.display)

  return new Map(ranked.map((row, index) => [row.playerId, index + 1]))
}

export async function recalculateLeaderboardMode(
  db: Database,
  leaderboardMode: LeaderboardMode,
  statsContext: StatsContext,
  options: RecalculateLeaderboardModeOptions = {},
): Promise<{ matchIds: string[] } | { error: string }> {
  const gameModes = leaderboardModesToGameModes(leaderboardMode)
  const seasonRows = await db
    .select({
      id: seasons.id,
      startsAt: seasons.startsAt,
      softReset: seasons.softReset,
    })
    .from(seasons)
    .orderBy(asc(seasons.startsAt), asc(seasons.id))
  const applicableSeasonRows = statsContext.seasonPolicy === 'ppl-seasons' ? seasonRows : []

  if (options.fromMatchId) {
    return recalculateLeaderboardModeFromBoundary(
      db,
      leaderboardMode,
      gameModes,
      applicableSeasonRows,
      statsContext,
      options.fromMatchId,
      options.includeFromMatch ?? true,
      options.includeActiveBoundary ?? false,
      [],
      options.extraAffectedPlayerIds ?? [],
    )
  }

  return recalculateLeaderboardModeFromScratch(db, leaderboardMode, gameModes, applicableSeasonRows, statsContext)
}

export async function recalculateGlobalRatings(
  db: Database,
  statsContext: StatsContext,
  options: RecalculateGlobalRatingsOptions = {},
): Promise<{ matchIds: string[] } | { error: string }> {
  const seasonRows = await db
    .select({
      id: seasons.id,
      startsAt: seasons.startsAt,
      softReset: seasons.softReset,
    })
    .from(seasons)
    .orderBy(asc(seasons.startsAt), asc(seasons.id))
  const applicableSeasonRows = statsContext.seasonPolicy === 'ppl-seasons' ? seasonRows : []

  if (options.fromMatchId) {
    return recalculateGlobalRatingsFromBoundary(
      db,
      applicableSeasonRows,
      statsContext,
      options.fromMatchId,
      options.includeFromMatch ?? true,
      options.includeActiveBoundary ?? false,
      options.opponentTierByPlayerId ?? new Map(),
      [],
      options.extraAffectedPlayerIds ?? [],
    )
  }

  return recalculateGlobalRatingsFromScratch(db, applicableSeasonRows, statsContext, options.opponentTierByPlayerId ?? new Map())
}

async function recalculateGlobalRatingsFromScratch(
  db: Database,
  seasonRows: StoredSeasonRow[],
  statsContext: StatsContext,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
): Promise<{ matchIds: string[] } | { error: string }> {
  const completedMatches = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
      isOld: matches.isOld,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(
      eq(matches.status, 'completed'),
      eq(matches.guildId, statsContext.guildId),
      inArray(matches.gameMode, [...GAME_MODES]),
      excludeTournamentMatchesCondition(),
    ))
    .orderBy(asc(matches.createdAt), asc(matches.id))

  const allParticipantRows = completedMatches.length > 0
    ? await db
        .select({
          matchId: matchParticipants.matchId,
          playerId: matchParticipants.playerId,
          team: matchParticipants.team,
          civId: matchParticipants.civId,
          placement: matchParticipants.placement,
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
          ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
          ratingAfterMu: matchParticipants.ratingAfterMu,
          ratingAfterSigma: matchParticipants.ratingAfterSigma,
        })
        .from(matchParticipants)
        .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
        .where(and(
          eq(matches.status, 'completed'),
          eq(matches.guildId, statsContext.guildId),
          inArray(matches.gameMode, [...GAME_MODES]),
          excludeTournamentMatchesCondition(),
        ))
    : []

  const { ratingStateByPlayer } = createReplayStates()
  const seasonProgress: SeasonProgress = { value: 0 }
  const participantsByMatchId = buildParticipantsByMatchId(allParticipantRows)
  const replayWriteQueries: DbBatchItem[] = []

  for (const match of completedMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, statsContext, null, match, participantRows, ratingStateByPlayer, {
      writeParticipantSnapshots: false,
      opponentTierByPlayerId,
      writeQueries: replayWriteQueries,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await db.delete(playerRatingEvents).where(and(eq(playerRatingEvents.statsKey, statsContext.statsKey), eq(playerRatingEvents.mode, GLOBAL_RATING_SCOPE)))
  if (statsContext.seasonPolicy === 'ppl-seasons') await db.delete(legacyPlayerRatingEvents).where(eq(legacyPlayerRatingEvents.mode, GLOBAL_RATING_SCOPE))
  await flushReplayWriteQueries(db, replayWriteQueries)
  await replacePlayerRatings(db, statsContext, GLOBAL_RATING_SCOPE, ratingStateByPlayer)

  return { matchIds: completedMatches.map(match => match.id) }
}

async function recalculateGlobalRatingsFromBoundary(
  db: Database,
  seasonRows: StoredSeasonRow[],
  statsContext: StatsContext,
  fromMatchId: string,
  includeFromMatch: boolean,
  includeActiveBoundary: boolean,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  extraReplayMatches: StoredMatchRow[] = [],
  extraAffectedPlayerIds: readonly string[] = [],
): Promise<{ matchIds: string[] } | { error: string }> {
  const [boundaryMatch] = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
      isOld: matches.isOld,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(eq(matches.id, fromMatchId), eq(matches.guildId, statsContext.guildId)))
    .limit(1)

  if (!boundaryMatch) return { error: `Match **${fromMatchId}** not found.` }

  const boundaryContext = getStoredGameModeContext(boundaryMatch.gameMode, boundaryMatch.draftData)
  if (!boundaryContext) return { error: `Match **${boundaryMatch.id}** has unsupported game mode: ${boundaryMatch.gameMode}.` }
  if (boundaryContext.leaderboardMode == null) return { matchIds: [] }

  const extraReplayMatchIds = extraReplayMatches.map(match => match.id)
  const boundaryReplayCondition = includeActiveBoundary
    ? or(
        and(
          eq(matches.status, 'completed'),
          buildBoundaryCondition(boundaryMatch, includeFromMatch, 'after'),
        ),
        eq(matches.id, fromMatchId),
      )
    : and(
        eq(matches.status, 'completed'),
        buildBoundaryCondition(boundaryMatch, includeFromMatch, 'after'),
      )
  const replayCondition = extraReplayMatchIds.length > 0
    ? or(boundaryReplayCondition, inArray(matches.id, extraReplayMatchIds))
    : boundaryReplayCondition

  const [boundaryParticipants, replayMatches] = await Promise.all([
    db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, fromMatchId)),
    db
      .select({
        id: matches.id,
        gameMode: matches.gameMode,
        draftData: matches.draftData,
        isOld: matches.isOld,
        createdAt: matches.createdAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(
        inArray(matches.gameMode, [...GAME_MODES]),
        eq(matches.guildId, statsContext.guildId),
        replayCondition,
        excludeTournamentMatchesCondition(),
      ))
      .orderBy(asc(matches.createdAt), asc(matches.id)),
  ])

  const replayParticipantRows = await listReplayParticipantRows(db, replayMatches.map(match => match.id))

  const affectedPlayerIds = [...new Set([
    ...boundaryParticipants.map(participant => participant.playerId),
    ...replayParticipantRows.map(participant => participant.playerId),
    ...extraAffectedPlayerIds,
  ])].sort((a, b) => a.localeCompare(b))

  const earlierEventRows = await listEarlierRatingEventRows(db, statsContext, GLOBAL_RATING_SCOPE, affectedPlayerIds, boundaryMatch)

  const { ratingStateByPlayer } = createReplayStates(affectedPlayerIds)
  const seasonProgress: SeasonProgress = { value: 0 }
  const hydrateResult = hydrateRatingStateFromEventsUntilBoundary(
    ratingStateByPlayer,
    seasonRows,
    seasonProgress,
    earlierEventRows,
    boundaryMatch.createdAt,
  )
  if (typeof hydrateResult === 'string' && isMissingRatingSnapshotsError(hydrateResult)) {
    const missingSnapshotMatchId = parseMissingRatingSnapshotMatchId(hydrateResult)
    if (!missingSnapshotMatchId) return { error: hydrateResult }
    return recalculateGlobalRatingsFromBoundary(
      db,
      seasonRows,
      statsContext,
      missingSnapshotMatchId,
      true,
      false,
      opponentTierByPlayerId,
      includeActiveBoundary ? [boundaryMatch, ...extraReplayMatches] : extraReplayMatches,
      extraAffectedPlayerIds,
    )
  }
  if (typeof hydrateResult === 'string') return { error: hydrateResult }

  const participantsByMatchId = buildParticipantsByMatchId(replayParticipantRows)
  const replayWriteQueries: DbBatchItem[] = []
  for (const match of replayMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, statsContext, null, match, participantRows, ratingStateByPlayer, {
      writeParticipantSnapshots: false,
      opponentTierByPlayerId,
      writeQueries: replayWriteQueries,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await deleteRatingEventsFromBoundary(db, statsContext, GLOBAL_RATING_SCOPE, boundaryMatch, affectedPlayerIds, includeFromMatch)
  await flushReplayWriteQueries(db, replayWriteQueries)
  await replacePlayerRatings(db, statsContext, GLOBAL_RATING_SCOPE, ratingStateByPlayer, affectedPlayerIds)

  return { matchIds: replayMatches.map(match => match.id) }
}

async function recalculateLeaderboardModeFromScratch(
  db: Database,
  leaderboardMode: LeaderboardMode,
  gameModes: readonly string[],
  seasonRows: StoredSeasonRow[],
  statsContext: StatsContext,
): Promise<{ matchIds: string[] } | { error: string }> {
  const completedMatchCandidates = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
      isOld: matches.isOld,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(
      eq(matches.status, 'completed'),
      eq(matches.guildId, statsContext.guildId),
      inArray(matches.gameMode, gameModes),
      excludeTournamentMatchesCondition(),
    ))
    .orderBy(asc(matches.createdAt), asc(matches.id))

  const completedMatches = completedMatchCandidates.filter(match => matchBelongsToLeaderboard(match, leaderboardMode))
  const allParticipantRows = await listReplayParticipantRows(db, completedMatches.map(match => match.id))

  const { ratingStateByPlayer } = createReplayStates()
  const seasonProgress: SeasonProgress = { value: 0 }
  const participantsByMatchId = buildParticipantsByMatchId(allParticipantRows)
  const replayWriteQueries: DbBatchItem[] = []

  for (const match of completedMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, statsContext, leaderboardMode, match, participantRows, ratingStateByPlayer, {
      writeQueries: replayWriteQueries,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await db.delete(playerRatingEvents).where(and(eq(playerRatingEvents.statsKey, statsContext.statsKey), eq(playerRatingEvents.mode, leaderboardMode)))
  if (statsContext.seasonPolicy === 'ppl-seasons') await db.delete(legacyPlayerRatingEvents).where(eq(legacyPlayerRatingEvents.mode, leaderboardMode))
  await flushReplayWriteQueries(db, replayWriteQueries)
  await replacePlayerRatings(db, statsContext, leaderboardMode, ratingStateByPlayer)

  return { matchIds: completedMatches.map(match => match.id) }
}

async function recalculateLeaderboardModeFromBoundary(
  db: Database,
  leaderboardMode: LeaderboardMode,
  gameModes: readonly string[],
  seasonRows: StoredSeasonRow[],
  statsContext: StatsContext,
  fromMatchId: string,
  includeFromMatch: boolean,
  includeActiveBoundary: boolean,
  extraReplayMatches: StoredMatchRow[] = [],
  extraAffectedPlayerIds: readonly string[] = [],
): Promise<{ matchIds: string[] } | { error: string }> {
  const [boundaryMatch] = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
      isOld: matches.isOld,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(eq(matches.id, fromMatchId), eq(matches.guildId, statsContext.guildId)))
    .limit(1)

  if (!boundaryMatch) return { error: `Match **${fromMatchId}** not found.` }

  const boundaryContext = getStoredGameModeContext(boundaryMatch.gameMode, boundaryMatch.draftData)
  if (!boundaryContext) return { error: `Match **${boundaryMatch.id}** has unsupported game mode: ${boundaryMatch.gameMode}.` }
  if (boundaryContext.leaderboardMode !== leaderboardMode) {
    return { error: `Match **${boundaryMatch.id}** does not belong to the **${leaderboardMode}** leaderboard.` }
  }

  const extraReplayMatchIds = extraReplayMatches.map(match => match.id)
  const boundaryReplayCondition = includeActiveBoundary
    ? or(
        and(
          eq(matches.status, 'completed'),
          buildBoundaryCondition(boundaryMatch, includeFromMatch, 'after'),
        ),
        eq(matches.id, fromMatchId),
      )
    : and(
        eq(matches.status, 'completed'),
        buildBoundaryCondition(boundaryMatch, includeFromMatch, 'after'),
      )
  const replayCondition = extraReplayMatchIds.length > 0
    ? or(boundaryReplayCondition, inArray(matches.id, extraReplayMatchIds))
    : boundaryReplayCondition

  const [boundaryParticipants, replayMatchCandidates] = await Promise.all([
    db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, fromMatchId)),
    db
      .select({
        id: matches.id,
        gameMode: matches.gameMode,
        draftData: matches.draftData,
        isOld: matches.isOld,
        createdAt: matches.createdAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(
        inArray(matches.gameMode, gameModes),
        eq(matches.guildId, statsContext.guildId),
        replayCondition,
        excludeTournamentMatchesCondition(),
      ))
      .orderBy(asc(matches.createdAt), asc(matches.id)),
  ])

  const replayMatches = replayMatchCandidates.filter(match => matchBelongsToLeaderboard(match, leaderboardMode))
  const replayParticipantRows = await listReplayParticipantRows(db, replayMatches.map(match => match.id))

  const affectedPlayerIds = [...new Set([
    ...boundaryParticipants.map(participant => participant.playerId),
    ...replayParticipantRows.map(participant => participant.playerId),
    ...extraAffectedPlayerIds,
  ])].sort((a, b) => a.localeCompare(b))

  const earlierEventRows = await listEarlierRatingEventRows(db, statsContext, leaderboardMode, affectedPlayerIds, boundaryMatch)

  const { ratingStateByPlayer } = createReplayStates(affectedPlayerIds)
  const seasonProgress: SeasonProgress = { value: 0 }
  const hydrateResult = hydrateRatingStateFromEventsUntilBoundary(
    ratingStateByPlayer,
    seasonRows,
    seasonProgress,
    earlierEventRows,
    boundaryMatch.createdAt,
  )
  if (typeof hydrateResult === 'string' && isMissingRatingSnapshotsError(hydrateResult)) {
    const missingSnapshotMatchId = parseMissingRatingSnapshotMatchId(hydrateResult)
    if (!missingSnapshotMatchId) return { error: hydrateResult }
    return recalculateLeaderboardModeFromBoundary(
      db,
      leaderboardMode,
      gameModes,
      seasonRows,
      statsContext,
      missingSnapshotMatchId,
      true,
      false,
      includeActiveBoundary ? [boundaryMatch, ...extraReplayMatches] : extraReplayMatches,
      extraAffectedPlayerIds,
    )
  }
  if (typeof hydrateResult === 'string') return { error: hydrateResult }

  const participantsByMatchId = buildParticipantsByMatchId(replayParticipantRows)
  const replayWriteQueries: DbBatchItem[] = []
  for (const match of replayMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, statsContext, leaderboardMode, match, participantRows, ratingStateByPlayer, {
      writeQueries: replayWriteQueries,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await deleteRatingEventsFromBoundary(db, statsContext, leaderboardMode, boundaryMatch, affectedPlayerIds, includeFromMatch)
  await flushReplayWriteQueries(db, replayWriteQueries)
  await replacePlayerRatings(db, statsContext, leaderboardMode, ratingStateByPlayer, affectedPlayerIds)

  return { matchIds: replayMatches.map(match => match.id) }
}

async function listReplayParticipantRows(db: Database, matchIds: string[]): Promise<StoredParticipantRow[]> {
  const rows: StoredParticipantRow[] = []
  for (const chunk of chunkArray(matchIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
    rows.push(...await db
      .select({
        matchId: matchParticipants.matchId,
        playerId: matchParticipants.playerId,
        team: matchParticipants.team,
        civId: matchParticipants.civId,
        placement: matchParticipants.placement,
        ratingBeforeMu: matchParticipants.ratingBeforeMu,
        ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
        ratingAfterMu: matchParticipants.ratingAfterMu,
        ratingAfterSigma: matchParticipants.ratingAfterSigma,
      })
      .from(matchParticipants)
      .where(inArray(matchParticipants.matchId, chunk)))
  }
  return rows
}

async function listEarlierRatingEventRows(
  db: Database,
  statsContext: StatsContext,
  ratingScope: RatingScope,
  playerIds: string[],
  boundaryMatch: Pick<StoredMatchRow, 'id' | 'createdAt'>,
): Promise<HistoricalRatingEventRow[]> {
  const rows: HistoricalRatingEventRow[] = []
  for (const chunk of chunkArray(playerIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
    rows.push(...await db
      .select({
        matchId: playerRatingEvents.matchId,
        matchCreatedAt: playerRatingEvents.matchCreatedAt,
        matchCompletedAt: playerRatingEvents.matchCompletedAt,
        playerId: playerRatingEvents.playerId,
        ratingAfterMu: playerRatingEvents.ratingAfterMu,
        ratingAfterSigma: playerRatingEvents.ratingAfterSigma,
        gamesDelta: playerRatingEvents.gamesDelta,
        winsDelta: playerRatingEvents.winsDelta,
        importedGamesDelta: playerRatingEvents.importedGamesDelta,
        effectiveGamesDelta: playerRatingEvents.effectiveGamesDelta,
        winsVsTier1Delta: playerRatingEvents.winsVsTier1Delta,
        winsVsTier2PlusDelta: playerRatingEvents.winsVsTier2PlusDelta,
        effectiveWinsVsTier1Delta: playerRatingEvents.effectiveWinsVsTier1Delta,
        effectiveWinsVsTier2PlusDelta: playerRatingEvents.effectiveWinsVsTier2PlusDelta,
      })
      .from(playerRatingEvents)
      .where(and(
        eq(playerRatingEvents.statsKey, statsContext.statsKey),
        eq(playerRatingEvents.mode, ratingScope),
        inArray(playerRatingEvents.playerId, chunk),
        buildEventBoundaryCondition(boundaryMatch, false, 'before'),
        excludeTournamentRatingEventsCondition(),
      )))
    if (statsContext.seasonPolicy === 'ppl-seasons') {
      const legacyRows = await db
        .select({
          matchId: legacyPlayerRatingEvents.matchId,
          matchCreatedAt: legacyPlayerRatingEvents.matchCreatedAt,
          matchCompletedAt: legacyPlayerRatingEvents.matchCompletedAt,
          playerId: legacyPlayerRatingEvents.playerId,
          ratingAfterMu: legacyPlayerRatingEvents.ratingAfterMu,
          ratingAfterSigma: legacyPlayerRatingEvents.ratingAfterSigma,
          gamesDelta: legacyPlayerRatingEvents.gamesDelta,
          winsDelta: legacyPlayerRatingEvents.winsDelta,
          importedGamesDelta: legacyPlayerRatingEvents.importedGamesDelta,
          effectiveGamesDelta: legacyPlayerRatingEvents.effectiveGamesDelta,
          winsVsTier1Delta: legacyPlayerRatingEvents.winsVsTier1Delta,
          winsVsTier2PlusDelta: legacyPlayerRatingEvents.winsVsTier2PlusDelta,
          effectiveWinsVsTier1Delta: legacyPlayerRatingEvents.effectiveWinsVsTier1Delta,
          effectiveWinsVsTier2PlusDelta: legacyPlayerRatingEvents.effectiveWinsVsTier2PlusDelta,
        })
        .from(legacyPlayerRatingEvents)
        .where(and(
          eq(legacyPlayerRatingEvents.mode, ratingScope),
          inArray(legacyPlayerRatingEvents.playerId, chunk),
          buildLegacyEventBoundaryCondition(boundaryMatch, false, 'before'),
          excludeLegacyTournamentRatingEventsCondition(),
        ))
      const existingKeys = new Set(rows.map(row => `${row.matchId}\0${row.playerId}`))
      for (const row of legacyRows) {
        const key = `${row.matchId}\0${row.playerId}`
        if (!existingKeys.has(key)) rows.push(row)
      }
    }
  }

  return rows.sort(compareHistoricalRatingEventRows)
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function compareHistoricalRatingEventRows(left: HistoricalRatingEventRow, right: HistoricalRatingEventRow): number {
  return left.matchCreatedAt - right.matchCreatedAt
    || left.matchId.localeCompare(right.matchId)
    || left.playerId.localeCompare(right.playerId)
}

function createReplayStates(_playerIds?: string[]): {
  ratingStateByPlayer: Map<string, RatingState>
} {
  const ratingStateByPlayer = new Map<string, RatingState>()
  return { ratingStateByPlayer }
}

function buildParticipantsByMatchId(rows: StoredParticipantRow[]): Map<string, StoredParticipantRow[]> {
  const participantsByMatchId = new Map<string, StoredParticipantRow[]>()

  for (const participant of rows) {
    const current = participantsByMatchId.get(participant.matchId) ?? []
    current.push(participant)
    participantsByMatchId.set(participant.matchId, current)
  }

  return participantsByMatchId
}

function matchBelongsToLeaderboard(
  match: Pick<StoredMatchRow, 'gameMode' | 'draftData'>,
  leaderboardMode: LeaderboardMode,
): boolean {
  return getStoredGameModeContext(match.gameMode, match.draftData)?.leaderboardMode === leaderboardMode
}

function applySeasonResetsUntil(
  ratingStateByPlayer: Map<string, RatingState>,
  seasonRows: StoredSeasonRow[],
  seasonProgress: SeasonProgress,
  timestamp: number,
): void {
  while (seasonProgress.value < seasonRows.length && seasonRows[seasonProgress.value]!.startsAt <= timestamp) {
    if (seasonRows[seasonProgress.value]!.softReset) {
      for (const [playerId, state] of ratingStateByPlayer.entries()) {
        const reset = seasonReset(state.mu, state.sigma)
        ratingStateByPlayer.set(playerId, {
          ...state,
          mu: reset.mu,
          sigma: reset.sigma,
          gamesPlayed: 0,
          wins: 0,
          importedGames: 0,
          effectiveGames: 0,
          winsVsTier1: 0,
          winsVsTier2Plus: 0,
          effectiveWinsVsTier1: 0,
          effectiveWinsVsTier2Plus: 0,
        })
      }
    }

    seasonProgress.value += 1
  }
}

function hydrateRatingStateFromEventsUntilBoundary(
  ratingStateByPlayer: Map<string, RatingState>,
  seasonRows: StoredSeasonRow[],
  seasonProgress: SeasonProgress,
  rows: HistoricalRatingEventRow[],
  boundaryCreatedAt: number,
): string | null {
  for (const row of rows) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, row.matchCreatedAt)

    const currentState = ratingStateByPlayer.get(row.playerId) ?? createDefaultRatingState(row.playerId)
    ratingStateByPlayer.set(row.playerId, {
      mu: row.ratingAfterMu,
      sigma: row.ratingAfterSigma,
      gamesPlayed: currentState.gamesPlayed + row.gamesDelta,
      wins: currentState.wins + row.winsDelta,
      importedGames: currentState.importedGames + row.importedGamesDelta,
      effectiveGames: currentState.effectiveGames + row.effectiveGamesDelta,
      winsVsTier1: currentState.winsVsTier1 + row.winsVsTier1Delta,
      winsVsTier2Plus: currentState.winsVsTier2Plus + row.winsVsTier2PlusDelta,
      effectiveWinsVsTier1: currentState.effectiveWinsVsTier1 + row.effectiveWinsVsTier1Delta,
      effectiveWinsVsTier2Plus: currentState.effectiveWinsVsTier2Plus + row.effectiveWinsVsTier2PlusDelta,
      lastPlayedAt: row.importedGamesDelta > 0 ? currentState.lastPlayedAt : (row.matchCompletedAt ?? row.matchCreatedAt),
    })
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, boundaryCreatedAt)
  return null
}

async function replayCompletedMatch(
  db: Database,
  statsContext: StatsContext,
  leaderboardMode: LeaderboardMode | null,
  match: StoredMatchRow,
  participantRows: StoredParticipantRow[],
  ratingStateByPlayer: Map<string, RatingState>,
  options: { writeParticipantSnapshots?: boolean, opponentTierByPlayerId?: ReadonlyMap<string, string>, writeQueries?: DbBatchItem[] } = {},
): Promise<string | null> {
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return `Completed match **${match.id}** has unsupported game mode: ${match.gameMode}.`
  if (leaderboardMode != null && gameContext.leaderboardMode !== leaderboardMode) return null
  if (leaderboardMode == null && gameContext.leaderboardMode == null) return null

  if (participantRows.length === 0) return `Completed match **${match.id}** has no participants.`
  if (participantRows.some(participant => participant.placement == null)) {
    return `Completed match **${match.id}** has missing placements.`
  }

  const gameMode = gameContext.mode
  const ratingUpdates = calculateRatingUpdatesForMatch(
    gameMode,
    participantRows,
    gameContext.permanentAlly,
    (playerId) => {
      const existingRating = ratingStateByPlayer.get(playerId)
      if (existingRating) {
        return { mu: existingRating.mu, sigma: existingRating.sigma, gamesPlayed: existingRating.gamesPlayed }
      }

      const rating = createRating(playerId)
      return { mu: rating.mu, sigma: rating.sigma, gamesPlayed: 0 }
    },
    match.isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1,
  )
  if ('error' in ratingUpdates) return ratingUpdates.error

  const updateByPlayer = new Map(ratingUpdates.map(update => [update.playerId, update]))
  const effectiveRows = gameContext.permanentAlly && gameMode === 'ffa'
    ? buildPermanentAllyFfaEffectiveRows(participantRows)
    : participantRows
  if ('error' in effectiveRows) return effectiveRows.error
  const effectiveRowByPlayerId = new Map(effectiveRows.map(row => [row.playerId, row]))
  const deferredWriteQueries = options.writeQueries
  const participantUpdateQueries = deferredWriteQueries ?? []
  const isImportedGame = match.isOld
  const writeParticipantSnapshots = options.writeParticipantSnapshots ?? true
  const ratingScope = leaderboardMode ?? GLOBAL_RATING_SCOPE

  for (const participant of participantRows) {
    const update = updateByPlayer.get(participant.playerId)
    if (!update) return `Failed to recalculate ratings for match **${match.id}**.`

    const currentState = ratingStateByPlayer.get(participant.playerId) ?? createDefaultRatingState(participant.playerId)
    const effectiveParticipant = effectiveRowByPlayerId.get(participant.playerId) ?? participant
    const sourceWeight = isImportedGame ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1
    const qualityWins = leaderboardMode == null
      ? countQualityWinsForParticipant(effectiveParticipant, effectiveRows, options.opponentTierByPlayerId ?? new Map(), sourceWeight)
      : { winsVsTier1: 0, winsVsTier2Plus: 0, effectiveWinsVsTier1: 0, effectiveWinsVsTier2Plus: 0 }
    const ratingBeforeMu = update.before.mu
    const ratingAfter = scaleRatingAfterForSource(update, sourceWeight)
    const ratingAfterMu = ratingAfter.mu
    const ratingAfterSigma = ratingAfter.sigma

    if (writeParticipantSnapshots) {
      participantUpdateQueries.push(
        db
          .update(matchParticipants)
          .set({
            ratingBeforeMu,
            ratingBeforeSigma: update.before.sigma,
            ratingAfterMu,
            ratingAfterSigma,
          })
          .where(
            and(
              eq(matchParticipants.matchId, match.id),
              eq(matchParticipants.playerId, participant.playerId),
            ),
          ),
      )
    }

    ratingStateByPlayer.set(participant.playerId, {
      mu: ratingAfterMu,
      sigma: ratingAfterSigma,
      gamesPlayed: currentState.gamesPlayed + 1,
      wins: currentState.wins + (effectiveParticipant.placement === 1 ? 1 : 0),
      importedGames: currentState.importedGames + (isImportedGame ? 1 : 0),
      effectiveGames: currentState.effectiveGames + sourceWeight,
      winsVsTier1: currentState.winsVsTier1 + qualityWins.winsVsTier1,
      winsVsTier2Plus: currentState.winsVsTier2Plus + qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1: currentState.effectiveWinsVsTier1 + qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: currentState.effectiveWinsVsTier2Plus + qualityWins.effectiveWinsVsTier2Plus,
      lastPlayedAt: isImportedGame ? currentState.lastPlayedAt : (match.completedAt ?? match.createdAt),
    })

    const eventRow = {
      statsKey: statsContext.statsKey,
      matchId: match.id,
      playerId: participant.playerId,
      mode: ratingScope,
      gameMode: match.gameMode,
      ratingBeforeMu,
      ratingBeforeSigma: update.before.sigma,
      ratingAfterMu,
      ratingAfterSigma,
      gamesDelta: 1,
      winsDelta: effectiveParticipant.placement === 1 ? 1 : 0,
      importedGamesDelta: isImportedGame ? 1 : 0,
      effectiveGamesDelta: sourceWeight,
      winsVsTier1Delta: qualityWins.winsVsTier1,
      winsVsTier2PlusDelta: qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1Delta: qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2PlusDelta: qualityWins.effectiveWinsVsTier2Plus,
      matchCreatedAt: match.createdAt,
      matchCompletedAt: match.completedAt,
      updatedAt: Date.now(),
    }
    participantUpdateQueries.push(
      db.insert(playerRatingEvents).values(eventRow).onConflictDoUpdate({
        target: [playerRatingEvents.statsKey, playerRatingEvents.matchId, playerRatingEvents.playerId, playerRatingEvents.mode],
        set: eventRow,
      }),
    )
    if (statsContext.seasonPolicy === 'ppl-seasons') {
      const { statsKey: _statsKey, ...legacyEventRow } = eventRow
      participantUpdateQueries.push(
        db.insert(legacyPlayerRatingEvents).values(legacyEventRow).onConflictDoUpdate({
          target: [legacyPlayerRatingEvents.matchId, legacyPlayerRatingEvents.playerId, legacyPlayerRatingEvents.mode],
          set: legacyEventRow,
        }),
      )
    }
  }

  if (!deferredWriteQueries && participantUpdateQueries.length > 0) await runDbBatch(db, participantUpdateQueries)
  return null
}

async function flushReplayWriteQueries(db: Database, queries: DbBatchItem[]): Promise<void> {
  for (const chunk of chunkArray(queries, REPLAY_WRITE_BATCH_SIZE)) {
    await runDbBatch(db, chunk)
  }
}

function scaleRatingAfterForSource(update: RatingUpdate, sourceWeight: number): { mu: number, sigma: number } {
  if (sourceWeight >= 1) return update.after
  return {
    mu: update.before.mu + ((update.after.mu - update.before.mu) * sourceWeight),
    sigma: update.before.sigma + ((update.after.sigma - update.before.sigma) * sourceWeight),
  }
}

function countQualityWinsForParticipant(
  participant: Pick<StoredParticipantRow, 'playerId' | 'team' | 'placement'>,
  participantRows: Array<Pick<StoredParticipantRow, 'playerId' | 'team' | 'placement'>>,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  sourceWeight = 1,
): { winsVsTier1: number, winsVsTier2Plus: number, effectiveWinsVsTier1: number, effectiveWinsVsTier2Plus: number } {
  let winsVsTier1 = 0
  let winsVsTier2Plus = 0
  let effectiveWinsVsTier1 = 0
  let effectiveWinsVsTier2Plus = 0
  const effectiveWinCredit = sourceWeight / participantTeamSize(participant, participantRows)

  for (const opponent of participantRows) {
    if (!didDefeatOpponent(participant, opponent)) continue
    const opponentTierNumber = rankedRoleTierNumber(opponentTierByPlayerId.get(opponent.playerId) ?? null)
    if (opponentTierNumber == null) continue
    if (opponentTierNumber <= 1) {
      winsVsTier1 += 1
      effectiveWinsVsTier1 += effectiveWinCredit
    }
    if (opponentTierNumber <= 2) {
      winsVsTier2Plus += 1
      effectiveWinsVsTier2Plus += effectiveWinCredit
    }
  }

  return { winsVsTier1, winsVsTier2Plus, effectiveWinsVsTier1, effectiveWinsVsTier2Plus }
}

function participantTeamSize(
  participant: Pick<StoredParticipantRow, 'playerId' | 'team'>,
  participantRows: Array<Pick<StoredParticipantRow, 'playerId' | 'team'>>,
): number {
  if (participant.team == null) return 1
  return Math.max(1, participantRows.filter(row => row.team === participant.team).length)
}

function didDefeatOpponent(
  participant: Pick<StoredParticipantRow, 'playerId' | 'team' | 'placement'>,
  opponent: Pick<StoredParticipantRow, 'playerId' | 'team' | 'placement'>,
): boolean {
  if (participant.playerId === opponent.playerId) return false
  if (participant.team != null && opponent.team != null && participant.team === opponent.team) return false
  if (participant.placement == null || opponent.placement == null) return false
  return participant.placement < opponent.placement
}

function rankedRoleTierNumber(tier: string | null): number | null {
  if (!tier) return null
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value) : null
}

function calculateRatingUpdatesForMatch(
  gameMode: string,
  participantRows: StoredParticipantRow[],
  permanentAlly: boolean,
  resolveRating: (playerId: string) => { mu: number, sigma: number, gamesPlayed: number },
  sourceWeight: number = 1,
): ReturnType<typeof calculateRatings> | { error: string } {
  if (permanentAlly && gameMode === 'ffa') {
    return calculatePermanentAllyFfaRatingUpdates(participantRows, resolveRating)
  }

  if (isTeamMode(gameMode as Parameters<typeof isTeamMode>[0]) || gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number, gamesPlayed: number }[]>()

    for (const participant of participantRows) {
      const team = participant.team ?? 0
      const rating = resolveRating(participant.playerId)
      const teamPlayers = teams.get(team) ?? []
      teamPlayers.push({
        playerId: participant.playerId,
        mu: rating.mu,
        sigma: rating.sigma,
        gamesPlayed: rating.gamesPlayed,
      })
      teams.set(team, teamPlayers)
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(participant => participant.team === a[0])?.placement ?? Number.MAX_SAFE_INTEGER
      const bPlacement = participantRows.find(participant => participant.team === b[0])?.placement ?? Number.MAX_SAFE_INTEGER
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(player => ({
        playerId: player.playerId,
        mu: player.mu,
        sigma: player.sigma,
        gamesPlayed: player.gamesPlayed,
      })),
    }))

    return calculateRatings({ type: 'team', teams: teamInputs }, { sourceWeight })
  }

  const ffaEntries: FfaEntry[] = participantRows.map((participant) => {
    const rating = resolveRating(participant.playerId)
    return {
      player: {
        playerId: participant.playerId,
        mu: rating.mu,
        sigma: rating.sigma,
      },
      placement: participant.placement!,
    }
  })

  return calculateRatings({ type: 'ffa', entries: ffaEntries })
}

async function replacePlayerRatings(
  db: Database,
  statsContext: StatsContext,
  leaderboardMode: RatingScope,
  ratingStateByPlayer: Map<string, RatingState>,
  playerIds?: string[],
): Promise<void> {
  const ratingQueries: DbBatchItem[] = []

  if (playerIds) {
    if (playerIds.length === 0) return

    for (const chunk of chunkArray(playerIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
      ratingQueries.push(
        db
          .delete(playerRatings)
          .where(and(
            eq(playerRatings.statsKey, statsContext.statsKey),
            eq(playerRatings.mode, leaderboardMode),
            inArray(playerRatings.playerId, chunk),
          )),
      )
      if (statsContext.seasonPolicy === 'ppl-seasons') {
        ratingQueries.push(db.delete(legacyPlayerRatings).where(and(
          eq(legacyPlayerRatings.mode, leaderboardMode),
          inArray(legacyPlayerRatings.playerId, chunk),
        )))
      }
    }
  }
  else {
    ratingQueries.push(db.delete(playerRatings).where(and(eq(playerRatings.statsKey, statsContext.statsKey), eq(playerRatings.mode, leaderboardMode))))
    if (statsContext.seasonPolicy === 'ppl-seasons') ratingQueries.push(db.delete(legacyPlayerRatings).where(eq(legacyPlayerRatings.mode, leaderboardMode)))
  }

  for (const [playerId, state] of ratingStateByPlayer.entries()) {
    const ratingRow = {
      playerId,
      mode: leaderboardMode,
      mu: state.mu,
      sigma: state.sigma,
      gamesPlayed: state.gamesPlayed,
      wins: state.wins,
      importedGames: state.importedGames,
      effectiveGames: state.effectiveGames,
      winsVsTier1: state.winsVsTier1,
      winsVsTier2Plus: state.winsVsTier2Plus,
      effectiveWinsVsTier1: state.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: state.effectiveWinsVsTier2Plus,
      lastPlayedAt: state.lastPlayedAt,
      updatedAt: Date.now(),
    }
    ratingQueries.push(
      db.insert(playerRatings).values({
        statsKey: statsContext.statsKey,
        ...ratingRow,
      }),
    )
    if (statsContext.seasonPolicy === 'ppl-seasons') ratingQueries.push(db.insert(legacyPlayerRatings).values(ratingRow))
  }

  await runDbBatch(db, ratingQueries)
}

async function deleteRatingEventsFromBoundary(
  db: Database,
  statsContext: StatsContext,
  ratingScope: RatingScope,
  boundaryMatch: Pick<StoredMatchRow, 'id' | 'createdAt'>,
  playerIds: string[],
  includeBoundary: boolean,
): Promise<void> {
  if (playerIds.length === 0) return
  const boundaryCondition = buildEventBoundaryCondition(boundaryMatch, includeBoundary, 'after')
  const replayRangeCondition = includeBoundary
    ? boundaryCondition
    : or(eq(playerRatingEvents.matchId, boundaryMatch.id), boundaryCondition)

  const eventDeleteQueries: DbBatchItem[] = []
  for (const chunk of chunkArray(playerIds, D1_SAFE_IN_LIST_CHUNK_SIZE)) {
    eventDeleteQueries.push(db
      .delete(playerRatingEvents)
      .where(and(
        eq(playerRatingEvents.mode, ratingScope),
        eq(playerRatingEvents.statsKey, statsContext.statsKey),
        inArray(playerRatingEvents.playerId, chunk),
        replayRangeCondition,
      )))
    if (statsContext.seasonPolicy === 'ppl-seasons') {
      const legacyBoundaryCondition = buildLegacyEventBoundaryCondition(boundaryMatch, includeBoundary, 'after')
      const legacyReplayRangeCondition = includeBoundary
        ? legacyBoundaryCondition
        : or(eq(legacyPlayerRatingEvents.matchId, boundaryMatch.id), legacyBoundaryCondition)
      eventDeleteQueries.push(db.delete(legacyPlayerRatingEvents).where(and(
        eq(legacyPlayerRatingEvents.mode, ratingScope),
        inArray(legacyPlayerRatingEvents.playerId, chunk),
        legacyReplayRangeCondition,
      )))
    }
  }
  await runDbBatch(db, eventDeleteQueries)
}

function buildLegacyEventBoundaryCondition(
  boundaryMatch: Pick<StoredMatchRow, 'id' | 'createdAt'>,
  includeBoundary: boolean,
  direction: 'before' | 'after',
) {
  if (direction === 'before') {
    return or(
      lt(legacyPlayerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
      and(eq(legacyPlayerRatingEvents.matchCreatedAt, boundaryMatch.createdAt), lt(legacyPlayerRatingEvents.matchId, boundaryMatch.id)),
    )
  }
  return or(
    gt(legacyPlayerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
    and(
      eq(legacyPlayerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
      includeBoundary ? gte(legacyPlayerRatingEvents.matchId, boundaryMatch.id) : gt(legacyPlayerRatingEvents.matchId, boundaryMatch.id),
    ),
  )
}

function createDefaultRatingState(playerId: string): RatingState {
  const rating = createRating(playerId)
  return {
    mu: rating.mu,
    sigma: rating.sigma,
    gamesPlayed: 0,
    wins: 0,
    importedGames: 0,
    effectiveGames: 0,
    winsVsTier1: 0,
    winsVsTier2Plus: 0,
    effectiveWinsVsTier1: 0,
    effectiveWinsVsTier2Plus: 0,
    lastPlayedAt: null,
  }
}

function isMissingRatingSnapshotsError(error: string): boolean {
  return error.includes(MISSING_RATING_SNAPSHOTS_MESSAGE)
}

function parseMissingRatingSnapshotMatchId(error: string): string | null {
  return /^Completed match \*\*(.+)\*\* has missing rating snapshots\.$/.exec(error)?.[1] ?? null
}

function buildBoundaryCondition(
  boundaryMatch: Pick<StoredMatchRow, 'id' | 'createdAt'>,
  includeBoundary: boolean,
  direction: 'before' | 'after',
) {
  if (direction === 'before') {
    return or(
      lt(matches.createdAt, boundaryMatch.createdAt),
      and(eq(matches.createdAt, boundaryMatch.createdAt), lt(matches.id, boundaryMatch.id)),
    )
  }

  return or(
    gt(matches.createdAt, boundaryMatch.createdAt),
    and(
      eq(matches.createdAt, boundaryMatch.createdAt),
      includeBoundary ? gte(matches.id, boundaryMatch.id) : gt(matches.id, boundaryMatch.id),
    ),
  )
}

function buildEventBoundaryCondition(
  boundaryMatch: Pick<StoredMatchRow, 'id' | 'createdAt'>,
  includeBoundary: boolean,
  direction: 'before' | 'after',
) {
  if (direction === 'before') {
    return or(
      lt(playerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
      and(eq(playerRatingEvents.matchCreatedAt, boundaryMatch.createdAt), lt(playerRatingEvents.matchId, boundaryMatch.id)),
    )
  }

  return or(
    gt(playerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
    and(
      eq(playerRatingEvents.matchCreatedAt, boundaryMatch.createdAt),
      includeBoundary ? gte(playerRatingEvents.matchId, boundaryMatch.id) : gt(playerRatingEvents.matchId, boundaryMatch.id),
    ),
  )
}

function excludeTournamentMatchesCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${matches.id}
       or ${tournamentMatches.sessionId} = ${matches.id}
  )`
}

function excludeTournamentRatingEventsCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${playerRatingEvents.matchId}
       or ${tournamentMatches.sessionId} = ${playerRatingEvents.matchId}
  )`
}

function excludeLegacyTournamentRatingEventsCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${legacyPlayerRatingEvents.matchId}
       or ${tournamentMatches.sessionId} = ${legacyPlayerRatingEvents.matchId}
  )`
}
