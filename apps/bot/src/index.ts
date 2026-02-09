import type { DraftWebhookPayload, GameMode } from '@civup/game'
import type { Env } from './env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { lobbyCancelledEmbed, lobbyDraftCompleteEmbed, lobbyResultEmbed } from './embeds/lfg.ts'
import {
  getMatchForChannel,
  getMatchForUser,
  storeUserMatchMappings,
} from './services/activity.ts'
import { createChannelMessage } from './services/discord.ts'
import { refreshConfiguredLeaderboards } from './services/leaderboard-message.ts'
import { upsertLobbyMessage } from './services/lobby-message.ts'
import {
  clearLobby,
  clearLobbyByMatch,
  getLobby,
  getLobbyByMatch,
  setLobbyDraftConfig,
  setLobbyStatus,
} from './services/lobby.ts'
import { activateDraftMatch, cancelDraftMatch, reportMatch } from './services/match.ts'
import { clearQueue, getPlayerQueueMode, getQueueState } from './services/queue.ts'
import { getSystemChannel } from './services/system-channels.ts'
import { factory } from './setup.ts'

const MAX_DRAFT_TIMER_SECONDS = 30 * 60

const discordApp = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

const app = new Hono<Env>()

app.use('/api/*', cors())

// Match lookup endpoint for activity
app.get('/api/match/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const matchId = await getMatchForChannel(c.env.KV, channelId)

  if (!matchId) {
    return c.json({ error: 'No active match for this channel' }, 404)
  }

  return c.json({ matchId })
})

// Match lookup fallback by user (voice-channel launches use user context)
app.get('/api/match/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const matchId = await getMatchForUser(c.env.KV, userId)

  if (matchId) {
    return c.json({ matchId })
  }

  const db = createDb(c.env.DB)
  const [active] = await db
    .select({
      matchId: matchParticipants.matchId,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      eq(matchParticipants.playerId, userId),
      inArray(matches.status, ['drafting', 'active']),
    ))
    .orderBy(desc(matches.createdAt))
    .limit(1)

  if (!active?.matchId) {
    return c.json({ error: 'No active match for this user' }, 404)
  }

  await storeUserMatchMappings(c.env.KV, [userId], active.matchId)
  return c.json({ matchId: active.matchId })
})

// Open lobby lookup for activity waiting room
app.get('/api/lobby/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  for (const mode of GAME_MODES) {
    const lobby = await getLobby(c.env.KV, mode)
    if (!lobby || lobby.channelId !== channelId || lobby.status !== 'open') continue

    return c.json(await buildOpenLobbySnapshot(c.env.KV, mode, lobby))
  }

  return c.json({ error: 'No open lobby for this channel' }, 404)
})

// Open lobby lookup by user (covers voice-channel launches)
app.get('/api/lobby/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const mode = await getPlayerQueueMode(c.env.KV, userId)

  if (!mode) {
    return c.json({ error: 'User is not in an open lobby queue' }, 404)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this user' }, 404)
  }

  return c.json(await buildOpenLobbySnapshot(c.env.KV, mode, lobby))
})

// Host-only lobby config update (pre-draft)
app.post('/api/lobby/:mode/config', async (c) => {
  const modeParam = c.req.param('mode')
  if (!GAME_MODES.includes(modeParam as GameMode)) {
    return c.json({ error: 'Invalid game mode' }, 400)
  }
  const mode = modeParam as GameMode

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

  const { userId, banTimerSeconds, pickTimerSeconds } = body as {
    userId?: string
    banTimerSeconds?: unknown
    pickTimerSeconds?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const normalizedBan = parseLobbyTimerSeconds(banTimerSeconds)
  const normalizedPick = parseLobbyTimerSeconds(pickTimerSeconds)
  if (normalizedBan === undefined || normalizedPick === undefined) {
    return c.json({ error: `Timers must be numbers between 0 and ${MAX_DRAFT_TIMER_SECONDS}` }, 400)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can update draft timers' }, 403)
  }

  const updated = await setLobbyDraftConfig(c.env.KV, mode, {
    banTimerSeconds: normalizedBan,
    pickTimerSeconds: normalizedPick,
  })

  if (!updated) {
    return c.json({ error: 'Lobby not found' }, 404)
  }

  return c.json(await buildOpenLobbySnapshot(c.env.KV, mode, updated))
})

// Host-only open lobby cancellation (before draft room exists)
app.post('/api/lobby/:mode/cancel', async (c) => {
  const modeParam = c.req.param('mode')
  if (!GAME_MODES.includes(modeParam as GameMode)) {
    return c.json({ error: 'Invalid game mode' }, 400)
  }
  const mode = modeParam as GameMode

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

  const { userId } = body as { userId?: string }
  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby) {
    return c.json({ error: 'No lobby for this mode' }, 404)
  }

  if (lobby.status !== 'open') {
    return c.json({ error: 'Lobby can only be cancelled before draft start' }, 400)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can cancel this lobby' }, 403)
  }

  const queue = await getQueueState(c.env.KV, mode)
  if (queue.entries.length > 0) {
    await clearQueue(c.env.KV, mode, queue.entries.map(entry => entry.playerId))
  }

  try {
    await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
      embeds: [{
        title: `LOBBY CANCELLED  -  ${mode.toUpperCase()}`,
        description: 'Host cancelled this lobby before draft start.',
        color: 0x6B7280,
      }],
      components: [],
    })
  }
  catch (error) {
    console.error(`Failed to update cancelled lobby embed for mode ${mode}:`, error)
  }

  await clearLobby(c.env.KV, mode)
  return c.json({ ok: true })
})

