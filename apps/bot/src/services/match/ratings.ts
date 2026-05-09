import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, RatingUpdate, TeamInput } from '@civup/rating'
import { matches, matchParticipants, playerRatingEvents, playerRatings, seasons } from '@civup/db'
import { GAME_MODES, isTeamMode, leaderboardModesToGameModes } from '@civup/game'
import { calculateRatings, createRating, displayRating, getLeaderboardMinGames, IMPORTED_GAME_EFFECTIVE_WEIGHT, seasonReset } from '@civup/rating'
import { and, asc, eq, gt, gte, inArray, lt, or } from 'drizzle-orm'
import { type DbBatchItem, runDbBatch } from '../db/batch.ts'
import { getStoredGameModeContext } from './draft-data.ts'

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

interface HistoricalParticipantRow {
  matchId: string
  createdAt: number
  completedAt: number | null
  isOld: boolean
  playerId: string
  team: number | null
  placement: number | null
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
  winsVsEliteDelta: number
  winsVsLegionPlusDelta: number
}

interface RatingState {
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  importedGames: number
  effectiveGames: number
  winsVsElite: number
  winsVsLegionPlus: number
  lastPlayedAt: number | null
}

interface SeasonProgress {
  value: number
}

interface RecalculateLeaderboardModeOptions {
  fromMatchId?: string
  includeFromMatch?: boolean
  includeActiveBoundary?: boolean
}

interface RecalculateGlobalRatingsOptions extends RecalculateLeaderboardModeOptions {
  opponentTierByPlayerId?: ReadonlyMap<string, string>
}

const MISSING_RATING_SNAPSHOTS_MESSAGE = 'has missing rating snapshots'
const GLOBAL_RATING_SCOPE = 'global'

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

  if (options.fromMatchId) {
    return recalculateLeaderboardModeFromBoundary(
      db,
      leaderboardMode,
      gameModes,
      seasonRows,
      options.fromMatchId,
      options.includeFromMatch ?? true,
      options.includeActiveBoundary ?? false,
    )
  }

  return recalculateLeaderboardModeFromScratch(db, leaderboardMode, gameModes, seasonRows)
}

export async function recalculateGlobalRatings(
  db: Database,
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

  if (options.fromMatchId) {
    return recalculateGlobalRatingsFromBoundary(
      db,
      seasonRows,
      options.fromMatchId,
      options.includeFromMatch ?? true,
      options.includeActiveBoundary ?? false,
      options.opponentTierByPlayerId ?? new Map(),
    )
  }

  return recalculateGlobalRatingsFromScratch(db, seasonRows, options.opponentTierByPlayerId ?? new Map())
}

