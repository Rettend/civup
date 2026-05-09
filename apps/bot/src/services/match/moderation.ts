import type { Database } from '@civup/db'
import type { DraftState, LeaderboardMode } from '@civup/game'
import type { CancelMatchInput, CancelMatchResult, CorrectMatchLeadersInput, CorrectMatchLeadersResult, MatchLeaderCorrection, MatchRow, ParticipantRow, ResolveMatchInput, ResolveMatchResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { allLeaderIds, isTeamMode, parseGameMode } from '@civup/game'
import { and, eq } from 'drizzle-orm'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { type DbBatchItem, runDbBatch } from '../db/batch.ts'
import { reconcileCivLeaderboardMatchContribution, removeCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { getStoredGameModeContext, isManualReportDraftData } from './draft-data.ts'
import { parseModerationPlacements } from './placements.ts'
import { recalculateGlobalRatings, recalculateLeaderboardMode } from './ratings.ts'

interface MatchSessionLifecycleOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
  rankedRoleGuildId?: string | null
}

const LIVE_LEADER_IDS = new Set<string>(allLeaderIds)

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

  const previousStatus = match.status

  const sessionValidationError = await validateReportableSession(db, options, input.matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  const parsedPlacements = parseModerationPlacements(gameContext.mode, input.placements, participants)
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
        .set({ placement })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        ),
    )
  }

  let recalculatedMatchIds: string[] = []
  if (leaderboardMode == null) {
    await runDbBatch(db, applyQueries)
    const lifecycleError = await runTerminalSessionCommand(db, options, input.matchId, { type: 'mark-reported', at: input.resolvedAt })
    if (lifecycleError) {
      const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, input.matchId, participants)
      if (rollbackError) return { error: `${lifecycleError} Automatic rollback also failed: ${rollbackError}` }
      return { error: lifecycleError }
    }
  }
  else {
    try {
      await runDbBatch(db, applyQueries)
      if (previousStatus === 'completed') {
        const prepareError = await prepareReportedMatchForRecalculation(db, input.matchId, input.resolvedAt)
        if (prepareError) return { error: prepareError }
      }

      const recalculated = await recalculateLeaderboardMode(db, leaderboardMode, {
        fromMatchId: input.matchId,
        includeFromMatch: true,
        includeActiveBoundary: previousStatus !== 'completed',
      })
      if ('error' in recalculated) {
        const rollbackError = await rollbackResolvedMatchModeration(db, kv, {
          input,
          match,
          participants,
          bans: originalBans,
          leaderboardMode,
          rankedRoleGuildId: options.rankedRoleGuildId,
        })
        if (rollbackError) return { error: `${recalculated.error} Automatic rollback also failed: ${rollbackError}` }
        return recalculated
      }
      const recalculatedGlobal = await recalculateGlobalRatings(db, {
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
      })
      if (rollbackError) {
        console.error(`Failed to roll back resolved match ${input.matchId}:`, rollbackError)
      }
      throw error
    }
  }

  await reconcileCivLeaderboardMatchContribution(db, input.matchId)

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

  return {
    match: updatedMatch,
    participants: updatedParticipants,
    previousStatus,
    recalculatedMatchIds,
  }
}

export async function correctMatchLeadersByModerator(
  db: Database,
  input: CorrectMatchLeadersInput,
): Promise<CorrectMatchLeadersResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) return { error: `Match **${input.matchId}** not found.` }
  if (match.status !== 'completed') return { error: `Match **${input.matchId}** must be reported before leaders can be corrected.` }

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
    if (!LIVE_LEADER_IDS.has(leaderId)) return { error: `Unknown leader: **${leaderId}**.` }
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
      .set({ draftData: nextDraftData })
      .where(eq(matches.id, input.matchId)))
  }

  await runDbBatch(db, applyQueries)
  await reconcileCivLeaderboardMatchContribution(db, input.matchId)

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

  return {
    match: updatedMatch,
    participants: updatedParticipants,
    previousStatus: match.status,
    recalculatedMatchIds: [],
    corrections,
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
      .where(
        and(
          eq(matchParticipants.matchId, options.input.matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ),
      ))

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
    await reconcileCivLeaderboardMatchContribution(db, options.input.matchId)

    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, {
      fromMatchId: options.input.matchId,
      includeFromMatch: options.match.status === 'completed',
    })
    if ('error' in recalculated) return recalculated.error
    const recalculatedGlobal = await recalculateGlobalRatings(db, {
      fromMatchId: options.input.matchId,
      includeFromMatch: options.match.status === 'completed',
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
    })
    if ('error' in recalculatedGlobal) return recalculatedGlobal.error

    await rebuildLeaderboardModeSnapshot(db, kv, options.leaderboardMode)
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
  if (!await shouldRollbackPreparedReportedMatch(options, rollbackOptions.input.matchId)) return null
  return rollbackResolvedMatchModeration(db, kv, rollbackOptions)
}

async function rollbackParticipantRowsAfterLifecycleFailure(
  db: Database,
  options: MatchSessionLifecycleOptions,
  matchId: string,
  participants: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(options, matchId)) return null
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

async function shouldRollbackPreparedReportedMatch(options: MatchSessionLifecycleOptions, matchId: string): Promise<boolean> {
  if (!options.sessionNamespace) return false
  try {
    const record = await getSessionRecord(options.sessionNamespace, matchId)
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
    const record = await getSessionRecord(sessionNamespace, matchId)
    if (!record) return `Session **${matchId}** not found.`
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

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (participants.length === 0) return { error: `Match **${input.matchId}** has no participants.` }

  const previousStatus = match.status
  let completedLeaderboardMode: LeaderboardMode | null = null
  if (previousStatus === 'completed') {
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
  if (previousStatus === 'completed') {
    await removeCivLeaderboardMatchContribution(db, input.matchId)
  }
  if (completedLeaderboardMode != null) {
    const recalculated = await recalculateLeaderboardMode(db, completedLeaderboardMode, {
      fromMatchId: input.matchId,
      includeFromMatch: false,
    })
    if ('error' in recalculated) return recalculated
    const recalculatedGlobal = await recalculateGlobalRatings(db, {
      fromMatchId: input.matchId,
      includeFromMatch: false,
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
    })
    if ('error' in recalculatedGlobal) return recalculatedGlobal
    await rebuildLeaderboardModeSnapshot(db, kv, completedLeaderboardMode)
    recalculatedMatchIds = recalculated.matchIds
  }

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
      await runSessionTerminalLifecycleCommand(sessionNamespace, matchId, { ...command, matchId })
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

async function applyDirectTerminalCommand(
  db: Database,
  matchId: string,
  command: { type: 'mark-reported' | 'cancel-session', at: number },
): Promise<void> {
  const [match] = await db
    .select({ completedAt: matches.completedAt })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  await db.update(matches)
    .set(command.type === 'mark-reported'
      ? { status: 'completed', completedAt: match?.completedAt ?? command.at }
      : { status: 'cancelled', completedAt: match?.completedAt ?? command.at })
    .where(eq(matches.id, matchId))
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
}
