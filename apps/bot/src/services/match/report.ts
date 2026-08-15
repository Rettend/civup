import type { Database } from '@civup/db'
import type { SQL } from 'drizzle-orm'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, RatingUpdate, TeamInput } from '@civup/rating'
import type { DbBatchItem } from '../db/batch.ts'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import type { MatchRow, ParticipantRow, ReportInput, ReportProcessingClaim, ReportResult } from './types.ts'
import type { StatsContext } from '../stats/context.ts'
import { matchBans, matches, matchParticipants, playerRatingEvents as legacyPlayerRatingEvents, playerRatings as legacyPlayerRatings, players, scopedPlayerRatingEvents as playerRatingEvents, scopedPlayerRatings as playerRatings, sessionDirectory } from '@civup/db'
import { allFactionIds, getLeaderIds, isTeamMode } from '@civup/game'
import { calculatePublicRatingUpdate, calculateRatings, createRating, IMPORTED_GAME_EFFECTIVE_WEIGHT, PUBLIC_RATING_START, resolvePublicRating } from '@civup/rating'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { claimSessionReport, getSessionRecord, getSessionReportClaimStatus, releaseSessionReportClaim, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { runDbBatch } from '../db/batch.ts'
import { reconcileCivLeaderboardMatchContribution, removeCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { reconcilePlayerCivStatMatchContribution, reconcilePlayerCivStatMatchContributionFromRows, removePlayerCivStatMatchContribution } from '../leaderboard/player-civ-stats.ts'
import { getStoredLeaderboardModeSnapshot, rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { isMatchTournamentLinked, syncTournamentMatchAfterReport } from '../tournament/index.ts'
import { getCompletedAtFromDraftData, getDraftStateFromDraftData, getHiddenDraftFromDraftData, getLeaderDataVersionFromDraftData, getRedDeathFromDraftData, getStoredGameModeContext } from './draft-data.ts'
import { buildPermanentAllyFfaEffectiveRows, buildPermanentAllyFfaPlacementByPlayerId, calculatePermanentAllyFfaRatingUpdates } from './permanent-ally.ts'
import { parseOrderedParticipantIds, parseOrderedTeamIndexes, parsePermanentAllyFfaPlacements, resolveWinningTeamIndex } from './placements.ts'
import { hydrateModeRatingSnapshotsFromEvents } from './rating-events.ts'
import { buildRankByPlayer, recalculateGlobalRatings, recalculateLeaderboardMode } from './ratings.ts'
import { createStatsContext, requireStoredMatchGuildId } from '../stats/context.ts'

interface ReportMatchOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
  rankedRoleGuildId?: string | null
  minimalResult?: boolean
  primaryGuildId?: string
  now?: number
}

interface RatedReportMatchContext {
  id: string
  gameMode: string
  draftData: string | null
  seasonId: string | null
  isOld: boolean
  createdAt: number
  guildId: string | null
}

type RatingScope = LeaderboardMode | typeof GLOBAL_RATING_SCOPE

interface StoredRatingSummaryRow {
  playerId: string
  mode: RatingScope
  mu: number
  sigma: number
  publicRating: number | null
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
  updatedAt: number | null
}

interface MatchEvidenceDelta {
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
}

interface RatingScopeUpdateInput {
  statsContext: StatsContext
  scope: RatingScope
  match: RatedReportMatchContext
  gameMode: string
  permanentAlly: boolean
  participantRows: ParticipantRow[]
  existingRatingsByPlayerId: Map<string, StoredRatingSummaryRow>
  evidenceByPlayerId: Map<string, MatchEvidenceDelta>
  now: number
  writeParticipantSnapshots: boolean
}

const GLOBAL_RATING_SCOPE = 'global'

function withTournamentLinked(result: ReportResult, tournamentLinked: boolean): ReportResult {
  if ('error' in result) return result
  return { ...result, tournamentLinked }
}

interface RatingState {
  mu: number
  sigma: number
}

export async function reportMatch(
  db: Database,
  kv: KVNamespace,
  input: ReportInput,
  options: ReportMatchOptions = {},
): Promise<ReportResult> {
  let [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${input.matchId}** not found.` }
  }
  if (!match.guildId) return { error: `Match **${input.matchId}** is missing owning-server data.` }
  const statsContext = statsContextForMatch(match, options)

  const sessionId = await resolveSessionIdForMatch(db, input.matchId)

  let participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))
  const tournamentLinked = await isMatchTournamentLinked(db, input.matchId)

  const isParticipant = participantRows.some(p => p.playerId === input.reporterId)
  if (!isParticipant) {
    return { error: 'Only match participants can report results.' }
  }

  if (match.status === 'active' && getCompletedAtFromDraftData(match.draftData) == null) {
    return { error: `Match **${input.matchId}** is not ready to report until the draft is complete.` }
  }

  if (match.status === 'completed') {
    const processingResult = await buildReportProcessingResultIfClaimed(options, sessionId, match, participantRows)
    if (processingResult) return withTournamentLinked(processingResult, tournamentLinked)

    const sessionValidationError = await validateReportableSession(options, sessionId, input.matchId)
    if (sessionValidationError) return { error: sessionValidationError }

    if (!tournamentLinked) {
      const repaired = await repairCompletedReportedMatch(db, kv, match, participantRows, options)
      if (repaired) return withTournamentLinked(repaired, tournamentLinked)
    }

    const cleanupError = await ensureReportedMatchCleanup(db, options, input.matchId, Date.now(), null, false)
    if (cleanupError) return { error: cleanupError }
    if (tournamentLinked) {
      await resetParticipantRatingSnapshots(db, input.matchId)
      await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
      await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
      await syncTournamentMatchAfterReport(db, input.matchId)
      return { match, participants: withNoLeaderboardRanks(participantRows), idempotent: true, tournamentLinked }
    }

    await reconcileCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, match, participantRows)
    return { match, participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, match, participantRows), idempotent: true, tournamentLinked }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  const reportClaim = await claimReportedMatchProcessing(options, sessionId, input.matchId, input.reporterId)
  if ('error' in reportClaim) return reportClaim
  if (!reportClaim.claimed) {
    if (reportClaim.processing) return { match, participants: participantRows, idempotent: true, reportProcessing: true, reportFinalizing: reportClaim.finalizing, tournamentLinked }

    const cleanupError = await ensureReportedMatchCleanup(db, options, input.matchId, Date.now(), null, false)
    if (cleanupError) return { error: cleanupError }

    const [updatedMatch] = await db.select().from(matches).where(eq(matches.id, input.matchId)).limit(1)
    const updatedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, input.matchId))
    if (tournamentLinked) {
      await resetParticipantRatingSnapshots(db, input.matchId)
      await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
      await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
      await syncTournamentMatchAfterReport(db, input.matchId)
      const refreshedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, input.matchId))
      return { match: updatedMatch ?? match, participants: withNoLeaderboardRanks(refreshedParticipants), idempotent: true, tournamentLinked }
    }

    await reconcileCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, updatedMatch ?? match, updatedParticipants)
    return { match: updatedMatch ?? match, participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, updatedMatch ?? match, updatedParticipants), idempotent: true, tournamentLinked }
  }

  if (reportClaim.finalized) {
    const [refreshedMatch] = await db
      .select()
      .from(matches)
      .where(eq(matches.id, input.matchId))
      .limit(1)
    match = refreshedMatch
    if (!match) return { error: `Match **${input.matchId}** not found.` }

    participantRows = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, input.matchId))
  }

  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) {
    return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
  }

  const gameMode = gameContext.mode
  let reportCompleted = false
  try {
    const hasPreparedRatedReport = !tournamentLinked && gameContext.leaderboardMode != null
      && (hasPreparedRatedReportParticipantMarkers(participantRows) || await hasPreparedRatedReportEvents(db, statsContext, match.id, participantRows, gameContext.leaderboardMode))
    if (hasPreparedRatedReport && gameContext.leaderboardMode != null) {
      const preparedReport = await buildPreparedRatedReportResultIfRatingEventsExist(
        db,
        kv,
        match,
        participantRows,
        input.reporterId,
        options,
        gameContext.leaderboardMode,
      )
      if (preparedReport) return withTournamentLinked(preparedReport, tournamentLinked)
      participantRows = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, input.matchId))
    }

    const hiddenLeaderAssignments = getHiddenDraftFromDraftData(match.draftData)
      ? validateHiddenDraftLeaderAssignments(match.draftData, participantRows, input.leaderAssignments)
      : null
    if (hiddenLeaderAssignments && 'error' in hiddenLeaderAssignments) return hiddenLeaderAssignments

    const placementUpdates: DbBatchItem[] = []
    if (gameContext.permanentAlly && gameMode === 'ffa') {
      const parsedPlacements = parsePermanentAllyFfaPlacements(input.placements, participantRows)
      if ('error' in parsedPlacements) return parsedPlacements

      for (const participant of participantRows) {
        const placement = parsedPlacements.placementsByPlayer.get(participant.playerId)
        if (placement == null) return { error: `Permanent Ally FFA placement missing for <@${participant.playerId}>.` }
        placementUpdates.push(db
          .update(matchParticipants)
          .set({ placement })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.playerId, participant.playerId),
            ),
          ))
      }
    }
    else if (isTeamMode(gameMode) || gameMode === '1v1') {
      const uniqueTeams = new Set(participantRows.flatMap(participant => participant.team == null ? [] : [participant.team]))
      if (uniqueTeams.size > 2) {
        const parsedTeams = parseOrderedTeamIndexes(input.placements, participantRows)
        if ('error' in parsedTeams) return parsedTeams

        for (let index = 0; index < parsedTeams.orderedTeams.length; index++) {
          const teamIndex = parsedTeams.orderedTeams[index]!
          placementUpdates.push(db
            .update(matchParticipants)
            .set({ placement: index + 1 })
            .where(
              and(
                eq(matchParticipants.matchId, input.matchId),
                eq(matchParticipants.team, teamIndex),
              ),
            ))
        }

        const remainingTeams = [...uniqueTeams].filter(teamIndex => !parsedTeams.orderedTeams.includes(teamIndex))
        let nextPlacement = parsedTeams.orderedTeams.length + 1
        for (const teamIndex of remainingTeams) {
          placementUpdates.push(db
            .update(matchParticipants)
            .set({ placement: nextPlacement })
            .where(
              and(
                eq(matchParticipants.matchId, input.matchId),
                eq(matchParticipants.team, teamIndex),
              ),
            ))
          nextPlacement += 1
        }
      }
      else {
        const resolvedTeam = resolveWinningTeamIndex(input.placements, participantRows)
        if ('error' in resolvedTeam) return resolvedTeam

        const winTeamIdx = resolvedTeam.winningTeamIndex

        for (const participant of participantRows) {
          const placement = participant.team === winTeamIdx ? 1 : 2
          placementUpdates.push(db
            .update(matchParticipants)
            .set({ placement })
            .where(
              and(
                eq(matchParticipants.matchId, input.matchId),
                eq(matchParticipants.playerId, participant.playerId),
              ),
            ))
        }
      }
    }
    else {
      const parsedOrder = parseOrderedParticipantIds(input.placements, participantRows)
      if ('error' in parsedOrder) return parsedOrder
      const placementIds = parsedOrder.orderedIds

      for (let index = 0; index < placementIds.length; index++) {
        const playerId = placementIds[index]!
        placementUpdates.push(db
          .update(matchParticipants)
          .set({ placement: index + 1 })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.playerId, playerId),
            ),
          ))
      }

      const mentionedIds = new Set(placementIds)
      const unplaced = participantRows.filter(participant => !mentionedIds.has(participant.playerId))
      const lastPlace = placementIds.length + 1
      for (const participant of unplaced) {
        placementUpdates.push(db
          .update(matchParticipants)
          .set({ placement: lastPlace })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.playerId, participant.playerId),
            ),
          ))
      }
    }

    await runDbBatch(db, placementUpdates)

    if (hiddenLeaderAssignments) {
      await applyHiddenDraftLeaderAssignments(db, input.matchId, hiddenLeaderAssignments.assignments)
    }

    const updatedParticipants = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, input.matchId))

    if (updatedParticipants.some(participant => participant.placement === null)) {
      return { error: 'Could not resolve placements for all participants.' }
    }

    const finalized = await finalizeReportedMatch(db, kv, match, updatedParticipants, participantRows, input.reporterId, options, tournamentLinked)
    if ('error' in finalized) {
      return finalized
    }

    reportCompleted = true
    return reportClaim.claim ? { ...finalized, reportClaim: reportClaim.claim, tournamentLinked } : { ...finalized, tournamentLinked }
  }
  finally {
    if (!reportCompleted && reportClaim.claim) {
      await releaseReportedMatchProcessingClaim(options.sessionNamespace, reportClaim.claim).catch((error) => {
        console.error(`Failed to release report claim for match ${input.matchId}:`, error)
      })
    }
  }
}

type ReportProcessingClaimAttempt
  = | { claimed: true, claim: ReportProcessingClaim | null, finalized?: boolean }
    | { claimed: false, processing?: boolean, alreadyReported?: boolean, finalizing?: boolean }
    | { error: string }

async function buildReportProcessingResultIfClaimed(
  options: ReportMatchOptions,
  sessionId: string,
  match: MatchRow,
  participants: ParticipantRow[],
): Promise<ReportResult | null> {
  if (!options.sessionNamespace) return null
  try {
    const status = await getSessionReportClaimStatus(options.sessionNamespace, sessionId, { matchId: match.id })
    if (!status.claimed && status.processing) {
      return { match, participants, idempotent: true, reportProcessing: true }
    }
  }
  catch {
    return null
  }
  return null
}

async function claimReportedMatchProcessing(
  options: ReportMatchOptions,
  sessionId: string,
  matchId: string,
  reporterId: string,
): Promise<ReportProcessingClaimAttempt> {
  if (options.sessionNamespace) {
    try {
      const result = await claimSessionReport(options.sessionNamespace, sessionId, { matchId, reporterId })
      if (result.claimed) return { claimed: true, claim: result.claim ? { ...result.claim, sessionId } : null, finalized: result.finalized }
      return { claimed: false, processing: result.processing, alreadyReported: result.alreadyReported, finalizing: result.finalizing }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const sessionValidationError = await validateReportableSession(options, sessionId, matchId)
  if (sessionValidationError) return { error: sessionValidationError }
  return { claimed: true, claim: null }
}

export async function releaseReportedMatchProcessingClaim(
  sessionNamespace: DurableObjectNamespace | null | undefined,
  claim: ReportProcessingClaim,
): Promise<void> {
  if (!sessionNamespace) return
  await releaseSessionReportClaim(sessionNamespace, claim.sessionId, claim)
}

function validateHiddenDraftLeaderAssignments(
  draftData: string | null,
  participantRows: ParticipantRow[],
  input: Record<string, string> | undefined,
): { assignments: Map<string, string> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Hidden draft reports require leader assignments for every participant.' }
  }

  const participantIds = new Set(participantRows.map(participant => participant.playerId))
  const assignments = new Map<string, string>()
  for (const [playerId, civId] of Object.entries(input)) {
    if (!participantIds.has(playerId)) {
      return { error: `Leader assignment references an unknown participant: **${playerId}**.` }
    }
    if (typeof civId !== 'string' || civId.trim().length === 0) {
      return { error: `Leader assignment for **${playerId}** is missing a leader.` }
    }
    assignments.set(playerId, civId.trim())
  }

  for (const participant of participantRows) {
    if (!assignments.has(participant.playerId)) {
      return { error: 'Hidden draft reports require leader assignments for every participant.' }
    }
  }

  const draftState = getDraftStateFromDraftData(draftData)
  const validCivIds = new Set(getRedDeathFromDraftData(draftData) ? allFactionIds : getLeaderIds(getLeaderDataVersionFromDraftData(draftData)))
  for (const civId of draftState?.availableCivIds ?? []) validCivIds.add(civId)
  for (const ban of draftState?.bans ?? []) validCivIds.add(ban.civId)
  for (const pick of draftState?.picks ?? []) validCivIds.add(pick.civId)

  const assignedCivIds = [...assignments.values()]
  for (const civId of assignedCivIds) {
    if (!validCivIds.has(civId)) return { error: `Unknown leader assignment: **${civId}**.` }
  }

  if (draftState?.duplicateFactions !== true && new Set(assignedCivIds).size !== assignedCivIds.length) {
    return { error: 'Leader assignments must be unique for this match.' }
  }

  return { assignments }
}

async function applyHiddenDraftLeaderAssignments(
  db: Database,
  matchId: string,
  assignments: Map<string, string>,
): Promise<void> {
  const updates: DbBatchItem[] = []
  for (const [playerId, civId] of assignments) {
    updates.push(db
      .update(matchParticipants)
      .set({ civId })
      .where(and(
        eq(matchParticipants.matchId, matchId),
        eq(matchParticipants.playerId, playerId),
      )))
  }
  await runDbBatch(db, updates)
}

async function finalizeReportedMatch(
  db: Database,
  kv: KVNamespace,
  match: RatedReportMatchContext,
  participantRows: ParticipantRow[],
  originalParticipantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
  tournamentLinked: boolean,
): Promise<ReportResult> {
  const matchId = match.id
  const statsContext = statsContextForMatch(match, options)
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${match.id}** has unsupported game mode: ${match.gameMode}.` }

  if (tournamentLinked) {
    return finalizeReportedTournamentMatch(db, match, originalParticipantRows, reporterId, options)
  }

  const leaderboardMode = gameContext.leaderboardMode
  if (leaderboardMode == null) {
    return finalizeReportedUnrankedMatch(db, match, participantRows, originalParticipantRows, reporterId, options)
  }

  const now = options.now ?? Date.now()
  const cachedLeaderboardSnapshot = options.minimalResult ? null : await getStoredLeaderboardModeSnapshot(kv, statsContext, leaderboardMode)
  const beforeRankByPlayer = buildCachedRankByPlayer(cachedLeaderboardSnapshot, leaderboardMode, now)
  const existingRatingsByScope = await listPlayerRatingsForPlayers(
    db,
    statsContext,
    [leaderboardMode, GLOBAL_RATING_SCOPE],
    participantRows.map(participant => participant.playerId),
  )

  await runDbBatch(db, participantRows.map(participant => db
    .insert(players)
    .values({
      id: participant.playerId,
      displayName: participant.playerId,
      createdAt: now,
    })
    .onConflictDoNothing()))

  const applied = await applyIncrementalRatedReport(
    db,
    kv,
    options.rankedRoleGuildId,
    statsContext,
    match,
    gameContext.mode,
    gameContext.permanentAlly,
    leaderboardMode,
    participantRows,
    existingRatingsByScope,
    now,
  )
  if (applied) return { error: applied }

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackPreparedReportAfterLifecycleFailure(db, kv, options, match, leaderboardMode, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }

  await reconcileCivLeaderboardMatchContribution(db, statsContext, matchId)
  await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, { ...match, status: 'completed' }, participantRows, { updatedAt: now, previous: 'empty' })

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  if (options.minimalResult) {
    return {
      match: updatedMatch!,
      participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, updatedMatch!, updatedParticipants),
    }
  }

  const updatedRatingsByPlayerId = cachedLeaderboardSnapshot
    ? await listPlayerRatingsForPlayers(db, statsContext, leaderboardMode, updatedParticipants.map(participant => participant.playerId))
    : new Map<RatingScope, Map<string, StoredRatingSummaryRow>>()
  const afterRankContext = buildCachedRankContext(cachedLeaderboardSnapshot, leaderboardMode, updatedRatingsByPlayerId.get(leaderboardMode) ?? new Map(), now)

  const participantsWithLeaderboardRanks: ParticipantRow[] = updatedParticipants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankContext?.rankByPlayer.get(participant.playerId) ?? null,
    leaderboardEligibleCount: afterRankContext?.eligibleCount ?? null,
  }))

  return { match: updatedMatch!, participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, updatedMatch!, participantsWithLeaderboardRanks) }
}

