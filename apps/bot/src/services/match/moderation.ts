import type { Database } from '@civup/db'
import type { DraftState, LeaderboardMode } from '@civup/game'
import type { DbBatchItem } from '../db/batch.ts'
import type { StatsContext } from '../stats/context.ts'
import type { CancelMatchInput, CancelMatchResult, CorrectMatchLeadersInput, CorrectMatchLeadersResult, MatchLeaderCorrection, MatchPlayerSubstitution, MatchRow, ParticipantRow, ResolveMatchInput, ResolveMatchResult, SubstituteMatchPlayerInput, SubstituteMatchPlayerResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatingEvents as legacyPlayerRatingEvents, players, scopedPlayerRatingEvents as playerRatingEvents } from '@civup/db'
import { allFactionIds, getLeaderIds, isTeamMode, parseGameMode } from '@civup/game'
import { and, eq, sql } from 'drizzle-orm'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { runDbBatch } from '../db/batch.ts'
import { fetchGuildMember, isDiscordApiError } from '../discord/index.ts'
import { reconcileCivLeaderboardMatchContribution, removeCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { reconcilePlayerCivStatMatchContribution, reconcilePlayerCivStatMatchContributionFromRows, removePlayerCivStatMatchContribution } from '../leaderboard/player-civ-stats.ts'
import { rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { isMatchTournamentLinked, syncTournamentMatchAfterCancel, syncTournamentMatchAfterReport } from '../tournament/index.ts'
import { getLeaderDataVersionFromDraftData, getRedDeathFromDraftData, getStoredGameModeContext, isManualReportDraftData } from './draft-data.ts'
import { splitValuesForD1InsertLimit } from './draft.ts'
import { parseModerationPlacements } from './placements.ts'
import { recalculateGlobalRatings, recalculateLeaderboardMode } from './ratings.ts'
import { hydrateModeRatingSnapshotsFromEvents } from './rating-events.ts'
import { createStatsContext, requireStoredMatchGuildId } from '../stats/context.ts'
import { getSessionOriginByMatch } from '../session/lobby-projection.ts'

const MATCH_PARTICIPANT_INSERT_COLUMN_COUNT = 11

interface MatchSessionLifecycleOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
  rankedRoleGuildId?: string | null
  primaryGuildId?: string
  discordToken?: string
}

interface MatchBanRow {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

export async function resolveMatchByModerator(
  db: Database,
  kv: KVNamespace,
  input: ResolveMatchInput,
  options: MatchSessionLifecycleOptions = {},
): Promise<ResolveMatchResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  const statsContext = getMatchStatsContext(match, options)
  if (!statsContext) return { error: `Match **${input.matchId}** is missing valid owning-server configuration.` }
  if (match.status === 'drafting') {
    return { error: `Match **${input.matchId}** is still drafting and cannot be resolved yet.` }
  }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
  const tournamentLinked = await isMatchTournamentLinked(db, input.matchId)

  const previousStatus = match.status

  const sessionValidationError = await validateReportableSession(db, options, input.matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  const parsedPlacements = parseModerationPlacements(gameContext.mode, input.placements, participants, { permanentAlly: gameContext.permanentAlly })
  if ('error' in parsedPlacements) return parsedPlacements

  const leaderboardMode = gameContext.leaderboardMode
  const originalBans = await db
    .select()
    .from(matchBans)
    .where(eq(matchBans.matchId, input.matchId))

  const applyQueries: DbBatchItem[] = []
  for (const participant of participants) {
    const placement = parsedPlacements.placementsByPlayer.get(participant.playerId)
    if (placement == null) return { error: `Failed to resolve placement for <@${participant.playerId}>.` }

    applyQueries.push(
      db
        .update(matchParticipants)
        .set(tournamentLinked
          ? {
              placement,
              ratingBeforeMu: null,
              ratingBeforeSigma: null,
              ratingAfterMu: null,
              ratingAfterSigma: null,
            }
          : { placement })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        ),
    )
  }

  let recalculatedMatchIds: string[] = []
  if (leaderboardMode == null || tournamentLinked) {
    await runDbBatch(db, applyQueries)
    const lifecycleError = await runTerminalSessionCommand(db, options, input.matchId, { type: 'mark-reported', at: input.resolvedAt })
    if (lifecycleError) {
      const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, input.matchId, participants)
      if (rollbackError) return { error: `${lifecycleError} Automatic rollback also failed: ${rollbackError}` }
      return { error: lifecycleError }
    }
    if (tournamentLinked) await syncTournamentMatchAfterReport(db, input.matchId)
  }
  else {
    try {
      await runDbBatch(db, applyQueries)
      if (previousStatus === 'completed') {
        const prepareError = await prepareReportedMatchForRecalculation(db, input.matchId, input.resolvedAt)
        if (prepareError) return { error: prepareError }
      }

      const recalculated = await recalculateLeaderboardMode(db, leaderboardMode, statsContext, {
        fromMatchId: input.matchId,
        includeFromMatch: true,
        includeActiveBoundary: previousStatus !== 'completed',
      })
      if ('error' in recalculated) {
        const rollbackError = await rollbackResolvedMatchRows(db, {
          input,
          match,
          participants,
          bans: originalBans,
          statsContext,
        })
        if (rollbackError) return { error: `${recalculated.error} Automatic rollback also failed: ${rollbackError}` }
        return recalculated
      }
      const recalculatedGlobal = await recalculateGlobalRatings(db, statsContext, {
        fromMatchId: input.matchId,
        includeFromMatch: true,
        includeActiveBoundary: previousStatus !== 'completed',
        opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
      })
      if ('error' in recalculatedGlobal) {
        const rollbackError = await rollbackResolvedMatchModeration(db, kv, {
          input,
          match,
          participants,
          bans: originalBans,
          leaderboardMode,
          rankedRoleGuildId: options.rankedRoleGuildId,
          statsContext,
        })
        if (rollbackError) return { error: `${recalculatedGlobal.error} Automatic rollback also failed: ${rollbackError}` }
        return recalculatedGlobal
      }

      recalculatedMatchIds = recalculated.matchIds

      const lifecycleError = await runTerminalSessionCommand(db, options, input.matchId, { type: 'mark-reported', at: input.resolvedAt })
      if (lifecycleError) {
        const rollbackError = await rollbackResolvedMatchAfterLifecycleFailure(db, kv, options, {
          input,
          match,
          participants,
          bans: originalBans,
          leaderboardMode,
          rankedRoleGuildId: options.rankedRoleGuildId,
          statsContext,
        })
        if (rollbackError) return { error: `${lifecycleError} Automatic rollback also failed: ${rollbackError}` }
        return { error: lifecycleError }
      }
    }
    catch (error) {
      const rollbackError = await rollbackResolvedMatchModeration(db, kv, {
        input,
        match,
        participants,
        bans: originalBans,
        leaderboardMode,
          rankedRoleGuildId: options.rankedRoleGuildId,
          statsContext,
      })
      if (rollbackError) {
        console.error(`Failed to roll back resolved match ${input.matchId}:`, rollbackError)
      }
      throw error
    }
  }

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${input.matchId}** not found after resolving.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (tournamentLinked) {
    await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
  }
  else {
    await reconcileCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, updatedMatch, updatedParticipants)
  }

  return {
    match: updatedMatch,
    participants: await hydrateModeratedParticipants(db, statsContext, updatedMatch, updatedParticipants),
    previousStatus,
    recalculatedMatchIds,
  }
}

