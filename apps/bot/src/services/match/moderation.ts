import type { Database } from '@civup/db'
import type { CancelMatchInput, CancelMatchResult, MatchRow, ParticipantRow, ResolveMatchInput, ResolveMatchResult } from './types.ts'
import type { LeaderboardMode } from '@civup/game'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { ensureLeaderboardModeSnapshot, rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { clearLobbyByMatch } from '../lobby/index.ts'
import { getStoredGameModeContext } from './draft-data.ts'
import { parseModerationPlacements } from './placements.ts'
import { buildRankByPlayer, recalculateLeaderboardMode } from './ratings.ts'

type BatchItem = Parameters<Database['batch']>[0][number]
type MatchBanRow = {
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

  const parsedPlacements = parseModerationPlacements(gameContext.mode, input.placements, participants)
  if ('error' in parsedPlacements) return parsedPlacements

  const leaderboardMode = gameContext.leaderboardMode
  const leaderboardSnapshotBefore = await ensureLeaderboardModeSnapshot(db, kv, leaderboardMode)
  const beforeRankByPlayer = buildRankByPlayer(leaderboardSnapshotBefore.rows)
  const previousStatus = match.status
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

  applyQueries.push(
    db
      .update(matches)
      .set({ status: 'completed', completedAt: match.completedAt ?? input.resolvedAt })
      .where(eq(matches.id, input.matchId)),
    db.delete(matchBans).where(eq(matchBans.matchId, input.matchId)),
  )

  let recalculatedMatchIds: string[] = []
  try {
    await runBatch(db, applyQueries)

    const recalculated = await recalculateLeaderboardMode(db, leaderboardMode)
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

  if (previousStatus !== 'completed') {
    const channelId = await getChannelForMatch(kv, input.matchId)
    await clearActivityMappings(
      kv,
      input.matchId,
      participants.map(participant => participant.playerId),
      channelId ?? undefined,
    )
    await clearLobbyByMatch(kv, input.matchId)
  }

  const leaderboardSnapshotAfter = await rebuildLeaderboardModeSnapshot(db, kv, leaderboardMode)
  const afterRankByPlayer = buildRankByPlayer(leaderboardSnapshotAfter.rows)
  const leaderboardEligibleCount = afterRankByPlayer.size

  return {
    match: updatedMatch,
    participants: updatedParticipants.map(participant => ({
      ...participant,
      leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
      leaderboardAfterRank: afterRankByPlayer.get(participant.playerId) ?? null,
      leaderboardEligibleCount,
    })),
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
      .set({ placement: participant.placement })
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

    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode)
    if ('error' in recalculated) return recalculated.error

    await rebuildLeaderboardModeSnapshot(db, kv, options.leaderboardMode)
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
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

export async function cancelMatchByModerator(
  db: Database,
  kv: KVNamespace,
  input: CancelMatchInput,
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

  await db
    .update(matches)
    .set({
      status: 'cancelled',
      completedAt: match.completedAt ?? input.cancelledAt,
    })
    .where(eq(matches.id, input.matchId))

  await db.delete(matchBans).where(eq(matchBans.matchId, input.matchId))

  const channelId = await getChannelForMatch(kv, input.matchId)
  await clearActivityMappings(
    kv,
    input.matchId,
    participants.map(participant => participant.playerId),
    channelId ?? undefined,
  )
  await clearLobbyByMatch(kv, input.matchId)

  let recalculatedMatchIds: string[] = []
  if (previousStatus === 'completed') {
    const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
    if (!gameContext) return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }

    const leaderboardMode = gameContext.leaderboardMode
    const recalculated = await recalculateLeaderboardMode(db, leaderboardMode)
    if ('error' in recalculated) return recalculated
    await rebuildLeaderboardModeSnapshot(db, kv, leaderboardMode)
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
