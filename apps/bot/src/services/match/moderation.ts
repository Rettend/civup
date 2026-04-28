import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { CancelMatchInput, CancelMatchResult, MatchRow, ParticipantRow, ResolveMatchInput, ResolveMatchResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq } from 'drizzle-orm'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { clearTeamLeaderboardModeSnapshots } from '../leaderboard/team-snapshot.ts'
import { getStoredGameModeContext } from './draft-data.ts'
import { parseModerationPlacements } from './placements.ts'
import { recalculateLeaderboardMode } from './ratings.ts'

interface MatchSessionLifecycleOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
}

type BatchItem = Parameters<Database['batch']>[0][number]
interface MatchBanRow {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

interface BatchRunner {
  batch?: (queries: [BatchItem, ...BatchItem[]]) => Promise<unknown>
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

  const sessionValidationError = await validateReportableSession(options, input.matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  const parsedPlacements = parseModerationPlacements(gameContext.mode, input.placements, participants)
  if ('error' in parsedPlacements) return parsedPlacements

  const leaderboardMode = gameContext.leaderboardMode
  const originalBans = await db
    .select()
    .from(matchBans)
    .where(eq(matchBans.matchId, input.matchId))

  const applyQueries: BatchItem[] = []
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
    await runBatch(db, applyQueries)
    const lifecycleError = await runTerminalSessionCommand(db, options, input.matchId, { type: 'mark-reported', at: input.resolvedAt })
    if (lifecycleError) {
      const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, input.matchId, participants)
      if (rollbackError) return { error: `${lifecycleError} Automatic rollback also failed: ${rollbackError}` }
      return { error: lifecycleError }
    }
  }
  else {
    try {
      await runBatch(db, applyQueries)
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
        })
        if (rollbackError) return { error: `${recalculated.error} Automatic rollback also failed: ${rollbackError}` }
        return recalculated
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

  return {
    match: updatedMatch,
    participants: updatedParticipants,
    previousStatus,
    recalculatedMatchIds,
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
  },
): Promise<string | null> {
  try {
    const rollbackQueries: BatchItem[] = options.participants.map(participant => db
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

    await runBatch(db, rollbackQueries)

    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, {
      fromMatchId: options.input.matchId,
      includeFromMatch: options.match.status === 'completed',
    })
    if ('error' in recalculated) return recalculated.error

    await rebuildLeaderboardModeSnapshot(db, kv, options.leaderboardMode)
    if (options.leaderboardMode === 'duo' || options.leaderboardMode === 'squad') {
      await clearTeamLeaderboardModeSnapshots(kv, options.leaderboardMode)
    }
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
  return await rollbackResolvedMatchModeration(db, kv, rollbackOptions)
}

async function rollbackParticipantRowsAfterLifecycleFailure(
  db: Database,
  options: MatchSessionLifecycleOptions,
  matchId: string,
  participants: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(options, matchId)) return null
  try {
    await runBatch(db, participants.map(participant => db
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
  options: MatchSessionLifecycleOptions,
  matchId: string,
): Promise<string | null> {
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
  if (completedLeaderboardMode != null) {
    const recalculated = await recalculateLeaderboardMode(db, completedLeaderboardMode, {
      fromMatchId: input.matchId,
      includeFromMatch: false,
    })
    if ('error' in recalculated) return recalculated
    await rebuildLeaderboardModeSnapshot(db, kv, completedLeaderboardMode)
    if (completedLeaderboardMode === 'duo' || completedLeaderboardMode === 'squad') {
      await clearTeamLeaderboardModeSnapshots(kv, completedLeaderboardMode)
    }
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

  if (command.type === 'mark-reported') {
    const [match] = await db
      .select({ completedAt: matches.completedAt })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)
    await db.update(matches)
      .set({ status: 'completed', completedAt: match?.completedAt ?? command.at })
      .where(eq(matches.id, matchId))
  }
  else {
    const [match] = await db
      .select({ completedAt: matches.completedAt })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)
    await db.update(matches)
      .set({ status: 'cancelled', completedAt: match?.completedAt ?? command.at })
      .where(eq(matches.id, matchId))
  }
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return null
}