async function hydrateParticipantRowsForRatingEvents<T extends ParticipantRow>(
  db: Database,
  statsContext: StatsContext,
  match: { gameMode: string, draftData: string | null },
  participants: readonly T[],
): Promise<T[]> {
  const hydrated = await hydrateModeRatingSnapshotsFromEvents(db, statsContext, participants.map(participant => ({
    ...participant,
    gameMode: match.gameMode,
    draftData: match.draftData,
  })))
  return hydrated.map((row, index) => ({
    ...participants[index]!,
    ratingBeforeMu: row.ratingBeforeMu,
    ratingBeforeSigma: row.ratingBeforeSigma,
    ratingAfterMu: row.ratingAfterMu,
    ratingAfterSigma: row.ratingAfterSigma,
    publicRatingBefore: row.publicRatingBefore,
    publicRatingAfter: row.publicRatingAfter,
  }))
}

function buildCachedRankByPlayer(
  snapshot: LeaderboardModeSnapshot | null,
  leaderboardMode: LeaderboardMode,
  now: number,
): Map<string, number> {
  return snapshot ? buildRankByPlayer(snapshot.rows, leaderboardMode, now) : new Map()
}

function buildCachedRankContext(
  snapshot: LeaderboardModeSnapshot | null,
  leaderboardMode: LeaderboardMode,
  updatedRatingsByPlayerId: Map<string, StoredRatingSummaryRow>,
  now: number,
): { rankByPlayer: Map<string, number>, eligibleCount: number } | null {
  if (!snapshot) return null

  const rowsByPlayerId = new Map(snapshot.rows.map(row => [row.playerId, row]))
  for (const [playerId, rating] of updatedRatingsByPlayerId) {
    rowsByPlayerId.set(playerId, {
      playerId,
      mode: leaderboardMode,
      mu: rating.mu,
      sigma: rating.sigma,
      publicRating: resolvePublicRating(rating.publicRating, rating.mu),
      gamesPlayed: rating.gamesPlayed,
      wins: rating.wins,
      lastPlayedAt: rating.lastPlayedAt,
    })
  }

  const rankByPlayer = buildRankByPlayer([...rowsByPlayerId.values()], leaderboardMode, now)
  return { rankByPlayer, eligibleCount: rankByPlayer.size }
}