async function recalculateGlobalRatingsFromScratch(
  db: Database,
  seasonRows: StoredSeasonRow[],
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
      inArray(matches.gameMode, [...GAME_MODES]),
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
          inArray(matches.gameMode, [...GAME_MODES]),
        ))
    : []

  const { ratingStateByPlayer } = createReplayStates()
  const seasonProgress: SeasonProgress = { value: 0 }
  const participantsByMatchId = buildParticipantsByMatchId(allParticipantRows)
  await db.delete(playerRatingEvents).where(eq(playerRatingEvents.mode, GLOBAL_RATING_SCOPE))

  for (const match of completedMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, null, match, participantRows, ratingStateByPlayer, {
      writeParticipantSnapshots: false,
      opponentTierByPlayerId,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await replacePlayerRatings(db, GLOBAL_RATING_SCOPE, ratingStateByPlayer)

  return { matchIds: completedMatches.map(match => match.id) }
}

async function recalculateGlobalRatingsFromBoundary(
  db: Database,
  seasonRows: StoredSeasonRow[],
  fromMatchId: string,
  includeFromMatch: boolean,
  includeActiveBoundary: boolean,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  extraReplayMatches: StoredMatchRow[] = [],
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
    .where(eq(matches.id, fromMatchId))
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
        replayCondition,
      ))
      .orderBy(asc(matches.createdAt), asc(matches.id)),
  ])

  const replayParticipantRows = replayMatches.length > 0
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
        .where(inArray(matchParticipants.matchId, replayMatches.map(match => match.id)))
    : []

  const affectedPlayerIds = [...new Set([
    ...boundaryParticipants.map(participant => participant.playerId),
    ...replayParticipantRows.map(participant => participant.playerId),
  ])].sort((a, b) => a.localeCompare(b))

  const earlierEventRows = affectedPlayerIds.length > 0
    ? await db
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
          winsVsEliteDelta: playerRatingEvents.winsVsEliteDelta,
          winsVsLegionPlusDelta: playerRatingEvents.winsVsLegionPlusDelta,
        })
        .from(playerRatingEvents)
        .where(and(
          eq(playerRatingEvents.mode, GLOBAL_RATING_SCOPE),
          inArray(playerRatingEvents.playerId, affectedPlayerIds),
          buildEventBoundaryCondition(boundaryMatch, false, 'before'),
        ))
        .orderBy(asc(playerRatingEvents.matchCreatedAt), asc(playerRatingEvents.matchId), asc(playerRatingEvents.playerId))
    : []

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
      missingSnapshotMatchId,
      true,
      false,
      opponentTierByPlayerId,
      includeActiveBoundary ? [boundaryMatch, ...extraReplayMatches] : extraReplayMatches,
    )
  }
  if (typeof hydrateResult === 'string') return { error: hydrateResult }

  await deleteRatingEventsFromBoundary(db, GLOBAL_RATING_SCOPE, boundaryMatch, affectedPlayerIds, includeFromMatch)

  const participantsByMatchId = buildParticipantsByMatchId(replayParticipantRows)
  for (const match of replayMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, null, match, participantRows, ratingStateByPlayer, {
      writeParticipantSnapshots: false,
      opponentTierByPlayerId,
    })
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await replacePlayerRatings(db, GLOBAL_RATING_SCOPE, ratingStateByPlayer, affectedPlayerIds)

  return { matchIds: replayMatches.map(match => match.id) }
}

async function recalculateLeaderboardModeFromScratch(
  db: Database,
  leaderboardMode: LeaderboardMode,
  gameModes: readonly string[],
  seasonRows: StoredSeasonRow[],
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
      inArray(matches.gameMode, gameModes),
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
          inArray(matches.gameMode, gameModes),
        ))
    : []

  const { ratingStateByPlayer } = createReplayStates()
  const seasonProgress: SeasonProgress = { value: 0 }
  const participantsByMatchId = buildParticipantsByMatchId(allParticipantRows)
  await db.delete(playerRatingEvents).where(eq(playerRatingEvents.mode, leaderboardMode))

  for (const match of completedMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, leaderboardMode, match, participantRows, ratingStateByPlayer)
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await replacePlayerRatings(db, leaderboardMode, ratingStateByPlayer)

  return { matchIds: completedMatches.map(match => match.id) }
}

