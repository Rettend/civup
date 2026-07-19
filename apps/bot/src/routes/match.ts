import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import type { CivBlitzKit, CivBlitzPartialKit, LeaderboardMode } from '@civup/game'
import type { CivBlitzModInput } from '@civup/civ6-mod'
import { createDb, matches, matchParticipants, sessionDirectory } from '@civup/db'
import { CIV_BLITZ_CATEGORIES } from '@civup/game'
import { desc, eq, or } from 'drizzle-orm'
import { requestCivBlitzModArchive } from '../maintenance/maintenance-client.ts'
import { lobbyCancelledEmbed } from '../embeds/match.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { getStoredLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { upsertLobbyMessage } from '../services/lobby/index.ts'
import { buildRankByPlayer, cancelMatchByModerator, getCivBlitzFromDraftData, getDraftStateFromDraftData, getHostIdFromDraftData, getLeaderDataVersionFromDraftData, getStoredGameModeContext, releaseReportedMatchProcessingClaim, reportMatch } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../services/match/report-discord.ts'
import { markRankedRolesDirty } from '../services/ranked/role-sync.ts'
import { getSessionLobbyProjectionByMatch } from '../services/session/index.ts'
import { isMatchTournamentLinked, refreshTournamentLeaderboard } from '../services/tournament/index.ts'
import { queueSessionReportedDiscordSync } from '../session-runtime/session-do-client.ts'
import { rejectMismatchedActivityUser, requireAuthenticatedActivity } from './auth.ts'

