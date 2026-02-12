import type { DraftWebhookPayload, GameMode } from '@civup/game'
import type { Env } from './env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { GAME_MODES, maxPlayerCount, minPlayerCount } from '@civup/game'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import {
  lobbyCancelledEmbed,
  lobbyComponents,
  lobbyDraftCompleteEmbed,
  lobbyDraftingEmbed,
  lobbyOpenEmbed,
  lobbyResultEmbed,
} from './embeds/lfg.ts'
import {
  createDraftRoom,
  getMatchForChannel,
  getMatchForUser,
  storeMatchMapping,
  storeUserMatchMappings,
} from './services/activity.ts'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS, resolveDraftTimerConfig } from './services/config.ts'
import { createChannelMessage } from './services/discord.ts'
import { refreshConfiguredLeaderboards } from './services/leaderboard-message.ts'
import { upsertLobbyMessage } from './services/lobby-message.ts'
import {
  clearLobby,
  clearLobbyByMatch,
  getLobby,
  getLobbyByMatch,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  sameLobbySlots,
  setLobbyDraftConfig,
  setLobbySlots,
  setLobbyStatus,
  upsertLobby,
} from './services/lobby.ts'
import { storeMatchMessageMapping } from './services/match-message.ts'
import { activateDraftMatch, cancelDraftMatch, createDraftMatch, reportMatch } from './services/match.ts'
import { addToQueue, clearQueue, getPlayerQueueMode, getQueueState, moveQueueMode, setQueueEntries } from './services/queue.ts'
import { getSystemChannel } from './services/system-channels.ts'
import { factory } from './setup.ts'

const TEMP_LOBBY_START_MIN_PLAYERS_FFA = 1

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
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) {
    return c.json({ error: 'Invalid game mode' }, 400)
  }

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
    return c.json({ error: `Timers must be numbers between 0 and ${MAX_CONFIG_TIMER_SECONDS}` }, 400)
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

// Host-only open lobby mode change
app.post('/api/lobby/:mode/mode', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)

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

  const { userId, nextMode: nextModeRaw } = body as {
    userId?: string
    nextMode?: string
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const nextMode = typeof nextModeRaw === 'string' ? parseGameMode(nextModeRaw) : null
  if (!nextMode) {
    return c.json({ error: 'nextMode must be one of ffa, 1v1, 2v2, 3v3' }, 400)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can change game mode' }, 403)
  }

  if (nextMode === mode) {
    return c.json(await buildOpenLobbySnapshot(c.env.KV, mode, lobby))
  }

  const modeCollision = await getLobby(c.env.KV, nextMode)
  if (modeCollision) {
    return c.json({ error: `A ${nextMode.toUpperCase()} lobby already exists.` }, 409)
  }

  const queue = await getQueueState(c.env.KV, mode)
  if (!queue.entries.some(entry => entry.playerId === lobby.hostId)) {
    return c.json({ error: 'Host is not in the queue anymore. Rejoin first.' }, 400)
  }

  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const orderedPlayers: string[] = []

  orderedPlayers.push(lobby.hostId)
  for (const playerId of normalizedSlots) {
    if (!playerId || orderedPlayers.includes(playerId)) continue
    orderedPlayers.push(playerId)
  }

  const nextSlots = Array.from({ length: maxPlayerCount(nextMode) }, () => null as string | null)
  for (let i = 0; i < nextSlots.length; i++) {
    nextSlots[i] = orderedPlayers[i] ?? null
  }

  const nextLobby = {
    ...lobby,
    mode: nextMode,
    slots: nextSlots,
    updatedAt: Date.now(),
  }

  await clearLobby(c.env.KV, mode)
  await upsertLobby(c.env.KV, nextLobby)

  const movedQueue = await moveQueueMode(c.env.KV, mode, nextMode)
  const normalizedNextSlots = normalizeLobbySlots(nextMode, nextSlots, movedQueue.entries)
  const slottedEntries = mapLobbySlotsToEntries(normalizedNextSlots, movedQueue.entries)

  if (!sameLobbySlots(normalizedNextSlots, nextSlots)) {
    await setLobbySlots(c.env.KV, nextMode, normalizedNextSlots)
  }

  try {
    await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: [lobbyOpenEmbed(nextMode, slottedEntries, maxPlayerCount(nextMode))],
      components: lobbyComponents(nextMode),
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after mode change ${mode} -> ${nextMode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(
    c.env.KV,
    nextMode,
    nextLobby,
    movedQueue.entries,
    normalizedNextSlots,
  ))
})