async function recalculateLeaderboardModeFromBoundary(
  db: Database,
  leaderboardMode: LeaderboardMode,
  gameModes: readonly string[],
  seasonRows: StoredSeasonRow[],
  fromMatchId: string,
  includeFromMatch: boolean,
  includeActiveBoundary: boolean,
  extraReplayMatches: StoredMatchRow[] = [],
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
    .where(eq(matches.id, fromMatchId))
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
        inArray(matches.gameMode, gameModes),
        replayCondition,
      ))
      .orderBy(asc(matches.createdAt), asc(matches.id)),
  ])

  const replayParticipantRows = replayMatches.length > 0
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
        .where(inArray(matchParticipants.matchId, replayMatches.map(match => match.id)))
    : []

  const affectedPlayerIds = [...new Set([
    ...boundaryParticipants.map(participant => participant.playerId),
    ...replayParticipantRows.map(participant => participant.playerId),
  ])].sort((a, b) => a.localeCompare(b))

  const earlierParticipantRows = affectedPlayerIds.length > 0
    ? await db
        .select({
          matchId: matchParticipants.matchId,
          createdAt: matches.createdAt,
          completedAt: matches.completedAt,
          isOld: matches.isOld,
          playerId: matchParticipants.playerId,
          team: matchParticipants.team,
          placement: matchParticipants.placement,
          ratingAfterMu: matchParticipants.ratingAfterMu,
          ratingAfterSigma: matchParticipants.ratingAfterSigma,
        })
        .from(matchParticipants)
        .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
        .where(and(
          eq(matches.status, 'completed'),
          inArray(matches.gameMode, gameModes),
          inArray(matchParticipants.playerId, affectedPlayerIds),
          buildBoundaryCondition(boundaryMatch, false, 'before'),
        ))
        .orderBy(asc(matches.createdAt), asc(matches.id), asc(matchParticipants.playerId))
    : []

  const { ratingStateByPlayer } = createReplayStates(affectedPlayerIds)
  const seasonProgress: SeasonProgress = { value: 0 }
  const hydrateResult = hydrateRatingStateUntilBoundary(
    ratingStateByPlayer,
    seasonRows,
    seasonProgress,
    earlierParticipantRows,
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
      missingSnapshotMatchId,
      true,
      false,
      includeActiveBoundary ? [boundaryMatch, ...extraReplayMatches] : extraReplayMatches,
    )
  }
  if (typeof hydrateResult === 'string') return { error: hydrateResult }

  await deleteRatingEventsFromBoundary(db, leaderboardMode, boundaryMatch, affectedPlayerIds, includeFromMatch)

  const participantsByMatchId = buildParticipantsByMatchId(replayParticipantRows)
  for (const match of replayMatches) {
    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, match.createdAt)

    const participantRows = participantsByMatchId.get(match.id) ?? []
    const replayResult = await replayCompletedMatch(db, leaderboardMode, match, participantRows, ratingStateByPlayer)
    if (typeof replayResult === 'string') return { error: replayResult }
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, Number.POSITIVE_INFINITY)
  await replacePlayerRatings(db, leaderboardMode, ratingStateByPlayer, affectedPlayerIds)

  return { matchIds: replayMatches.map(match => match.id) }
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
          winsVsElite: 0,
          winsVsLegionPlus: 0,
        })
      }
    }

    seasonProgress.value += 1
  }
}

function hydrateRatingStateUntilBoundary(
  ratingStateByPlayer: Map<string, RatingState>,
  seasonRows: StoredSeasonRow[],
  seasonProgress: SeasonProgress,
  rows: HistoricalParticipantRow[],
  boundaryCreatedAt: number,
  options: {
    trackedPlayerIds?: ReadonlySet<string>
    opponentTierByPlayerId?: ReadonlyMap<string, string>
  } = {},
): string | null {
  let currentMatchId: string | null = null
  let currentMatchCreatedAt = 0
  let currentMatchCompletedAt: number | null = null
  let currentMatchRows: HistoricalParticipantRow[] = []

  const flushCurrentMatch = (): string | null => {
    if (!currentMatchId) return null

    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, currentMatchCreatedAt)

    for (const row of currentMatchRows) {
      if (options.trackedPlayerIds && !options.trackedPlayerIds.has(row.playerId)) continue
      if (row.placement == null) return `Completed match **${row.matchId}** has missing placements.`
      if (row.ratingAfterMu == null || row.ratingAfterSigma == null) {
        return `Completed match **${row.matchId}** has missing rating snapshots.`
      }

      const currentState = ratingStateByPlayer.get(row.playerId) ?? createDefaultRatingState(row.playerId)
      const isImportedGame = row.isOld
      const qualityWins = countQualityWinsForParticipant(row, currentMatchRows, options.opponentTierByPlayerId ?? new Map())
      ratingStateByPlayer.set(row.playerId, {
        mu: row.ratingAfterMu,
        sigma: row.ratingAfterSigma,
        gamesPlayed: currentState.gamesPlayed + 1,
        wins: currentState.wins + (row.placement === 1 ? 1 : 0),
        importedGames: currentState.importedGames + (isImportedGame ? 1 : 0),
        effectiveGames: currentState.effectiveGames + (isImportedGame ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1),
        winsVsElite: currentState.winsVsElite + qualityWins.winsVsElite,
        winsVsLegionPlus: currentState.winsVsLegionPlus + qualityWins.winsVsLegionPlus,
        lastPlayedAt: isImportedGame ? currentState.lastPlayedAt : (currentMatchCompletedAt ?? currentMatchCreatedAt),
      })
    }

    return null
  }

  for (const row of rows) {
    if (currentMatchId !== row.matchId) {
      const error = flushCurrentMatch()
      if (error) return error

      currentMatchId = row.matchId
      currentMatchCreatedAt = row.createdAt
      currentMatchCompletedAt = row.completedAt
      currentMatchRows = []
    }

    currentMatchRows.push(row)
  }

  const finalError = flushCurrentMatch()
  if (finalError) return finalError

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, boundaryCreatedAt)
  return null
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
      winsVsElite: currentState.winsVsElite + row.winsVsEliteDelta,
      winsVsLegionPlus: currentState.winsVsLegionPlus + row.winsVsLegionPlusDelta,
      lastPlayedAt: row.importedGamesDelta > 0 ? currentState.lastPlayedAt : (row.matchCompletedAt ?? row.matchCreatedAt),
    })
  }

  applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, boundaryCreatedAt)
  return null
}