async function listPlayerRatingsForPlayers(
  db: Database,
  statsContext: StatsContext,
  scopes: RatingScope | readonly RatingScope[],
  playerIds: readonly string[],
): Promise<Map<RatingScope, Map<string, StoredRatingSummaryRow>>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const requestedScopes = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).filter(scope => scope.length > 0))]
  if (uniquePlayerIds.length === 0 || requestedScopes.length === 0) return new Map()

  const rows = await db
    .select({
      mode: playerRatings.mode,
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      publicRating: playerRatings.publicRating,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      importedGames: playerRatings.importedGames,
      effectiveGames: playerRatings.effectiveGames,
      winsVsTier1: playerRatings.winsVsTier1,
      winsVsTier2Plus: playerRatings.winsVsTier2Plus,
      effectiveWinsVsTier1: playerRatings.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: playerRatings.effectiveWinsVsTier2Plus,
      lastPlayedAt: playerRatings.lastPlayedAt,
      updatedAt: playerRatings.updatedAt,
    })
    .from(playerRatings)
    .where(and(
      eq(playerRatings.statsKey, statsContext.statsKey),
      inArray(playerRatings.mode, requestedScopes),
      inArray(playerRatings.playerId, uniquePlayerIds),
    ))

  const byScope = new Map<RatingScope, Map<string, StoredRatingSummaryRow>>(requestedScopes.map(scope => [scope, new Map()]))
  for (const row of rows) {
    if (!requestedScopes.includes(row.mode as RatingScope)) continue
    const scope = row.mode as RatingScope
    byScope.get(scope)?.set(row.playerId, {
      mode: scope,
      playerId: row.playerId,
      mu: row.mu,
      sigma: row.sigma,
      publicRating: row.publicRating,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      importedGames: row.importedGames,
      effectiveGames: row.effectiveGames,
      winsVsTier1: row.winsVsTier1,
      winsVsTier2Plus: row.winsVsTier2Plus,
      effectiveWinsVsTier1: row.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus,
      lastPlayedAt: row.lastPlayedAt ?? null,
      updatedAt: row.updatedAt ?? null,
    })
  }

  if (statsContext.seasonPolicy === 'ppl-seasons') {
    const missingPlayerIds = uniquePlayerIds.filter(playerId => requestedScopes.some(scope => !byScope.get(scope)?.has(playerId)))
    if (missingPlayerIds.length > 0) {
      const legacyRows = await db
        .select()
        .from(legacyPlayerRatings)
        .where(and(
          inArray(legacyPlayerRatings.mode, requestedScopes),
          inArray(legacyPlayerRatings.playerId, missingPlayerIds),
        ))
      for (const row of legacyRows) {
        if (!requestedScopes.includes(row.mode as RatingScope)) continue
        const scope = row.mode as RatingScope
        if (byScope.get(scope)?.has(row.playerId)) continue
        byScope.get(scope)?.set(row.playerId, {
          mode: scope,
          playerId: row.playerId,
          mu: row.mu,
          sigma: row.sigma,
          publicRating: row.publicRating,
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
          importedGames: row.importedGames,
          effectiveGames: row.effectiveGames,
          winsVsTier1: row.winsVsTier1,
          winsVsTier2Plus: row.winsVsTier2Plus,
          effectiveWinsVsTier1: row.effectiveWinsVsTier1,
          effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus,
          lastPlayedAt: row.lastPlayedAt ?? null,
          updatedAt: row.updatedAt ?? null,
        })
      }
    }
  }

  return byScope
}