export async function correctMatchLeadersByModerator(
  db: Database,
  input: CorrectMatchLeadersInput,
  options: MatchSessionLifecycleOptions = {},
): Promise<CorrectMatchLeadersResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  if (match.status !== 'completed') return { error: `Match **${input.matchId}** must be reported before leaders can be corrected.` }
  const statsContext = getMatchStatsContext(match, options)
  if (!statsContext) return { error: `Match **${input.matchId}** is missing valid owning-server configuration.` }

  const hasLeader = typeof input.leaderId === 'string' && input.leaderId.trim().length > 0
  const hasSwapWith = typeof input.swapWithPlayerId === 'string' && input.swapWithPlayerId.trim().length > 0
  if (hasLeader === hasSwapWith) return { error: 'Provide exactly one of `leader` or `swap_with`.' }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const participant = participants.find(candidate => candidate.playerId === input.playerId)
  if (!participant) return { error: `<@${input.playerId}> is not a participant in match **${input.matchId}**.` }

  const corrections: MatchLeaderCorrection[] = []
  if (hasLeader) {
    const leaderId = input.leaderId!.trim()
    const validCivIds = new Set(getRedDeathFromDraftData(match.draftData) ? allFactionIds : getLeaderIds(getLeaderDataVersionFromDraftData(match.draftData)))
    if (!validCivIds.has(leaderId)) return { error: `Unknown leader: **${leaderId}**.` }
    corrections.push({
      playerId: participant.playerId,
      previousCivId: participant.civId,
      nextCivId: leaderId,
    })
  }
  else {
    const swapWithPlayerId = input.swapWithPlayerId!.trim()
    if (swapWithPlayerId === participant.playerId) return { error: '`swap_with` must be a different participant.' }
    const swapParticipant = participants.find(candidate => candidate.playerId === swapWithPlayerId)
    if (!swapParticipant) return { error: `<@${swapWithPlayerId}> is not a participant in match **${input.matchId}**.` }
    if (!participant.civId || !swapParticipant.civId) return { error: 'Both participants must already have leaders to swap.' }
    corrections.push(
      { playerId: participant.playerId, previousCivId: participant.civId, nextCivId: swapParticipant.civId },
      { playerId: swapParticipant.playerId, previousCivId: swapParticipant.civId, nextCivId: participant.civId },
    )
  }

  const applyQueries: DbBatchItem[] = []
  for (const correction of corrections) {
    if (correction.previousCivId === correction.nextCivId) continue
    applyQueries.push(db
      .update(matchParticipants)
      .set({ civId: correction.nextCivId })
      .where(and(
        eq(matchParticipants.matchId, input.matchId),
        eq(matchParticipants.playerId, correction.playerId),
      )))
  }

  const nextDraftData = applyLeaderCorrectionsToDraftData(match.draftData, match.gameMode, participants, corrections)
  if (nextDraftData !== match.draftData) {
    applyQueries.push(db
      .update(matches)
      .set({ draftData: nextDraftData, resultRevision: sql`${matches.resultRevision} + 1` })
      .where(eq(matches.id, input.matchId)))
  }

  await runDbBatch(db, applyQueries)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${input.matchId}** not found after correcting leaders.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (await isMatchTournamentLinked(db, input.matchId)) {
    await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
  }
  else {
    await reconcileCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await reconcilePlayerCivStatMatchContributionFromRows(db, statsContext, updatedMatch, updatedParticipants)
  }

  return {
    match: updatedMatch,
    participants: await hydrateModeratedParticipants(db, statsContext, updatedMatch, updatedParticipants),
    previousStatus: match.status,
    recalculatedMatchIds: [],
    corrections,
  }
}