// Place a player into a lobby slot (join/move/swap)
app.post('/api/lobby/:mode/place', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)

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

  const {
    userId,
    targetSlot: targetSlotRaw,
    playerId: requestedPlayerId,
    displayName,
    avatarUrl,
  } = body as {
    userId?: string
    targetSlot?: unknown
    playerId?: unknown
    displayName?: unknown
    avatarUrl?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const targetSlot = parseSlotIndex(targetSlotRaw)
  if (targetSlot == null || targetSlot >= maxPlayerCount(mode)) {
    return c.json({ error: 'Invalid target slot index' }, 400)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  const isHost = lobby.hostId === userId
  const movingPlayerId = typeof requestedPlayerId === 'string' && requestedPlayerId.length > 0
    ? requestedPlayerId
    : userId

  if (!isHost && movingPlayerId !== userId) {
    return c.json({ error: 'You can only move yourself' }, 403)
  }

  let queue = await getQueueState(c.env.KV, mode)
  let slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)

  const movingEntry = queue.entries.find(entry => entry.playerId === movingPlayerId)
  if (!movingEntry) {
    if (movingPlayerId !== userId) {
      return c.json({ error: 'Target player is not available as a spectator.' }, 400)
    }

    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      return c.json({ error: 'displayName is required when joining as spectator.' }, 400)
    }

    const joinResult = await addToQueue(c.env.KV, mode, {
      playerId: movingPlayerId,
      displayName,
      avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
      joinedAt: Date.now(),
    })

    if (joinResult.error) {
      return c.json({ error: joinResult.error }, 400)
    }

    queue = await getQueueState(c.env.KV, mode)
    slots = normalizeLobbySlots(mode, slots, queue.entries)
  }

  const sourceSlot = slots.findIndex(playerId => playerId === movingPlayerId)
  const targetPlayerId = slots[targetSlot]

  if (targetPlayerId === movingPlayerId) {
    return c.json(await buildOpenLobbySnapshotFromParts(c.env.KV, mode, lobby, queue.entries, slots))
  }

  if (!isHost) {
    if (targetPlayerId != null) {
      return c.json({ error: 'You can only move to empty slots.' }, 403)
    }
    if (sourceSlot >= 0) slots[sourceSlot] = null
    slots[targetSlot] = movingPlayerId
  }
  else {
    if (sourceSlot < 0) {
      if (targetPlayerId != null) {
        return c.json({ error: 'Choose an empty slot for this spectator.' }, 400)
      }
      slots[targetSlot] = movingPlayerId
    }
    else {
      slots[sourceSlot] = targetPlayerId ?? null
      slots[targetSlot] = movingPlayerId
    }
  }

  const updatedLobby = await setLobbySlots(c.env.KV, mode, slots)
  const nextLobby = updatedLobby ?? { ...lobby, slots, updatedAt: Date.now() }

  const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
  try {
    await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: [lobbyOpenEmbed(mode, slottedEntries, maxPlayerCount(mode))],
      components: lobbyComponents(mode),
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after slot placement in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(c.env.KV, mode, nextLobby, queue.entries, slots))
})

