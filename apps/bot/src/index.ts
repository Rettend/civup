import type { CompetitiveTier, DraftWebhookPayload, GameMode } from '@civup/game'
import type { Env } from './env.ts'
import type { LobbyState } from './services/lobby/index.ts'
import type { RankedRoleVisual } from './services/ranked/roles.ts'
import { createDb, matches, matchParticipants, playerRatings } from '@civup/db'
import { COMPETITIVE_TIERS, formatModeLabel, GAME_MODES, isTeamMode, maxPlayerCount, minPlayerCount, parseGameMode, slotToTeamIndex } from '@civup/game'
import { isDev } from '@civup/utils'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed, lobbyDraftingEmbed, lobbyResultEmbed } from './embeds/match.ts'
import { clearLobbyMappings, clearUserActivityTargets, createDraftRoom, getLobbyForUser, getMatchForChannel, getMatchForUser, getUserActivityTarget, storeMatchMapping, storeUserActivityTarget, storeUserLobbyMappings, storeUserMatchMappings } from './services/activity.ts'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS, resolveDraftTimerConfig } from './services/config.ts'
import { createChannelMessage } from './services/discord.ts'
import { markLeaderboardsDirty } from './services/leaderboard-message.ts'
import { arrangeTeamLobbySlots } from './services/lobby/arrange.ts'
import {
  attachLobbyMatch,
  clearLobbyById,
  filterQueueEntriesForLobby,
  getLobbiesByMode,
  getLobbyById,
  getLobbyByMatch,
  getOpenLobbyForPlayer,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  sameLobbySlots,
  setLobbyDraftConfig,
  setLobbyMemberPlayerIds,
  setLobbyMinRole,
  setLobbySlots,
  setLobbyStatus,
  touchLobby,
  upsertLobby,
} from './services/lobby/index.ts'
import { upsertLobbyMessage } from './services/lobby/message.ts'
import {
  arePremadeGroupsAdjacent,
  buildActivePremadeEdgeSet,
  buildSlottedPremadeGroups,
  compactSlottedPremadesForMode,
  moveSlottedPremadeGroup,
  rebuildQueueEntriesFromPremadeEdgeSet,
} from './services/lobby/premades.ts'
import { buildOpenLobbyRenderPayload } from './services/lobby/render.ts'
import { activateDraftMatch, cancelDraftMatch, cancelMatchByModerator, createDraftMatch, reportMatch } from './services/match/index.ts'
import { storeMatchMessageMapping } from './services/match/message.ts'
import { addToQueue, clearQueue, getPlayerQueueMode, getQueueState, moveQueueEntriesBetweenModes, setQueueEntries } from './services/queue.ts'
import { markRankedRolesDirty } from './services/ranked/role-sync.ts'
import {
  buildRankedRoleVisuals,
  fetchGuildMemberRoleIds,
  getRankedRoleConfig,
  getRankedRoleGateError,
  memberMeetsRankedRoleGate,

} from './services/ranked/roles.ts'
import { createStateStore } from './services/state-store.ts'
import { getSystemChannel } from './services/system-channels.ts'
import { factory } from './setup.ts'

const TEMP_LOBBY_START_MIN_PLAYERS_FFA = 1

const DEBUG_TEST_PLAYER_ID_PREFIX = 'debug-active-lobby-bot:'

interface ActivityTargetOption {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: GameMode
  status: 'open' | 'drafting' | 'active'
  participantCount: number
  targetSize: number
  isMember: boolean
  isHost: boolean
  updatedAt: number
}

type ActivityLaunchSelection
  = | {
    kind: 'lobby'
    option: ActivityTargetOption
    lobby: Awaited<ReturnType<typeof buildOpenLobbySnapshot>>
  }
  | {
    kind: 'match'
    option: ActivityTargetOption
    matchId: string
  }

interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

interface ChannelActivityTarget {
  option: ActivityTargetOption
  lobby: LobbyState
}

function buildDebugFillPlayerId(prefix: string, mode: GameMode, slot: number, existingIds: Set<string>): string {
  const base = `${prefix}${mode}:${slot}`
  if (!existingIds.has(base)) return base

  let suffix = 1
  while (existingIds.has(`${base}:${suffix}`)) {
    suffix += 1
  }
  return `${base}:${suffix}`
}

function isDebugLobbyFillEnabled(requestUrl: string, botHost: string | undefined): boolean {
  return isDev({ host: requestUrl, configuredHosts: [botHost] })
}

const discordApp = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

const app = new Hono<Env>()

app.onError((error, c) => {
  console.error('[bot:unhandled]', c.req.method, new URL(c.req.url).pathname, error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

app.use('/api/*', cors())

// Match lookup endpoint for activity
app.get('/api/match/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const kv = createStateStore(c.env)
  const matchId = await getMatchForChannel(kv, channelId)

  if (!matchId) {
    return c.json({ error: 'No active match for this channel' }, 404)
  }

  return c.json({ matchId })
})

// Match lookup fallback by user (voice-channel launches use user context)
app.get('/api/match/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const kv = createStateStore(c.env)
  const matchId = await getMatchForUser(kv, userId)

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

  await storeUserMatchMappings(kv, [userId], active.matchId)
  return c.json({ matchId: active.matchId })
})

// Open lobby lookup for activity waiting room
app.get('/api/lobby/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const kv = createStateStore(c.env)

  const lobby = await getUniqueOpenLobbyForChannel(kv, channelId)
  if (lobby) {
    return c.json(await buildOpenLobbySnapshot(kv, lobby.mode, lobby))
  }

  return c.json({ error: 'No open lobby for this channel' }, 404)
})

