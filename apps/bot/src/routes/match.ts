import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed } from '../embeds/match.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { clearLobbyById, getLobbyByMatch, upsertLobbyMessage } from '../services/lobby/index.ts'
import { cancelMatchByModerator, getHostIdFromDraftData, getStoredGameModeContext, reportMatch } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../services/match/report-discord.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles } from '../services/ranked/role-sync.ts'
import { syncSeasonPeaksForPlayers } from '../services/season/index.ts'
import { createStateStore } from '../services/state/store.ts'
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

    const kv = createStateStore(c.env)
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

    const { reporterId, placements } = body as { reporterId?: string, placements?: string }
    if (typeof reporterId !== 'string' || typeof placements !== 'string') {
      return c.json({ error: 'reporterId and placements are required strings' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, reporterId, auth.identity.userId)
    if (mismatch) return mismatch

    const db = createDb(c.env.DB)
    const fallbackLobby = await getLobbyByMatch(kv, c.req.param('matchId'))
    const result = await reportMatch(db, kv, {
      matchId: c.req.param('matchId'),
      reporterId: auth.identity.userId,
      placements,
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    const reportedContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
    if (!reportedContext) {
      return c.json({ error: `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.` }, 400)
    }

    const lobby = await getLobbyByMatch(kv, result.match.id) ?? fallbackLobby

    if (result.idempotent) {
      console.log('[idempotency] activity report request deduplicated', {
        matchId: result.match.id,
        reporterId,
      })
      await syncReportedMatchDiscordMessages({
        db,
        kv,
        token: c.env.DISCORD_TOKEN,
        matchId: result.match.id,
        reportedMode: reportedContext.mode,
        reportedRedDeath: reportedContext.redDeath,
        participants: result.participants,
        lobby,
        archivePolicy: 'if-missing',
      })
      if (lobby) {
        await clearLobbyById(kv, lobby.id, lobby)
      }
      return c.json({ ok: true, alreadyReported: true, match: result.match, participants: result.participants })
    }

    const guildId = lobby?.guildId ?? null
    let rankedRoleLines: string[] = []
    if (guildId) {
      try {
        const participantIds = result.participants.map(participant => participant.playerId)
        const rankedPreview = await previewRankedRoles({
          db,
          kv,
          guildId,
          playerIds: participantIds,
          includePlayerIdentities: false,
        })
        rankedRoleLines = await listRankedRoleMatchUpdateLines({
          kv,
          guildId,
          preview: rankedPreview,
          playerIds: participantIds,
        })
        await syncSeasonPeaksForPlayers(db, {
          playerIds: participantIds,
          playerPreviews: rankedPreview.playerPreviews,
        })
      }
      catch (error) {
        console.error(`Failed to preview ranked role changes after match ${result.match.id}:`, error)
      }
    }

    await syncReportedMatchDiscordMessages({
      db,
      kv,
      token: c.env.DISCORD_TOKEN,
      matchId: result.match.id,
      reportedMode: reportedContext.mode,
      reportedRedDeath: reportedContext.redDeath,
      participants: result.participants,
      lobby,
      rankedRoleLines,
      archivePolicy: 'always',
    })
    if (lobby) {
      await clearLobbyById(kv, lobby.id, lobby)
    }

    try {
      await markLeaderboardsDirty(db, `activity-report:${result.match.id}`)
    }
    catch (error) {
      console.error(`Failed to mark leaderboards dirty after match ${result.match.id}:`, error)
    }

    try {
      await markRankedRolesDirty(kv, `activity-report:${result.match.id}`)
    }
    catch (error) {
      console.error(`Failed to mark ranked roles dirty after match ${result.match.id}:`, error)
    }

    return c.json({ ok: true, match: result.match, participants: result.participants })
  })

  app.post('/api/match/:matchId/scrub', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const kv = createStateStore(c.env)
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

    const lobby = await getLobbyByMatch(kv, matchId)
    const hostId = lobby?.hostId ?? getHostIdFromDraftData(match.draftData)
    if (hostId && hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the match host can scrub this match.' }, 403)
    }

    const result = await cancelMatchByModerator(db, kv, {
      matchId,
      cancelledAt: Date.now(),
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    if (lobby) {
      try {
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
          embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'scrub', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath)],
          components: [],
        })
        await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
      }
      catch (error) {
        console.error(`Failed to update scrubbed lobby embed for match ${result.match.id}:`, error)
      }
    }

    if (result.previousStatus === 'completed') {
      try {
        await markLeaderboardsDirty(db, `activity-scrub:${result.match.id}`)
      }
      catch (error) {
        console.error(`Failed to mark leaderboards dirty after scrub ${result.match.id}:`, error)
      }

      try {
        await markRankedRolesDirty(kv, `activity-scrub:${result.match.id}`)
      }
      catch (error) {
        console.error(`Failed to mark ranked roles dirty after scrub ${result.match.id}:`, error)
      }
    }

    return c.json({ ok: true, match: result.match, participants: result.participants })
  })
}
