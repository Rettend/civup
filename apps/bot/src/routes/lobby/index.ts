import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../../env.ts'
import { createDb, playerRatings } from '@civup/db'
import { defaultPlayerCount, formatModeLabel, getMinimumLeaderPoolSize, isLeaderDataVersion, isTeamMode, isUnrankedMode, MAX_LEADER_POOL_SIZE, normalizeCompetitiveTierBounds, parseGameMode, playerCountOptions, slotToTeamIndex, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { createDraftRoomAccessToken, isDev } from '@civup/utils'
import { and, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyDraftingEmbed } from '../../embeds/match.ts'
import { clearLobbyMappingsIfMatchingLobby, clearUserLobbyMappings, createDraftRoom, handoffLobbySpectatorsToMatchActivity, storeMatchActivityState, storeUserLobbyMappings, storeUserLobbyState } from '../../services/activity/index.ts'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS, resolveDraftTimerConfig } from '../../services/config/index.ts'
import {
  arrangeLobbySlots,
  attachLobbyMatch,
  buildActivePremadeEdgeSet,
  buildOpenLobbyRenderPayload,
  buildSlottedPremadeGroups,
  clearLobbyById,
  compactSlottedPremadesForMode,
  getCurrentLobbiesForPlayer,
  getCurrentLobbyForQueuedMessageUpdate,
  getLobbyById,
  mapLobbySlotsToEntries,
  moveSlottedPremadeGroup,
  normalizeLobbySlots,
  rebuildQueueEntriesFromPremadeEdgeSet,
  sameLobbySlots,
  setLobbyDraftConfig,
  setLobbyLastActivityAt,
  setLobbyMaxRole,
  setLobbyMemberPlayerIds,
  setLobbyMinRole,
  setLobbySlots,
  setLobbySteamLobbyLink,
  storeLobbyDraftRoster,
  upsertLobby,
  upsertLobbyMessage,
} from '../../services/lobby/index.ts'
import { modeIndexKey } from '../../services/lobby/keys.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { arePremadeGroupsAdjacent } from '../../services/lobby/premades.ts'
import { normalizeDraftConfigForMode } from '../../services/lobby/normalize.ts'
import { createDraftMatch } from '../../services/match/index.ts'
import { storeMatchMessageMapping } from '../../services/match/message.ts'
import { addToQueue, clearQueue, getQueueState, moveQueueEntriesBetweenModes, removeFromQueueAndUnlinkParty, setQueueEntries } from '../../services/queue/index.ts'
import { buildRankedRoleVisuals, getRankedRoleConfig, getRankedRoleGateError } from '../../services/ranked/roles.ts'
import { createStateStore, stateStoreMdelete } from '../../services/state/store.ts'
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
  parseLobbyMaxRole,
  parseLobbyMinRole,
  parseLobbyTargetSize,
  parseLobbyTimerSeconds,
  parseSlotIndex,
  resolveOpenLobbyFromBody,
} from './snapshot.ts'

const DEBUG_TEST_PLAYER_ID_PREFIX = 'bot:'