// Open lobby lookup by user (covers voice-channel launches)
app.get('/api/lobby/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const kv = createStateStore(c.env)
  const mappedLobbyId = await getLobbyForUser(kv, userId)
  if (mappedLobbyId) {
    const mappedLobby = await getLobbyById(kv, mappedLobbyId)
    if (mappedLobby?.status === 'open') {
      return c.json(await buildOpenLobbySnapshot(kv, mappedLobby.mode, mappedLobby))
    }
  }

  const mode = await getPlayerQueueMode(kv, userId)
  if (!mode) {
    return c.json({ error: 'User is not in an open lobby queue' }, 404)
  }

  const lobby = await getOpenLobbyForPlayer(kv, userId, mode)
  if (!lobby || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this user' }, 404)
  }

  return c.json(await buildOpenLobbySnapshot(kv, mode, lobby))
})

// Resolve the per-user activity target inside one channel.
app.get('/api/activity/launch/:channelId/:userId', async (c) => {
  const channelId = c.req.param('channelId')
  const userId = c.req.param('userId')
  const kv = createStateStore(c.env)

  return c.json(await buildActivityLaunchSnapshot(kv, channelId, userId))
})

// Persist a per-user activity target selection and return the resolved launch snapshot.
app.post('/api/activity/target', async (c) => {
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

  const { channelId, userId, kind, id } = body as {
    channelId?: unknown
    userId?: unknown
    kind?: unknown
    id?: unknown
  }

  if (typeof channelId !== 'string' || channelId.length === 0) {
    return c.json({ error: 'channelId is required' }, 400)
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  if ((kind !== 'lobby' && kind !== 'match') || typeof id !== 'string' || id.length === 0) {
    return c.json({ error: 'A valid target kind and id are required' }, 400)
  }

  const kv = createStateStore(c.env)
  const targets = await listChannelActivityTargets(kv, channelId, userId)
  const target = targets.find(candidate => candidate.option.kind === kind && candidate.option.id === id)
  if (!target) {
    return c.json({ error: 'That activity target is no longer available in this channel' }, 404)
  }

  await storeUserActivityTarget(kv, channelId, [userId], { kind, id })
  return c.json(await buildActivityLaunchSnapshotFromTargets(kv, targets, target))
})

// Ranked-role visuals for one open lobby (used by activity min-rank UI)
app.get('/api/lobby-ranks/:mode/:lobbyId', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const lobbyId = c.req.param('lobbyId')
  const kv = createStateStore(c.env)
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
  if (!lobbyId) return c.json({ error: 'lobbyId is required' }, 400)

  const lobby = await getLobbyById(kv, lobbyId)
  if (!lobby || lobby.mode !== mode || lobby.status !== 'open') {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  const rankedRoleConfig = lobby.guildId
    ? await getRankedRoleConfig(kv, lobby.guildId)
    : emptyRankedRoleConfig()
  const visuals = buildRankedRoleVisuals(rankedRoleConfig)

  return c.json({ options: visuals })
})

// Host-only lobby config update (pre-draft)
app.post('/api/lobby/:mode/config', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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

  const { userId, banTimerSeconds, pickTimerSeconds, minRole: minRoleRaw, lobbyId } = body as {
    userId?: string
    banTimerSeconds?: unknown
    pickTimerSeconds?: unknown
    minRole?: unknown
    lobbyId?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const normalizedBan = parseLobbyTimerSeconds(banTimerSeconds)
  const normalizedPick = parseLobbyTimerSeconds(pickTimerSeconds)
  if (normalizedBan === undefined || normalizedPick === undefined) {
    return c.json({ error: `Timers must be numbers between 0 and ${MAX_CONFIG_TIMER_SECONDS}` }, 400)
  }

  const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!resolvedLobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }
  let lobby = resolvedLobby

  const parsedMinRole = Object.prototype.hasOwnProperty.call(body, 'minRole')
    ? parseLobbyMinRole(minRoleRaw)
    : lobby.minRole
  if (parsedMinRole === undefined) {
    return c.json({ error: `minRole must be one of ${COMPETITIVE_TIERS.join(', ')}, or null` }, 400)
  }
  const normalizedMinRole = parsedMinRole
  const minRoleChanged = normalizedMinRole !== lobby.minRole

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can update draft timers' }, 403)
  }

  if (minRoleChanged && normalizedMinRole && !lobby.guildId) {
    return c.json({ error: 'This lobby is missing guild context, so minimum rank cannot be set.' }, 400)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)

  const rankedRoleConfig = lobby.guildId ? await getRankedRoleConfig(kv, lobby.guildId) : null
  if (minRoleChanged && normalizedMinRole && rankedRoleConfig) {
    const gateError = getRankedRoleGateError(rankedRoleConfig, normalizedMinRole)
    if (gateError) return c.json({ error: gateError }, 400)

    const memberGateError = await validateLobbyMembersAgainstMinRole(
      c.env.DISCORD_TOKEN,
      lobby,
      lobbyQueueEntries,
      rankedRoleConfig,
      normalizedMinRole,
    )
    if (memberGateError) return c.json(memberGateError, 400)
  }

  const draftUpdated = await setLobbyDraftConfig(kv, lobby.id, {
    banTimerSeconds: normalizedBan,
    pickTimerSeconds: normalizedPick,
  }, lobby)

  lobby = draftUpdated ?? lobby
  const minRoleUpdated = await setLobbyMinRole(kv, lobby.id, normalizedMinRole, lobby)
  const updated = minRoleUpdated ?? lobby

  if (!updated) {
    return c.json({ error: 'Lobby not found' }, 404)
  }

  const nextLobbyQueueEntries = buildLobbyQueueEntries(updated, queue.entries)
  const slots = normalizeLobbySlots(mode, updated.slots, nextLobbyQueueEntries)
  const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, updated, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, updated, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after config change in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshot(kv, mode, updated))
})