// Remove a player from a lobby slot (self leave or host kick)
app.post('/api/lobby/:mode/remove', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)

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

  const { userId, slot: slotRaw } = body as { userId?: string, slot?: unknown }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const slot = parseSlotIndex(slotRaw)
  if (slot == null || slot >= maxPlayerCount(mode)) {
    return c.json({ error: 'Invalid slot index' }, 400)
  }

  const lobby = await getLobby(c.env.KV, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  const queue = await getQueueState(c.env.KV, mode)
  const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const targetPlayerId = slots[slot]

  if (targetPlayerId == null) {
    return c.json(await buildOpenLobbySnapshotFromParts(c.env.KV, mode, lobby, queue.entries, slots))
  }

  if (targetPlayerId === lobby.hostId) {
    return c.json({ error: 'Host cannot leave the lobby.' }, 400)
  }

  const isHost = userId === lobby.hostId
  if (!isHost && userId !== targetPlayerId) {
    return c.json({ error: 'You can only remove yourself from a slot.' }, 403)
  }

  slots[slot] = null
  const updatedLobby = await setLobbySlots(c.env.KV, mode, slots)
  const nextLobby = updatedLobby ?? { ...lobby, slots, updatedAt: Date.now() }
  const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)

  try {
    await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: [lobbyOpenEmbed(mode, slottedEntries, maxPlayerCount(mode))],
      components: lobbyComponents(mode),
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after slot removal in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(c.env.KV, mode, nextLobby, queue.entries, slots))
})

// Host-only lobby start (manual start from config screen)
app.post('/api/lobby/:mode/start', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)

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
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can start the draft' }, 403)
  }

  const queue = await getQueueState(c.env.KV, mode)
  const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
  const selectedEntries = slottedEntries.filter(
    (entry): entry is Exclude<(typeof slottedEntries)[number], null> => entry !== null,
  )

  if (!selectedEntries.some(entry => entry.playerId === lobby.hostId)) {
    return c.json({ error: 'Host must be in a lobby slot before starting.' }, 400)
  }

  if (!canStartLobbyWithPlayerCount(mode, selectedEntries.length)) {
    if (mode === 'ffa') {
      return c.json({ error: `FFA can start with ${lobbyMinPlayerCount(mode)}-${maxPlayerCount(mode)} slotted players.` }, 400)
    }
    return c.json({ error: `${mode.toUpperCase()} requires exactly ${maxPlayerCount(mode)} slotted players.` }, 400)
  }

  try {
    const timerConfig = await resolveDraftTimerConfig(c.env.KV, lobby.draftConfig)
    const { matchId, seats } = await createDraftRoom(mode, selectedEntries, {
      hostId: lobby.hostId,
      partyHost: c.env.PARTY_HOST,
      botHost: c.env.BOT_HOST,
      webhookSecret: c.env.DRAFT_WEBHOOK_SECRET,
      timerConfig,
    })

    const db = createDb(c.env.DB)
    await createDraftMatch(db, { matchId, mode, seats })

    if (queue.entries.length > 0) {
      await clearQueue(c.env.KV, mode, queue.entries.map(entry => entry.playerId))
    }

    await storeMatchMapping(c.env.KV, lobby.channelId, matchId)
    await storeUserMatchMappings(c.env.KV, queue.entries.map(entry => entry.playerId), matchId)

    const attachedLobby = await setLobbySlots(c.env.KV, mode, slots)
    const nextLobbyBase = attachedLobby ?? { ...lobby, slots }
    await upsertLobby(c.env.KV, {
      ...nextLobbyBase,
      status: 'drafting',
      matchId,
      updatedAt: Date.now(),
    })

    const lobbyForMessage = await getLobby(c.env.KV, mode) ?? {
      ...nextLobbyBase,
      status: 'drafting',
      matchId,
      updatedAt: Date.now(),
    }

    try {
      const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobbyForMessage, {
        embeds: [lobbyDraftingEmbed(mode, seats)],
        components: lobbyComponents(mode),
      })
      await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, matchId)
    }
    catch (error) {
      console.error(`Failed to update drafting lobby embed for mode ${mode}:`, error)
    }

    return c.json({ ok: true, matchId })
  }
  catch (error) {
    console.error(`Failed to start lobby draft for mode ${mode}:`, error)
    return c.json({ error: 'Failed to start draft. Please try again.' }, 500)
  }
})