async function applyIncrementalRatedReport(
  db: Database,
  kv: KVNamespace,
  rankedRoleGuildId: string | null | undefined,
  statsContext: StatsContext,
  match: RatedReportMatchContext,
  gameMode: string,
  permanentAlly: boolean,
  leaderboardMode: LeaderboardMode,
  participantRows: ParticipantRow[],
  existingRatingsByScope: Map<RatingScope, Map<string, StoredRatingSummaryRow>>,
  now: number,
): Promise<string | null> {
  const opponentTierByPlayerId = await loadCurrentRankedRoleTierByPlayerId(kv, rankedRoleGuildId)
  const evidenceByPlayerId = buildMatchEvidenceByPlayerId(participantRows, match.isOld, opponentTierByPlayerId, permanentAlly)
  const modeQueries = buildRatingScopeUpdateQueries(db, {
    statsContext,
    scope: leaderboardMode,
    match,
    gameMode,
    permanentAlly,
    participantRows,
    existingRatingsByPlayerId: existingRatingsByScope.get(leaderboardMode) ?? new Map(),
    evidenceByPlayerId,
    now,
    writeParticipantSnapshots: true,
  })
  if (typeof modeQueries === 'string') return modeQueries

  const globalQueries = buildRatingScopeUpdateQueries(db, {
    statsContext,
    scope: GLOBAL_RATING_SCOPE,
    match,
    gameMode,
    permanentAlly,
    participantRows,
    existingRatingsByPlayerId: existingRatingsByScope.get(GLOBAL_RATING_SCOPE) ?? new Map(),
    evidenceByPlayerId,
    now,
    writeParticipantSnapshots: false,
  })
  if (typeof globalQueries === 'string') return globalQueries

  await runDbBatch(db, [...modeQueries, ...globalQueries])
  return null
}