// Host-only open lobby mode change
app.post('/api/lobby/:mode/mode', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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

  const { userId, nextMode: nextModeRaw, lobbyId } = body as {
    userId?: string
    nextMode?: string
    lobbyId?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const nextMode = typeof nextModeRaw === 'string' ? parseGameMode(nextModeRaw) : null
  if (!nextMode) {
    return c.json({ error: 'nextMode must be one of ffa, 1v1, 2v2, 3v3' }, 400)
  }

  const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!resolvedLobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }
  const lobby = resolvedLobby

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can change game mode' }, 403)
  }

  if (nextMode === mode) {
    return c.json(await buildOpenLobbySnapshot(kv, mode, lobby))
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  if (!lobbyQueueEntries.some(entry => entry.playerId === lobby.hostId)) {
    return c.json({ error: 'Host is not in the queue anymore. Rejoin first.' }, 400)
  }

  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const orderedPlayers: string[] = []

  orderedPlayers.push(lobby.hostId)
  for (const playerId of normalizedSlots) {
    if (!playerId || orderedPlayers.includes(playerId)) continue
    orderedPlayers.push(playerId)
  }

  const nextLayout = compactSlottedPremadesForMode(nextMode, orderedPlayers, lobbyQueueEntries)
  if ('error' in nextLayout) {
    return c.json({ error: nextLayout.error }, 400)
  }
  const nextSlots = nextLayout.slots

  const nextLobby = {
    ...lobby,
    mode: nextMode,
    slots: nextSlots,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }

  const movedQueue = await moveQueueEntriesBetweenModes(kv, mode, nextMode, lobby.memberPlayerIds)
  const movedLobbyQueueEntries = buildLobbyQueueEntries({ ...lobby, mode: nextMode }, movedQueue.to.entries)
  const normalizedNextSlots = normalizeLobbySlots(nextMode, nextSlots, movedLobbyQueueEntries)
  const finalizedLobby = {
    ...nextLobby,
    slots: normalizedNextSlots,
  }

  await clearLobbyById(kv, lobby.id)
  await upsertLobby(kv, finalizedLobby)
  await storeUserLobbyMappings(kv, finalizedLobby.memberPlayerIds, finalizedLobby.id)
  const slottedEntries = mapLobbySlotsToEntries(normalizedNextSlots, movedLobbyQueueEntries)

  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, finalizedLobby, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, finalizedLobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after mode change ${mode} -> ${nextMode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(
    kv,
    nextMode,
    finalizedLobby,
    movedLobbyQueueEntries,
    normalizedNextSlots,
  ))
})

