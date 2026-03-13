import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../../env.ts'
import { createDraftRoomAccessToken } from '@civup/utils'
import { createDb, playerRatings } from '@civup/db'
import { formatModeLabel, getMinimumLeaderPoolSize, isTeamMode, MAX_LEADER_POOL_SIZE, maxPlayerCount, parseGameMode, slotToTeamIndex } from '@civup/game'
import { isDev } from '@civup/utils'
import { and, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyDraftingEmbed } from '../../embeds/match.ts'
import { clearLobbyMappings, clearUserLobbyMappings, createDraftRoom, storeMatchMapping, storeUserActivityTarget, storeUserLobbyMappings, storeUserMatchMappings } from '../../services/activity/index.ts'
import { MAX_CONFIG_TIMER_SECONDS, resolveDraftTimerConfig } from '../../services/config/index.ts'
import {
  arrangeTeamLobbySlots,
  attachLobbyMatch,
  buildActivePremadeEdgeSet,
  buildOpenLobbyRenderPayload,
  buildSlottedPremadeGroups,
  clearLobbyById,
  compactSlottedPremadesForMode,
  getLobbyById,
  getOpenLobbyForPlayer,
  mapLobbySlotsToEntries,
  moveSlottedPremadeGroup,
  normalizeLobbySlots,
  rebuildQueueEntriesFromPremadeEdgeSet,
  setLobbyDraftConfig,
  setLobbyMemberPlayerIds,
  setLobbyMinRole,
  setLobbySlots,
  setLobbySteamLobbyLink,
  touchLobby,
  upsertLobby,
  upsertLobbyMessage,
} from '../../services/lobby/index.ts'
import { arePremadeGroupsAdjacent } from '../../services/lobby/premades.ts'
import { createDraftMatch } from '../../services/match/index.ts'
import { storeMatchMessageMapping } from '../../services/match/message.ts'
import { addToQueue, clearQueue, getQueueState, moveQueueEntriesBetweenModes, removeFromQueueAndUnlinkParty, setQueueEntries } from '../../services/queue/index.ts'
import { buildRankedRoleVisuals, getRankedRoleConfig, getRankedRoleGateError } from '../../services/ranked/roles.ts'
import { createStateStore } from '../../services/state/store.ts'
import { parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../services/steam-link.ts'
import { rejectMismatchedActivityUser, requireAuthenticatedActivity } from '../auth.ts'
import {
  buildLobbyQueueEntries,
  buildOpenLobbySnapshot,
  buildOpenLobbySnapshotFromParts,
  canStartLobbyWithPlayerCount,
  emptyRankedRoleConfig,
  lobbyMinPlayerCount,
  parseLobbyLeaderPoolSize,
  parseLobbyMinRole,
  parseLobbyTimerSeconds,
  parseSlotIndex,
  resolveOpenLobbyFromBody,
} from './snapshot.ts'

const DEBUG_TEST_PLAYER_ID_PREFIX = 'debug-active-lobby-bot:'

export function registerLobbyRoutes(app: Hono<Env>) {
  app.get('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!isDebugLobbyFillEnabled(c.req.url, c.env.BOT_HOST)) return c.json({ error: 'Not found' }, 404)
    return c.body(null, 204)
  })

  app.get('/api/lobby-ranks/:mode/:lobbyId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

  app.post('/api/lobby/:mode/config', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const { userId, banTimerSeconds, pickTimerSeconds, leaderPoolSize: leaderPoolSizeRaw, minRole: minRoleRaw, steamLobbyLink: steamLobbyLinkRaw, lobbyId } = body as {
      userId?: string
      banTimerSeconds?: unknown
      pickTimerSeconds?: unknown
      leaderPoolSize?: unknown
      minRole?: unknown
      steamLobbyLink?: unknown
      lobbyId?: unknown
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      return c.json({ error: 'userId is required' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const normalizedBan = parseLobbyTimerSeconds(banTimerSeconds)
    const normalizedPick = parseLobbyTimerSeconds(pickTimerSeconds)
    const hasLeaderPoolSize = Object.prototype.hasOwnProperty.call(body, 'leaderPoolSize')
    const parsedLeaderPoolSize = hasLeaderPoolSize
      ? parseLobbyLeaderPoolSize(leaderPoolSizeRaw)
      : undefined
    if (normalizedBan === undefined || normalizedPick === undefined) {
      return c.json({ error: `Timers must be numbers between 0 and ${MAX_CONFIG_TIMER_SECONDS}` }, 400)
    }
    if (hasLeaderPoolSize && parsedLeaderPoolSize === undefined) {
      return c.json({ error: `leaderPoolSize must be an integer between 1 and ${MAX_LEADER_POOL_SIZE}, or null` }, 400)
    }
    const hasSteamLobbyLink = Object.prototype.hasOwnProperty.call(body, 'steamLobbyLink')
    const parsedSteamLobbyLink = hasSteamLobbyLink
      ? parseSteamLobbyLink(steamLobbyLinkRaw)
      : undefined
    if (hasSteamLobbyLink && parsedSteamLobbyLink === undefined) {
      return c.json({ error: STEAM_LOBBY_LINK_ERROR }, 400)
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
      return c.json({ error: 'minRole must be a ranked tier id like tier1, or null' }, 400)
    }
    const normalizedMinRole = parsedMinRole
    const normalizedLeaderPoolSize: number | null = hasLeaderPoolSize
      ? parsedLeaderPoolSize ?? null
      : lobby.draftConfig.leaderPoolSize
    const minRoleChanged = normalizedMinRole !== lobby.minRole

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can update draft config' }, 403)
    }

    if (minRoleChanged && normalizedMinRole && !lobby.guildId) {
      return c.json({ error: 'This lobby is missing guild context, so min rank cannot be set.' }, 400)
    }

    const queue = await getQueueState(kv, mode)
    const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
    const currentPlayerCount = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
      .filter(playerId => playerId != null)
      .length

    const leaderPoolError = getLeaderPoolSizeError(
      mode,
      normalizedLeaderPoolSize,
      mode === 'ffa' ? currentPlayerCount : maxPlayerCount(mode),
    )
    if (leaderPoolError) return c.json({ error: leaderPoolError }, 400)

    const rankedRoleConfig = lobby.guildId ? await getRankedRoleConfig(kv, lobby.guildId) : null
    if (minRoleChanged && normalizedMinRole && rankedRoleConfig) {
      const gateError = getRankedRoleGateError(rankedRoleConfig, normalizedMinRole)
      if (gateError) return c.json({ error: gateError }, 400)
    }

    const draftUpdated = await setLobbyDraftConfig(kv, lobby.id, {
      banTimerSeconds: normalizedBan,
      pickTimerSeconds: normalizedPick,
      leaderPoolSize: normalizedLeaderPoolSize,
    }, lobby)

    lobby = draftUpdated ?? lobby
    const minRoleUpdated = await setLobbyMinRole(kv, lobby.id, normalizedMinRole, lobby)
    lobby = minRoleUpdated ?? lobby
    const updated = hasSteamLobbyLink
      ? (await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby) ?? lobby)
      : lobby

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

  app.post('/api/lobby/:mode/mode', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const nextMode = typeof nextModeRaw === 'string' ? parseGameMode(nextModeRaw) : null
    if (!nextMode) {
      return c.json({ error: 'nextMode must be one of ffa, 1v1, 2v2, 3v3, 4v4' }, 400)
    }

    const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    const lobby = resolvedLobby

    if (lobby.hostId !== auth.identity.userId) {
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

  app.post('/api/lobby/:mode/place', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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
      lobbyId,
    } = body as {
      userId?: string
      targetSlot?: unknown
      playerId?: unknown
      lobbyId?: unknown
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      return c.json({ error: 'userId is required' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const targetSlot = parseSlotIndex(targetSlotRaw)
    if (targetSlot == null || targetSlot >= maxPlayerCount(mode)) {
      return c.json({ error: 'Invalid target slot index' }, 400)
    }

    const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    let lobby = resolvedLobby

    const isHost = lobby.hostId === auth.identity.userId
    const movingPlayerId = typeof requestedPlayerId === 'string' && requestedPlayerId.length > 0
      ? requestedPlayerId
      : auth.identity.userId

    if (!isHost && movingPlayerId !== auth.identity.userId) {
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
      if (movingPlayerId !== auth.identity.userId) {
        return c.json({ error: 'Target player is not available as a spectator.' }, 400)
      }

      const resolvedDisplayName = auth.identity.displayName?.trim() ?? ''
      if (resolvedDisplayName.length === 0) {
        return c.json({ error: 'displayName is required when joining as spectator.' }, 400)
      }

      const joinResult = await addToQueue(kv, mode, {
        playerId: movingPlayerId,
        displayName: resolvedDisplayName,
        avatarUrl: auth.identity.avatarUrl,
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

  app.post('/api/lobby/:mode/remove', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

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

    const isHost = auth.identity.userId === lobby.hostId
    if (!isHost && auth.identity.userId !== targetPlayerId) {
      return c.json({ error: 'You can only remove yourself from a slot.' }, 403)
    }

    const removed = await removeFromQueueAndUnlinkParty(kv, targetPlayerId)
    const queueAfterRemoval = removed.mode ? await getQueueState(kv, mode) : queue

    slots[slot] = null
    let nextEntries = queueAfterRemoval.entries
    if (isTeamMode(mode)) {
      const nextEdges = buildActivePremadeEdgeSet(mode, slots, queueAfterRemoval.entries)
      nextEntries = rebuildQueueEntriesFromPremadeEdgeSet(mode, slots, queueAfterRemoval.entries, nextEdges)
      await setQueueEntries(kv, mode, nextEntries, {
        currentState: queueAfterRemoval,
      })
    }

    const nextMemberIds = lobby.memberPlayerIds.filter(playerId => playerId !== targetPlayerId)
    let nextLobby = await setLobbyMemberPlayerIds(kv, lobby.id, nextMemberIds, lobby) ?? lobby
    const updatedLobby = await setLobbySlots(kv, nextLobby.id, slots, nextLobby)
    nextLobby = updatedLobby ?? { ...nextLobby, slots, updatedAt: Date.now() }
    const nextLobbyQueueEntries = buildLobbyQueueEntries(nextLobby, nextEntries)
    const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

    await clearUserLobbyMappings(kv, [targetPlayerId])

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

  app.post('/api/lobby/:mode/link', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = createStateStore(c.env)
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!isTeamMode(mode)) {
      return c.json({ error: 'Premade links are only available in 2v2, 3v3, and 4v4.' }, 400)
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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

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

    const isHost = lobby.hostId === auth.identity.userId
    if (!isHost && auth.identity.userId !== leftPlayerId && auth.identity.userId !== rightPlayerId) {
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

  app.post('/api/lobby/:mode/arrange', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = createStateStore(c.env)
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!isTeamMode(mode)) {
      return c.json({ error: 'Team arrange actions are only available in 2v2, 3v3, and 4v4 lobbies.' }, 400)
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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    if (strategyRaw !== 'randomize' && strategyRaw !== 'balance') {
      return c.json({ error: 'strategy must be one of randomize or balance' }, 400)
    }

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
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

  app.post('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
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

  app.post('/api/lobby/:mode/start', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const internalSecret = c.env.CIVUP_SECRET?.trim() ?? ''
    if (internalSecret.length === 0) {
      return c.json({ error: 'Draft auth is not configured.' }, 503)
    }

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId }) ?? await getLobbyById(kv, typeof lobbyId === 'string' ? lobbyId : '')
    if (!lobby) return c.json({ error: 'No lobby for this mode' }, 404)

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can start the draft' }, 403)
    }

    if (lobby.status === 'drafting' && lobby.matchId) {
        console.log('[idempotency] duplicate lobby start request', {
          mode,
          hostId: auth.identity.userId,
          matchId: lobby.matchId,
          revision: lobby.revision,
        })
       return c.json({
         ok: true,
         matchId: lobby.matchId,
         idempotent: true,
         roomAccessToken: await createDraftRoomAccessToken(internalSecret, {
           userId: auth.identity.userId,
           roomId: lobby.matchId,
           channelId: lobby.channelId,
         }),
       })
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
      const leaderPoolError = getLeaderPoolSizeError(mode, lobby.draftConfig.leaderPoolSize, selectedEntries.length)
      if (leaderPoolError) return c.json({ error: leaderPoolError }, 400)

      const { matchId, seats } = await createDraftRoom(mode, selectedEntries, {
        hostId: lobby.hostId,
        partyHost: c.env.PARTY_HOST,
        botHost: c.env.BOT_HOST,
        webhookSecret: internalSecret,
        timerConfig,
        leaderPoolSize: lobby.draftConfig.leaderPoolSize,
      })

      const db = createDb(c.env.DB)
      await createDraftMatch(db, { matchId, mode, seats })

      if (lobby.memberPlayerIds.length > 0) {
        await clearQueue(kv, mode, lobby.memberPlayerIds, {
          currentState: queue,
        })
      }

      await setLobbySlots(kv, lobby.id, slots, lobby)
      const lobbyForMessage = await attachLobbyMatch(kv, lobby.id, matchId, lobby)
      if (!lobbyForMessage) {
        const currentLobby = await getLobbyById(kv, lobby.id)
        if (currentLobby?.status === 'drafting' && currentLobby.matchId) {
          console.warn('[idempotency] lobby start transitioned concurrently', {
            mode,
            hostId: auth.identity.userId,
            requestedMatchId: matchId,
            activeMatchId: currentLobby.matchId,
            revision: currentLobby.revision,
          })
           return c.json({
             ok: true,
             matchId: currentLobby.matchId,
             idempotent: true,
             roomAccessToken: await createDraftRoomAccessToken(internalSecret, {
               userId: auth.identity.userId,
               roomId: currentLobby.matchId,
               channelId: currentLobby.channelId,
             }),
           })
         }
        console.warn('[lobby-transition] failed to attach match to lobby', {
          mode,
          hostId: auth.identity.userId,
          requestedMatchId: matchId,
        })
        return c.json({ error: 'Lobby state changed while starting. Please retry.' }, 409)
      }

      await clearLobbyMappings(kv, lobbyForMessage.memberPlayerIds, lobbyForMessage.channelId)
      await storeMatchMapping(kv, lobbyForMessage.channelId, matchId)
      await storeUserMatchMappings(kv, lobbyForMessage.memberPlayerIds, matchId)
      await storeUserActivityTarget(kv, lobbyForMessage.channelId, lobbyForMessage.memberPlayerIds, { kind: 'match', id: matchId })

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

      return c.json({
        ok: true,
        matchId,
        roomAccessToken: await createDraftRoomAccessToken(internalSecret, {
          userId: auth.identity.userId,
          roomId: matchId,
          channelId: lobbyForMessage.channelId,
        }),
      })
    }
    catch (error) {
      console.error(`Failed to start lobby draft for mode ${mode}:`, error)
      return c.json({ error: 'Failed to start draft. Please try again.' }, 500)
    }
  })

  app.post('/api/lobby/:mode/cancel', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

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

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No lobby for this mode' }, 404)
    }

    if (lobby.status !== 'open') {
      return c.json({ error: 'Lobby can only be cancelled before draft start' }, 400)
    }

    if (lobby.hostId !== auth.identity.userId) {
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
}

function getLeaderPoolSizeError(
  mode: GameMode,
  leaderPoolSize: number | null,
  playerCount: number,
): string | null {
  if (leaderPoolSize == null) return null

  const minimumSize = getMinimumLeaderPoolSize(mode, playerCount)
  if (leaderPoolSize >= minimumSize) return null

  if (mode === 'ffa') {
    return `Leaders must be at least ${minimumSize} for a ${playerCount}-player FFA.`
  }

  return `Leaders must be at least ${minimumSize} for ${formatModeLabel(mode)}.`
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