function buildRatingScopeUpdateQueries(
  db: Database,
  input: RatingScopeUpdateInput,
): DbBatchItem[] | string {
  const placementByPlayerId = input.permanentAlly && input.gameMode === 'ffa'
    ? buildPermanentAllyFfaPlacementByPlayerId(input.participantRows)
    : new Map(input.participantRows.map(participant => [participant.playerId, participant.placement]))
  if ('error' in placementByPlayerId) return placementByPlayerId.error
  const playerRatingMap = new Map<string, { mu: number, sigma: number, gamesPlayed: number }>()

  for (const participant of input.participantRows) {
    const existing = input.existingRatingsByPlayerId.get(participant.playerId)
    if (existing) {
      playerRatingMap.set(participant.playerId, {
        mu: existing.mu,
        sigma: existing.sigma,
        gamesPlayed: existing.gamesPlayed,
      })
    }
    else {
      const fresh = createRating(participant.playerId)
      playerRatingMap.set(participant.playerId, { mu: fresh.mu, sigma: fresh.sigma, gamesPlayed: 0 })
    }
  }

  let ratingUpdates: RatingUpdate[]

  if (input.permanentAlly && input.gameMode === 'ffa') {
    const updates = calculatePermanentAllyFfaRatingUpdates(input.participantRows, (playerId) => {
      const rating = playerRatingMap.get(playerId)
      if (!rating) throw new Error(`Missing rating state for ${playerId}`)
      return rating
    })
    if ('error' in updates) return updates.error
    ratingUpdates = updates
  }
  else if (isTeamMode(input.gameMode as Parameters<typeof isTeamMode>[0]) || input.gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number, gamesPlayed: number }[]>()
    for (const participant of input.participantRows) {
      const team = participant.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(participant.playerId)
      if (!rating) return `Missing rating state for **${participant.playerId}**.`
      teams.get(team)?.push({
        playerId: participant.playerId,
        mu: rating.mu,
        sigma: rating.sigma,
        gamesPlayed: rating.gamesPlayed,
      })
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = input.participantRows.find(participant => participant.team === a[0])?.placement ?? 99
      const bPlacement = input.participantRows.find(participant => participant.team === b[0])?.placement ?? 99
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

    ratingUpdates = calculateRatings(
      { type: 'team', teams: teamInputs },
      { sourceWeight: input.match.isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1 },
    )
  }
  else {
    const ffaEntries: FfaEntry[] = input.participantRows.map((participant) => {
      const rating = playerRatingMap.get(participant.playerId)
      if (!rating) throw new Error(`Missing rating state for ${participant.playerId}`)
      return {
        player: { playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma },
        placement: participant.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  const queries: DbBatchItem[] = []

  for (const update of ratingUpdates) {
    const ratingBeforeMu = update.before.mu
    const sourceWeight = input.match.isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1
    const ratingAfter = scaleRatingAfterForSource(update, sourceWeight)
    const ratingAfterMu = ratingAfter.mu
    const ratingAfterSigma = ratingAfter.sigma

    if (input.writeParticipantSnapshots) {
      queries.push(db
        .update(matchParticipants)
        .set({
          ratingBeforeMu,
          ratingBeforeSigma: update.before.sigma,
          ratingAfterMu,
          ratingAfterSigma,
        })
        .where(and(
          eq(matchParticipants.matchId, input.match.id),
          eq(matchParticipants.playerId, update.playerId),
        ))
      )
    }

    const existing = input.existingRatingsByPlayerId.get(update.playerId)
    const publicUpdate = calculatePublicRatingUpdate({
      priorPublicRating: existing ? resolvePublicRating(existing.publicRating, existing.mu) : PUBLIC_RATING_START,
      hiddenMuBefore: update.before.mu,
      hiddenMuAfterRaw: update.after.mu,
      sourceWeight,
    })
    const isWin = placementByPlayerId.get(update.playerId) === 1
    const evidence = input.evidenceByPlayerId.get(update.playerId) ?? createEmptyMatchEvidenceDelta()
    const qualityWins = input.scope === GLOBAL_RATING_SCOPE
      ? evidence
      : createEmptyMatchEvidenceDelta()
    const row = {
      statsKey: input.statsContext.statsKey,
      playerId: update.playerId,
      mode: input.scope,
      mu: ratingAfterMu,
      sigma: ratingAfterSigma,
      publicRating: publicUpdate.after,
      gamesPlayed: (existing?.gamesPlayed ?? 0) + 1,
      wins: (existing?.wins ?? 0) + (isWin ? 1 : 0),
      importedGames: (existing?.importedGames ?? 0) + evidence.importedGames,
      effectiveGames: (existing?.effectiveGames ?? 0) + evidence.effectiveGames,
      winsVsTier1: (existing?.winsVsTier1 ?? 0) + qualityWins.winsVsTier1,
      winsVsTier2Plus: (existing?.winsVsTier2Plus ?? 0) + qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1: (existing?.effectiveWinsVsTier1 ?? 0) + qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: (existing?.effectiveWinsVsTier2Plus ?? 0) + qualityWins.effectiveWinsVsTier2Plus,
      lastPlayedAt: input.match.isOld ? (existing?.lastPlayedAt ?? null) : input.now,
      updatedAt: input.now,
    }
    const eventRow = {
      statsKey: input.statsContext.statsKey,
      matchId: input.match.id,
      playerId: update.playerId,
      mode: input.scope,
      gameMode: input.match.gameMode,
      ratingBeforeMu,
      ratingBeforeSigma: update.before.sigma,
      ratingAfterMu,
      ratingAfterSigma,
      publicRatingBefore: publicUpdate.before,
      publicRatingAfter: publicUpdate.after,
      gamesDelta: 1,
      winsDelta: isWin ? 1 : 0,
      importedGamesDelta: evidence.importedGames,
      effectiveGamesDelta: evidence.effectiveGames,
      winsVsTier1Delta: qualityWins.winsVsTier1,
      winsVsTier2PlusDelta: qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1Delta: qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2PlusDelta: qualityWins.effectiveWinsVsTier2Plus,
      matchCreatedAt: input.match.createdAt,
      matchCompletedAt: input.match.isOld ? input.match.createdAt : input.now,
      updatedAt: input.now,
    }

    queries.push(db.insert(playerRatings).values(row).onConflictDoUpdate({
      target: [playerRatings.statsKey, playerRatings.playerId, playerRatings.mode],
      set: row,
    }))
    queries.push(db.insert(playerRatingEvents).values(eventRow).onConflictDoUpdate({
      target: [playerRatingEvents.statsKey, playerRatingEvents.matchId, playerRatingEvents.playerId, playerRatingEvents.mode],
      set: eventRow,
    }))
    if (input.statsContext.seasonPolicy === 'ppl-seasons') {
      const { statsKey: _ratingStatsKey, ...legacyRatingRow } = row
      const { statsKey: _eventStatsKey, ...legacyEventRow } = eventRow
      queries.push(db.insert(legacyPlayerRatings).values(legacyRatingRow).onConflictDoUpdate({
        target: [legacyPlayerRatings.playerId, legacyPlayerRatings.mode],
        set: legacyRatingRow,
      }))
      queries.push(db.insert(legacyPlayerRatingEvents).values(legacyEventRow).onConflictDoUpdate({
        target: [legacyPlayerRatingEvents.matchId, legacyPlayerRatingEvents.playerId, legacyPlayerRatingEvents.mode],
        set: legacyEventRow,
      }))
    }
  }

  return queries
}

type PreparedRatedReportState = 'none' | 'complete' | 'partial'

function hasPreparedRatedReportParticipantMarkers(participantRows: ParticipantRow[]): boolean {
  return participantRows.some(participant => (
    participant.placement != null
    || participant.ratingBeforeMu != null
    || participant.ratingBeforeSigma != null
    || participant.ratingAfterMu != null
    || participant.ratingAfterSigma != null
  ))
}

async function hasPreparedRatedReportEvents(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
  participantRows: ParticipantRow[],
  leaderboardMode: LeaderboardMode,
): Promise<boolean> {
  const playerIds = [...new Set(participantRows.map(participant => participant.playerId).filter(playerId => playerId.length > 0))]
  if (playerIds.length === 0) return false
  return (await listPreparedRatingEventKeys(db, statsContext, matchId, playerIds, [leaderboardMode, GLOBAL_RATING_SCOPE])).size > 0
}

async function buildPreparedRatedReportResultIfRatingEventsExist(
  db: Database,
  kv: KVNamespace,
  match: MatchRow,
  participantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
  leaderboardMode: LeaderboardMode,
): Promise<ReportResult | null> {
  const statsContext = statsContextForMatch(match, options)
  const preparedState = await getPreparedRatedReportState(db, statsContext, match.id, participantRows, leaderboardMode)
  if (preparedState !== 'complete') {
    const rollbackError = await rollbackReportedRatedMatch(db, kv, {
      match,
      leaderboardMode,
      rankedRoleGuildId: options.rankedRoleGuildId,
      statsContext,
    })
    if (rollbackError) {
      return { error: `Match **${match.id}** has a partially prepared rating report. Automatic cleanup failed: ${rollbackError}` }
    }
    return null
  }

  const cleanupError = await ensureReportedMatchCleanup(db, options, match.id, Date.now(), reporterId, true)
  if (cleanupError) return { error: cleanupError }

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, match.id))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${match.id}** not found after cleanup.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, match.id))

  await reconcileCivLeaderboardMatchContribution(db, statsContext, match.id)
  await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, updatedMatch, updatedParticipants)
  return { match: updatedMatch, participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, updatedMatch, updatedParticipants), idempotent: true }
}