// Place a player into a lobby slot (join/move/swap)
app.post('/api/lobby/:mode/place', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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
    lobbyId,
  } = body as {
    userId?: string
    targetSlot?: unknown
    playerId?: unknown
    displayName?: unknown
    avatarUrl?: unknown
    lobbyId?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const targetSlot = parseSlotIndex(targetSlotRaw)
  if (targetSlot == null || targetSlot >= maxPlayerCount(mode)) {
    return c.json({ error: 'Invalid target slot index' }, 400)
  }

  const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!resolvedLobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }
  let lobby = resolvedLobby

  const isHost = lobby.hostId === userId
  const movingPlayerId = typeof requestedPlayerId === 'string' && requestedPlayerId.length > 0
    ? requestedPlayerId
    : userId

  if (!isHost && movingPlayerId !== userId) {
    return c.json({ error: 'You can only move yourself' }, 403)
  }

  let queue = await getQueueState(kv, mode)
  let lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  let slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

  const existingLobbyForPlayer = await getOpenLobbyForPlayer(kv, movingPlayerId, mode)
  if (existingLobbyForPlayer && existingLobbyForPlayer.id !== lobby.id) {
    return c.json({ error: 'That player is already in another open lobby.' }, 400)
  }

  const movingEntry = lobbyQueueEntries.find(entry => entry.playerId === movingPlayerId)
  if (!movingEntry) {
    if (movingPlayerId !== userId) {
      return c.json({ error: 'Target player is not available as a spectator.' }, 400)
    }

    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      return c.json({ error: 'displayName is required when joining as spectator.' }, 400)
    }

    const joinGateError = await validatePlayerAgainstLobbyMinRole(c.env.DISCORD_TOKEN, kv, lobby, movingPlayerId)
    if (joinGateError) {
      return c.json({ error: joinGateError }, 400)
    }

    const joinResult = await addToQueue(kv, mode, {
      playerId: movingPlayerId,
      displayName,
      avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
      joinedAt: Date.now(),
    })

    if (joinResult.error) {
      return c.json({ error: joinResult.error }, 400)
    }

    queue = await getQueueState(kv, mode)
    const nextMemberIds = [...new Set([...lobby.memberPlayerIds, movingPlayerId])]
    const updatedLobby = await setLobbyMemberPlayerIds(kv, lobby.id, nextMemberIds, lobby)
    if (updatedLobby) {
      lobby = updatedLobby
    }
    lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
    slots = normalizeLobbySlots(mode, slots, lobbyQueueEntries)
    await storeUserLobbyMappings(kv, [movingPlayerId], lobby.id)
    await storeUserActivityTarget(kv, lobby.channelId, [movingPlayerId], { kind: 'lobby', id: lobby.id })
  }

  const sourceSlot = slots.findIndex(playerId => playerId === movingPlayerId)
  const targetPlayerId = slots[targetSlot]
  const movingPremadeGroup = isTeamMode(mode) && sourceSlot >= 0
    ? buildSlottedPremadeGroups(mode, slots, lobbyQueueEntries).find(group => group.playerIds.includes(movingPlayerId)) ?? null
    : null

  if (targetPlayerId === movingPlayerId) {
    return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots))
  }

  if (!isHost) {
    if (movingPremadeGroup && movingPremadeGroup.playerIds.length > 1) {
      return c.json({ error: 'Only the host can move linked premades.' }, 403)
    }

    if (targetPlayerId != null) {
      return c.json({ error: 'You can only move to empty slots.' }, 403)
    }
    if (sourceSlot >= 0) slots[sourceSlot] = null
    slots[targetSlot] = movingPlayerId
  }
  else {
    if (movingPremadeGroup && movingPremadeGroup.playerIds.length > 1) {
      const movedGroup = moveSlottedPremadeGroup(mode, slots, movingPremadeGroup, sourceSlot, targetSlot)
      if ('error' in movedGroup) {
        return c.json({ error: movedGroup.error }, 400)
      }
      slots = movedGroup.slots
    }
    else if (sourceSlot < 0) {
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

  if (isTeamMode(mode) && !arePremadeGroupsAdjacent(mode, slots, lobbyQueueEntries)) {
    return c.json({ error: 'This move would split a linked premade.' }, 400)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, slots, lobby)
  const nextLobby = updatedLobby ?? { ...lobby, slots, updatedAt: Date.now() }

  const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after slot placement in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, slots))
})

// Remove a player from a lobby slot (self leave or host kick)
app.post('/api/lobby/:mode/remove', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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

  const { userId, slot: slotRaw, lobbyId } = body as { userId?: string, slot?: unknown, lobbyId?: unknown }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const slot = parseSlotIndex(slotRaw)
  if (slot == null || slot >= maxPlayerCount(mode)) {
    return c.json({ error: 'Invalid slot index' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!lobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const targetPlayerId = slots[slot]

  if (targetPlayerId == null) {
    return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots))
  }

  if (targetPlayerId === lobby.hostId) {
    return c.json({ error: 'Host cannot leave the lobby.' }, 400)
  }

  const isHost = userId === lobby.hostId
  if (!isHost && userId !== targetPlayerId) {
    return c.json({ error: 'You can only remove yourself from a slot.' }, 403)
  }

  slots[slot] = null
  let nextEntries = queue.entries
  if (isTeamMode(mode)) {
    const nextEdges = buildActivePremadeEdgeSet(mode, slots, lobbyQueueEntries)
    nextEntries = rebuildQueueEntriesFromPremadeEdgeSet(mode, slots, queue.entries, nextEdges)
    await setQueueEntries(kv, mode, nextEntries, {
      currentState: queue,
    })
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, slots, lobby)
  const nextLobby = updatedLobby ?? { ...lobby, slots, updatedAt: Date.now() }
  const nextLobbyQueueEntries = buildLobbyQueueEntries(nextLobby, nextEntries)
  const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after slot removal in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots))
})