// Host-only open lobby cancellation (before draft room exists)
app.post('/api/lobby/:mode/cancel', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  if (!mode) {
    return c.json({ error: 'Invalid game mode' }, 400)
  }

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
      const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyResultEmbed(lobby.mode, result.participants)],
        components: [],
      })
      await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, result.match.id)
    }
    catch (error) {
      console.error(`Failed to update lobby result embed for match ${result.match.id}:`, error)
    }
    await clearLobbyByMatch(c.env.KV, result.match.id)
  }

  const archiveChannelId = await getSystemChannel(c.env.KV, 'archive')
  if (archiveChannelId) {
    try {
      const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
        embeds: [lobbyResultEmbed(reportedMode, result.participants)],
      })
      await storeMatchMessageMapping(c.env.KV, archiveMessage.id, result.match.id)
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
    const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
    if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

    const result = await activateDraftMatch(db, {
      state: payload.state,
      completedAt: payload.completedAt,
      hostId,
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
      const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants)],
        components: lobbyComponents(lobby.mode),
      })
      await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, payload.matchId)
    }
    catch (error) {
      console.error(`Failed to update draft-complete embed for match ${payload.matchId}:`, error)
    }

    return c.json({ ok: true })
  }

  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

  const cancelled = await cancelDraftMatch(db, c.env.KV, {
    state: payload.state,
    cancelledAt: payload.cancelledAt,
    reason: payload.reason,
    hostId,
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
    const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason)],
      components: [],
    })
    await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, payload.matchId)
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
    slots: (string | null)[]
    draftConfig: {
      banTimerSeconds: number | null
      pickTimerSeconds: number | null
    }
  },
) {
  const queue = await getQueueState(kv, mode)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, queue.entries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, lobby, queue.entries, normalizedSlots)
  }

  const updatedLobby = await setLobbySlots(kv, mode, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }
  return buildOpenLobbySnapshotFromParts(kv, mode, resolvedLobby, queue.entries, normalizedSlots)
}

async function buildOpenLobbySnapshotFromParts(
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
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
) {
  const slotEntries = mapLobbySlotsToEntries(slots, queueEntries)
  const serverDefaults = await getServerDraftTimerDefaults(kv)

  return {
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    entries: slotEntries.map((entry) => {
      if (!entry) return null
      return {
        playerId: entry.playerId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl ?? null,
      }
    }),
    minPlayers: lobbyMinPlayerCount(mode),
    targetSize: maxPlayerCount(mode),
    draftConfig: lobby.draftConfig,
    serverDefaults,
  }
}

function lobbyMinPlayerCount(mode: GameMode): number {
  if (mode === 'ffa') return TEMP_LOBBY_START_MIN_PLAYERS_FFA
  return minPlayerCount(mode)
}

function canStartLobbyWithPlayerCount(mode: GameMode, playerCount: number): boolean {
  if (mode === 'ffa') {
    return playerCount >= lobbyMinPlayerCount(mode) && playerCount <= maxPlayerCount(mode)
  }
  return playerCount === maxPlayerCount(mode)
}

function parseGameMode(modeParam: string): GameMode | null {
  if (!GAME_MODES.includes(modeParam as GameMode)) return null
  return modeParam as GameMode
}

function parseSlotIndex(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return null
  if (numeric < 0) return null
  return numeric
}

function parseLobbyTimerSeconds(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  if (rounded < 0 || rounded > MAX_CONFIG_TIMER_SECONDS) return undefined
  return rounded
}