async function getPreparedRatedReportState(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
  participantRows: ParticipantRow[],
  leaderboardMode: LeaderboardMode,
): Promise<PreparedRatedReportState> {
  const playerIds = [...new Set(participantRows.map(participant => participant.playerId).filter(playerId => playerId.length > 0))]
  if (playerIds.length === 0) return 'none'

  const scopes = [leaderboardMode, GLOBAL_RATING_SCOPE]
  const eventKeys = await listPreparedRatingEventKeys(db, statsContext, matchId, playerIds, scopes)
  if (eventKeys.size === 0) return 'none'
  const complete = playerIds.every(playerId => scopes.every(scope => eventKeys.has(`${playerId}:${scope}`)))
  return complete ? 'complete' : 'partial'
}

async function listPreparedRatingEventKeys(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
  playerIds: readonly string[],
  scopes: readonly string[],
): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: playerRatingEvents.playerId, mode: playerRatingEvents.mode })
    .from(playerRatingEvents)
    .where(and(
      eq(playerRatingEvents.statsKey, statsContext.statsKey),
      eq(playerRatingEvents.matchId, matchId),
      inArray(playerRatingEvents.playerId, playerIds),
      inArray(playerRatingEvents.mode, scopes),
    ))
  const keys = new Set(rows.map(row => `${row.playerId}:${row.mode}`))
  if (statsContext.seasonPolicy !== 'ppl-seasons') return keys

  const legacyRows = await db
    .select({ playerId: legacyPlayerRatingEvents.playerId, mode: legacyPlayerRatingEvents.mode })
    .from(legacyPlayerRatingEvents)
    .where(and(
      eq(legacyPlayerRatingEvents.matchId, matchId),
      inArray(legacyPlayerRatingEvents.playerId, playerIds),
      inArray(legacyPlayerRatingEvents.mode, scopes),
    ))
  for (const row of legacyRows) keys.add(`${row.playerId}:${row.mode}`)
  return keys
}