// Toggle a visible premade link between neighboring team slots
app.post('/api/lobby/:mode/link', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
  if (!isTeamMode(mode)) {
    return c.json({ error: 'Premade links are only available in 2v2 and 3v3.' }, 400)
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

  const { userId, leftSlot: leftSlotRaw, lobbyId } = body as {
    userId?: unknown
    leftSlot?: unknown
    lobbyId?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const leftSlot = parseSlotIndex(leftSlotRaw)
  const rightSlot = leftSlot == null ? null : leftSlot + 1
  if (leftSlot == null || rightSlot == null || rightSlot >= maxPlayerCount(mode)) {
    return c.json({ error: 'Invalid premade link position' }, 400)
  }

  if (slotToTeamIndex(mode, leftSlot) == null || slotToTeamIndex(mode, leftSlot) !== slotToTeamIndex(mode, rightSlot)) {
    return c.json({ error: 'Premade links must stay on one team.' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!lobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const leftPlayerId = slots[leftSlot]
  const rightPlayerId = slots[rightSlot]
  if (!leftPlayerId || !rightPlayerId) {
    return c.json({ error: 'Both slots must be occupied.' }, 400)
  }

  const isHost = lobby.hostId === userId
  if (!isHost && userId !== leftPlayerId && userId !== rightPlayerId) {
    return c.json({ error: 'You can only link yourself with a neighbor.' }, 403)
  }

  const nextEdges = buildActivePremadeEdgeSet(mode, slots, lobbyQueueEntries)
  if (nextEdges.has(leftSlot)) {
    nextEdges.delete(leftSlot)
  }
  else {
    nextEdges.add(leftSlot)
  }

  const nextEntries = rebuildQueueEntriesFromPremadeEdgeSet(mode, slots, queue.entries, nextEdges)
  await setQueueEntries(kv, mode, nextEntries, {
    currentState: queue,
  })
  const nextLobby = await touchLobby(kv, lobby.id, lobby) ?? lobby

  return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, buildLobbyQueueEntries(nextLobby, nextEntries), slots))
})

// Host-only team arrange actions (premade-aware randomize / auto-balance)
app.post('/api/lobby/:mode/arrange', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
  if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
  if (!isTeamMode(mode)) {
    return c.json({ error: 'Team arrange actions are only available in 2v2 and 3v3 lobbies.' }, 400)
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

  const { userId, strategy: strategyRaw, lobbyId } = body as {
    userId?: unknown
    strategy?: unknown
    lobbyId?: unknown
  }

  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  if (strategyRaw !== 'randomize' && strategyRaw !== 'balance') {
    return c.json({ error: 'strategy must be one of randomize or balance' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!lobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can arrange teams' }, 403)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const slottedPlayerIds = slots.filter((playerId): playerId is string => playerId != null)

  let ratingsByPlayerId = new Map<string, { mu: number, sigma: number }>()
  if (strategyRaw === 'balance' && slottedPlayerIds.length > 0) {
    const db = createDb(c.env.DB)
    const rows = await db
      .select({
        playerId: playerRatings.playerId,
        mu: playerRatings.mu,
        sigma: playerRatings.sigma,
      })
      .from(playerRatings)
      .where(and(
        eq(playerRatings.mode, 'teamers'),
        inArray(playerRatings.playerId, slottedPlayerIds),
      ))

    ratingsByPlayerId = new Map(rows.map(row => [row.playerId, { mu: row.mu, sigma: row.sigma }]))
  }

  const arranged = arrangeTeamLobbySlots({
    mode,
    slots,
    queueEntries: lobbyQueueEntries,
    strategy: strategyRaw,
    ratingsByPlayerId,
  })

  if ('error' in arranged) {
    return c.json({ error: arranged.error }, 400)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, arranged.slots, lobby)
  const nextLobby = updatedLobby ?? { ...lobby, slots: arranged.slots, updatedAt: Date.now() }
  const slottedEntries = mapLobbySlotsToEntries(arranged.slots, lobbyQueueEntries)

  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after ${strategyRaw} arrange in ${mode}:`, error)
  }

  return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, arranged.slots))
})

// Dev-only host helper: fill empty lobby slots with active test players
app.post('/api/lobby/:mode/fill-test', async (c) => {
  if (!isDebugLobbyFillEnabled(c.req.url, c.env.BOT_HOST)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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

  const { userId, lobbyId } = body as { userId?: string, lobbyId?: unknown }
  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!lobby) {
    return c.json({ error: 'No open lobby for this mode' }, 404)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can fill test players' }, 403)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const nextEntries = [...queue.entries]
  const nextMemberIds = new Set(lobby.memberPlayerIds)
  const existingIds = new Set(nextEntries.map(entry => entry.playerId))

  let addedCount = 0
  const now = Date.now()

  for (let slot = 0; slot < slots.length; slot++) {
    if (slots[slot] != null) continue

    const playerId = buildDebugFillPlayerId(DEBUG_TEST_PLAYER_ID_PREFIX, mode, slot, existingIds)
    slots[slot] = playerId
    nextEntries.push({
      playerId,
      displayName: `Test Player ${slot + 1}`,
      avatarUrl: null,
      joinedAt: now + slot,
    })
    nextMemberIds.add(playerId)
    existingIds.add(playerId)
    addedCount += 1
  }

  if (addedCount > 0) {
    await setQueueEntries(kv, mode, nextEntries)
  }

  let nextLobby = lobby
  if (nextMemberIds.size !== lobby.memberPlayerIds.length) {
    nextLobby = await setLobbyMemberPlayerIds(kv, lobby.id, [...nextMemberIds], lobby) ?? lobby
  }

  const updatedLobby = await setLobbySlots(kv, nextLobby.id, slots, nextLobby)
  nextLobby = updatedLobby ?? { ...nextLobby, slots, updatedAt: Date.now() }
  const slottedEntries = mapLobbySlotsToEntries(slots, buildLobbyQueueEntries(nextLobby, nextEntries))

  try {
    const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    })
  }
  catch (error) {
    console.error(`Failed to update lobby embed after test fill in ${mode}:`, error)
  }

  const snapshot = await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, buildLobbyQueueEntries(nextLobby, nextEntries), slots)
  return c.json({ ...snapshot, addedCount })
})

// Host-only lobby start (manual start from config screen)
app.post('/api/lobby/:mode/start', async (c) => {
  const mode = parseGameMode(c.req.param('mode'))
  const kv = createStateStore(c.env)
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

  const { userId, lobbyId } = body as { userId?: string, lobbyId?: unknown }
  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId }) ?? await getLobbyById(kv, typeof lobbyId === 'string' ? lobbyId : '')
  if (!lobby) return c.json({ error: 'No lobby for this mode' }, 404)

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can start the draft' }, 403)
  }

  if (lobby.status === 'drafting' && lobby.matchId) {
    console.log('[idempotency] duplicate lobby start request', {
      mode,
      hostId: userId,
      matchId: lobby.matchId,
      revision: lobby.revision,
    })
    return c.json({ ok: true, matchId: lobby.matchId, idempotent: true })
  }

  if (lobby.status !== 'open') {
    return c.json({ error: `Lobby is not open (status: ${lobby.status}).` }, 409)
  }

  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
  const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
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
    return c.json({ error: `${formatModeLabel(mode)} requires exactly ${maxPlayerCount(mode)} slotted players.` }, 400)
  }

  try {
    const timerConfig = await resolveDraftTimerConfig(kv, lobby.draftConfig)
    const { matchId, seats } = await createDraftRoom(mode, selectedEntries, {
      hostId: lobby.hostId,
      partyHost: c.env.PARTY_HOST,
      botHost: c.env.BOT_HOST,
      webhookSecret: c.env.CIVUP_SECRET,
      timerConfig,
    })

    const db = createDb(c.env.DB)
    await createDraftMatch(db, { matchId, mode, seats })

    if (lobby.memberPlayerIds.length > 0) {
      await clearQueue(kv, mode, lobby.memberPlayerIds, {
        currentState: queue,
      })
    }

    await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
    await storeMatchMapping(kv, lobby.channelId, matchId)
    await storeUserMatchMappings(kv, lobby.memberPlayerIds, matchId)
    await storeUserActivityTarget(kv, lobby.channelId, lobby.memberPlayerIds, { kind: 'match', id: matchId })

    await setLobbySlots(kv, lobby.id, slots, lobby)
    const lobbyForMessage = await attachLobbyMatch(kv, lobby.id, matchId, lobby)
    if (!lobbyForMessage) {
      const currentLobby = await getLobbyById(kv, lobby.id)
      if (currentLobby?.status === 'drafting' && currentLobby.matchId) {
        console.warn('[idempotency] lobby start transitioned concurrently', {
          mode,
          hostId: userId,
          requestedMatchId: matchId,
          activeMatchId: currentLobby.matchId,
          revision: currentLobby.revision,
        })
        return c.json({ ok: true, matchId: currentLobby.matchId, idempotent: true })
      }
      console.warn('[lobby-transition] failed to attach match to lobby', {
        mode,
        hostId: userId,
        requestedMatchId: matchId,
      })
      return c.json({ error: 'Lobby state changed while starting. Please retry.' }, 409)
    }

    try {
      const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobbyForMessage, {
        embeds: [lobbyDraftingEmbed(mode, seats)],
        components: lobbyComponents(mode, lobbyForMessage.id),
      })
      await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
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
  const kv = createStateStore(c.env)
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

  const { userId, lobbyId } = body as { userId?: string, lobbyId?: unknown }
  if (typeof userId !== 'string' || userId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }

  const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
  if (!lobby) {
    return c.json({ error: 'No lobby for this mode' }, 404)
  }

  if (lobby.status !== 'open') {
    return c.json({ error: 'Lobby can only be cancelled before draft start' }, 400)
  }

  if (lobby.hostId !== userId) {
    return c.json({ error: 'Only the lobby host can cancel this lobby' }, 403)
  }

  const queue = await getQueueState(kv, mode)
  if (lobby.memberPlayerIds.length > 0) {
    await clearQueue(kv, mode, lobby.memberPlayerIds, {
      currentState: queue,
    })
  }

  try {
    await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
      embeds: [{
        title: `LOBBY CANCELLED  -  ${formatModeLabel(mode)}`,
        description: 'Host cancelled this lobby before draft start.',
        color: 0x6B7280,
      }],
      components: [],
    })
  }
  catch (error) {
    console.error(`Failed to update cancelled lobby embed for mode ${mode}:`, error)
  }

  await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
  await clearLobbyById(kv, lobby.id)
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
  if (lobby) {
    await setLobbyStatus(kv, lobby.id, 'completed', lobby)
    try {
      const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyResultEmbed(lobby.mode, result.participants)],
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
        embeds: [lobbyResultEmbed(reportedMode, result.participants)],
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

// Scrub match result from activity (host-only, post-draft)
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
  const hostId = lobby?.hostId ?? parseHostIdFromDraftData(match.draftData)
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

// Webhook from PartyKit when draft lifecycle changes
app.post('/api/webhooks/draft-complete', async (c) => {
  const kv = createStateStore(c.env)
  const expectedSecret = c.env.CIVUP_SECRET
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

    const lobby = await getLobbyByMatch(kv, payload.matchId)
    if (!lobby) {
      console.warn(`No lobby mapping found for draft-complete match ${payload.matchId}`)
      return c.json({ ok: true })
    }

    await setLobbyStatus(kv, lobby.id, 'active', lobby)
    try {
      const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants)],
        components: lobbyComponents(lobby.mode, lobby.id),
      })
      await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
    }
    catch (error) {
      console.error(`Failed to update draft-complete embed for match ${payload.matchId}:`, error)
    }

    return c.json({ ok: true })
  }

  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

  const cancelled = await cancelDraftMatch(db, kv, {
    state: payload.state,
    cancelledAt: payload.cancelledAt,
    reason: payload.reason,
    hostId,
  })

  if ('error' in cancelled) {
    return c.json({ error: cancelled.error }, 400)
  }

  const lobby = await getLobbyByMatch(kv, payload.matchId)
  if (!lobby) {
    console.warn(`No lobby mapping found for cancelled match ${payload.matchId}`)
    return c.json({ ok: true })
  }

  await setLobbyStatus(kv, lobby.id, payload.reason === 'cancel' ? 'cancelled' : 'scrubbed', lobby)
  try {
    const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason)],
      components: [],
    })
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }
  catch (error) {
    console.error(`Failed to update cancelled embed for match ${payload.matchId}:`, error)
  }

  await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
  await clearLobbyById(kv, lobby.id)
  return c.json({ ok: true })
})

// Mount Discord interactions at root (default path for discord-hono)
app.mount('/', discordApp.fetch)

const worker: ExportedHandler<Env['Bindings']> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    const cronEvent = {
      ...controller,
      type: 'scheduled',
    } as Parameters<typeof discordApp.scheduled>[0]
    return discordApp.scheduled(cronEvent, env, ctx)
  },
}

export default worker

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

async function buildActivityLaunchSnapshot(
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<ActivityLaunchSnapshot> {
  const targets = await listChannelActivityTargets(kv, channelId, userId)
  const selection = await resolveActivityLaunchSelection(kv, channelId, userId, targets)
  return buildActivityLaunchSnapshotFromTargets(kv, targets, selection)
}

async function buildActivityLaunchSnapshotFromTargets(
  kv: KVNamespace,
  targets: ChannelActivityTarget[],
  selection: ChannelActivityTarget | null,
): Promise<ActivityLaunchSnapshot> {
  return {
    selection: selection ? await serializeActivityLaunchSelection(kv, selection) : null,
    options: targets.map(target => target.option),
  }
}

async function resolveActivityLaunchSelection(
  kv: KVNamespace,
  channelId: string,
  userId: string,
  targets: ChannelActivityTarget[],
): Promise<ChannelActivityTarget | null> {
  const storedTarget = await getUserActivityTarget(kv, channelId, userId)
  if (storedTarget) {
    const storedSelection = targets.find(target => target.option.kind === storedTarget.kind && target.option.id === storedTarget.id) ?? null
    if (storedSelection) {
      return storedSelection
    }
    await clearUserActivityTargets(kv, channelId, [userId])
  }

  return null
}

async function serializeActivityLaunchSelection(
  kv: KVNamespace,
  selection: ChannelActivityTarget,
): Promise<ActivityLaunchSelection> {
  if (selection.option.kind === 'lobby') {
    return {
      kind: 'lobby',
      option: selection.option,
      lobby: await buildOpenLobbySnapshot(kv, selection.lobby.mode, selection.lobby),
    }
  }

  return {
    kind: 'match',
    option: selection.option,
    matchId: selection.option.id,
  }
}

async function listChannelActivityTargets(
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<ChannelActivityTarget[]> {
  const queueByMode = new Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>()
  const targets: ChannelActivityTarget[] = []

  const lobbiesByMode = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  for (let modeIndex = 0; modeIndex < GAME_MODES.length; modeIndex++) {
    const mode = GAME_MODES[modeIndex]!
    const lobbies = lobbiesByMode[modeIndex] ?? []

    for (const lobby of lobbies) {
      if (lobby.channelId !== channelId) continue

      if (lobby.status === 'open') {
        let queue = queueByMode.get(mode)
        if (!queue) {
          queue = await getQueueState(kv, mode)
          queueByMode.set(mode, queue)
        }

        const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
        const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
        targets.push({
          lobby,
          option: {
            kind: 'lobby',
            id: lobby.id,
            lobbyId: lobby.id,
            matchId: null,
            channelId,
            mode,
            status: 'open',
            participantCount: countFilledSlots(slots),
            targetSize: maxPlayerCount(mode),
            isMember: lobby.memberPlayerIds.includes(userId),
            isHost: lobby.hostId === userId,
            updatedAt: lobby.updatedAt,
          },
        })
        continue
      }

      if ((lobby.status === 'drafting' || lobby.status === 'active') && lobby.matchId) {
        targets.push({
          lobby,
          option: {
            kind: 'match',
            id: lobby.matchId,
            lobbyId: lobby.id,
            matchId: lobby.matchId,
            channelId,
            mode,
            status: lobby.status,
            participantCount: countFilledSlots(lobby.slots),
            targetSize: maxPlayerCount(mode),
            isMember: lobby.memberPlayerIds.includes(userId),
            isHost: lobby.hostId === userId,
            updatedAt: lobby.updatedAt,
          },
        })
      }
    }
  }

  return targets.sort(compareActivityTargets)
}

async function getUniqueOpenLobbyForChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbiesByMode = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  const openLobbies = lobbiesByMode
    .flat()
    .filter(lobby => lobby.channelId === channelId && lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

function countFilledSlots(slots: (string | null)[]): number {
  let count = 0
  for (const slot of slots) {
    if (slot != null) count += 1
  }
  return count
}

function compareActivityTargets(left: ChannelActivityTarget, right: ChannelActivityTarget): number {
  const leftPriority = activityTargetPriority(left.option)
  const rightPriority = activityTargetPriority(right.option)
  if (leftPriority !== rightPriority) return leftPriority - rightPriority

  if (left.option.updatedAt !== right.option.updatedAt) return right.option.updatedAt - left.option.updatedAt
  if (left.option.mode !== right.option.mode) return left.option.mode.localeCompare(right.option.mode)
  return left.option.id.localeCompare(right.option.id)
}

function activityTargetPriority(option: ActivityTargetOption): number {
  if (option.isHost) return 0
  if (option.isMember) return 1
  if (option.kind === 'lobby') return 2
  return option.status === 'drafting' ? 3 : 4
}

async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
) {
  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, normalizedSlots)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }
  return buildOpenLobbySnapshotFromParts(kv, mode, resolvedLobby, lobbyQueueEntries, normalizedSlots)
}

async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
) {
  const slotEntries = mapLobbySlotsToEntries(slots, queueEntries)
  const serverDefaults = await getServerDraftTimerDefaults(kv)

  return {
    id: lobby.id,
    revision: lobby.revision,
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    minRole: lobby.minRole,
    entries: slotEntries.map((entry) => {
      if (!entry) return null
      return {
        playerId: entry.playerId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl ?? null,
        partyIds: entry.partyIds ?? [],
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

async function resolveOpenLobbyFromBody(
  kv: KVNamespace,
  mode: GameMode,
  body: { lobbyId?: unknown },
): Promise<LobbyState | null> {
  if (typeof body.lobbyId === 'string' && body.lobbyId.length > 0) {
    const lobby = await getLobbyById(kv, body.lobbyId)
    if (!lobby || lobby.mode !== mode || lobby.status !== 'open') return null
    return lobby
  }

  const lobbies = await getLobbiesByMode(kv, mode)
  const openLobbies = lobbies.filter(lobby => lobby.status === 'open')
  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

function buildLobbyQueueEntries(lobby: LobbyState, queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries']) {
  return filterQueueEntriesForLobby(lobby, queueEntries)
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

function parseLobbyMinRole(value: unknown): CompetitiveTier | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  if (typeof value !== 'string') return undefined
  return COMPETITIVE_TIERS.includes(value as CompetitiveTier) ? value as CompetitiveTier : undefined
}

async function validatePlayerAgainstLobbyMinRole(
  token: string,
  kv: KVNamespace,
  lobby: LobbyState,
  playerId: string,
): Promise<string | null> {
  if (!lobby.minRole) return null
  if (!lobby.guildId) return 'This lobby is missing guild context, so rank gating is unavailable.'

  const config = await getRankedRoleConfig(kv, lobby.guildId)
  const gateError = getRankedRoleGateError(config, lobby.minRole)
  if (gateError) return gateError
  const visuals = buildRankedRoleVisuals(config)
  const minRoleVisual = getRankedRoleVisualForTier(visuals, lobby.minRole)

  const roleIds = await fetchGuildMemberRoleIds(token, lobby.guildId, playerId)
  if (memberMeetsRankedRoleGate(roleIds, lobby.minRole, config)) return null
  return `This lobby requires at least ${minRoleVisual?.label ?? 'that ranked role'}.`
}

async function validateLobbyMembersAgainstMinRole(
  token: string,
  lobby: LobbyState,
  lobbyQueueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  minRole: CompetitiveTier,
): Promise<{
  error: string
  errorCode: string
  context?: {
    playerId: string
    playerName: string
    minRole: RankedRoleVisual
  }
} | null> {
  if (!lobby.guildId) {
    return {
      error: 'This lobby is missing guild context, so rank gating is unavailable.',
      errorCode: 'MIN_ROLE_CONTEXT_MISSING',
    }
  }

  const visuals = buildRankedRoleVisuals(config)
  const minRoleVisual = getRankedRoleVisualForTier(visuals, minRole)
  if (!minRoleVisual) {
    return {
      error: 'This minimum ranked role is not configured yet. Ask an admin to run /admin ranked roles.',
      errorCode: 'MIN_ROLE_NOT_CONFIGURED',
    }
  }
  const queueEntryByPlayerId = new Map(lobbyQueueEntries.map(entry => [entry.playerId, entry]))

  for (const playerId of lobby.memberPlayerIds) {
    const roleIds = await fetchGuildMemberRoleIds(token, lobby.guildId, playerId)
    if (memberMeetsRankedRoleGate(roleIds, minRole, config)) continue

    const playerName = queueEntryByPlayerId.get(playerId)?.displayName ?? 'Unknown player'
    return {
      error: `${playerName} does not meet the new minimum rank ${minRoleVisual.label}.`,
      errorCode: 'MIN_ROLE_MEMBER_MISMATCH',
      context: {
        playerId,
        playerName,
        minRole: minRoleVisual,
      },
    }
  }

  return null
}

function getRankedRoleVisualForTier(visuals: RankedRoleVisual[], tier: CompetitiveTier): RankedRoleVisual | null {
  return visuals.find(visual => visual.tier === tier) ?? null
}

function emptyRankedRoleConfig(): Awaited<ReturnType<typeof getRankedRoleConfig>> {
  return {
    currentRoles: {
      champion: null,
      legion: null,
      gladiator: null,
      squire: null,
      pleb: null,
    },
    currentRoleMeta: {
      champion: { label: null, color: null },
      legion: { label: null, color: null },
      gladiator: { label: null, color: null },
      squire: { label: null, color: null },
      pleb: { label: null, color: null },
    },
  }
}

function parseHostIdFromDraftData(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { hostId?: unknown }
    return typeof parsed.hostId === 'string' ? parsed.hostId : null
  }
  catch {
    return null
  }
}
