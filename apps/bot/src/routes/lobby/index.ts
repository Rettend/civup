import type { GameMode, QueueEntry } from '@civup/game'
import type { Context, Hono } from 'hono'
import type { Env } from '../../env.ts'
import { createDb, playerRatings } from '@civup/db'
import { defaultPlayerCount, formatModeLabel, getMinimumLeaderPoolSize, isLeaderDataVersion, isUnrankedMode, MAX_LEADER_POOL_SIZE, normalizeCompetitiveTierBounds, parseGameMode, toBalanceLeaderboardMode } from '@civup/game'
import { createSessionAccessToken, isDev } from '@civup/utils'
import { and, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyDraftingEmbed } from '../../embeds/match.ts'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import {
  arrangeLobbySlots,
  buildOpenLobbyRenderPayload,
  clearLobbyById,
  compactSlottedPremadesForMode,
  getCurrentLobbyForQueuedMessageUpdate,
  getLobbyById,
  leaveOpenLobbyForLobbyJoin,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  sameLobbySlots,
  setLobbyArranged,
  setLobbyDraftConfig,
  setLobbyLastActivityAt,
  setLobbyMaxRole,
  setLobbyMinRole,
  setLobbyModeAndLayout,
  setLobbyRoster,
  setLobbySlots,
  setLobbyStatus,
  setLobbySteamLobbyLink,
  upsertLobbyMessage,
} from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { normalizeDraftConfigForMode } from '../../services/lobby/normalize.ts'
import { findPersistedBlockingDraftMatchIdsForPlayers } from '../../services/match/live.ts'
import { storeMatchMessageMapping } from '../../services/match/message.ts'
import { buildRankedRoleVisuals, getRankedRoleConfig, getRankedRoleGateError } from '../../services/ranked/roles.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import { getCurrentSessionLobbyProjectionsForPlayer } from '../../services/session/index.ts'
import { getSessionRecord, startSessionDraft } from '../../session-runtime/session-do-client.ts'
import { buildLobbyStateFromSessionRecord, buildSessionRosterQueueEntries } from '../../session-runtime/session-record.ts'
import { parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../services/steam-link.ts'
import { rejectMismatchedActivityUser, requireAuthenticatedActivity } from '../auth.ts'
import {
  buildLobbyQueueEntries,
  buildOpenLobbySnapshot,
  buildOpenLobbySnapshotFromParts,
  emptyRankedRoleConfig,
  getLobbyBalanceSnapshot,
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

function lobbySessionMutationOptions(c: Context<Env>, queueEntries?: readonly QueueEntry[]) {
  return {
    db: isWritableD1Binding(c.env.DB) ? createDb(c.env.DB) : null,
    sessionNamespace: c.env.SessionDO,
    queueEntries,
  }
}

async function getLobbyRosterEntriesForRender(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: Awaited<ReturnType<typeof getLobbyById>> extends infer T ? Exclude<T, null> : never,
  fallbackEntries: QueueEntry[] = [],
): Promise<QueueEntry[]> {
  const record = await getSessionRecord(namespace, lobby.id).catch(() => null)
  return record ? buildSessionRosterQueueEntries(record) : buildLobbyQueueEntries(lobby, fallbackEntries)
}

function isWritableD1Binding(db: D1Database | undefined): db is D1Database {
  if (!db || typeof db.prepare !== 'function') return false
  try {
    const statement = db.prepare('select 1')
    return typeof statement.bind().run === 'function'
  }
  catch {
    return false
  }
}

function parseSessionDraftStartError(error: unknown): { status: 400 | 403 | 409, message: string } | null {
  if (!(error instanceof Error)) return null
  const match = /^Failed to start session draft for [^:]+: (400|403|409) (.*)$/.exec(error.message)
  if (!match) return null
  return {
    status: Number(match[1]) as 400 | 403 | 409,
    message: match[2] || 'Session could not start.',
  }
}

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
    const kv = getKvStore(c.env)
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!lobbyId) return c.json({ error: 'lobbyId is required' }, 400)

    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
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
    const kv = getKvStore(c.env)
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

    const { userId, banTimerSeconds, pickTimerSeconds, leaderPoolSize: leaderPoolSizeRaw, leaderDataVersion: leaderDataVersionRaw, mapVoteEnabled: mapVoteEnabledRaw, blindBans: blindBansRaw, simultaneousPick: simultaneousPickRaw, redDeath: redDeathRaw, dealOptionsSize: dealOptionsSizeRaw, randomDraft: randomDraftRaw, duplicateFactions: duplicateFactionsRaw, minRole: minRoleRaw, maxRole: maxRoleRaw, steamLobbyLink: steamLobbyLinkRaw, targetSize: targetSizeRaw, lobbyId } = body as {
      userId?: string
      banTimerSeconds?: unknown
      pickTimerSeconds?: unknown
      leaderPoolSize?: unknown
      leaderDataVersion?: unknown
      mapVoteEnabled?: unknown
      blindBans?: unknown
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
    const hasMapVoteEnabled = Object.prototype.hasOwnProperty.call(body, 'mapVoteEnabled')
    const hasBlindBans = Object.prototype.hasOwnProperty.call(body, 'blindBans')
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
    const parsedMapVoteEnabled = hasMapVoteEnabled
      ? parseLobbyMapVoteEnabled(mapVoteEnabledRaw)
      : undefined
    const parsedBlindBans = hasBlindBans
      ? parseLobbyBlindBans(blindBansRaw)
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
    if (hasBlindBans && parsedBlindBans === undefined) {
      return c.json({ error: 'blindBans must be true or false' }, 400)
    }
    if (hasMapVoteEnabled && parsedMapVoteEnabled === undefined) {
      return c.json({ error: 'mapVoteEnabled must be true or false' }, 400)
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
    const resolvedLobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
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
    const normalizedMapVoteEnabled = hasMapVoteEnabled
      ? parsedMapVoteEnabled ?? false
      : lobby.draftConfig.mapVoteEnabled
    const normalizedBlindBans = hasBlindBans
      ? parsedBlindBans ?? true
      : lobby.draftConfig.blindBans
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
      if (hasBanTimerSeconds || hasPickTimerSeconds || hasLeaderPoolSize || hasLeaderDataVersion || hasMapVoteEnabled || hasBlindBans || hasSimultaneousPick || hasRedDeath || hasDealOptionsSize || hasRandomDraft || hasDuplicateFactions || hasTargetSize || hasMinRole || hasMaxRole) {
        return c.json({ error: 'Only the Steam lobby link can be updated after the draft starts.' }, 409)
      }

      const updated = await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby, lobbySessionMutationOptions(c)) ?? lobby
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

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, resolvedLobby.draftConfig.redDeath)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
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

    const nextDraftConfig = normalizeDraftConfigForMode(mode, {
      banTimerSeconds: resolvedBanTimerSeconds,
      pickTimerSeconds: resolvedPickTimerSeconds,
      leaderPoolSize: normalizedLeaderPoolSize,
      leaderDataVersion: normalizedLeaderDataVersion,
      mapVoteEnabled: normalizedMapVoteEnabled,
      blindBans: normalizedBlindBans,
      simultaneousPick: normalizedSimultaneousPick,
      redDeath: normalizedRedDeath,
      dealOptionsSize: normalizedDealOptionsSize,
      randomDraft: normalizedRandomDraft,
      duplicateFactions: normalizedDuplicateFactions,
    }, requestedTargetSize)

    if (!sameLobbySlots(slots, lobby.slots)) {
      const resizedLobby = await setLobbySlots(kv, lobby.id, slots, lobby, lobbySessionMutationOptions(c))
      lobby = resizedLobby ?? { ...lobby, slots, updatedAt: Date.now() }
    }

    const draftUpdated = await setLobbyDraftConfig(kv, lobby.id, nextDraftConfig, lobby, lobbySessionMutationOptions(c))

    lobby = draftUpdated ?? lobby
    const minRoleUpdated = await setLobbyMinRole(kv, lobby.id, normalizedMinRole, lobby, lobbySessionMutationOptions(c))
    lobby = minRoleUpdated ?? lobby
    const maxRoleUpdated = await setLobbyMaxRole(kv, lobby.id, normalizedMaxRole, lobby, lobbySessionMutationOptions(c))
    lobby = maxRoleUpdated ?? lobby
    let updated = hasSteamLobbyLink
      ? (await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby, lobbySessionMutationOptions(c)) ?? lobby)
      : lobby

    if (!updated) {
      return c.json({ error: 'Lobby not found' }, 404)
    }

    let nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, updated, lobbyQueueEntries)
    if (updated.revision !== resolvedLobby.revision) {
      updated = await setLobbyLastActivityAt(kv, updated.id, Date.now(), updated, lobbySessionMutationOptions(c)) ?? updated
      nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, updated, nextLobbyQueueEntries)
    }

    const normalizedSlots = normalizeLobbySlots(mode, updated.slots, nextLobbyQueueEntries)
    const slottedEntries = mapLobbySlotsToEntries(normalizedSlots, nextLobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, updated, {
      queueEntries: nextLobbyQueueEntries,
      slots: normalizedSlots,
      balanceSnapshot,
    })

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, updated)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, updated, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after config change in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, updated, nextLobbyQueueEntries, normalizedSlots))
  })

  app.post('/api/lobby/:mode/mode', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    const resolvedLobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
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

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
    const sourceLobby = lobby
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, sourceLobby)
    if (!sourceLobby.memberPlayerIds.includes(sourceLobby.hostId)) {
      return c.json({ error: 'Host is not in this lobby anymore.' }, 400)
    }

    const normalizedSlots = normalizeLobbySlots(mode, sourceLobby.slots, lobbyQueueEntries)
    const orderedPlayers = normalizedSlots.filter((playerId): playerId is string => playerId != null)
    const orderedPlayerSet = new Set(orderedPlayers)

    if (!orderedPlayerSet.has(sourceLobby.hostId)) {
      orderedPlayers.push(sourceLobby.hostId)
      orderedPlayerSet.add(sourceLobby.hostId)
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
    if (nextMode === 'ffa' && sourceLobby.draftConfig.redDeath) {
      nextSlots = resizeLobbySlots(nextMode, nextSlots, 10)
    }
    const changedAt = Date.now()

    const movedLobbyQueueEntries = buildLobbyQueueEntries({ ...sourceLobby, mode: nextMode }, lobbyQueueEntries)
    const normalizedNextSlots = normalizeLobbySlots(nextMode, nextSlots, movedLobbyQueueEntries)
    const finalizedLobby = await setLobbyModeAndLayout(kv, sourceLobby.id, {
      mode: nextMode,
      draftConfig: normalizeDraftConfigForMode(nextMode, sourceLobby.draftConfig, normalizedNextSlots.length),
      minRole: isUnrankedMode(nextMode) ? null : sourceLobby.minRole,
      maxRole: isUnrankedMode(nextMode) ? null : sourceLobby.maxRole,
      slots: normalizedNextSlots,
      lastActivityAt: changedAt,
      now: changedAt,
    }, sourceLobby, lobbySessionMutationOptions(c)) ?? sourceLobby
    const finalizedLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, finalizedLobby, movedLobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, finalizedLobby, {
      queueEntries: finalizedLobbyQueueEntries,
      slots: finalizedLobby.slots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(finalizedLobby.slots, finalizedLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, finalizedLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, finalizedLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after mode change ${mode} -> ${nextMode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(
      kv,
      nextMode,
      finalizedLobby,
      finalizedLobbyQueueEntries,
      finalizedLobby.slots,
    ))
  })

  app.post('/api/lobby/:mode/place', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    const resolvedLobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    const lobby = resolvedLobby

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

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
    let transferNotice: string | null = null

    const alreadyInTargetLobby = lobby.memberPlayerIds.includes(movingPlayerId) || lobby.slots.includes(movingPlayerId)
    let blockingLobbyForPlayer: Awaited<ReturnType<typeof getCurrentSessionLobbyProjectionsForPlayer>>[number] | null = null
    if (!alreadyInTargetLobby) {
      const db = createDb(c.env.DB)
      const currentLobbiesForPlayer = await getCurrentSessionLobbyProjectionsForPlayer(db, movingPlayerId, {
        excludeLobbyIds: [lobby.id],
      })
      const blockingDraftMatchIds = await findPersistedBlockingDraftMatchIdsForPlayers(c.env.DB, [movingPlayerId])
      const hasLiveMatch = blockingDraftMatchIds == null
        ? currentLobbiesForPlayer.some(candidate => candidate.status !== 'open')
        : blockingDraftMatchIds.has(movingPlayerId)
      if (hasLiveMatch) {
        return c.json({ error: 'That player is already in a live match.' }, 400)
      }
      blockingLobbyForPlayer = currentLobbiesForPlayer.find(candidate => candidate.status === 'open') ?? null
      if (blockingLobbyForPlayer) {
        if (movingPlayerId !== auth.identity.userId) {
          return c.json({ error: 'That player is already in another lobby.' }, 400)
        }
        transferNotice = `Moved you from your previous ${formatModeLabel(blockingLobbyForPlayer.mode, blockingLobbyForPlayer.mode, { redDeath: blockingLobbyForPlayer.draftConfig.redDeath })} lobby.`
      }
    }

    let lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    let slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

    const actionAt = Date.now()
    let resolvedDisplayName: string | null = null
    const movingEntry = lobbyQueueEntries.find(entry => entry.playerId === movingPlayerId)
    if (!movingEntry) {
      if (movingPlayerId !== auth.identity.userId) {
        return c.json({ error: 'Target player is not available as a spectator.' }, 400)
      }

      resolvedDisplayName = auth.identity.displayName?.trim() ?? ''
      if (resolvedDisplayName.length === 0) {
        return c.json({ error: 'displayName is required when joining as spectator.' }, 400)
      }
    }
    const sourceSlot = slots.findIndex(playerId => playerId === movingPlayerId)
    const targetPlayerId = slots[targetSlot]
    if (targetPlayerId === movingPlayerId) {
      return c.json({
        lobby: await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots),
        transferNotice,
      })
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

    if (blockingLobbyForPlayer?.status === 'open') {
      const sourceRosterEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, blockingLobbyForPlayer)
      const transferResult = await leaveOpenLobbyForLobbyJoin(
        kv,
        c.env.DISCORD_TOKEN,
        blockingLobbyForPlayer,
        [movingPlayerId],
        mode,
        lobbySessionMutationOptions(c, sourceRosterEntries),
      )
      if (!transferResult.ok) {
        return c.json({ error: transferResult.error }, 400)
      }
    }

    const addedRosterEntry = !movingEntry
      ? {
        playerId: movingPlayerId,
        displayName: resolvedDisplayName ?? '',
        avatarUrl: auth.identity.avatarUrl,
        joinedAt: actionAt,
      }
      : null

    const nextMemberIds = lobby.memberPlayerIds.includes(movingPlayerId)
      ? lobby.memberPlayerIds
      : [...new Set([...lobby.memberPlayerIds, movingPlayerId])]
    const rosterPatchEntries = addedRosterEntry ? [addedRosterEntry] : []
    lobbyQueueEntries = buildLobbyQueueEntries({ ...lobby, memberPlayerIds: nextMemberIds }, [...lobbyQueueEntries, ...rosterPatchEntries])
    slots = normalizeLobbySlots(mode, slots, lobbyQueueEntries)
    const nextLobby = !sameLobbySlots(slots, lobby.slots) || nextMemberIds.length !== lobby.memberPlayerIds.length || lobby.lastActivityAt !== actionAt
      ? await setLobbyRoster(kv, lobby.id, {
        memberPlayerIds: nextMemberIds,
        slots,
        lastActivityAt: actionAt,
        now: actionAt,
      }, lobby, lobbySessionMutationOptions(c, rosterPatchEntries)) ?? lobby
      : lobby

    lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, lobbyQueueEntries)
    slots = normalizeLobbySlots(mode, nextLobby.slots, lobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: lobbyQueueEntries,
      slots,
      balanceSnapshot,
    })

    const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after slot placement in ${mode}:`)

    return c.json({
      lobby: snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, slots),
      transferNotice,
    })
  })

  app.post('/api/lobby/:mode/remove', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (slot >= lobby.slots.length) {
      return c.json({ error: 'Invalid slot index' }, 400)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
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

    slots[slot] = null

    const nextMemberIds = lobby.memberPlayerIds.filter(playerId => playerId !== targetPlayerId)
    const activityAt = Date.now()
    const nextLobby = await setLobbyRoster(kv, lobby.id, {
      memberPlayerIds: nextMemberIds,
      slots,
      lastActivityAt: activityAt,
      now: activityAt,
    }, lobby, lobbySessionMutationOptions(c)) ?? lobby
    const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, lobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
      balanceSnapshot,
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
    }, `Failed to update lobby embed after slot removal in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots))
  })

  app.post('/api/lobby/:mode/arrange', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    if (strategyRaw !== 'randomize' && strategyRaw !== 'balance' && strategyRaw !== 'shuffle-teams') {
      return c.json({ error: 'strategy must be one of randomize, balance, or shuffle-teams' }, 400)
    }

    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can arrange the lobby' }, 403)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
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

    const nextLobby = await setLobbyArranged(kv, lobby.id, {
      slots: arranged.slots,
      strategy: strategyRaw,
    }, lobby, lobbySessionMutationOptions(c)) ?? lobby
    const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, lobbyQueueEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots: arranged.slots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(arranged.slots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, nextLobby)
      if (!currentLobby) return
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }, `Failed to update lobby embed after ${strategyRaw} arrange in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, arranged.slots))
  })

  app.post('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    if (!isDebugLobbyFillEnabled(c.req.url, c.env.BOT_HOST, c.env.ENABLE_DEBUG_LOBBY_FILL)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can fill test players' }, 403)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const nextEntries = [...lobbyQueueEntries]
    const addedEntries: QueueEntry[] = []
    const nextMemberIds = new Set(lobby.memberPlayerIds)
    const existingIds = new Set(nextEntries.map(entry => entry.playerId))

    let addedCount = 0
    const now = Date.now()

    for (let slot = 0; slot < slots.length; slot++) {
      if (slots[slot] != null) continue

      const playerId = buildDebugFillPlayerId(DEBUG_TEST_PLAYER_ID_PREFIX, mode, slot, existingIds)
      slots[slot] = playerId
      const entry = {
        playerId,
        displayName: `Test Player ${slot + 1}`,
        avatarUrl: null,
        joinedAt: now + slot,
      }
      nextEntries.push(entry)
      addedEntries.push(entry)
      nextMemberIds.add(playerId)
      existingIds.add(playerId)
      addedCount += 1
    }

    const nextLobby = await setLobbyRoster(kv, lobby.id, {
      memberPlayerIds: [...nextMemberIds],
      slots,
      lastActivityAt: now,
      now,
    }, lobby, lobbySessionMutationOptions(c, addedEntries)) ?? lobby
    const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, nextEntries)
    const snapshot = await syncLobbyDerivedState(kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
      balanceSnapshot,
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
    const kv = getKvStore(c.env)
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
    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
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
        sessionAccessToken: await createSessionAccessToken(internalSecret, {
          userId: auth.identity.userId,
          sessionId: lobby.matchId,
          channelId: lobby.channelId,
        }),
      })
    }

    if (lobby.status !== 'open') {
      return c.json({ error: `Lobby is not open (status: ${lobby.status}).` }, 409)
    }

    try {
      const started = await startSessionDraft(c.env.SessionDO, lobby.id, {
        expectedVersion: lobby.revision,
        hostId: auth.identity.userId,
      })
      if (started.record.mode !== mode) return c.json({ error: 'Session mode does not match lobby route.' }, 409)

      const { matchId, seats } = started
      const lobbyForMessage = buildLobbyStateFromSessionRecord(started.record, lobby)
      const db = createDb(c.env.DB)

      await syncLobbyDerivedState(kv, lobbyForMessage)

      if (!started.idempotent && seats.length > 0) {
        queueBackgroundTask(c, async () => {
          const currentLobby = await getCurrentLobbyForQueuedMessageUpdate(kv, lobbyForMessage)
          if (!currentLobby) return
          const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
            embeds: [lobbyDraftingEmbed(mode, seats, lobbyForMessage.draftConfig.leaderDataVersion, lobbyForMessage.draftConfig.redDeath)],
            components: lobbyComponents(mode, currentLobby.id),
          })
          await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
        }, `Failed to update drafting lobby embed for mode ${mode}:`)
      }

      return c.json({
        ok: true as const,
        matchId,
        sessionAccessToken: await createSessionAccessToken(internalSecret, {
          userId: auth.identity.userId,
          sessionId: matchId,
          channelId: lobbyForMessage.channelId,
        }),
      })
    }
    catch (error) {
      console.error(`Failed to start lobby draft for mode ${mode}:`, error)
      const commandError = parseSessionDraftStartError(error)
      if (commandError) return c.json({ error: commandError.message }, commandError.status)
      return c.json({ error: 'Failed to start draft. Please try again.' }, 500)
    }
  })

  app.post('/api/lobby/:mode/cancel', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const kv = getKvStore(c.env)
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

    const lobby = await resolveOpenLobbyFromBody(createDb(c.env.DB), mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No lobby for this mode' }, 404)
    }

    if (lobby.status !== 'open') {
      return c.json({ error: 'Lobby can only be cancelled before draft start' }, 400)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can cancel this lobby' }, 403)
    }

    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)

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

    const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby, lobbySessionMutationOptions(c, lobbyQueueEntries)) ?? {
      ...lobby,
      status: 'cancelled' as const,
      updatedAt: Date.now(),
      revision: lobby.revision + 1,
    }
    await clearLobbyById(kv, lobby.id, cancelledLobby)
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

function parseLobbyBlindBans(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyMapVoteEnabled(value: unknown): boolean | undefined {
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