export function registerMatchRoutes(app: Hono<Env>) {
  app.get('/api/match/state/:matchId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const matchId = c.req.param('matchId')
    const db = createDb(c.env.DB)

    const [match] = await db
      .select()
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)

    if (!match) {
      return c.json({ error: 'Match not found' }, 404)
    }

    const participants = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId))

    if (!participants.some(participant => participant.playerId === auth.identity.userId)) {
      return c.json({ error: 'Only match participants can view this match.' }, 403)
    }

    return c.json({ match, participants })
  })

  app.get('/api/match/:matchId/civblitz/download', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const matchId = c.req.param('matchId')
    const db = createDb(c.env.DB)
    const [match] = await db
      .select({
        id: matches.id,
        status: matches.status,
        draftData: matches.draftData,
      })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)

    if (!match) return c.json({ error: 'Match not found' }, 404)

    const participants = await db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId))
    if (!participants.some(participant => participant.playerId === auth.identity.userId)) {
      return c.json({ error: 'Only match participants can download this mod.' }, 403)
    }

    if (match.status === 'cancelled') return c.json({ error: 'Cancelled matches do not have a mod.' }, 409)

    const [directory] = await db
      .select({ phase: sessionDirectory.phase })
      .from(sessionDirectory)
      .where(or(eq(sessionDirectory.matchId, matchId), eq(sessionDirectory.sessionId, matchId)))
      .orderBy(desc(sessionDirectory.updatedAt))
      .limit(1)
    if (directory && (directory.phase === 'open' || directory.phase === 'draft' || directory.phase === 'swap')) {
      return c.json({ error: 'The match mod will be available after the draft and swaps are finalized.' }, 409)
    }

    if (!getCivBlitzFromDraftData(match.draftData)) {
      return c.json({ error: 'This match is not a CivBlitz draft.' }, 422)
    }

    const state = getDraftStateFromDraftData(match.draftData)
    if (!state || state.status !== 'complete' || !state.civBlitz || !Array.isArray(state.seats) || !isRecord(state.civBlitz.lockedKits)) {
      return c.json({ error: 'The CivBlitz draft is not complete.' }, 409)
    }

    const seats: CivBlitzModInput['seats'][number][] = []
    for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex += 1) {
      const seat = state.seats[seatIndex]
      const kit = state.civBlitz.lockedKits[seatIndex]
      if (!seat || !isCompleteCivBlitzKit(kit)) {
        return c.json({ error: 'The finalized CivBlitz draft is missing a complete player kit.' }, 422)
      }
      seats.push({ seatIndex, displayName: seat.displayName, kit })
    }

    const input: CivBlitzModInput = {
      matchId,
      leaderDataVersion: getLeaderDataVersionFromDraftData(match.draftData),
      excludeBbgExpanded: state.civBlitz.excludeBbgExpanded,
      seats,
    }

    try {
      return await requestCivBlitzModArchive(c.env.MaintenanceDO, input)
    }
    catch (error) {
      console.error(`Failed to request CivBlitz mod for match ${matchId}:`, error)
      return c.json({ error: 'Failed to generate the match mod.' }, 500)
    }
  })

  app.post('/api/match/:matchId/report', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const kv = getKvStore(c.env)
    let body: unknown
    try {
      body = await c.req.json()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    const { reporterId, placements, leaderAssignments } = body as { reporterId?: string, placements?: string, leaderAssignments?: unknown }
    if (typeof reporterId !== 'string' || typeof placements !== 'string') {
      return c.json({ error: 'reporterId and placements are required strings' }, 400)
    }
    if (leaderAssignments !== undefined && !isStringRecord(leaderAssignments)) {
      return c.json({ error: 'leaderAssignments must be an object of player IDs to leader IDs' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, reporterId, auth.identity.userId)
    if (mismatch) return mismatch

    const db = createDb(c.env.DB)
    const liveLobbyBeforeReport = await getSessionLobbyProjectionByMatch(db, c.req.param('matchId'))
    const result = await reportMatch(db, kv, {
      matchId: c.req.param('matchId'),
      reporterId: auth.identity.userId,
      placements,
      leaderAssignments,
    }, {
      sessionNamespace: c.env.SessionDO,
      rankedRoleGuildId: liveLobbyBeforeReport?.guildId ?? null,
      minimalResult: true,
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    if (result.reportProcessing) {
      return c.json({ ok: true, reportProcessing: true, reportFinalizing: result.reportFinalizing === true, match: result.match, participants: result.participants })
    }

    const reportedContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
    if (!reportedContext) {
      await releaseReportedMatchClaimIfNeeded(c.env.SessionDO, result)
      return c.json({ error: `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.` }, 400)
    }

    const isTournamentMatch = result.tournamentLinked === true
    const lobby = result.idempotent && !isLiveLobbyProjection(liveLobbyBeforeReport) ? null : liveLobbyBeforeReport
    if (result.idempotent) {
      console.log('[idempotency] activity report request deduplicated', {
        matchId: result.match.id,
        reporterId,
      })
    }

    queueActivityReportProjectionTasks(c, {
      db,
      kv,
      matchId: result.match.id,
      reportClaim: result.reportClaim,
      reportedContext,
      isTournamentMatch,
      participants: result.participants,
      matchDraftData: result.match.draftData,
      lobby,
      archivePolicy: result.idempotent ? 'if-missing' : 'always',
      reporter: result.idempotent
        ? null
        : {
            userId: auth.identity.userId,
            displayName: auth.identity.displayName,
            avatarUrl: auth.identity.avatarUrl,
          },
    })

    return c.json({ ok: true, alreadyReported: result.idempotent === true || undefined, match: result.match, participants: result.participants })
  })

  app.post('/api/match/:matchId/scrub', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const kv = getKvStore(c.env)
    let body: unknown
    try {
      body = await c.req.json()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    const { reporterId } = body as { reporterId?: string }
    if (typeof reporterId !== 'string' || reporterId.length === 0) {
      return c.json({ error: 'reporterId is required' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, reporterId, auth.identity.userId)
    if (mismatch) return mismatch

    const matchId = c.req.param('matchId')
    const db = createDb(c.env.DB)

    const [match] = await db
      .select({
        id: matches.id,
        status: matches.status,
        draftData: matches.draftData,
      })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)

    if (!match) {
      return c.json({ error: `Match **${matchId}** not found.` }, 404)
    }

    const participants = await db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId))

    if (!participants.some(participant => participant.playerId === auth.identity.userId)) {
      return c.json({ error: 'Only match participants can scrub this match.' }, 403)
    }

    const lobby = await getSessionLobbyProjectionByMatch(db, matchId)
    const hostId = lobby?.hostId ?? getHostIdFromDraftData(match.draftData)
    if (hostId && hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the match host can scrub this match.' }, 403)
    }

    const result = await cancelMatchByModerator(db, kv, {
      matchId,
      cancelledAt: Date.now(),
    }, {
      sessionNamespace: c.env.SessionDO,
      rankedRoleGuildId: lobby?.guildId ?? null,
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    if (lobby) {
      try {
        const scrubber = {
          userId: auth.identity.userId,
          displayName: auth.identity.displayName,
          avatarUrl: auth.identity.avatarUrl,
        }
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
          embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'scrub', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, scrubber, lobby.draftConfig.civBlitz)],
          components: [],
        }, { db, sessionNamespace: c.env.SessionDO })
        await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
      }
      catch (error) {
        console.error(`Failed to update scrubbed lobby embed for match ${result.match.id}:`, error)
      }
    }

    if (result.previousStatus === 'completed') {
      const scrubContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
      const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)
      if (isTournamentMatch) {
        await refreshTournamentLeaderboard(db, kv, c.env.DISCORD_TOKEN).catch((error) => {
          console.error(`Failed to refresh tournament leaderboard after activity scrub ${result.match.id}:`, error)
        })
      }
      if (!isTournamentMatch && scrubContext && !scrubContext.redDeath && !scrubContext.civBlitz) {
        try {
          await markLeaderboardsDirty(db, `activity-scrub:${result.match.id}`, {
            civ: true,
            modes: scrubContext.leaderboardMode ? [scrubContext.leaderboardMode] : [],
          })
        }
        catch (error) {
          console.error(`Failed to mark leaderboards dirty after scrub ${result.match.id}:`, error)
        }
      }

      if (!isTournamentMatch && scrubContext?.ranked) {
        try {
          await markRankedRolesDirty(kv, `activity-scrub:${result.match.id}`)
        }
        catch (error) {
          console.error(`Failed to mark ranked roles dirty after scrub ${result.match.id}:`, error)
        }
      }
    }

    return c.json({ ok: true, match: result.match, participants: result.participants })
  })
}