// Full match state (used by activity post-draft screen)
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

// Report result from activity
app.post('/api/match/:matchId/report', async (c) => {
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
  const result = await reportMatch(db, c.env.KV, {
    matchId: c.req.param('matchId'),
    reporterId,
    placements,
  })

  if ('error' in result) {
    return c.json({ error: result.error }, 400)
  }

  const reportedMode = result.match.gameMode as GameMode

  const lobby = await getLobbyByMatch(c.env.KV, result.match.id)
  if (lobby) {
    await setLobbyStatus(c.env.KV, lobby.mode, 'completed')
    try {
      await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyResultEmbed(lobby.mode, result.participants)],
        components: [],
      })
    }
    catch (error) {
      console.error(`Failed to update lobby result embed for match ${result.match.id}:`, error)
    }
    await clearLobbyByMatch(c.env.KV, result.match.id)
  }

  const archiveChannelId = await getSystemChannel(c.env.KV, 'archive')
  if (archiveChannelId) {
    try {
      await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
        embeds: [lobbyResultEmbed(reportedMode, result.participants)],
      })
    }
    catch (error) {
      console.error(`Failed to post archive result for match ${result.match.id}:`, error)
    }
  }

  try {
    await refreshConfiguredLeaderboards(db, c.env.KV, c.env.DISCORD_TOKEN)
  }
  catch (error) {
    console.error(`Failed to refresh leaderboard embeds after match ${result.match.id}:`, error)
  }

  return c.json({ ok: true, match: result.match, participants: result.participants })
})

// Webhook from PartyKit when draft lifecycle changes
app.post('/api/webhooks/draft-complete', async (c) => {
  const expectedSecret = c.env.DRAFT_WEBHOOK_SECRET
  if (expectedSecret) {
    const providedSecret = c.req.header('X-CivUp-Webhook-Secret')
    if (providedSecret !== expectedSecret) {
      return c.json({ error: 'Unauthorized webhook' }, 401)
    }
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  }
  catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  if (!isDraftWebhookPayload(payload)) {
    return c.json({ error: 'Invalid draft webhook payload' }, 400)
  }

  console.log(`Received draft webhook (${payload.outcome}) for match ${payload.matchId}`)

  const db = createDb(c.env.DB)

  if (payload.outcome === 'complete') {
    const result = await activateDraftMatch(db, {
      state: payload.state,
      completedAt: payload.completedAt,
    })

    if ('error' in result) {
      return c.json({ error: result.error }, 400)
    }

    const lobby = await getLobbyByMatch(c.env.KV, payload.matchId)
    if (!lobby) {
      console.warn(`No lobby mapping found for draft-complete match ${payload.matchId}`)
      return c.json({ ok: true })
    }

    await setLobbyStatus(c.env.KV, lobby.mode, 'active')
    try {
      await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants)],
        components: [],
      })
    }
    catch (error) {
      console.error(`Failed to update draft-complete embed for match ${payload.matchId}:`, error)
    }

    return c.json({ ok: true })
  }

  const cancelled = await cancelDraftMatch(db, c.env.KV, {
    state: payload.state,
    cancelledAt: payload.cancelledAt,
    reason: payload.reason,
  })

  if ('error' in cancelled) {
    return c.json({ error: cancelled.error }, 400)
  }

  const lobby = await getLobbyByMatch(c.env.KV, payload.matchId)
  if (!lobby) {
    console.warn(`No lobby mapping found for cancelled match ${payload.matchId}`)
    return c.json({ ok: true })
  }

  await setLobbyStatus(c.env.KV, lobby.mode, payload.reason === 'cancel' ? 'cancelled' : 'scrubbed')
  try {
    await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason)],
      components: [],
    })
  }
  catch (error) {
    console.error(`Failed to update cancelled embed for match ${payload.matchId}:`, error)
  }

  await clearLobbyByMatch(c.env.KV, payload.matchId)
  return c.json({ ok: true })
})

// Mount Discord interactions at root (default path for discord-hono)
app.mount('/', discordApp.fetch)

export default app

function isDraftWebhookPayload(value: unknown): value is DraftWebhookPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<DraftWebhookPayload> & {
    outcome?: unknown
    cancelledAt?: unknown
    reason?: unknown
  }

  if (typeof payload.matchId !== 'string') return false
  if (!payload.state || typeof payload.state !== 'object') return false

  if (payload.outcome === 'complete') {
    return typeof payload.completedAt === 'number' && payload.state.status === 'complete'
  }

  if (payload.outcome === 'cancelled') {
    if (typeof payload.cancelledAt !== 'number') return false
    if (payload.reason !== 'cancel' && payload.reason !== 'scrub' && payload.reason !== 'timeout') return false
    return payload.state.status === 'cancelled'
  }

  return false
}

async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: {
    hostId: string
    status: string
    draftConfig: {
      banTimerSeconds: number | null
      pickTimerSeconds: number | null
    }
  },
) {
  const queue = await getQueueState(kv, mode)
  return {
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    entries: queue.entries.map(entry => ({
      playerId: entry.playerId,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl ?? null,
    })),
    targetSize: queue.targetSize,
    draftConfig: lobby.draftConfig,
  }
}

function parseLobbyTimerSeconds(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  if (rounded < 0 || rounded > MAX_DRAFT_TIMER_SECONDS) return undefined
  return rounded
}
