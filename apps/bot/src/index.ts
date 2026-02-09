import type { DraftCompleteWebhookPayload, GameMode } from '@civup/game'
import type { Env } from './env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { lobbyDraftCompleteEmbed, lobbyResultEmbed } from './embeds/lfg.ts'
import {
  getMatchForChannel,
  getMatchForUser,
  storeUserMatchMappings,
} from './services/activity.ts'
import { createChannelMessage } from './services/discord.ts'
import { upsertLobbyMessage } from './services/lobby-message.ts'
import {
  clearLobbyByMatch,
  getLobby,
  getLobbyByMatch,
  setLobbyDraftConfig,
  setLobbyStatus,
} from './services/lobby.ts'
import { activateDraftMatch, reportMatch } from './services/match.ts'
import { getPlayerQueueMode, getQueueState } from './services/queue.ts'
import { factory } from './setup.ts'

const DEFAULT_ARCHIVE_CHANNEL_ID = '1470095104332267560'
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

  const archiveChannelId = c.env.ARCHIVE_CHANNEL_ID ?? DEFAULT_ARCHIVE_CHANNEL_ID
  try {
    await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
      embeds: [lobbyResultEmbed(reportedMode, result.participants)],
    })
  }
  catch (error) {
    console.error(`Failed to post archive result for match ${result.match.id}:`, error)
  }

  return c.json({ ok: true, match: result.match, participants: result.participants })
})

// Webhook from PartyKit when draft reaches COMPLETE
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

  if (!isDraftCompletePayload(payload)) {
    return c.json({ error: 'Invalid draft completion payload' }, 400)
  }

  console.log(`Received draft-complete webhook for match ${payload.matchId}`)

  const db = createDb(c.env.DB)
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
})

// Mount Discord interactions at root (default path for discord-hono)
app.mount('/', discordApp.fetch)

export default app

function isDraftCompletePayload(value: unknown): value is DraftCompleteWebhookPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<DraftCompleteWebhookPayload>
  if (typeof payload.matchId !== 'string' || typeof payload.completedAt !== 'number') return false
  if (!payload.state || typeof payload.state !== 'object') return false
  return payload.state.status === 'complete'
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
