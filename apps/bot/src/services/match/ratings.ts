import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, TeamInput } from '@civup/rating'
import { matches, matchParticipants, playerRatings, playerRatingSeeds, seasons } from '@civup/db'
import { isTeamMode, leaderboardModesToGameModes } from '@civup/game'
import { calculateRatings, createRating, displayRating, getLeaderboardMinGames, seasonReset } from '@civup/rating'
import { and, asc, eq, gt, gte, inArray, lt, or } from 'drizzle-orm'
import { getStoredGameModeContext } from './draft-data.ts'

type BatchItem = Parameters<Database['batch']>[0][number]

interface BatchRunner {
  batch?: (queries: [BatchItem, ...BatchItem[]]) => Promise<unknown>
}

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

interface StoredSeedRow {
  playerId: string
  mu: number
  sigma: number
}

interface StoredMatchRow {
  id: string
  gameMode: string
  draftData: string | null
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
  playerId: string
  placement: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

interface RatingState {
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

interface SeasonProgress {
  value: number
}

interface RecalculateLeaderboardModeOptions {
  fromMatchId?: string
  includeFromMatch?: boolean
}

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
  const [seasonRows, seedRows] = await Promise.all([
    db
      .select({
        id: seasons.id,
        startsAt: seasons.startsAt,
        softReset: seasons.softReset,
      })
      .from(seasons)
      .orderBy(asc(seasons.startsAt), asc(seasons.id)),
    db
      .select({
        playerId: playerRatingSeeds.playerId,
        mu: playerRatingSeeds.mu,
        sigma: playerRatingSeeds.sigma,
      })
      .from(playerRatingSeeds)
      .where(eq(playerRatingSeeds.mode, leaderboardMode)),
  ])

  if (options.fromMatchId) {
    return await recalculateLeaderboardModeFromBoundary(
      db,
      leaderboardMode,
      gameModes,
      seasonRows,
      seedRows,
      options.fromMatchId,
      options.includeFromMatch ?? true,
    )
  }