export async function substituteMatchPlayerByModerator(
  db: Database,
  kv: KVNamespace,
  input: SubstituteMatchPlayerInput,
  options: MatchSessionLifecycleOptions = {},
): Promise<SubstituteMatchPlayerResult> {
  const playerId = input.playerId.trim()
  const subPlayer = {
    playerId: input.subPlayer.playerId.trim(),
    displayName: input.subPlayer.displayName.trim() || input.subPlayer.playerId.trim(),
    avatarUrl: input.subPlayer.avatarUrl ?? null,
  }
  if (!playerId) return { error: 'Provide a player to substitute.' }
  if (!subPlayer.playerId) return { error: 'Provide a substitute player.' }
  if (playerId === subPlayer.playerId) return { error: '`sub` must be a different player.' }

  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  if (match.status !== 'active' && match.status !== 'completed') {
    return { error: `Match **${input.matchId}** must be draft-complete or reported before players can be substituted.` }
  }
  const statsContext = getMatchStatsContext(match, options)
  if (!statsContext) return { error: `Match **${input.matchId}** is missing valid owning-server configuration.` }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }
  const participant = participants.find(candidate => candidate.playerId === playerId)
  if (!participant) return { error: `<@${playerId}> is not a participant in match **${input.matchId}**.` }
  if (!participant.sourceGuildId) return { error: `The replaced seat in match **${input.matchId}** is missing source-server data.` }
  if (!options.discordToken) return { error: 'Discord membership verification is unavailable.' }
  try {
    await fetchGuildMember(options.discordToken, participant.sourceGuildId, subPlayer.playerId)
  }
  catch (error) {
    if (isDiscordApiError(error, 404)) {
      return { error: `<@${subPlayer.playerId}> must be a member of the replaced seat's source server.` }
    }
    throw error
  }

  const draftSubstitution = buildDraftPlayerSubstitution(match.draftData, {
    matchId: input.matchId,
    playerId,
    subPlayer,
  })
  if ('error' in draftSubstitution) return draftSubstitution

  const participantRows = buildSubstitutedParticipantRows(input.matchId, participants, draftSubstitution)
  if ('error' in participantRows) return participantRows

  const substitutions = buildPlayerSubstitutionSummaries(draftSubstitution, participantRows.rows)
  const nextBanRows = buildMatchBanRowsFromDraftState(draftSubstitution.nextState)
  const originalBans = await db
    .select()
    .from(matchBans)
    .where(eq(matchBans.matchId, input.matchId))
  const tournamentLinked = await isMatchTournamentLinked(db, input.matchId)
  const gameContext = getStoredGameModeContext(match.gameMode, draftSubstitution.nextDraftData)
  if (!gameContext) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }

  await upsertSubstitutePlayer(db, subPlayer, input.correctedAt)
  await replaceMatchParticipantRows(db, input.matchId, participantRows.rows)
  await replaceMatchBanRows(db, input.matchId, nextBanRows)
  await db
    .update(matches)
    .set({
      draftData: draftSubstitution.nextDraftData,
      resultRevision: sql`${matches.resultRevision} + 1`,
    })
    .where(eq(matches.id, input.matchId))

  let recalculatedMatchIds: string[] = []
  const extraAffectedPlayerIds = draftSubstitution.removedPlayerIds
  if (match.status === 'completed' && gameContext.leaderboardMode != null && !tournamentLinked) {
    const recalculated = await recalculateLeaderboardMode(db, gameContext.leaderboardMode, statsContext, {
      fromMatchId: input.matchId,
      includeFromMatch: true,
      extraAffectedPlayerIds,
    })
    if ('error' in recalculated) {
      const rollbackError = await rollbackMatchPlayerSubstitution(db, kv, {
        match,
        participants,
        bans: originalBans,
        leaderboardMode: gameContext.leaderboardMode,
        rankedRoleGuildId: options.rankedRoleGuildId,
        extraAffectedPlayerIds: substitutions.flatMap(substitution => [substitution.previousPlayerId, substitution.nextPlayerId]),
        tournamentLinked,
        statsContext,
      })
      if (rollbackError) return { error: `${recalculated.error} Automatic rollback also failed: ${rollbackError}` }
      return recalculated
    }

    const recalculatedGlobal = await recalculateGlobalRatings(db, statsContext, {
      fromMatchId: input.matchId,
      includeFromMatch: true,
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
      extraAffectedPlayerIds,
    })
    if ('error' in recalculatedGlobal) {
      const rollbackError = await rollbackMatchPlayerSubstitution(db, kv, {
        match,
        participants,
        bans: originalBans,
        leaderboardMode: gameContext.leaderboardMode,
        rankedRoleGuildId: options.rankedRoleGuildId,
        extraAffectedPlayerIds: substitutions.flatMap(substitution => [substitution.previousPlayerId, substitution.nextPlayerId]),
        tournamentLinked,
        statsContext,
      })
      if (rollbackError) return { error: `${recalculatedGlobal.error} Automatic rollback also failed: ${rollbackError}` }
      return recalculatedGlobal
    }

    await rebuildLeaderboardModeSnapshot(db, kv, statsContext, gameContext.leaderboardMode)
    recalculatedMatchIds = recalculated.matchIds
  }

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${input.matchId}** not found after substituting player.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (tournamentLinked) {
    await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
  }
  else {
    await reconcileCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await reconcilePlayerCivStatMatchContribution(db, statsContext, input.matchId)
  }

  return {
    match: updatedMatch,
    participants: await hydrateModeratedParticipants(db, statsContext, updatedMatch, updatedParticipants),
    previousStatus: match.status,
    recalculatedMatchIds,
    substitutions,
  }
}