function scaleRatingAfterForSource(update: ReturnType<typeof calculateRatings>[number], sourceWeight: number): { mu: number, sigma: number } {
  if (sourceWeight >= 1) return update.after
  return {
    mu: update.before.mu + ((update.after.mu - update.before.mu) * sourceWeight),
    sigma: update.before.sigma + ((update.after.sigma - update.before.sigma) * sourceWeight),
  }
}

function buildMatchEvidenceByPlayerId(
  participantRows: ParticipantRow[],
  isOld: boolean,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  permanentAlly = false,
): Map<string, MatchEvidenceDelta> {
  const sourceWeight = isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1
  const effectiveRows = permanentAlly ? buildPermanentAllyFfaEffectiveRows(participantRows) : participantRows
  const evidenceRows = 'error' in effectiveRows ? participantRows : effectiveRows
  return new Map(evidenceRows.map((participant) => {
    const qualityWins = countQualityWinsForParticipant(participant, evidenceRows, opponentTierByPlayerId, sourceWeight)
    return [participant.playerId, {
      importedGames: isOld ? 1 : 0,
      effectiveGames: sourceWeight,
      winsVsTier1: qualityWins.winsVsTier1,
      winsVsTier2Plus: qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1: qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: qualityWins.effectiveWinsVsTier2Plus,
    }]
  }))
}

function createEmptyMatchEvidenceDelta(): MatchEvidenceDelta {
  return {
    importedGames: 0,
    effectiveGames: 0,
    winsVsTier1: 0,
    winsVsTier2Plus: 0,
    effectiveWinsVsTier1: 0,
    effectiveWinsVsTier2Plus: 0,
  }
}

function countQualityWinsForParticipant(
  participant: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
  participantRows: Array<Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>>,
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
  participant: Pick<ParticipantRow, 'playerId' | 'team'>,
  participantRows: Array<Pick<ParticipantRow, 'playerId' | 'team'>>,
): number {
  if (participant.team == null) return 1
  return Math.max(1, participantRows.filter(row => row.team === participant.team).length)
}

function didDefeatOpponent(
  participant: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
  opponent: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
): boolean {
  if (participant.playerId === opponent.playerId) return false
  if (participant.team != null && opponent.team != null && participant.team === opponent.team) return false
  if (participant.placement == null || opponent.placement == null) return false
  return participant.placement < opponent.placement
}

async function loadCurrentRankedRoleTierByPlayerId(kv: KVNamespace, guildId: string | null | undefined): Promise<Map<string, string>> {
  if (!guildId) return new Map()
  const assignments = await getCurrentRankAssignments(kv, guildId)
  return new Map(Object.entries(assignments.byPlayerId).map(([playerId, assignment]) => [playerId, assignment.tier]))
}

function rankedRoleTierNumber(tier: string | null): number | null {
  if (!tier) return null
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value) : null
}