  return await recalculateLeaderboardModeFromScratch(db, leaderboardMode, gameModes, seasonRows, seedRows)
}

async function recalculateLeaderboardModeFromScratch(
  db: Database,
  leaderboardMode: LeaderboardMode,
  gameModes: readonly string[],
  seasonRows: StoredSeasonRow[],
  seedRows: StoredSeedRow[],
): Promise<{ matchIds: string[] } | { error: string }> {
  const completedMatches = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
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

  const ratingStateByPlayer = createSeededRatingState(seedRows)
  const seasonProgress: SeasonProgress = { value: 0 }
  const participantsByMatchId = buildParticipantsByMatchId(allParticipantRows)

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
  seedRows: StoredSeedRow[],
  fromMatchId: string,
  includeFromMatch: boolean,
): Promise<{ matchIds: string[] } | { error: string }> {
  const [boundaryMatch] = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      draftData: matches.draftData,
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
        createdAt: matches.createdAt,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(
        eq(matches.status, 'completed'),
        inArray(matches.gameMode, gameModes),
        buildBoundaryCondition(boundaryMatch, includeFromMatch, 'after'),
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
          playerId: matchParticipants.playerId,
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

  const ratingStateByPlayer = createSeededRatingState(seedRows, affectedPlayerIds)
  const seasonProgress: SeasonProgress = { value: 0 }
  const hydrateResult = hydrateRatingStateUntilBoundary(
    ratingStateByPlayer,
    seasonRows,
    seasonProgress,
    earlierParticipantRows,
    boundaryMatch.createdAt,
  )
  if (typeof hydrateResult === 'string') return { error: hydrateResult }

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

function createSeededRatingState(seedRows: StoredSeedRow[], playerIds?: string[]): Map<string, RatingState> {
  const playerIdSet = playerIds ? new Set(playerIds) : null
  const ratingStateByPlayer = new Map<string, RatingState>()

  for (const seed of seedRows) {
    if (playerIdSet && !playerIdSet.has(seed.playerId)) continue

    ratingStateByPlayer.set(seed.playerId, {
      mu: seed.mu,
      sigma: seed.sigma,
      gamesPlayed: 0,
      wins: 0,
      lastPlayedAt: null,
    })
  }

  return ratingStateByPlayer
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
): string | null {
  let currentMatchId: string | null = null
  let currentMatchCreatedAt = 0
  let currentMatchCompletedAt: number | null = null
  let currentMatchRows: HistoricalParticipantRow[] = []

  const flushCurrentMatch = (): string | null => {
    if (!currentMatchId) return null

    applySeasonResetsUntil(ratingStateByPlayer, seasonRows, seasonProgress, currentMatchCreatedAt)

    for (const row of currentMatchRows) {
      if (row.placement == null) return `Completed match **${row.matchId}** has missing placements.`
      if (row.ratingAfterMu == null || row.ratingAfterSigma == null) {
        return `Completed match **${row.matchId}** has missing rating snapshots.`
      }

      const currentState = ratingStateByPlayer.get(row.playerId) ?? createDefaultRatingState(row.playerId)
      ratingStateByPlayer.set(row.playerId, {
        mu: row.ratingAfterMu,
        sigma: row.ratingAfterSigma,
        gamesPlayed: currentState.gamesPlayed + 1,
        wins: currentState.wins + (row.placement === 1 ? 1 : 0),
        lastPlayedAt: currentMatchCompletedAt ?? currentMatchCreatedAt,
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

async function replayCompletedMatch(
  db: Database,
  leaderboardMode: LeaderboardMode,
  match: StoredMatchRow,
  participantRows: StoredParticipantRow[],
  ratingStateByPlayer: Map<string, RatingState>,
): Promise<string | null> {
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return `Completed match **${match.id}** has unsupported game mode: ${match.gameMode}.`
  if (gameContext.leaderboardMode !== leaderboardMode) return null

  if (participantRows.length === 0) return `Completed match **${match.id}** has no participants.`
  if (participantRows.some(participant => participant.placement == null)) {
    return `Completed match **${match.id}** has missing placements.`
  }

  let ratingUpdates
  const gameMode = gameContext.mode

  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()

    for (const participant of participantRows) {
      const team = participant.team ?? 0
      const existingRating = ratingStateByPlayer.get(participant.playerId)
      const rating = existingRating
        ? { mu: existingRating.mu, sigma: existingRating.sigma }
        : createRating(participant.playerId)

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

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    const ffaEntries: FfaEntry[] = participantRows.map((participant) => {
      const existingRating = ratingStateByPlayer.get(participant.playerId)
      const rating = existingRating
        ? { mu: existingRating.mu, sigma: existingRating.sigma }
        : createRating(participant.playerId)

      return {
        player: {
          playerId: participant.playerId,
          mu: rating.mu,
          sigma: rating.sigma,
        },
        placement: participant.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  const updateByPlayer = new Map(ratingUpdates.map(update => [update.playerId, update]))
  const participantUpdateQueries: BatchItem[] = []

  for (const participant of participantRows) {
    const update = updateByPlayer.get(participant.playerId)
    if (!update) return `Failed to recalculate ratings for match **${match.id}**.`

    participantUpdateQueries.push(
      db
        .update(matchParticipants)
        .set({
          ratingBeforeMu: update.before.mu,
          ratingBeforeSigma: update.before.sigma,
          ratingAfterMu: update.after.mu,
          ratingAfterSigma: update.after.sigma,
        })
        .where(
          and(
            eq(matchParticipants.matchId, match.id),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        ),
    )

    const currentState = ratingStateByPlayer.get(participant.playerId) ?? createDefaultRatingState(participant.playerId)
    ratingStateByPlayer.set(participant.playerId, {
      mu: update.after.mu,
      sigma: update.after.sigma,
      gamesPlayed: currentState.gamesPlayed + 1,
      wins: currentState.wins + (participant.placement === 1 ? 1 : 0),
      lastPlayedAt: match.completedAt ?? match.createdAt,
    })
  }

  await runBatch(db, participantUpdateQueries)
  return null
}

async function replacePlayerRatings(
  db: Database,
  leaderboardMode: LeaderboardMode,
  ratingStateByPlayer: Map<string, RatingState>,
  playerIds?: string[],
): Promise<void> {
  const ratingQueries: BatchItem[] = []

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
        lastPlayedAt: state.lastPlayedAt,
      }),
    )
  }

  await runBatch(db, ratingQueries)
}

function createDefaultRatingState(playerId: string): RatingState {
  const rating = createRating(playerId)
  return {
    mu: rating.mu,
    sigma: rating.sigma,
    gamesPlayed: 0,
    wins: 0,
    lastPlayedAt: null,
  }
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

async function runBatch(db: Database, queries: BatchItem[]): Promise<void> {
  if (queries.length === 0) return

  const batchDb = db as unknown as BatchRunner
  if (typeof batchDb.batch === 'function') {
    await batchDb.batch(queries as [BatchItem, ...BatchItem[]])
    return
  }

  for (const query of queries) {
    await query
  }
}
