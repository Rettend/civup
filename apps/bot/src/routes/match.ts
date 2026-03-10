import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyResultEmbed } from '../embeds/match.ts'
import { clearLobbyMappings } from '../services/activity/index.ts'
import { createChannelMessage } from '../services/discord/index.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { clearLobbyById, getLobbyByMatch, setLobbyStatus, upsertLobbyMessage } from '../services/lobby/index.ts'
import { cancelMatchByModerator, getHostIdFromDraftData, reportMatch } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles } from '../services/ranked/role-sync.ts'
import { syncSeasonPeaksForPlayers } from '../services/season/index.ts'
import { createStateStore } from '../services/state/store.ts'
import { getSystemChannel } from '../services/system/channels.ts'

export function registerMatchRoutes(app: Hono<Env>) {
  app.get('/api/match/state/:matchId', async (c) => {
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

    return c.json({ match, participants })
  })

  app.post('/api/match/:matchId/report', async (c) => {
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

    const db = createDb(c.env.DB)
    const result = await reportMatch(db, kv, {
      matchId: c.req.param('matchId'),
      reporterId,
      placements,
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    if (result.idempotent) {
      console.log('[idempotency] activity report request deduplicated', {
        matchId: result.match.id,
        reporterId,
      })
      return c.json({ ok: true, alreadyReported: true, match: result.match, participants: result.participants })
    }

    const reportedMode = result.match.gameMode as GameMode

    const lobby = await getLobbyByMatch(kv, result.match.id)
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

    if (lobby) {
      await setLobbyStatus(kv, lobby.id, 'completed', lobby)
      try {
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
          embeds: [lobbyResultEmbed(lobby.mode, result.participants, undefined, { rankedRoleLines })],
          components: [],
        })
        await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
      }
      catch (error) {
        console.error(`Failed to update lobby result embed for match ${result.match.id}:`, error)
      }
      await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
      await clearLobbyById(kv, lobby.id)
    }

    const archiveChannelId = await getSystemChannel(kv, 'archive')
    if (archiveChannelId) {
      try {
        const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
          embeds: [lobbyResultEmbed(reportedMode, result.participants, undefined, { rankedRoleLines })],
        })
        await storeMatchMessageMapping(db, archiveMessage.id, result.match.id)
      }
      catch (error) {
        console.error(`Failed to post archive result for match ${result.match.id}:`, error)
      }
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

    if (!participants.some(participant => participant.playerId === reporterId)) {
      return c.json({ error: 'Only match participants can scrub this match.' }, 403)
    }

    const lobby = await getLobbyByMatch(kv, matchId)
    const hostId = lobby?.hostId ?? getHostIdFromDraftData(match.draftData)
    if (hostId && hostId !== reporterId) {
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
          embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'scrub')],
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