async function repairCompletedReportedMatch(
  db: Database,
  kv: KVNamespace,
  match: { id: string, gameMode: string, draftData: string | null, guildId?: string | null },
  participantRows: ParticipantRow[],
  options: ReportMatchOptions = {},
): Promise<ReportResult | null> {
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${match.id}** has unsupported game mode: ${match.gameMode}.` }
  if (gameContext.leaderboardMode == null) return null
  const statsContext = statsContextForMatch(match, options)

  const preparedState = await getPreparedRatedReportState(db, statsContext, match.id, participantRows, gameContext.leaderboardMode)
  if (!hasMissingRatingSnapshots(participantRows) && preparedState === 'complete') return null

  console.error(`Repairing incomplete reported match ${match.id}.`)

  const recalculated = await recalculateLeaderboardMode(db, gameContext.leaderboardMode, statsContext, {
    fromMatchId: match.id,
    includeFromMatch: true,
  })
  if ('error' in recalculated) return recalculated
  const recalculatedGlobal = await recalculateGlobalRatings(db, statsContext, {
    fromMatchId: match.id,
    includeFromMatch: true,
    opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
  })
  if ('error' in recalculatedGlobal) return recalculatedGlobal

  await rebuildLeaderboardModeSnapshot(db, kv, statsContext, gameContext.leaderboardMode)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, match.id))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${match.id}** not found after repair.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, match.id))

  const cleanupError = await ensureReportedMatchCleanup(db, options, match.id, Date.now(), null, false)
  if (cleanupError) return { error: cleanupError }
  await reconcileCivLeaderboardMatchContribution(db, statsContext, match.id)
  await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, updatedMatch, updatedParticipants)
  return { match: updatedMatch, participants: await hydrateParticipantRowsForRatingEvents(db, statsContext, updatedMatch, updatedParticipants), idempotent: true }
}

function hasMissingRatingSnapshots(participantRows: ParticipantRow[]): boolean {
  return participantRows.some(participant => (
    participant.ratingBeforeMu == null
    || participant.ratingBeforeSigma == null
    || participant.ratingAfterMu == null
    || participant.ratingAfterSigma == null
  ))
}

async function ensureReportedMatchCleanup(
  db: Database,
  options: ReportMatchOptions,
  matchId: string,
  reportedAt = Date.now(),
  reportedById: string | null = null,
  updateMatch = true,
): Promise<string | null> {
  const { sessionNamespace } = options
  const sessionId = await resolveSessionIdForMatch(db, matchId)
  if (sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(sessionNamespace, sessionId, { type: 'mark-reported', matchId, at: reportedAt, reportedById })
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return null
  }

  if (!options.allowDirectTerminalWriteForTests) {
    return 'SessionDO binding is required to finalize reported match state.'
  }

  if (updateMatch) {
    const values: { status: string, completedAt: number, cancelledAt: null, resultRevision: SQL, draftData?: string | null } = {
      status: 'completed',
      completedAt: reportedAt,
      cancelledAt: null,
      resultRevision: sql`${matches.resultRevision} + 1`,
    }
    if (reportedById) {
      const [match] = await db
        .select({ draftData: matches.draftData })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      if (match) values.draftData = setReportedByInDraftData(match.draftData, reportedById)
    }
    await db.update(matches).set(values).where(eq(matches.id, matchId))
  }
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return null
}

async function validateReportableSession(
  options: ReportMatchOptions,
  sessionId: string,
  matchId: string,
): Promise<string | null> {
  const { sessionNamespace } = options
  if (!sessionNamespace) {
    return options.allowDirectTerminalWriteForTests ? null : 'SessionDO binding is required to validate match lifecycle.'
  }
  try {
    const record = await getSessionRecord(sessionNamespace, sessionId)
    if (!record) return `Session **${sessionId}** not found.`
    if (record.matchId !== matchId) return `Session **${sessionId}** does not own match **${matchId}**.`
    if (record.phase === 'reported') return null
    if (record.phase === 'cancelled') return 'Cancelled sessions cannot be reported'
    if (record.phase !== 'active' && record.phase !== 'swap') return `Session is not reportable (phase: ${record.phase})`
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function rollbackReportedRatedMatch(
  db: Database,
  kv: KVNamespace,
  options: {
    match: { id: string, draftData: string | null }
    leaderboardMode: LeaderboardMode
    participantRows?: ParticipantRow[]
    rankedRoleGuildId?: string | null
    statsContext: StatsContext
  },
): Promise<string | null> {
  try {
    if (options.participantRows) {
      for (const participant of options.participantRows) {
        await db
          .update(matchParticipants)
          .set({
            civId: participant.civId,
            placement: participant.placement,
            ratingBeforeMu: participant.ratingBeforeMu,
            ratingBeforeSigma: participant.ratingBeforeSigma,
            ratingAfterMu: participant.ratingAfterMu,
            ratingAfterSigma: participant.ratingAfterSigma,
          })
          .where(and(
            eq(matchParticipants.matchId, options.match.id),
            eq(matchParticipants.playerId, participant.playerId),
          ))
      }
    }
    else {
      await db
        .update(matchParticipants)
        .set({
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        })
        .where(eq(matchParticipants.matchId, options.match.id))
    }

    await db
      .update(matches)
      .set({
        status: 'active',
        completedAt: null,
        draftData: options.match.draftData,
      })
      .where(eq(matches.id, options.match.id))

    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, options.statsContext, {
      fromMatchId: options.match.id,
      includeFromMatch: false,
    })
    if ('error' in recalculated) return recalculated.error
    const recalculatedGlobal = await recalculateGlobalRatings(db, options.statsContext, {
      fromMatchId: options.match.id,
      includeFromMatch: false,
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
    })
    if ('error' in recalculatedGlobal) return recalculatedGlobal.error

    await rebuildLeaderboardModeSnapshot(db, kv, options.statsContext, options.leaderboardMode)
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function rollbackPreparedReportAfterLifecycleFailure(
  db: Database,
  kv: KVNamespace,
  options: ReportMatchOptions,
  match: { id: string, draftData: string | null, gameMode: string, seasonId: string | null, guildId?: string | null },
  leaderboardMode: LeaderboardMode,
  participantRows?: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(db, options, match.id)) return null
  return rollbackReportedRatedMatch(db, kv, {
    match,
    leaderboardMode,
    participantRows,
    rankedRoleGuildId: options.rankedRoleGuildId,
    statsContext: statsContextForMatch(match, options),
  })
}

async function rollbackParticipantRowsAfterLifecycleFailure(
  db: Database,
  options: ReportMatchOptions,
  matchId: string,
  participants: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(db, options, matchId)) return null
  try {
    for (const participant of participants) {
      await db
        .update(matchParticipants)
        .set({
          civId: participant.civId,
          placement: participant.placement,
          ratingBeforeMu: participant.ratingBeforeMu,
          ratingBeforeSigma: participant.ratingBeforeSigma,
          ratingAfterMu: participant.ratingAfterMu,
          ratingAfterSigma: participant.ratingAfterSigma,
        })
        .where(and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ))
    }
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function shouldRollbackPreparedReportedMatch(db: Database, options: ReportMatchOptions, matchId: string): Promise<boolean> {
  if (!options.sessionNamespace) return false
  try {
    const sessionId = await resolveSessionIdForMatch(db, matchId)
    const record = await getSessionRecord(options.sessionNamespace, sessionId)
    if (!record) return false
    return record.phase === 'active' || record.phase === 'swap'
  }
  catch {
    return false
  }
}

async function resolveSessionIdForMatch(db: Database, matchId: string): Promise<string> {
  const [row] = await db
    .select({ sessionId: sessionDirectory.sessionId })
    .from(sessionDirectory)
    .where(eq(sessionDirectory.matchId, matchId))
    .limit(1)
  return row?.sessionId ?? matchId
}

async function finalizeReportedUnrankedMatch(
  db: Database,
  match: { id: string, draftData: string | null, gameMode: string, seasonId: string | null, guildId?: string | null },
  participantRows: ParticipantRow[],
  originalParticipantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
): Promise<ReportResult> {
  const matchId = match.id
  const now = Date.now()

  await db
    .update(matchParticipants)
    .set({
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, matchId))

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, matchId, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }
  await reconcileCivLeaderboardMatchContribution(db, statsContextForMatch(match, options), matchId)
  await reconcilePlayerCivStatMatchContributionFromRows(db, statsContextForMatch(match, options), { ...match, status: 'completed' }, participantRows, { updatedAt: now, previous: 'empty' })

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return {
    match: updatedMatch!,
    participants: updatedParticipants.map(participant => ({
      ...participant,
      leaderboardBeforeRank: null,
      leaderboardAfterRank: null,
      leaderboardEligibleCount: null,
    })),
  }
}

async function finalizeReportedTournamentMatch(
  db: Database,
  match: { id: string, draftData: string | null, guildId?: string | null },
  originalParticipantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
): Promise<ReportResult> {
  const matchId = match.id
  const now = Date.now()

  await resetParticipantRatingSnapshots(db, matchId)

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, matchId, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }

  await removeCivLeaderboardMatchContribution(db, statsContextForMatch(match, options), matchId)
  await removePlayerCivStatMatchContribution(db, statsContextForMatch(match, options), matchId)
  await syncTournamentMatchAfterReport(db, matchId)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return {
    match: updatedMatch!,
    participants: withNoLeaderboardRanks(updatedParticipants),
  }
}

function statsContextForMatch(match: { guildId?: string | null }, options: ReportMatchOptions): StatsContext {
  return createStatsContext(requireStoredMatchGuildId(match), options.primaryGuildId ?? '')
}

async function resetParticipantRatingSnapshots(db: Database, matchId: string): Promise<void> {
  await db
    .update(matchParticipants)
    .set({
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, matchId))
}

function withNoLeaderboardRanks(participants: ParticipantRow[]): ParticipantRow[] {
  return participants.map(participant => ({
    ...participant,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
    leaderboardBeforeRank: null,
    leaderboardAfterRank: null,
    leaderboardEligibleCount: null,
  }))
}

function setReportedByInDraftData(draftData: string | null, reporterId: string): string | null {
  const normalizedReporterId = reporterId.trim()
  if (normalizedReporterId.length === 0) return draftData
  if (!draftData) return JSON.stringify({ reportedById: normalizedReporterId })

  try {
    const parsed = JSON.parse(draftData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return draftData
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      reportedById: normalizedReporterId,
    })
  }
  catch {
    return draftData
  }
}