function isLiveLobbyProjection(lobby: { status: string } | null): boolean {
  return lobby != null && (lobby.status === 'open' || lobby.status === 'drafting' || lobby.status === 'active')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(entry => typeof entry === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isCompleteCivBlitzKit(value: CivBlitzPartialKit | undefined): value is CivBlitzKit {
  return value != null && CIV_BLITZ_CATEGORIES.every(category => typeof value[category] === 'string' && value[category]!.length > 0)
}

async function releaseReportedMatchClaimIfNeeded(
  sessionNamespace: DurableObjectNamespace | null | undefined,
  result: { match: { id: string }, reportClaim?: Parameters<typeof releaseReportedMatchProcessingClaim>[1] },
): Promise<void> {
  if (!result.reportClaim) return
  await releaseReportedMatchProcessingClaim(sessionNamespace, result.reportClaim).catch((error) => {
    console.error(`Failed to release report claim for match ${result.match.id}:`, error)
  })
}

function queueActivityReportProjectionTasks(
  context: { env: Env['Bindings'], executionCtx: ExecutionContext },
  input: {
    db: ReturnType<typeof createDb>
    kv: KVNamespace
    matchId: string
    reportClaim?: Parameters<typeof releaseReportedMatchProcessingClaim>[1]
    reportedContext: NonNullable<ReturnType<typeof getStoredGameModeContext>>
    isTournamentMatch: boolean
    participants: Parameters<typeof syncReportedMatchDiscordMessages>[0]['participants']
    matchDraftData: string | null
    lobby: Parameters<typeof syncReportedMatchDiscordMessages>[0]['lobby']
    archivePolicy: Parameters<typeof syncReportedMatchDiscordMessages>[0]['archivePolicy']
    reporter: Parameters<typeof syncReportedMatchDiscordMessages>[0]['reporter']
  },
): void {
  queueBackgroundTask(context, async () => {
    let reportClaimReleased = false
    const releaseReportClaim = async () => {
      if (reportClaimReleased) return
      reportClaimReleased = true
      await releaseReportedMatchClaimIfNeeded(context.env.SessionDO, { match: { id: input.matchId }, reportClaim: input.reportClaim })
    }

    try {
      let discordSyncErrors: string[] = []
      try {
        const participants = await hydrateLeaderboardRanksForDiscord(input.kv, input.reportedContext.leaderboardMode, input.participants)
        const discordSync = await syncReportedMatchDiscordMessages({
          db: input.db,
          kv: input.kv,
          token: context.env.DISCORD_TOKEN,
          matchId: input.matchId,
          reportedMode: input.reportedContext.mode,
          reportedRedDeath: input.reportedContext.redDeath,
          reportedCivBlitz: input.reportedContext.civBlitz,
          participants,
          matchDraftData: input.matchDraftData,
          lobby: input.lobby,
          sessionNamespace: context.env.SessionDO,
          reporter: input.reporter,
          archivePolicy: input.archivePolicy,
          archiveChannelType: input.isTournamentMatch ? 'tournament-archive' : 'archive',
        })
        discordSyncErrors = discordSync.errors
      }
      catch (error) {
        console.error(`Failed to sync reported Discord messages after activity report ${input.matchId}:`, error)
        discordSyncErrors = [error instanceof Error ? error.message : String(error)]
      }
      if (discordSyncErrors.length > 0) {
        await releaseReportClaim()
        await queueReportedDiscordRepair(context, input.matchId, discordSyncErrors)
      }

      if (input.isTournamentMatch) {
        await refreshTournamentLeaderboard(input.db, input.kv, context.env.DISCORD_TOKEN).catch((error) => {
          console.error(`Failed to refresh tournament leaderboard after activity report ${input.matchId}:`, error)
        })
        return
      }

      if (!input.reportedContext.redDeath && !input.reportedContext.civBlitz) {
        await markLeaderboardsDirty(input.db, `activity-report:${input.matchId}`, {
          civ: true,
          modes: input.reportedContext.leaderboardMode ? [input.reportedContext.leaderboardMode] : [],
        }).catch((error) => {
          console.error(`Failed to mark leaderboards dirty after match ${input.matchId}:`, error)
        })
      }

      if (input.reportedContext.ranked) {
        await markRankedRolesDirty(input.kv, `activity-report:${input.matchId}`).catch((error) => {
          console.error(`Failed to mark ranked roles dirty after match ${input.matchId}:`, error)
        })
      }
    }
    finally {
      await releaseReportClaim()
    }
  }, `[match-report] failed to queue activity report projection work for ${input.matchId}:`)
}

async function hydrateLeaderboardRanksForDiscord(
  kv: KVNamespace,
  leaderboardMode: LeaderboardMode | null,
  participants: Parameters<typeof syncReportedMatchDiscordMessages>[0]['participants'],
): Promise<Parameters<typeof syncReportedMatchDiscordMessages>[0]['participants']> {
  if (!leaderboardMode) return participants

  const snapshot = await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
  if (!snapshot) return participants

  const beforeRankByPlayer = buildRankByPlayer(snapshot.rows, leaderboardMode)
  const rowsByPlayerId = new Map(snapshot.rows.map(row => [row.playerId, row]))
  for (const participant of participants) {
    if (participant.ratingAfterMu == null || participant.ratingAfterSigma == null) continue
    const previous = rowsByPlayerId.get(participant.playerId)
    rowsByPlayerId.set(participant.playerId, {
      playerId: participant.playerId,
      mode: leaderboardMode,
      mu: participant.ratingAfterMu,
      sigma: participant.ratingAfterSigma,
      gamesPlayed: (previous?.gamesPlayed ?? 0) + 1,
      wins: previous?.wins ?? 0,
      lastPlayedAt: previous?.lastPlayedAt ?? null,
    })
  }

  const afterRankByPlayer = buildRankByPlayer([...rowsByPlayerId.values()], leaderboardMode)
  return participants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankByPlayer.get(participant.playerId) ?? null,
    leaderboardEligibleCount: afterRankByPlayer.size,
  }))
}

async function queueReportedDiscordRepair(
  context: { env: Env['Bindings'] },
  matchId: string,
  errors: string[],
): Promise<void> {
  await queueSessionReportedDiscordSync(context.env.SessionDO, matchId, {
    matchId,
    reason: errors.join('; '),
  }).catch((error) => {
    console.error(`[match-report] failed to queue reported Discord repair for ${matchId}:`, error)
  })
}

function queueBackgroundTask(context: { executionCtx: ExecutionContext }, run: () => Promise<void>, errorMessage: string): void {
  const task = (async () => {
    try {
      await run()
    }
    catch (error) {
      console.error(errorMessage, error)
    }
  })()

  try {
    context.executionCtx.waitUntil(task)
  }
  catch {
    void task
  }
}