export function registerLobbyRoutes(app: Hono<Env>) {
  app.get('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!isDebugLobbyFillEnabled(c.req.url, c.env.BOT_HOST, c.env.ENABLE_DEBUG_LOBBY_FILL)) return c.json({ error: 'Not found' }, 404)
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

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
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

    const { userId, banTimerSeconds, pickTimerSeconds, leaderPoolSize: leaderPoolSizeRaw, leaderDataVersion: leaderDataVersionRaw, simultaneousPick: simultaneousPickRaw, redDeath: redDeathRaw, dealOptionsSize: dealOptionsSizeRaw, randomDraft: randomDraftRaw, duplicateFactions: duplicateFactionsRaw, minRole: minRoleRaw, maxRole: maxRoleRaw, steamLobbyLink: steamLobbyLinkRaw, targetSize: targetSizeRaw, lobbyId } = body as {
      userId?: string
      banTimerSeconds?: unknown
      pickTimerSeconds?: unknown
      leaderPoolSize?: unknown
      leaderDataVersion?: unknown
      simultaneousPick?: unknown
      redDeath?: unknown
      dealOptionsSize?: unknown
      randomDraft?: unknown
      duplicateFactions?: unknown
      minRole?: unknown
      maxRole?: unknown
      steamLobbyLink?: unknown
      targetSize?: unknown
      lobbyId?: unknown
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      return c.json({ error: 'userId is required' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    const hasBanTimerSeconds = Object.prototype.hasOwnProperty.call(body, 'banTimerSeconds')
    const hasPickTimerSeconds = Object.prototype.hasOwnProperty.call(body, 'pickTimerSeconds')
    const hasMinRole = Object.prototype.hasOwnProperty.call(body, 'minRole')
    const hasMaxRole = Object.prototype.hasOwnProperty.call(body, 'maxRole')
    const normalizedBan = hasBanTimerSeconds
      ? parseLobbyTimerSeconds(banTimerSeconds)
      : undefined
    const normalizedPick = hasPickTimerSeconds
      ? parseLobbyTimerSeconds(pickTimerSeconds)
      : undefined
    const hasLeaderPoolSize = Object.prototype.hasOwnProperty.call(body, 'leaderPoolSize')
    const hasLeaderDataVersion = Object.prototype.hasOwnProperty.call(body, 'leaderDataVersion')
    const hasSimultaneousPick = Object.prototype.hasOwnProperty.call(body, 'simultaneousPick')
    const hasRedDeath = Object.prototype.hasOwnProperty.call(body, 'redDeath')
    const hasDealOptionsSize = Object.prototype.hasOwnProperty.call(body, 'dealOptionsSize')
    const hasRandomDraft = Object.prototype.hasOwnProperty.call(body, 'randomDraft')
    const hasDuplicateFactions = Object.prototype.hasOwnProperty.call(body, 'duplicateFactions')
    const hasTargetSize = Object.prototype.hasOwnProperty.call(body, 'targetSize')
    const parsedLeaderPoolSize = hasLeaderPoolSize
      ? parseLobbyLeaderPoolSize(leaderPoolSizeRaw)
      : undefined
    if ((hasBanTimerSeconds && normalizedBan === undefined) || (hasPickTimerSeconds && normalizedPick === undefined)) {
      return c.json({ error: `Timers must be numbers between 0 and ${MAX_CONFIG_TIMER_SECONDS}` }, 400)
    }
    if (hasLeaderPoolSize && parsedLeaderPoolSize === undefined) {
      return c.json({ error: `leaderPoolSize must be an integer between 1 and ${MAX_LEADER_POOL_SIZE}, or null` }, 400)
    }
    const parsedLeaderDataVersion = hasLeaderDataVersion
      ? parseLobbyLeaderDataVersion(leaderDataVersionRaw)
      : undefined
    const parsedSimultaneousPick = hasSimultaneousPick
      ? parseLobbySimultaneousPick(simultaneousPickRaw)
      : undefined
    const parsedRedDeath = hasRedDeath
      ? parseLobbyRedDeath(redDeathRaw)
      : undefined
    const parsedDealOptionsSize = hasDealOptionsSize
      ? parseLobbyDealOptionsSize(dealOptionsSizeRaw)
      : undefined
    const parsedRandomDraft = hasRandomDraft
      ? parseLobbyRandomDraft(randomDraftRaw)
      : undefined
    const parsedDuplicateFactions = hasDuplicateFactions
      ? parseLobbyDuplicateFactions(duplicateFactionsRaw)
      : undefined
    const parsedTargetSize = hasTargetSize
      ? parseLobbyTargetSize(mode, targetSizeRaw)
      : undefined
    if (hasLeaderDataVersion && parsedLeaderDataVersion === undefined) {
      return c.json({ error: 'leaderDataVersion must be "live" or "beta"' }, 400)
    }
    if (hasSimultaneousPick && parsedSimultaneousPick === undefined) {
      return c.json({ error: 'simultaneousPick must be true or false' }, 400)
    }
    if (hasRedDeath && parsedRedDeath === undefined) {
      return c.json({ error: 'redDeath must be true or false' }, 400)
    }
    if (hasDealOptionsSize && parsedDealOptionsSize === undefined) {
      return c.json({ error: 'dealOptionsSize must be an integer between 2 and 10, or null' }, 400)
    }
    if (hasRandomDraft && parsedRandomDraft === undefined) {
      return c.json({ error: 'randomDraft must be true or false' }, 400)
    }
    if (hasDuplicateFactions && parsedDuplicateFactions === undefined) {
      return c.json({ error: 'duplicateFactions must be true or false' }, 400)
    }
    const hasSteamLobbyLink = Object.prototype.hasOwnProperty.call(body, 'steamLobbyLink')
    const parsedSteamLobbyLink = hasSteamLobbyLink
      ? parseSteamLobbyLink(steamLobbyLinkRaw)
      : undefined
    if (hasSteamLobbyLink && parsedSteamLobbyLink === undefined) {
      return c.json({ error: STEAM_LOBBY_LINK_ERROR }, 400)
    }

    const lobbyById = typeof lobbyId === 'string' && lobbyId.length > 0 ? await getLobbyById(kv, lobbyId) : null
    const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
      ?? (lobbyById && lobbyById.status !== 'open' ? lobbyById : null)
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    if (resolvedLobby.mode !== mode) {
      return c.json({ error: 'No lobby for this mode' }, 404)
    }
    let lobby = resolvedLobby

    const parsedMinRole = Object.prototype.hasOwnProperty.call(body, 'minRole')
      ? parseLobbyMinRole(minRoleRaw)
      : lobby.minRole
    if (parsedMinRole === undefined) {
      return c.json({ error: 'minRole must be a ranked tier id like tier1, or null' }, 400)
    }
    const parsedMaxRole = Object.prototype.hasOwnProperty.call(body, 'maxRole')
      ? parseLobbyMaxRole(maxRoleRaw)
      : lobby.maxRole
    if (parsedMaxRole === undefined) {
      return c.json({ error: 'maxRole must be a ranked tier id like tier1, or null' }, 400)
    }
    const normalizedRankBounds = normalizeCompetitiveTierBounds(parsedMinRole, parsedMaxRole)

    const resolvedBanTimerSeconds = hasBanTimerSeconds
      ? normalizedBan ?? null
      : lobby.draftConfig.banTimerSeconds
    const resolvedPickTimerSeconds = hasPickTimerSeconds
      ? normalizedPick ?? null
      : lobby.draftConfig.pickTimerSeconds
    const normalizedMinRole = normalizedRankBounds.minimum
    const normalizedMaxRole = normalizedRankBounds.maximum
    const normalizedLeaderPoolSize: number | null = hasLeaderPoolSize
      ? parsedLeaderPoolSize ?? null
      : lobby.draftConfig.leaderPoolSize
    const normalizedLeaderDataVersion = hasLeaderDataVersion
      ? parsedLeaderDataVersion ?? 'live'
      : lobby.draftConfig.leaderDataVersion
    const normalizedSimultaneousPick = hasSimultaneousPick
      ? parsedSimultaneousPick ?? false
      : lobby.draftConfig.simultaneousPick
    const normalizedRedDeath = hasRedDeath
      ? parsedRedDeath ?? false
      : lobby.draftConfig.redDeath
    const normalizedDealOptionsSize = hasDealOptionsSize
      ? parsedDealOptionsSize ?? null
      : lobby.draftConfig.dealOptionsSize
    const normalizedRandomDraft = hasRandomDraft
      ? parsedRandomDraft ?? false
      : lobby.draftConfig.randomDraft
    const normalizedDuplicateFactions = hasDuplicateFactions
      ? parsedDuplicateFactions ?? false
      : lobby.draftConfig.duplicateFactions
    const parsedRedDeathFfaTargetSize = mode === 'ffa' && hasTargetSize
      ? parseRedDeathFfaTargetSize(targetSizeRaw)
      : undefined

    if (isUnrankedMode(mode) && (normalizedMinRole != null || normalizedMaxRole != null)) {
      return c.json({ error: `${formatModeLabel(mode)} lobbies are unranked and do not support matchmaking rank limits.` }, 400)
    }

    if (hasTargetSize) {
      const targetSizeValid = mode === 'ffa' && normalizedRedDeath
        ? parsedRedDeathFfaTargetSize !== undefined
        : parsedTargetSize !== undefined
      if (!targetSizeValid) {
        return c.json({ error: 'targetSize must be a supported player count for this mode' }, 400)
      }
    }
    const minRoleChanged = normalizedMinRole !== lobby.minRole
    const maxRoleChanged = normalizedMaxRole !== lobby.maxRole

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can update draft config' }, 403)
    }

    if (lobby.status !== 'open') {
      if (!isSteamLobbyEditableStatus(lobby.status)) {
        return c.json({ error: 'Steam lobby links can only be managed while the lobby is open or the match is live.' }, 409)
      }
      if (!hasSteamLobbyLink) {
        return c.json({ error: 'Only the Steam lobby link can be updated after the draft starts.' }, 409)
      }
      if (hasBanTimerSeconds || hasPickTimerSeconds || hasLeaderPoolSize || hasLeaderDataVersion || hasSimultaneousPick || hasRedDeath || hasDealOptionsSize || hasRandomDraft || hasDuplicateFactions || hasTargetSize || hasMinRole || hasMaxRole) {
        return c.json({ error: 'Only the Steam lobby link can be updated after the draft starts.' }, 409)
      }

      const updated = await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby) ?? lobby
      if (updated.revision !== lobby.revision) {
        await syncLobbyDerivedState(kv, updated)
      }
      return c.json(await buildStoredLobbySnapshot(kv, mode, updated))
    }

    if (minRoleChanged && normalizedMinRole && !lobby.guildId) {
      return c.json({ error: 'This lobby is missing guild context, so min rank cannot be set.' }, 400)
    }
    if (maxRoleChanged && normalizedMaxRole && !lobby.guildId) {
      return c.json({ error: 'This lobby is missing guild context, so max rank cannot be set.' }, 400)
    }

    const queue = await getQueueState(kv, mode)
    const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
    let slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const requestedTargetSize = (() => {
      if (mode !== 'ffa') {
        return hasTargetSize ? parsedTargetSize ?? slots.length : slots.length
      }

      if (normalizedRedDeath) {
        if (hasTargetSize) return parsedRedDeathFfaTargetSize ?? 10
        return 10
      }

      return defaultPlayerCount(mode)
    })()

    if (requestedTargetSize !== slots.length) {
      if (requestedTargetSize < slots.length) {
        const removedSlotIndexes = getRemovedSlotIndexesForResize(mode, slots.length, requestedTargetSize)
        if (removedSlotIndexes.some(index => slots[index] != null)) {
          return c.json({ error: getResizeShrinkErrorMessage(mode, slots.length, requestedTargetSize) }, 400)
        }
      }

      slots = resizeLobbySlots(mode, slots, requestedTargetSize)
    }

    const leaderPoolError = getLeaderPoolSizeError(
      mode,
      normalizedRedDeath,
      normalizedLeaderPoolSize,
      slots.length,
    )
    if (leaderPoolError) return c.json({ error: leaderPoolError }, 400)

    const rankedRoleConfig = lobby.guildId ? await getRankedRoleConfig(kv, lobby.guildId) : null
    if (minRoleChanged && normalizedMinRole && rankedRoleConfig) {
      const gateError = getRankedRoleGateError(rankedRoleConfig, normalizedMinRole, 'min')
      if (gateError) return c.json({ error: gateError }, 400)
    }
    if (maxRoleChanged && normalizedMaxRole && rankedRoleConfig) {
      const gateError = getRankedRoleGateError(rankedRoleConfig, normalizedMaxRole, 'max')
      if (gateError) return c.json({ error: gateError }, 400)
    }

    const draftUpdated = await setLobbyDraftConfig(kv, lobby.id, {
      banTimerSeconds: resolvedBanTimerSeconds,
      pickTimerSeconds: resolvedPickTimerSeconds,
      leaderPoolSize: normalizedLeaderPoolSize,
      leaderDataVersion: normalizedLeaderDataVersion,
      simultaneousPick: normalizedSimultaneousPick,
      redDeath: normalizedRedDeath,
      dealOptionsSize: normalizedDealOptionsSize,
      randomDraft: normalizedRandomDraft,
      duplicateFactions: normalizedDuplicateFactions,
    }, lobby)

    lobby = draftUpdated ?? lobby
    const minRoleUpdated = await setLobbyMinRole(kv, lobby.id, normalizedMinRole, lobby)
    lobby = minRoleUpdated ?? lobby
    const maxRoleUpdated = await setLobbyMaxRole(kv, lobby.id, normalizedMaxRole, lobby)
    lobby = maxRoleUpdated ?? lobby
    if (!sameLobbySlots(slots, lobby.slots)) {
      const resizedLobby = await setLobbySlots(kv, lobby.id, slots, lobby)
      lobby = resizedLobby ?? { ...lobby, slots, updatedAt: Date.now() }
    }
    let updated = hasSteamLobbyLink
      ? (await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby) ?? lobby)
      : lobby

    if (!updated) {
      return c.json({ error: 'Lobby not found' }, 404)
    }

    if (updated.revision !== resolvedLobby.revision) {
      updated = await setLobbyLastActivityAt(kv, updated.id, Date.now(), updated) ?? updated
    }

    const nextLobbyQueueEntries = buildLobbyQueueEntries(updated, queue.entries)
    const normalizedSlots = normalizeLobbySlots(mode, updated.slots, nextLobbyQueueEntries)
    const slottedEntries = mapLobbySlotsToEntries(normalizedSlots, nextLobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, updated, {
      queueEntries: nextLobbyQueueEntries,
      slots: normalizedSlots,
    })

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, updated)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, updated, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after config change in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, updated, nextLobbyQueueEntries, normalizedSlots))
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
      return c.json({ error: 'nextMode must be a supported lobby mode' }, 400)
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
    const orderedPlayers = normalizedSlots.filter((playerId): playerId is string => playerId != null)
    const orderedPlayerSet = new Set(orderedPlayers)

    if (!orderedPlayerSet.has(lobby.hostId)) {
      orderedPlayers.push(lobby.hostId)
      orderedPlayerSet.add(lobby.hostId)
    }

    for (const entry of lobbyQueueEntries) {
      if (orderedPlayerSet.has(entry.playerId)) continue
      orderedPlayers.push(entry.playerId)
      orderedPlayerSet.add(entry.playerId)
    }

    const nextLayout = compactSlottedPremadesForMode(nextMode, orderedPlayers, lobbyQueueEntries, {
      sourceMode: mode,
      sourceSlots: normalizedSlots,
    })
    if ('error' in nextLayout) {
      return c.json({ error: nextLayout.error }, 400)
    }
    let nextSlots = nextLayout.slots
    if (nextMode === 'ffa' && lobby.draftConfig.redDeath) {
      nextSlots = resizeLobbySlots(nextMode, nextSlots, 10)
    }
    const changedAt = Date.now()

    const nextLobby = {
      ...lobby,
      mode: nextMode,
      draftConfig: normalizeDraftConfigForMode(nextMode, lobby.draftConfig),
      minRole: isUnrankedMode(nextMode) ? null : lobby.minRole,
      maxRole: isUnrankedMode(nextMode) ? null : lobby.maxRole,
      slots: nextSlots,
      lastActivityAt: changedAt,
      updatedAt: changedAt,
      revision: lobby.revision + 1,
    }

    const movedQueue = await moveQueueEntriesBetweenModes(kv, mode, nextMode, lobby.memberPlayerIds)
    const movedLobbyQueueEntries = buildLobbyQueueEntries({ ...lobby, mode: nextMode }, movedQueue.to.entries)
    const normalizedNextSlots = normalizeLobbySlots(nextMode, nextSlots, movedLobbyQueueEntries)
    const finalizedLobby = {
      ...nextLobby,
      slots: normalizedNextSlots,
    }

    await stateStoreMdelete(kv, [modeIndexKey(mode, lobby.id)])
    await upsertLobby(kv, finalizedLobby)
    const snapshot = await syncLobbyDerivedState(kv, finalizedLobby, {
      queueEntries: movedLobbyQueueEntries,
      slots: normalizedNextSlots,
    })
    await storeUserLobbyMappings(kv, finalizedLobby.memberPlayerIds, finalizedLobby.id)
    const slottedEntries = mapLobbySlotsToEntries(normalizedNextSlots, movedLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, finalizedLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, finalizedLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after mode change ${mode} -> ${nextMode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(
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
    if (targetSlot == null) {
      return c.json({ error: 'Invalid target slot index' }, 400)
    }

    const resolvedLobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    let lobby = resolvedLobby

    if (targetSlot >= lobby.slots.length) {
      return c.json({ error: 'Invalid target slot index' }, 400)
    }

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

    const currentLobbiesForPlayer = await getCurrentLobbiesForPlayer(kv, movingPlayerId, {
      excludeLobbyIds: [lobby.id],
    })
    const blockingLobbyForPlayer = currentLobbiesForPlayer.find(candidate => candidate.status !== 'open') ?? currentLobbiesForPlayer[0] ?? null
    if (blockingLobbyForPlayer) {
      return c.json({ error: blockingLobbyForPlayer.status === 'open' ? 'That player is already in another open lobby.' : 'That player is already in a live match.' }, 400)
    }

    const actionAt = Date.now()
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
        joinedAt: actionAt,
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
      await storeUserLobbyState(kv, lobby.channelId, [movingPlayerId], lobby.id)
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
    let nextLobby = updatedLobby ?? { ...lobby, slots, updatedAt: Date.now() }
    nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, actionAt, nextLobby) ?? nextLobby
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: lobbyQueueEntries,
      slots,
    })

    const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after slot placement in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, slots))
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
    if (slot == null) {
      return c.json({ error: 'Invalid slot index' }, 400)
    }

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (slot >= lobby.slots.length) {
      return c.json({ error: 'Invalid slot index' }, 400)
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
    nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, Date.now(), nextLobby) ?? nextLobby
    const nextLobbyQueueEntries = buildLobbyQueueEntries(nextLobby, nextEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
    })
    const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

    await clearUserLobbyMappings(kv, [targetPlayerId])

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after slot removal in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots))
  })

  app.post('/api/lobby/:mode/link', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = createStateStore(c.env)
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!isTeamMode(mode)) {
      return c.json({ error: 'Premade links are only available in team modes.' }, 400)
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
    if (leftSlot == null || rightSlot == null) {
      return c.json({ error: 'Invalid premade link position' }, 400)
    }

    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (rightSlot >= lobby.slots.length) {
      return c.json({ error: 'Invalid premade link position' }, 400)
    }

    if (slotToTeamIndex(mode, leftSlot, lobby.slots.length) == null || slotToTeamIndex(mode, leftSlot, lobby.slots.length) !== slotToTeamIndex(mode, rightSlot, lobby.slots.length)) {
      return c.json({ error: 'Premade links must stay on one team.' }, 400)
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
    const nextLobby = await setLobbyLastActivityAt(kv, lobby.id, Date.now(), lobby) ?? lobby
    const nextLobbyQueueEntries = buildLobbyQueueEntries(nextLobby, nextEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
    })

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots))
  })

  app.post('/api/lobby/:mode/arrange', async (c) => {
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
      return c.json({ error: 'Only the lobby host can arrange the lobby' }, 403)
    }

    const queue = await getQueueState(kv, mode)
    const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
    const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const slottedPlayerIds = slots.filter((playerId): playerId is string => playerId != null)

    let ratingsByPlayerId = new Map<string, { mu: number, sigma: number }>()
    if (strategyRaw === 'balance' && slottedPlayerIds.length > 0) {
      const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: lobby.draftConfig.redDeath })
      if (leaderboardMode != null) {
        const db = createDb(c.env.DB)
        const rows = await db
          .select({
            playerId: playerRatings.playerId,
            mu: playerRatings.mu,
            sigma: playerRatings.sigma,
          })
          .from(playerRatings)
          .where(and(
            eq(playerRatings.mode, leaderboardMode),
            inArray(playerRatings.playerId, slottedPlayerIds),
          ))

        ratingsByPlayerId = new Map(rows.map(row => [row.playerId, { mu: row.mu, sigma: row.sigma }]))
      }
    }

    const arranged = arrangeLobbySlots({
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
    let nextLobby = updatedLobby ?? { ...lobby, slots: arranged.slots, updatedAt: Date.now() }
    nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, Date.now(), nextLobby) ?? nextLobby
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: lobbyQueueEntries,
      slots: arranged.slots,
    })
    const slottedEntries = mapLobbySlotsToEntries(arranged.slots, lobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after ${strategyRaw} arrange in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, arranged.slots))
  })

  app.post('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    if (!isDebugLobbyFillEnabled(c.req.url, c.env.BOT_HOST, c.env.ENABLE_DEBUG_LOBBY_FILL)) {
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
    nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, now, nextLobby) ?? nextLobby
    const nextLobbyQueueEntries = buildLobbyQueueEntries(nextLobby, nextEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
    })
    const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after test fill in ${mode}:`)

    return c.json({
      ...(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots)),
      addedCount,
    })
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

    const lobbyById = typeof lobbyId === 'string' ? await getLobbyById(kv, lobbyId) : null
    const lobby = await resolveOpenLobbyFromBody(kv, mode, { lobbyId })
      ?? (lobbyById && lobbyById.status !== 'open' ? lobbyById : null)
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

    if (!canStartLobbyWithPlayerCount(mode, selectedEntries.length, slots.length, lobby.draftConfig.redDeath)) {
      const validCounts = startPlayerCountOptions(mode, slots.length, { redDeath: lobby.draftConfig.redDeath })
      const label = formatModeLabel(mode, mode, { redDeath: lobby.draftConfig.redDeath, targetSize: slots.length })
      if (validCounts.length > 0) {
        return c.json({ error: `${label} can start with ${formatCountList(validCounts)} slotted players.` }, 400)
      }
      return c.json({ error: `${label} requires exactly ${slots.length} slotted players.` }, 400)
    }

    try {
      const timerConfig = await resolveDraftTimerConfig(kv, lobby.draftConfig)
      const leaderPoolError = getLeaderPoolSizeError(mode, lobby.draftConfig.redDeath, lobby.draftConfig.leaderPoolSize, selectedEntries.length)
      if (leaderPoolError) return c.json({ error: leaderPoolError }, 400)

      await storeLobbyDraftRoster(kv, lobby.id, lobbyQueueEntries)

      const { matchId, seats } = await createDraftRoom(mode, selectedEntries, {
        hostId: lobby.hostId,
        leaderDataVersion: lobby.draftConfig.leaderDataVersion,
        simultaneousPick: lobby.draftConfig.simultaneousPick,
        redDeath: lobby.draftConfig.redDeath,
        randomDraft: lobby.draftConfig.randomDraft,
        duplicateFactions: lobby.draftConfig.duplicateFactions,
        partyHost: c.env.PARTY_HOST,
        botHost: c.env.BOT_HOST,
        webhookSecret: internalSecret,
        timerConfig,
        leaderPoolSize: lobby.draftConfig.leaderPoolSize,
        dealOptionsSize: lobby.draftConfig.dealOptionsSize,
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

      await storeMatchActivityState(kv, lobbyForMessage.channelId, lobbyForMessage.memberPlayerIds, {
        matchId,
        lobbyId: lobbyForMessage.id,
        mode: lobbyForMessage.mode,
        steamLobbyLink: lobbyForMessage.steamLobbyLink,
        activitySecret: internalSecret,
      })
      await handoffLobbySpectatorsToMatchActivity(kv, lobbyForMessage.channelId, lobbyForMessage.id, lobbyForMessage.memberPlayerIds, {
        matchId,
        lobbyId: lobbyForMessage.id,
        mode: lobbyForMessage.mode,
        steamLobbyLink: lobbyForMessage.steamLobbyLink,
        activitySecret: internalSecret,
      })
      await syncLobbyDerivedState(kv, lobbyForMessage)
      await clearUserLobbyMappings(kv, lobbyForMessage.memberPlayerIds)

      queueBackgroundTask(c, async () => {
        const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, lobbyForMessage)
        if (!currentLobby) return
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
          embeds: [lobbyDraftingEmbed(mode, seats, lobbyForMessage.draftConfig.leaderDataVersion, lobbyForMessage.draftConfig.redDeath)],
          components: lobbyComponents(mode, currentLobby.id),
        })
        await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
      }, `Failed to update drafting lobby embed for mode ${mode}:`)

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
    const lobbyQueueEntries = buildLobbyQueueEntries(lobby, queue.entries)
    const activePlayerIds = lobbyQueueEntries.map(entry => entry.playerId)
    if (activePlayerIds.length > 0) {
      await clearQueue(kv, mode, activePlayerIds, {
        currentState: queue,
      })
    }

    queueBackgroundTask(c, async () => {
        await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
          embeds: [{
            title: `LOBBY CANCELLED  -  ${formatModeLabel(mode, mode, { redDeath: lobby.draftConfig.redDeath })}`,
            description: 'Host cancelled this lobby before draft start.',
            color: 0x6B7280,
          }],
        components: [],
      })
    }, `Failed to update cancelled lobby embed for mode ${mode}:`)

    await clearLobbyMappingsIfMatchingLobby(kv, activePlayerIds, lobby.id, lobby.channelId)
    await clearLobbyById(kv, lobby.id, lobby)
    return c.json({ ok: true })
  })
}

async function buildStoredLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: Awaited<ReturnType<typeof getLobbyById>> extends infer T ? Exclude<T, null> : never,
) {
  const serverDefaults = await getServerDraftTimerDefaults(kv)
  return {
    id: lobby.id,
    revision: lobby.revision,
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    steamLobbyLink: lobby.steamLobbyLink,
    minRole: lobby.minRole,
    maxRole: lobby.maxRole,
    entries: lobby.slots.map(() => null),
    minPlayers: lobbyMinPlayerCount(mode, lobby.slots.length, lobby.draftConfig.redDeath),
    targetSize: lobby.slots.length,
    draftConfig: lobby.draftConfig,
    serverDefaults,
  }
}

function formatCountList(counts: readonly number[]): string {
  if (counts.length <= 1) return String(counts[0] ?? '')
  if (counts.length === 2) return `${counts[0]} or ${counts[1]}`
  return `${counts.slice(0, -1).join(', ')}, or ${counts[counts.length - 1]}`
}

function isSteamLobbyEditableStatus(status: 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'): boolean {
  return status === 'open' || status === 'drafting' || status === 'active'
}

function getLeaderPoolSizeError(
  mode: GameMode,
  redDeath: boolean,
  leaderPoolSize: number | null,
  playerCount: number,
): string | null {
  if (redDeath) return null
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

function parseLobbyLeaderDataVersion(value: unknown): 'live' | 'beta' | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return isLeaderDataVersion(normalized) ? normalized : undefined
}

function parseLobbySimultaneousPick(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyRedDeath(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyDealOptionsSize(value: unknown): number | null | undefined {
  if (value == null) return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return undefined
  if (numeric < 2 || numeric > 10) return undefined
  return numeric
}

function parseLobbyRandomDraft(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyDuplicateFactions(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseRedDeathFfaTargetSize(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return undefined
  return [4, 6, 8, 10].includes(numeric) ? numeric : undefined
}

function resizeLobbySlots(_mode: GameMode, slots: (string | null)[], targetSize: number): (string | null)[] {
  return Array.from({ length: targetSize }, (_, index) => slots[index] ?? null)
}

function getRemovedSlotIndexesForResize(_mode: GameMode, currentSize: number, targetSize: number): number[] {
  return Array.from({ length: Math.max(0, currentSize - targetSize) }, (_, index) => targetSize + index)
}

function getResizeShrinkErrorMessage(mode: GameMode, currentSize: number, targetSize: number): string {
  if (mode === '2v2' && currentSize === 8 && targetSize === 4) {
    return 'Clear the extra 2v2 seats before removing them.'
  }

  return 'Clear the extra seats before shrinking the lobby.'
}

function isDebugLobbyFillEnabled(
  requestUrl: string,
  botHost: string | undefined,
  forceEnabled: string | undefined,
): boolean {
  return isTruthyEnvFlag(forceEnabled) || isDev({ host: requestUrl, configuredHosts: [botHost] })
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
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
