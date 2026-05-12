import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed } from '../embeds/match.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { upsertLobbyMessage } from '../services/lobby/index.ts'
import { cancelMatchByModerator, getHostIdFromDraftData, getStoredGameModeContext, reportMatch } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../services/match/report-discord.ts'
import { markRankedRolesDirty } from '../services/ranked/role-sync.ts'
import { getSessionLobbyProjectionByMatch } from '../services/session/index.ts'
import { isMatchTournamentLinked } from '../services/tournament/index.ts'
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
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    const reportedContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
    if (!reportedContext) {
      return c.json({ error: `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.` }, 400)
    }

    const lobby = result.idempotent && !isLiveLobbyProjection(liveLobbyBeforeReport) ? null : liveLobbyBeforeReport
    const isRankedResult = reportedContext.ranked
    const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)
    const archiveChannelType = isTournamentMatch ? 'tournament-archive' : 'archive'

    if (result.idempotent) {
      console.log('[idempotency] activity report request deduplicated', {
        matchId: result.match.id,
        reporterId,
      })
      const discordSync = await syncReportedMatchDiscordMessages({
        db,
        kv,
        token: c.env.DISCORD_TOKEN,
        matchId: result.match.id,
        reportedMode: reportedContext.mode,
        reportedRedDeath: reportedContext.redDeath,
        participants: result.participants,
        matchDraftData: result.match.draftData,
        lobby,
        sessionNamespace: c.env.SessionDO,
        archivePolicy: 'if-missing',
        archiveChannelType,
      })
      queueReportedDiscordRepairIfNeeded(c, result.match.id, discordSync.errors)
      return c.json({ ok: true, alreadyReported: true, match: result.match, participants: result.participants })
    }

    const discordSync = await syncReportedMatchDiscordMessages({
      db,
      kv,
      token: c.env.DISCORD_TOKEN,
      matchId: result.match.id,
      reportedMode: reportedContext.mode,
      reportedRedDeath: reportedContext.redDeath,
      participants: result.participants,
      matchDraftData: result.match.draftData,
      lobby,
      sessionNamespace: c.env.SessionDO,
      reporter: {
        userId: auth.identity.userId,
        displayName: auth.identity.displayName,
        avatarUrl: auth.identity.avatarUrl,
      },
      archivePolicy: 'always',
      archiveChannelType,
    })
    queueReportedDiscordRepairIfNeeded(c, result.match.id, discordSync.errors)
    try {
      if (!isTournamentMatch && !reportedContext.redDeath) {
        await markLeaderboardsDirty(db, `activity-report:${result.match.id}`, {
          civ: true,
          modes: reportedContext.leaderboardMode ? [reportedContext.leaderboardMode] : [],
        })
      }
    }
    catch (error) {
      console.error(`Failed to mark leaderboards dirty after match ${result.match.id}:`, error)
    }

    if (!isTournamentMatch && isRankedResult) {
      try {
        await markRankedRolesDirty(kv, `activity-report:${result.match.id}`)
      }
      catch (error) {
        console.error(`Failed to mark ranked roles dirty after match ${result.match.id}:`, error)
      }
    }

    return c.json({ ok: true, match: result.match, participants: result.participants })
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
          embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'scrub', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, scrubber)],
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
      if (!isTournamentMatch && scrubContext && !scrubContext.redDeath) {
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

function queueReportedDiscordRepairIfNeeded(
  context: { env: Env['Bindings'], executionCtx: ExecutionContext },
  matchId: string,
  errors: string[],
): void {
  if (errors.length === 0) return
  queueBackgroundTask(context, async () => {
    await queueSessionReportedDiscordSync(context.env.SessionDO, matchId, {
      matchId,
      reason: errors.join('; '),
    })
  }, `[match-report] failed to queue reported Discord repair for ${matchId}:`)
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