async function replayCompletedMatch(
  db: Database,
  leaderboardMode: LeaderboardMode | null,
  match: StoredMatchRow,
  participantRows: StoredParticipantRow[],
  ratingStateByPlayer: Map<string, RatingState>,
  options: { writeParticipantSnapshots?: boolean, opponentTierByPlayerId?: ReadonlyMap<string, string> } = {},
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
  const ratingUpdates = calculateRatingUpdatesForMatch(gameMode, participantRows, (playerId) => {
    const existingRating = ratingStateByPlayer.get(playerId)
    if (existingRating) return { mu: existingRating.mu, sigma: existingRating.sigma }
    const rating = createRating(playerId)
    return { mu: rating.mu, sigma: rating.sigma }
  })

  const updateByPlayer = new Map(ratingUpdates.map(update => [update.playerId, update]))
  const participantUpdateQueries: DbBatchItem[] = []
  const isImportedGame = match.isOld
  const writeParticipantSnapshots = options.writeParticipantSnapshots ?? true
  const ratingScope = leaderboardMode ?? GLOBAL_RATING_SCOPE

  for (const participant of participantRows) {
    const update = updateByPlayer.get(participant.playerId)
    if (!update) return `Failed to recalculate ratings for match **${match.id}**.`

    const currentState = ratingStateByPlayer.get(participant.playerId) ?? createDefaultRatingState(participant.playerId)
    const qualityWins = leaderboardMode == null
      ? countQualityWinsForParticipant(participant, participantRows, options.opponentTierByPlayerId ?? new Map())
      : { winsVsElite: 0, winsVsLegionPlus: 0 }
    const ratingBeforeMu = update.before.mu
    const ratingAfter = scaleRatingAfterForSource(update, isImportedGame ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1)
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
      wins: currentState.wins + (participant.placement === 1 ? 1 : 0),
      importedGames: currentState.importedGames + (isImportedGame ? 1 : 0),
      effectiveGames: currentState.effectiveGames + (isImportedGame ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1),
      winsVsElite: currentState.winsVsElite + qualityWins.winsVsElite,
      winsVsLegionPlus: currentState.winsVsLegionPlus + qualityWins.winsVsLegionPlus,
      lastPlayedAt: isImportedGame ? currentState.lastPlayedAt : (match.completedAt ?? match.createdAt),
    })

    const eventRow = {
      matchId: match.id,
      playerId: participant.playerId,
      mode: ratingScope,
      gameMode: match.gameMode,
      ratingBeforeMu,
      ratingBeforeSigma: update.before.sigma,
      ratingAfterMu,
      ratingAfterSigma,
      gamesDelta: 1,
      winsDelta: participant.placement === 1 ? 1 : 0,
      importedGamesDelta: isImportedGame ? 1 : 0,
      effectiveGamesDelta: isImportedGame ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1,
      winsVsEliteDelta: qualityWins.winsVsElite,
      winsVsLegionPlusDelta: qualityWins.winsVsLegionPlus,
      matchCreatedAt: match.createdAt,
      matchCompletedAt: match.completedAt,
      updatedAt: Date.now(),
    }
    participantUpdateQueries.push(
      db.insert(playerRatingEvents).values(eventRow).onConflictDoUpdate({
        target: [playerRatingEvents.matchId, playerRatingEvents.playerId, playerRatingEvents.mode],
        set: eventRow,
      }),
    )
  }

  if (participantUpdateQueries.length > 0) await runDbBatch(db, participantUpdateQueries)
  return null
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
): { winsVsElite: number, winsVsLegionPlus: number } {
  let winsVsElite = 0
  let winsVsLegionPlus = 0

  for (const opponent of participantRows) {
    if (!didDefeatOpponent(participant, opponent)) continue
    const opponentTierNumber = rankedRoleTierNumber(opponentTierByPlayerId.get(opponent.playerId) ?? null)
    if (opponentTierNumber == null) continue
    if (opponentTierNumber <= 1) winsVsElite += 1
    if (opponentTierNumber <= 2) winsVsLegionPlus += 1
  }

  return { winsVsElite, winsVsLegionPlus }
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
  resolveRating: (playerId: string) => { mu: number, sigma: number },
) {
  if (isTeamMode(gameMode as Parameters<typeof isTeamMode>[0]) || gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()

    for (const participant of participantRows) {
      const team = participant.team ?? 0
      const rating = resolveRating(participant.playerId)
      const teamPlayers = teams.get(team) ?? []
      teamPlayers.push({ playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma })
      teams.set(team, teamPlayers)
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(participant => participant.team === a[0])?.placement ?? Number.MAX_SAFE_INTEGER
      const bPlacement = participantRows.find(participant => participant.team === b[0])?.placement ?? Number.MAX_SAFE_INTEGER
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(player => ({ playerId: player.playerId, mu: player.mu, sigma: player.sigma })),
    }))

    return calculateRatings({ type: 'team', teams: teamInputs })
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
  leaderboardMode: RatingScope,
  ratingStateByPlayer: Map<string, RatingState>,
  playerIds?: string[],
): Promise<void> {
  const ratingQueries: DbBatchItem[] = []

  if (playerIds) {
    if (playerIds.length === 0) return

    ratingQueries.push(
      db
        .delete(playerRatings)
        .where(and(
          eq(playerRatings.mode, leaderboardMode),
          inArray(playerRatings.playerId, playerIds),
        )),
    )
  }
  else {
    ratingQueries.push(db.delete(playerRatings).where(eq(playerRatings.mode, leaderboardMode)))
  }

  for (const [playerId, state] of ratingStateByPlayer.entries()) {
    ratingQueries.push(
      db.insert(playerRatings).values({
        playerId,
        mode: leaderboardMode,
        mu: state.mu,
        sigma: state.sigma,
        gamesPlayed: state.gamesPlayed,
        wins: state.wins,
        importedGames: state.importedGames,
        effectiveGames: state.effectiveGames,
        winsVsElite: state.winsVsElite,
        winsVsLegionPlus: state.winsVsLegionPlus,
        lastPlayedAt: state.lastPlayedAt,
        updatedAt: Date.now(),
      }),
    )
  }

  await runDbBatch(db, ratingQueries)
}

async function deleteRatingEventsFromBoundary(
  db: Database,
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

  await db
    .delete(playerRatingEvents)
    .where(and(
      eq(playerRatingEvents.mode, ratingScope),
      inArray(playerRatingEvents.playerId, playerIds),
      replayRangeCondition,
    ))
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
    winsVsElite: 0,
    winsVsLegionPlus: 0,
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