async function rollbackResolvedMatchModeration(
  db: Database,
  kv: KVNamespace,
  options: {
    input: ResolveMatchInput
    match: MatchRow
    participants: ParticipantRow[]
    bans: MatchBanRow[]
    leaderboardMode: LeaderboardMode
    rankedRoleGuildId?: string | null
    statsContext: StatsContext
  },
): Promise<string | null> {
  const rowRollbackError = await rollbackResolvedMatchRows(db, options)
  if (rowRollbackError) return rowRollbackError

  try {
    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, options.statsContext, {
      fromMatchId: options.input.matchId,
      includeFromMatch: options.match.status === 'completed',
    })
    if ('error' in recalculated) return recalculated.error
    const recalculatedGlobal = await recalculateGlobalRatings(db, options.statsContext, {
      fromMatchId: options.input.matchId,
      includeFromMatch: options.match.status === 'completed',
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

async function rollbackResolvedMatchRows(
  db: Database,
  options: {
    input: ResolveMatchInput
    match: MatchRow
    participants: ParticipantRow[]
    bans: MatchBanRow[]
    statsContext: StatsContext
  },
): Promise<string | null> {
  try {
    const rollbackQueries: DbBatchItem[] = options.participants.map(participant => db
      .update(matchParticipants)
      .set({
        placement: participant.placement,
        ratingBeforeMu: participant.ratingBeforeMu,
        ratingBeforeSigma: participant.ratingBeforeSigma,
        ratingAfterMu: participant.ratingAfterMu,
        ratingAfterSigma: participant.ratingAfterSigma,
      })
      .where(and(
        eq(matchParticipants.matchId, options.input.matchId),
        eq(matchParticipants.playerId, participant.playerId),
      )))

    rollbackQueries.push(
      db
        .update(matches)
        .set({
          status: options.match.status,
          completedAt: options.match.completedAt,
        })
        .where(eq(matches.id, options.input.matchId)),
      db.delete(matchBans).where(eq(matchBans.matchId, options.input.matchId)),
    )

    if (options.bans.length > 0) rollbackQueries.push(db.insert(matchBans).values(options.bans))

    await runDbBatch(db, rollbackQueries)
    await reconcileCivLeaderboardMatchContribution(db, options.statsContext, options.input.matchId)
    await reconcilePlayerCivStatMatchContribution(db, options.statsContext, options.input.matchId)
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function rollbackResolvedMatchAfterLifecycleFailure(
  db: Database,
  kv: KVNamespace,
  options: MatchSessionLifecycleOptions,
  rollbackOptions: Parameters<typeof rollbackResolvedMatchModeration>[2],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(db, options, rollbackOptions.input.matchId)) return null
  return rollbackResolvedMatchModeration(db, kv, rollbackOptions)
}

async function rollbackParticipantRowsAfterLifecycleFailure(
  db: Database,
  options: MatchSessionLifecycleOptions,
  matchId: string,
  participants: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(db, options, matchId)) return null
  try {
    await runDbBatch(db, participants.map(participant => db
      .update(matchParticipants)
      .set({
        placement: participant.placement,
        ratingBeforeMu: participant.ratingBeforeMu,
        ratingBeforeSigma: participant.ratingBeforeSigma,
        ratingAfterMu: participant.ratingAfterMu,
        ratingAfterSigma: participant.ratingAfterSigma,
      })
      .where(and(
        eq(matchParticipants.matchId, matchId),
        eq(matchParticipants.playerId, participant.playerId),
      ))))
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function shouldRollbackPreparedReportedMatch(db: Database, options: MatchSessionLifecycleOptions, matchId: string): Promise<boolean> {
  if (!options.sessionNamespace) return false
  try {
    const record = await getSessionRecord(options.sessionNamespace, await resolveSessionIdForMatch(db, matchId))
    if (!record) return false
    return record.phase === 'active' || record.phase === 'swap' || record.phase === 'cancelled'
  }
  catch {
    return false
  }
}

function applyLeaderCorrectionsToDraftData(
  draftData: string | null,
  gameMode: string,
  participants: ParticipantRow[],
  corrections: MatchLeaderCorrection[],
): string | null {
  if (!draftData || corrections.length === 0) return draftData

  let parsed: unknown
  try {
    parsed = JSON.parse(draftData)
  }
  catch {
    return draftData
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return draftData
  const state = (parsed as { state?: unknown }).state
  if (!state || typeof state !== 'object' || Array.isArray(state)) return draftData
  const draftState = state as DraftState
  if (!Array.isArray(draftState.seats) || !Array.isArray(draftState.picks)) return draftData

  const mode = parseGameMode(gameMode)
  if (!mode) return draftData

  const nextState: DraftState = {
    ...draftState,
    picks: draftState.picks.map(pick => ({ ...pick })),
  }
  const nextLeaderByPlayer = new Map(corrections.map(correction => [correction.playerId, correction.nextCivId]))
  let changed = false

  if (isTeamMode(mode)) {
    const playerToSeatIndex = new Map<string, number>()
    nextState.seats.forEach((seat, index) => playerToSeatIndex.set(seat.playerId, index))
    const orderedParticipants = [...participants].sort((left, right) => {
      const leftSeat = playerToSeatIndex.get(left.playerId) ?? Number.MAX_SAFE_INTEGER
      const rightSeat = playerToSeatIndex.get(right.playerId) ?? Number.MAX_SAFE_INTEGER
      return leftSeat - rightSeat
    })
    const picksByTeam = new Map<number, DraftState['picks']>()
    for (const pick of nextState.picks) {
      const team = nextState.seats[pick.seatIndex]?.team
      if (team == null) continue
      const picks = picksByTeam.get(team) ?? []
      picks.push(pick)
      picksByTeam.set(team, picks)
    }
    const teamPickOffsets = new Map<number, number>()
    for (const participant of orderedParticipants) {
      const team = participant.team
      if (team == null) continue
      const offset = teamPickOffsets.get(team) ?? 0
      const pick = picksByTeam.get(team)?.[offset]
      const nextLeaderId = nextLeaderByPlayer.get(participant.playerId)
      if (pick && nextLeaderId && pick.civId !== nextLeaderId) {
        pick.civId = nextLeaderId
        changed = true
      }
      teamPickOffsets.set(team, offset + 1)
    }
  }
  else {
    const pickBySeat = new Map(nextState.picks.map(pick => [pick.seatIndex, pick]))
    nextState.seats.forEach((seat, seatIndex) => {
      const nextLeaderId = nextLeaderByPlayer.get(seat.playerId)
      const pick = pickBySeat.get(seatIndex)
      if (pick && nextLeaderId && pick.civId !== nextLeaderId) {
        pick.civId = nextLeaderId
        changed = true
      }
    })
  }

  return changed ? JSON.stringify({ ...parsed, state: nextState }) : draftData
}

interface DraftPlayerSubstitutionUpdate {
  previousState: DraftState
  nextState: DraftState
  nextDraftData: string
  changedSeatIndexes: number[]
  removedPlayerIds: string[]
}

interface SubstitutePlayerIdentity {
  playerId: string
  displayName: string
  avatarUrl?: string | null
}

function buildDraftPlayerSubstitution(
  draftData: string | null,
  input: {
    matchId: string
    playerId: string
    subPlayer: SubstitutePlayerIdentity
  },
): DraftPlayerSubstitutionUpdate | { error: string } {
  if (!draftData) return { error: `Match **${input.matchId}** has no stored draft data to substitute.` }

  let parsed: unknown
  try {
    parsed = JSON.parse(draftData)
  }
  catch {
    return { error: `Match **${input.matchId}** has invalid stored draft data.` }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `Match **${input.matchId}** has invalid stored draft data.` }
  }

  const parsedRecord = parsed as Record<string, unknown>
  const state = parsedRecord.state
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { error: `Match **${input.matchId}** has no stored draft state to substitute.` }
  }

  const draftState = state as DraftState
  if (!Array.isArray(draftState.seats)) {
    return { error: `Match **${input.matchId}** has invalid stored draft seats.` }
  }

  const sourceSeatIndex = draftState.seats.findIndex(seat => seat.playerId === input.playerId)
  if (sourceSeatIndex < 0) return { error: `<@${input.playerId}> is not in the stored draft for match **${input.matchId}**.` }

  const subSeatIndex = draftState.seats.findIndex(seat => seat.playerId === input.subPlayer.playerId)
  if (subSeatIndex === sourceSeatIndex) return { error: '`sub` must be a different player.' }

  const nextSeats = draftState.seats.map(seat => ({ ...seat }))
  const sourceSeat = nextSeats[sourceSeatIndex]!
  const changedSeatIndexes = [sourceSeatIndex]
  const removedPlayerIds: string[] = []

  if (subSeatIndex >= 0) {
    const subSeat = nextSeats[subSeatIndex]!
    nextSeats[sourceSeatIndex] = withSeatPlayer(sourceSeat, subSeat)
    nextSeats[subSeatIndex] = withSeatPlayer(subSeat, sourceSeat)
    changedSeatIndexes.push(subSeatIndex)
  }
  else {
    nextSeats[sourceSeatIndex] = withSeatPlayer(sourceSeat, input.subPlayer)
    removedPlayerIds.push(input.playerId)
  }

  const duplicatePlayerId = findDuplicateSeatPlayerId(nextSeats)
  if (duplicatePlayerId) return { error: `<@${duplicatePlayerId}> would appear in the draft more than once.` }

  const nextState: DraftState = {
    ...draftState,
    seats: nextSeats,
  }
  const nextRecord: Record<string, unknown> = {
    ...parsedRecord,
    state: nextState,
  }
  if (parsedRecord.hostId === input.playerId && subSeatIndex < 0) {
    nextRecord.hostId = input.subPlayer.playerId
  }

  return {
    previousState: draftState,
    nextState,
    nextDraftData: JSON.stringify(nextRecord),
    changedSeatIndexes,
    removedPlayerIds,
  }
}

function buildSubstitutedParticipantRows(
  matchId: string,
  participants: ParticipantRow[],
  substitution: DraftPlayerSubstitutionUpdate,
): { rows: ParticipantRow[] } | { error: string } {
  const previousSeatPlayerIds = new Set(substitution.previousState.seats.map(seat => seat.playerId))
  for (const participant of participants) {
    if (!previousSeatPlayerIds.has(participant.playerId)) {
      return { error: `<@${participant.playerId}> is a match participant but is missing from the stored draft.` }
    }
  }

  const participantByPlayerId = new Map<string, ParticipantRow>()
  for (const participant of participants) {
    if (participantByPlayerId.has(participant.playerId)) return { error: `<@${participant.playerId}> appears in match **${matchId}** more than once.` }
    participantByPlayerId.set(participant.playerId, participant)
  }

  const rows: ParticipantRow[] = []
  for (let seatIndex = 0; seatIndex < substitution.previousState.seats.length; seatIndex++) {
    const previousSeat = substitution.previousState.seats[seatIndex]!
    const nextSeat = substitution.nextState.seats[seatIndex]!
    const participant = participantByPlayerId.get(previousSeat.playerId)
    if (!participant) return { error: `<@${previousSeat.playerId}> is in the stored draft but is missing from match participants.` }

    rows.push({
      matchId,
      playerId: nextSeat.playerId,
      sourceGuildId: participant.sourceGuildId,
      sourceKind: nextSeat.playerId === previousSeat.playerId ? participant.sourceKind : 'substitution_inherited',
      team: nextSeat.team ?? null,
      civId: participant.civId,
      placement: participant.placement,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
  }

  const duplicatePlayerId = findDuplicateParticipantPlayerId(rows)
  if (duplicatePlayerId) return { error: `<@${duplicatePlayerId}> would appear in match **${matchId}** more than once.` }

  return { rows }
}

function buildPlayerSubstitutionSummaries(
  substitution: DraftPlayerSubstitutionUpdate,
  rows: ParticipantRow[],
): MatchPlayerSubstitution[] {
  const uniqueSeatIndexes = [...new Set(substitution.changedSeatIndexes)]
  return uniqueSeatIndexes.map((seatIndex) => {
    const previousSeat = substitution.previousState.seats[seatIndex]!
    const nextSeat = substitution.nextState.seats[seatIndex]!
    const row = rows[seatIndex]!
    return {
      seatIndex,
      previousPlayerId: previousSeat.playerId,
      nextPlayerId: nextSeat.playerId,
      team: row.team,
      civId: row.civId,
      placement: row.placement,
    }
  })
}

function buildMatchBanRowsFromDraftState(state: DraftState): MatchBanRow[] {
  return state.bans
    .map((ban) => {
      const seat = state.seats[ban.seatIndex]
      if (!seat) return null
      return {
        matchId: state.matchId,
        civId: ban.civId,
        bannedBy: seat.playerId,
        phase: ban.stepIndex,
      }
    })
    .filter((row): row is MatchBanRow => row != null)
}

function withSeatPlayer(
  seat: DraftState['seats'][number],
  player: SubstitutePlayerIdentity,
): DraftState['seats'][number] {
  return {
    ...seat,
    playerId: player.playerId,
    displayName: player.displayName,
    avatarUrl: player.avatarUrl ?? null,
  }
}

function findDuplicateSeatPlayerId(seats: DraftState['seats']): string | null {
  const seen = new Set<string>()
  for (const seat of seats) {
    if (seen.has(seat.playerId)) return seat.playerId
    seen.add(seat.playerId)
  }
  return null
}

function findDuplicateParticipantPlayerId(participants: ParticipantRow[]): string | null {
  const seen = new Set<string>()
  for (const participant of participants) {
    if (seen.has(participant.playerId)) return participant.playerId
    seen.add(participant.playerId)
  }
  return null
}

async function upsertSubstitutePlayer(
  db: Database,
  player: SubstitutePlayerIdentity,
  at: number,
): Promise<void> {
  await db.insert(players)
    .values({
      id: player.playerId,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl ?? null,
      createdAt: at,
    })
    .onConflictDoUpdate({
      target: players.id,
      set: {
        displayName: player.displayName,
        avatarUrl: player.avatarUrl ?? null,
      },
    })
}

async function replaceMatchParticipantRows(
  db: Database,
  matchId: string,
  rows: ParticipantRow[],
): Promise<void> {
  await db.delete(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  for (const chunk of splitValuesForD1InsertLimit(rows.map(toParticipantInsertRow), MATCH_PARTICIPANT_INSERT_COLUMN_COUNT)) {
    await db.insert(matchParticipants).values(chunk)
  }
}

async function replaceMatchBanRows(
  db: Database,
  matchId: string,
  rows: MatchBanRow[],
): Promise<void> {
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  for (const chunk of splitValuesForD1InsertLimit(rows, 4)) {
    await db.insert(matchBans).values(chunk)
  }
}

function toParticipantInsertRow(participant: ParticipantRow): typeof matchParticipants.$inferInsert {
  return {
    matchId: participant.matchId,
    playerId: participant.playerId,
    sourceGuildId: participant.sourceGuildId,
    sourceKind: participant.sourceKind,
    team: participant.team,
    civId: participant.civId,
    placement: participant.placement,
    ratingBeforeMu: participant.ratingBeforeMu,
    ratingBeforeSigma: participant.ratingBeforeSigma,
    ratingAfterMu: participant.ratingAfterMu,
    ratingAfterSigma: participant.ratingAfterSigma,
  }
}

async function rollbackMatchPlayerSubstitution(
  db: Database,
  kv: KVNamespace,
  options: {
    match: MatchRow
    participants: ParticipantRow[]
    bans: MatchBanRow[]
    leaderboardMode: LeaderboardMode
    rankedRoleGuildId?: string | null
    extraAffectedPlayerIds: readonly string[]
    tournamentLinked: boolean
    statsContext: StatsContext
  },
): Promise<string | null> {
  try {
    await db
      .update(matches)
      .set({ draftData: options.match.draftData })
      .where(eq(matches.id, options.match.id))
    await replaceMatchParticipantRows(db, options.match.id, options.participants)
    await replaceMatchBanRows(db, options.match.id, options.bans)

    if (!options.tournamentLinked && options.match.status === 'completed') {
      const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, options.statsContext, {
        fromMatchId: options.match.id,
        includeFromMatch: true,
        extraAffectedPlayerIds: options.extraAffectedPlayerIds,
      })
      if ('error' in recalculated) return recalculated.error
      const recalculatedGlobal = await recalculateGlobalRatings(db, options.statsContext, {
        fromMatchId: options.match.id,
        includeFromMatch: true,
        opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
        extraAffectedPlayerIds: options.extraAffectedPlayerIds,
      })
      if ('error' in recalculatedGlobal) return recalculatedGlobal.error
      await rebuildLeaderboardModeSnapshot(db, kv, options.statsContext, options.leaderboardMode)
    }

    if (options.tournamentLinked) {
      await removeCivLeaderboardMatchContribution(db, options.statsContext, options.match.id)
      await removePlayerCivStatMatchContribution(db, options.statsContext, options.match.id)
    }
    else {
      await reconcileCivLeaderboardMatchContribution(db, options.statsContext, options.match.id)
      await reconcilePlayerCivStatMatchContribution(db, options.statsContext, options.match.id)
    }
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function prepareReportedMatchForRecalculation(
  db: Database,
  matchId: string,
  reportedAt: number,
): Promise<string | null> {
  try {
    const [match] = await db
      .select({ completedAt: matches.completedAt })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)
    await db.update(matches)
      .set({ status: 'completed', completedAt: match?.completedAt ?? reportedAt })
      .where(eq(matches.id, matchId))
    await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function validateReportableSession(
  db: Database,
  options: MatchSessionLifecycleOptions,
  matchId: string,
): Promise<string | null> {
  if (await isManualReportedMatch(db, matchId)) return null

  const { sessionNamespace } = options
  if (!sessionNamespace) {
    return options.allowDirectTerminalWriteForTests ? null : 'SessionDO binding is required to validate match lifecycle.'
  }
  try {
    const sessionId = await resolveSessionIdForMatch(db, matchId)
    const record = await getSessionRecord(sessionNamespace, sessionId)
    if (!record) return `Session **${sessionId}** not found.`
    if (record.matchId !== matchId) return `Session **${sessionId}** does not own match **${matchId}**.`
    if (record.phase === 'reported') return null
    if (record.phase !== 'active' && record.phase !== 'swap' && record.phase !== 'cancelled') return `Session is not reportable (phase: ${record.phase})`
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function cancelMatchByModerator(
  db: Database,
  kv: KVNamespace,
  input: CancelMatchInput,
  options: MatchSessionLifecycleOptions = {},
): Promise<CancelMatchResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  const statsContext = getMatchStatsContext(match, options)
  if (!statsContext) return { error: `Match **${input.matchId}** is missing valid owning-server configuration.` }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const previousStatus = match.status
  const tournamentLinked = await isMatchTournamentLinked(db, input.matchId)
  const hasStaleRatingEvents = previousStatus === 'cancelled' && !tournamentLinked
    ? await matchHasRatingEvents(db, statsContext, input.matchId)
    : false
  let completedLeaderboardMode: LeaderboardMode | null = null
  if ((previousStatus === 'completed' || hasStaleRatingEvents) && !tournamentLinked) {
    const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
    if (!gameContext) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
    completedLeaderboardMode = gameContext.leaderboardMode
  }

  const lifecycleError = await runTerminalSessionCommand(db, options, input.matchId, { type: 'cancel-session', at: input.cancelledAt })
  if (lifecycleError) return { error: lifecycleError }

  await db
    .update(matchParticipants)
    .set({
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, input.matchId))

  let recalculatedMatchIds: string[] = []
  if (previousStatus === 'completed' || hasStaleRatingEvents) {
    await removeCivLeaderboardMatchContribution(db, statsContext, input.matchId)
    await removePlayerCivStatMatchContribution(db, statsContext, input.matchId)
  }
  if (completedLeaderboardMode != null) {
    const recalculated = await recalculateLeaderboardMode(db, completedLeaderboardMode, statsContext, {
      fromMatchId: input.matchId,
      includeFromMatch: false,
    })
    if ('error' in recalculated) return recalculated
    const recalculatedGlobal = await recalculateGlobalRatings(db, statsContext, {
      fromMatchId: input.matchId,
      includeFromMatch: false,
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
    })
    if ('error' in recalculatedGlobal) return recalculatedGlobal
    await rebuildLeaderboardModeSnapshot(db, kv, statsContext, completedLeaderboardMode)
    recalculatedMatchIds = recalculated.matchIds
  }
  if (tournamentLinked) await syncTournamentMatchAfterCancel(db, input.matchId)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  return {
    match: updatedMatch!,
    participants: updatedParticipants,
    previousStatus,
    recalculatedMatchIds,
  }
}

async function matchHasRatingEvents(db: Database, statsContext: StatsContext, matchId: string): Promise<boolean> {
  const [event] = await db
    .select({ matchId: playerRatingEvents.matchId })
    .from(playerRatingEvents)
    .where(and(eq(playerRatingEvents.statsKey, statsContext.statsKey), eq(playerRatingEvents.matchId, matchId)))
    .limit(1)
  if (event || statsContext.seasonPolicy !== 'ppl-seasons') return event != null
  const [legacyEvent] = await db
    .select({ matchId: legacyPlayerRatingEvents.matchId })
    .from(legacyPlayerRatingEvents)
    .where(eq(legacyPlayerRatingEvents.matchId, matchId))
    .limit(1)
  return legacyEvent != null
}

async function hydrateModeratedParticipants(
  db: Database,
  statsContext: StatsContext,
  match: Pick<MatchRow, 'gameMode' | 'draftData'>,
  participants: ParticipantRow[],
): Promise<ParticipantRow[]> {
  return hydrateModeRatingSnapshotsFromEvents(db, statsContext, participants.map(participant => ({
    ...participant,
    gameMode: match.gameMode,
    draftData: match.draftData,
  })))
}

async function runTerminalSessionCommand(
  db: Database,
  options: MatchSessionLifecycleOptions,
  matchId: string,
  command: { type: 'mark-reported' | 'cancel-session', at: number },
): Promise<string | null> {
  if (await isManualReportedMatch(db, matchId)) {
    await applyDirectTerminalCommand(db, matchId, command)
    return null
  }

  const { sessionNamespace } = options
  if (sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(sessionNamespace, await resolveSessionIdForMatch(db, matchId), { ...command, matchId })
      return null
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  if (!options.allowDirectTerminalWriteForTests) {
    return 'SessionDO binding is required to update terminal match state.'
  }

  await applyDirectTerminalCommand(db, matchId, command)
  return null
}

async function resolveSessionIdForMatch(db: Database, matchId: string): Promise<string> {
  return (await getSessionOriginByMatch(db, matchId))?.sessionId ?? matchId
}

async function isManualReportedMatch(db: Database, matchId: string): Promise<boolean> {
  const [match] = await db
    .select({ draftData: matches.draftData })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)
  return isManualReportDraftData(match?.draftData ?? null)
}

async function loadCurrentRankedRoleTierByPlayerId(kv: KVNamespace, guildId: string | null | undefined): Promise<Map<string, string>> {
  if (!guildId) return new Map()
  const assignments = await getCurrentRankAssignments(kv, guildId)
  return new Map(Object.entries(assignments.byPlayerId).map(([playerId, assignment]) => [playerId, assignment.tier]))
}

function getMatchStatsContext(match: { guildId?: string | null }, options: MatchSessionLifecycleOptions): StatsContext | null {
  try {
    return createStatsContext(requireStoredMatchGuildId(match), options.primaryGuildId ?? '')
  }
  catch {
    return null
  }
}

async function applyDirectTerminalCommand(
  db: Database,
  matchId: string,
  command: { type: 'mark-reported' | 'cancel-session', at: number },
): Promise<void> {
  const [match] = await db
    .select({ completedAt: matches.completedAt, status: matches.status })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const nextStatus = command.type === 'mark-reported' ? 'completed' : 'cancelled'
  await db.update(matches)
    .set(command.type === 'mark-reported'
      ? { status: nextStatus, completedAt: match?.completedAt ?? command.at, cancelledAt: null, ...(match?.status === nextStatus ? {} : { resultRevision: sql`${matches.resultRevision} + 1` }) }
      : { status: nextStatus, cancelledAt: command.at, ...(match?.status === nextStatus ? {} : { resultRevision: sql`${matches.resultRevision} + 1` }) })
    .where(eq(matches.id, matchId))
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
}
