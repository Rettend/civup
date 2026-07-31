import type { GameMode, QueueEntry } from '@civup/game'
import type { Context, Hono } from 'hono'
import type { Env } from '../../env.ts'
import type { DeferredOpenLobbyTransferSource, LobbyDraftConfig, LobbyState } from '../../services/lobby/index.ts'
import { createDb, scopedPlayerRatings as playerRatings } from '@civup/db'
import { CIV_BLITZ_DEFAULT_OPTION_COUNT, CIV_BLITZ_MAX_OPTION_COUNT, CIV_BLITZ_MIN_OPTION_COUNT, defaultPlayerCount, formatModeLabel, getCivBlitzOptionCountMaximum, getMaxLeaderPoolSize, getMinimumLeaderPoolSize, isLeaderDataVersion, isUnrankedMode, MAX_LEADER_POOL_SIZE, normalizeCompetitiveTierBounds, parseGameMode, toBalanceLeaderboardMode } from '@civup/game'
import { createSessionAccessToken } from '@civup/utils'
import { and, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyDraftingEmbed } from '../../embeds/match.ts'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import {
  arrangeLobbySlots,
  buildOpenLobbyRenderPayload,
  compactSlottedPremadesForMode,
  finalizeDeferredOpenLobbyTransferSource,
  getLobbyById,
  leaveOpenLobbyForLobbyJoin,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  restoreDeferredOpenLobbyTransferSourceAdmission,
  rollbackDeferredOpenLobbyTransferTarget,
  sameLobbySlots,
  setLobbyArranged,
  setLobbyDraftConfig,
  setLobbyHost,
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
import { buildLobbyRankSnapshot } from '../../services/lobby/rank.ts'
import { findPersistedBlockingDraftMatchIdsForPlayers } from '../../services/match/live.ts'
import { storeMatchMessageMapping } from '../../services/match/message.ts'
import { buildRankedRoleVisuals, getRankedRoleCalculationConfig } from '../../services/ranked/roles.ts'
import { getCalculatedRankGateError } from '../../services/ranked/admission.ts'
import { createStatsContext } from '../../services/stats/context.ts'
import { formatSessionAdmissionError, getCurrentSessionLobbyProjectionsForPlayer, getSessionLobbyProjectionByMatch, isSessionAdmissionError } from '../../services/session/index.ts'
import { parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../services/steam-link.ts'
import { buildTournamentReservedSlotLabels, getTournamentMatchBySessionId, markTournamentMatchDrafting, updateTournamentMatchRoster, validateTournamentLobbyJoin } from '../../services/tournament/index.ts'
import { getSessionRecord, repeatSessionDraft, startSessionDraft } from '../../session-runtime/session-do-client.ts'
import { buildLobbyStateFromSessionRecord, buildSessionRosterQueueEntries } from '../../session-runtime/session-record.ts'
import { rejectMismatchedActivityUser, requireAuthenticatedActivity } from '../auth.ts'
import {
  buildLobbyQueueEntries,
  buildOpenLobbySnapshot,
  buildOpenLobbySnapshotFromParts,
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
    legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
  }
}

function syncRequestLobbyDerivedState(
  c: Context<Env>,
  kv: KVNamespace,
  lobby: LobbyState,
  options: Parameters<typeof syncLobbyDerivedState>[2] = {},
) {
  return syncLobbyDerivedState(kv, lobby, { ...options, legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
}

async function buildOpenLobbyRenderPayloadForMessage(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  lobby: LobbyState,
  entries: (QueueEntry | null)[],
) {
  return buildOpenLobbyRenderPayload(kv, lobby, entries, {
    reservedSlotLabels: await buildTournamentReservedSlotLabels(db, lobby),
  })
}

async function getLobbyRosterEntriesForRender(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: Awaited<ReturnType<typeof getLobbyById>> extends infer T ? Exclude<T, null> : never,
  fallbackEntries: QueueEntry[] = [],
): Promise<QueueEntry[]> {
  const record = await getSessionRecord(namespace, lobby.id).catch(() => null)
  return record ? buildSessionRosterQueueEntries(record) : buildLobbyQueueEntries(lobby, fallbackEntries)
}

async function restoreOpenLobbyTransferSource(
  kv: KVNamespace,
  c: Context<Env>,
  sourceLobby: Awaited<ReturnType<typeof getLobbyById>> extends infer T ? Exclude<T, null> : never,
  queueEntries: QueueEntry[],
  at: number,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const currentSource = await getLobbyById(kv, sourceLobby.id)
  if (!currentSource || currentSource.status !== 'open') {
    return { ok: false, error: 'Could not restore your previous lobby after the transfer failed. Please refresh and try again.' }
  }
  try {
    const restored = await setLobbyRoster(kv, sourceLobby.id, {
      memberPlayerIds: sourceLobby.memberPlayerIds,
      slots: sourceLobby.slots,
      lastActivityAt: Math.max(sourceLobby.lastActivityAt, at),
      now: Date.now(),
    }, currentSource, lobbySessionMutationOptions(c, queueEntries)) ?? currentSource
    await syncRequestLobbyDerivedState(c, kv, restored, { queueEntries })
    return { ok: true }
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Could not restore your previous lobby after the transfer failed: ${detail}` }
  }
}

function isSessionVersionStaleError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Session version is stale')
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

function parseSessionDraftCommandError(error: unknown): { status: 400 | 403 | 409, message: string } | null {
  if (!(error instanceof Error)) return null
  const match = /^Failed to (?:start|repeat) session draft for [^:]+: (400|403|409) (.*)$/.exec(error.message)
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
    if (!isDebugLobbyFillEnabled(c.env.ENABLE_DEBUG_LOBBY_FILL)) return c.json({ error: 'Not found' }, 404)
    return new Response(null, { status: 204 })
  })

  app.get('/api/lobby-ranks/:mode/:lobbyId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mode = parseGameMode(c.req.param('mode'))
    const lobbyId = c.req.param('lobbyId')
    const kv = getKvStore(c.env)
    if (!mode) return c.json({ error: 'Invalid game mode' }, 400)
    if (!lobbyId) return c.json({ error: 'lobbyId is required' }, 400)

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby || lobby.mode !== mode || lobby.status !== 'open') {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (!lobby.guildId) return c.json({ error: 'Lobby is missing owning-server data' }, 409)
    const style = await getRankedRoleCalculationConfig(kv, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID ?? '')
    if (!style.valid) return c.json({ error: 'This server has an incomplete rank setup.' }, 409)
    const visuals = buildRankedRoleVisuals(style.config)

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

    const { userId, banTimerSeconds, pickTimerSeconds, leaderPoolSize: leaderPoolSizeRaw, leaderDataVersion: leaderDataVersionRaw, mapVoteEnabled: mapVoteEnabledRaw, blindBans: blindBansRaw, blindPicks: blindPicksRaw, simultaneousPick: simultaneousPickRaw, permanentAlly: permanentAllyRaw, redDeath: redDeathRaw, dealOptionsSize: dealOptionsSizeRaw, civBlitz: civBlitzRaw, civBlitzOptionCount: civBlitzOptionCountRaw, civBlitzExcludeBbgExpanded: civBlitzExcludeBbgExpandedRaw, randomDraft: randomDraftRaw, hiddenDraft: hiddenDraftRaw, duplicateFactions: duplicateFactionsRaw, closed: closedRaw, minRole: minRoleRaw, maxRole: maxRoleRaw, steamLobbyLink: steamLobbyLinkRaw, targetSize: targetSizeRaw, lobbyId } = body as {
      userId?: string
      banTimerSeconds?: unknown
      pickTimerSeconds?: unknown
      leaderPoolSize?: unknown
      leaderDataVersion?: unknown
      mapVoteEnabled?: unknown
      blindBans?: unknown
      blindPicks?: unknown
      simultaneousPick?: unknown
      permanentAlly?: unknown
      redDeath?: unknown
      dealOptionsSize?: unknown
      civBlitz?: unknown
      civBlitzOptionCount?: unknown
      civBlitzExcludeBbgExpanded?: unknown
      randomDraft?: unknown
      hiddenDraft?: unknown
      duplicateFactions?: unknown
      closed?: unknown
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
    const hasBlindPicks = Object.prototype.hasOwnProperty.call(body, 'blindPicks')
    const hasSimultaneousPick = Object.prototype.hasOwnProperty.call(body, 'simultaneousPick')
    const hasPermanentAlly = Object.prototype.hasOwnProperty.call(body, 'permanentAlly')
    const hasRedDeath = Object.prototype.hasOwnProperty.call(body, 'redDeath')
    const hasDealOptionsSize = Object.prototype.hasOwnProperty.call(body, 'dealOptionsSize')
    const hasCivBlitz = Object.prototype.hasOwnProperty.call(body, 'civBlitz')
    const hasCivBlitzOptionCount = Object.prototype.hasOwnProperty.call(body, 'civBlitzOptionCount')
    const hasCivBlitzExcludeBbgExpanded = Object.prototype.hasOwnProperty.call(body, 'civBlitzExcludeBbgExpanded')
    const hasRandomDraft = Object.prototype.hasOwnProperty.call(body, 'randomDraft')
    const hasHiddenDraft = Object.prototype.hasOwnProperty.call(body, 'hiddenDraft')
    const hasDuplicateFactions = Object.prototype.hasOwnProperty.call(body, 'duplicateFactions')
    const hasClosed = Object.prototype.hasOwnProperty.call(body, 'closed')
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
    const parsedBlindPicks = hasBlindPicks
      ? parseLobbyBlindPicks(blindPicksRaw)
      : undefined
    const parsedSimultaneousPick = hasSimultaneousPick
      ? parseLobbySimultaneousPick(simultaneousPickRaw)
      : undefined
    const parsedPermanentAlly = hasPermanentAlly
      ? parseLobbyPermanentAlly(permanentAllyRaw)
      : undefined
    const parsedRedDeath = hasRedDeath
      ? parseLobbyRedDeath(redDeathRaw)
      : undefined
    const parsedDealOptionsSize = hasDealOptionsSize
      ? parseLobbyDealOptionsSize(dealOptionsSizeRaw)
      : undefined
    const parsedCivBlitz = hasCivBlitz
      ? parseLobbyCivBlitz(civBlitzRaw)
      : undefined
    const parsedCivBlitzOptionCount = hasCivBlitzOptionCount
      ? parseLobbyCivBlitzOptionCount(civBlitzOptionCountRaw)
      : undefined
    const parsedCivBlitzExcludeBbgExpanded = hasCivBlitzExcludeBbgExpanded
      ? parseLobbyCivBlitzExcludeBbgExpanded(civBlitzExcludeBbgExpandedRaw)
      : undefined
    const parsedRandomDraft = hasRandomDraft
      ? parseLobbyRandomDraft(randomDraftRaw)
      : undefined
    const parsedHiddenDraft = hasHiddenDraft
      ? parseLobbyHiddenDraft(hiddenDraftRaw)
      : undefined
    const parsedDuplicateFactions = hasDuplicateFactions
      ? parseLobbyDuplicateFactions(duplicateFactionsRaw)
      : undefined
    const parsedClosed = hasClosed
      ? parseLobbyClosed(closedRaw)
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
    if (hasBlindPicks && parsedBlindPicks === undefined) {
      return c.json({ error: 'blindPicks must be true or false' }, 400)
    }
    if (hasMapVoteEnabled && parsedMapVoteEnabled === undefined) {
      return c.json({ error: 'mapVoteEnabled must be true or false' }, 400)
    }
    if (hasSimultaneousPick && parsedSimultaneousPick === undefined) {
      return c.json({ error: 'simultaneousPick must be true or false' }, 400)
    }
    if (hasPermanentAlly && parsedPermanentAlly === undefined) {
      return c.json({ error: 'permanentAlly must be true or false' }, 400)
    }
    if (hasRedDeath && parsedRedDeath === undefined) {
      return c.json({ error: 'redDeath must be true or false' }, 400)
    }
    if (hasDealOptionsSize && parsedDealOptionsSize === undefined) {
      return c.json({ error: 'dealOptionsSize must be an integer between 2 and 10, or null' }, 400)
    }
    if (hasCivBlitz && parsedCivBlitz === undefined) {
      return c.json({ error: 'civBlitz must be true or false' }, 400)
    }
    if (hasCivBlitzOptionCount && parsedCivBlitzOptionCount === undefined) {
      return c.json({ error: `civBlitzOptionCount must be an integer between ${CIV_BLITZ_MIN_OPTION_COUNT} and ${CIV_BLITZ_MAX_OPTION_COUNT}, or null` }, 400)
    }
    if (hasCivBlitzExcludeBbgExpanded && parsedCivBlitzExcludeBbgExpanded === undefined) {
      return c.json({ error: 'civBlitzExcludeBbgExpanded must be true or false' }, 400)
    }
    if (hasRandomDraft && parsedRandomDraft === undefined) {
      return c.json({ error: 'randomDraft must be true or false' }, 400)
    }
    if (hasHiddenDraft && parsedHiddenDraft === undefined) {
      return c.json({ error: 'hiddenDraft must be true or false' }, 400)
    }
    if (hasDuplicateFactions && parsedDuplicateFactions === undefined) {
      return c.json({ error: 'duplicateFactions must be true or false' }, 400)
    }
    if (hasClosed && parsedClosed === undefined) {
      return c.json({ error: 'closed must be true or false' }, 400)
    }
    const hasSteamLobbyLink = Object.prototype.hasOwnProperty.call(body, 'steamLobbyLink')
    const parsedSteamLobbyLink = hasSteamLobbyLink
      ? parseSteamLobbyLink(steamLobbyLinkRaw)
      : undefined
    if (hasSteamLobbyLink && parsedSteamLobbyLink === undefined) {
      return c.json({ error: STEAM_LOBBY_LINK_ERROR }, 400)
    }

    const db = createDb(c.env.DB)
    const lobbyById = typeof lobbyId === 'string' && lobbyId.length > 0 ? await getSessionLobbyProjectionByMatch(db, lobbyId) ?? await getLobbyById(kv, lobbyId) : null
    const resolvedLobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
      ?? (lobbyById && lobbyById.status !== 'open' ? lobbyById : null)
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    if (resolvedLobby.mode !== mode) {
      return c.json({ error: 'No lobby for this mode' }, 404)
    }
    let lobby = resolvedLobby
    const tournamentMatch = await getTournamentMatchBySessionId(db, lobby.id)

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
    const requestedLeaderPoolSize: number | null = hasLeaderPoolSize
      ? parsedLeaderPoolSize ?? null
      : lobby.draftConfig.leaderPoolSize
    const normalizedLeaderDataVersion = hasLeaderDataVersion
      ? parsedLeaderDataVersion ?? 'live'
      : lobby.draftConfig.leaderDataVersion
    const leaderDataVersionChanged = normalizedLeaderDataVersion !== lobby.draftConfig.leaderDataVersion
    const normalizedLeaderPoolSize = requestedLeaderPoolSize == null || !leaderDataVersionChanged
      ? requestedLeaderPoolSize
      : Math.min(requestedLeaderPoolSize, getMaxLeaderPoolSize(normalizedLeaderDataVersion))
    const normalizedMapVoteEnabled = hasMapVoteEnabled
      ? parsedMapVoteEnabled ?? false
      : lobby.draftConfig.mapVoteEnabled
    const normalizedBlindBans = hasBlindBans
      ? parsedBlindBans ?? true
      : lobby.draftConfig.blindBans
    const normalizedBlindPicks = hasBlindPicks
      ? parsedBlindPicks ?? false
      : lobby.draftConfig.blindPicks
    const normalizedSimultaneousPick = hasSimultaneousPick
      ? parsedSimultaneousPick ?? false
      : lobby.draftConfig.simultaneousPick
    const normalizedPermanentAlly = hasPermanentAlly
      ? parsedPermanentAlly ?? true
      : lobby.draftConfig.permanentAlly
    let normalizedRedDeath = hasRedDeath
      ? parsedRedDeath ?? false
      : lobby.draftConfig.redDeath
    const normalizedDealOptionsSize = hasDealOptionsSize
      ? parsedDealOptionsSize ?? null
      : lobby.draftConfig.dealOptionsSize
    let normalizedCivBlitz = hasCivBlitz
      ? parsedCivBlitz ?? false
      : lobby.draftConfig.civBlitz
    if (hasRedDeath && parsedRedDeath === true) normalizedCivBlitz = false
    if (normalizedCivBlitz) normalizedRedDeath = false
    let normalizedCivBlitzOptionCount = hasCivBlitzOptionCount
      ? parsedCivBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT
      : lobby.draftConfig.civBlitzOptionCount
    const normalizedCivBlitzExcludeBbgExpanded = hasCivBlitzExcludeBbgExpanded
      ? parsedCivBlitzExcludeBbgExpanded ?? true
      : lobby.draftConfig.civBlitzExcludeBbgExpanded
    if (normalizedCivBlitz) {
      normalizedCivBlitzOptionCount = Math.min(
        normalizedCivBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT,
        getCivBlitzOptionCountMaximum(normalizedLeaderDataVersion, { excludeBbgExpanded: normalizedCivBlitzExcludeBbgExpanded }),
      )
    }
    let normalizedRandomDraft = hasRandomDraft
      ? parsedRandomDraft ?? false
      : lobby.draftConfig.randomDraft
    let normalizedHiddenDraft = hasHiddenDraft
      ? parsedHiddenDraft ?? false
      : lobby.draftConfig.hiddenDraft
    if (hasHiddenDraft && parsedHiddenDraft === true) normalizedRandomDraft = false
    if (hasRandomDraft && parsedRandomDraft === true) normalizedHiddenDraft = false
    if (normalizedCivBlitz) {
      normalizedRandomDraft = false
      normalizedHiddenDraft = false
    }
    const normalizedDuplicateFactions = hasDuplicateFactions
      ? parsedDuplicateFactions ?? false
      : lobby.draftConfig.duplicateFactions
    const normalizedClosed = hasClosed
      ? parsedClosed ?? false
      : lobby.draftConfig.closed === true
    const parsedRedDeathFfaTargetSize = mode === 'ffa' && hasTargetSize
      ? parseRedDeathFfaTargetSize(targetSizeRaw)
      : undefined

    let normalizedMinRole = normalizedRankBounds.minimum
    let normalizedMaxRole = normalizedRankBounds.maximum
    if (normalizedCivBlitz) {
      normalizedMinRole = null
      normalizedMaxRole = null
    }

    if (isUnrankedMode(mode) && (normalizedMinRole != null || normalizedMaxRole != null)) {
      return c.json({ error: `${normalizedCivBlitz ? 'CivBlitz' : formatModeLabel(mode)} lobbies are unranked and do not support matchmaking rank limits.` }, 400)
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
    const hasDraftConfigUpdate = hasBanTimerSeconds || hasPickTimerSeconds || hasLeaderPoolSize || hasLeaderDataVersion || hasMapVoteEnabled || hasBlindBans || hasBlindPicks || hasSimultaneousPick || hasPermanentAlly || hasRedDeath || hasDealOptionsSize || hasCivBlitz || hasCivBlitzOptionCount || hasCivBlitzExcludeBbgExpanded || hasRandomDraft || hasHiddenDraft || hasDuplicateFactions || hasClosed || hasTargetSize || hasMinRole || hasMaxRole
    const isSteamLobbyLinkOnlyUpdate = hasSteamLobbyLink && !hasDraftConfigUpdate
    const currentUserIsHost = lobby.hostId === auth.identity.userId
    const currentUserIsSlotted = lobby.slots.includes(auth.identity.userId)

    if (isSteamLobbyLinkOnlyUpdate) {
      if (!isSteamLobbyEditableStatus(lobby.status)) {
        return c.json({ error: 'Steam lobby links can only be managed while the lobby is open or the match is live.' }, 409)
      }
      if (!currentUserIsHost && !currentUserIsSlotted) {
        return c.json({ error: 'Only lobby players can update the Steam lobby link' }, 403)
      }

      const updated = await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby, lobbySessionMutationOptions(c)) ?? lobby
      if (updated.revision !== lobby.revision) {
        await syncRequestLobbyDerivedState(c, kv, updated)
      }
      return c.json(await buildStoredLobbySnapshot(kv, mode, updated, c.env.ALLOWED_DISCORD_GUILD_ID))
    }

    if (!currentUserIsHost) {
      return c.json({ error: 'Only the lobby host can update draft config' }, 403)
    }

    if (lobby.status !== 'open') {
      if (!isSteamLobbyEditableStatus(lobby.status)) {
        return c.json({ error: 'Steam lobby links can only be managed while the lobby is open or the match is live.' }, 409)
      }
      if (!hasSteamLobbyLink) {
        return c.json({ error: 'Only the Steam lobby link can be updated after the draft starts.' }, 409)
      }
      if (hasDraftConfigUpdate) {
        return c.json({ error: 'Only the Steam lobby link can be updated after the draft starts.' }, 409)
      }

      const updated = await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby, lobbySessionMutationOptions(c)) ?? lobby
      if (updated.revision !== lobby.revision) {
        await syncRequestLobbyDerivedState(c, kv, updated)
      }
      return c.json(await buildStoredLobbySnapshot(kv, mode, updated, c.env.ALLOWED_DISCORD_GUILD_ID))
    }

    if (tournamentMatch) {
      const lockError = getTournamentLockedConfigError(lobby, {
        hasTargetSize,
        targetSize: parsedTargetSize,
        hasLeaderPoolSize,
        leaderPoolSize: parsedLeaderPoolSize ?? null,
        hasMapVoteEnabled,
        mapVoteEnabled: parsedMapVoteEnabled ?? false,
        hasBlindBans,
        blindBans: parsedBlindBans ?? true,
        hasBlindPicks,
        blindPicks: parsedBlindPicks ?? false,
        hasSimultaneousPick,
        simultaneousPick: parsedSimultaneousPick ?? false,
        hasPermanentAlly,
        permanentAlly: parsedPermanentAlly ?? false,
        hasRedDeath,
        redDeath: parsedRedDeath ?? false,
        hasDealOptionsSize,
        dealOptionsSize: parsedDealOptionsSize ?? null,
        hasCivBlitz,
        civBlitz: parsedCivBlitz ?? false,
        hasCivBlitzOptionCount,
        civBlitzOptionCount: parsedCivBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT,
        hasCivBlitzExcludeBbgExpanded,
        civBlitzExcludeBbgExpanded: parsedCivBlitzExcludeBbgExpanded ?? true,
        hasRandomDraft,
        randomDraft: parsedRandomDraft ?? false,
        hasHiddenDraft,
        hiddenDraft: parsedHiddenDraft ?? false,
        hasDuplicateFactions,
        duplicateFactions: parsedDuplicateFactions ?? false,
        hasMinRole,
        minRole: normalizedMinRole,
        hasMaxRole,
        maxRole: normalizedMaxRole,
      })
      if (lockError) return c.json({ error: lockError }, 400)
    }

    if (minRoleChanged && normalizedMinRole && !lobby.guildId) {
      return c.json({ error: 'This lobby is missing guild context, so min rank cannot be set.' }, 400)
    }
    if (maxRoleChanged && normalizedMaxRole && !lobby.guildId) {
      return c.json({ error: 'This lobby is missing guild context, so max rank cannot be set.' }, 400)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, normalizedRedDeath, normalizedCivBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    let slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const renderSlotsBeforeConfigChange = [...slots]
    const requestedTargetSize = (() => {
      if (mode !== 'ffa') {
        return hasTargetSize ? parsedTargetSize ?? slots.length : slots.length
      }

      if (normalizedRedDeath) {
        if (hasTargetSize) return parsedRedDeathFfaTargetSize ?? slots.length
        return lobby.draftConfig.redDeath ? slots.length : 10
      }

      if (hasTargetSize) return parsedTargetSize ?? slots.length
      return lobby.draftConfig.redDeath ? defaultPlayerCount(mode) : parseLobbyTargetSize(mode, slots.length) ?? defaultPlayerCount(mode)
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
      normalizedRedDeath || normalizedCivBlitz,
      normalizedLeaderPoolSize,
      normalizedLeaderDataVersion,
      slots.length,
    )
    if (leaderPoolError) return c.json({ error: leaderPoolError }, 400)

    if ((minRoleChanged || maxRoleChanged) && (normalizedMinRole || normalizedMaxRole)) {
      if (!lobby.guildId) return c.json({ error: 'Lobby is missing owning-server data' }, 409)
      const gateError = await getCalculatedRankGateError(
        db,
        kv,
        createStatsContext(lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID ?? ''),
        { minRole: normalizedMinRole, maxRole: normalizedMaxRole },
        slots.filter((playerId): playerId is string => playerId != null),
      )
      if (gateError) return c.json({ error: gateError }, 400)
    }

    const baseDraftConfig = normalizeDraftConfigForMode(mode, {
      banTimerSeconds: resolvedBanTimerSeconds,
      pickTimerSeconds: resolvedPickTimerSeconds,
      leaderPoolSize: normalizedLeaderPoolSize,
      leaderDataVersion: normalizedLeaderDataVersion,
      mapVoteEnabled: normalizedMapVoteEnabled,
      blindBans: normalizedBlindBans,
      blindPicks: normalizedBlindPicks,
      simultaneousPick: normalizedSimultaneousPick,
      permanentAlly: normalizedPermanentAlly,
      redDeath: normalizedRedDeath,
      dealOptionsSize: normalizedDealOptionsSize,
      civBlitz: normalizedCivBlitz,
      civBlitzOptionCount: normalizedCivBlitzOptionCount,
      civBlitzExcludeBbgExpanded: normalizedCivBlitzExcludeBbgExpanded,
      randomDraft: normalizedRandomDraft,
      hiddenDraft: normalizedHiddenDraft,
      duplicateFactions: normalizedDuplicateFactions,
      closed: normalizedClosed,
    }, requestedTargetSize)
    const nextDraftConfig = lockTournamentDraftConfig(baseDraftConfig, tournamentMatch != null)

    let updated: LobbyState
    let nextLobbyQueueEntries: QueueEntry[]
    try {
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
      updated = hasSteamLobbyLink
        ? (await setLobbySteamLobbyLink(kv, lobby.id, parsedSteamLobbyLink ?? null, lobby, lobbySessionMutationOptions(c)) ?? lobby)
        : lobby

      nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, updated, lobbyQueueEntries)
      if (updated.revision !== resolvedLobby.revision) {
        updated = await setLobbyLastActivityAt(kv, updated.id, Date.now(), updated, lobbySessionMutationOptions(c)) ?? updated
        nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, updated, nextLobbyQueueEntries)
      }
    }
    catch (error) {
      if (isSessionVersionStaleError(error)) return c.json({ error: 'Lobby changed; please retry.' }, 409)
      throw error
    }

    const normalizedSlots = normalizeLobbySlots(mode, updated.slots, nextLobbyQueueEntries)
    const slottedEntries = mapLobbySlotsToEntries(normalizedSlots, nextLobbyQueueEntries)
    const snapshot = await syncRequestLobbyDerivedState(c, kv, updated, {
      queueEntries: nextLobbyQueueEntries,
      slots: normalizedSlots,
      balanceSnapshot,
    })

    if (openLobbyMessageRenderStateChanged(resolvedLobby, updated, renderSlotsBeforeConfigChange, normalizedSlots)) {
      queueBackgroundTask(c, async () => {
        const currentLobby = updated
        const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, updated, slottedEntries)
        await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
          embeds: renderPayload.embeds,
          components: renderPayload.components,
        }, lobbySessionMutationOptions(c))
      }, `Failed to update lobby embed after config change in ${mode}:`)
    }

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, updated, nextLobbyQueueEntries, normalizedSlots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
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

    const db = createDb(c.env.DB)
    const resolvedLobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!resolvedLobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }
    const lobby = resolvedLobby

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can change game mode' }, 403)
    }

    if (nextMode === mode) {
      return c.json(await buildOpenLobbySnapshot(kv, mode, lobby, c.env.ALLOWED_DISCORD_GUILD_ID))
    }

    const tournamentMatch = await getTournamentMatchBySessionId(db, lobby.id)
    if (tournamentMatch) {
      return c.json({ error: 'Tournament lobbies are fixed at 1v1.' }, 403)
    }
    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)
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
    const nextDraftConfigInput = nextMode === 'ffa' && !sourceLobby.draftConfig.redDeath
      ? { ...sourceLobby.draftConfig, permanentAlly: true }
      : sourceLobby.draftConfig
    const finalizedLobby = await setLobbyModeAndLayout(kv, sourceLobby.id, {
      mode: nextMode,
      draftConfig: normalizeDraftConfigForMode(nextMode, nextDraftConfigInput, normalizedNextSlots.length),
      minRole: isUnrankedMode(nextMode) ? null : sourceLobby.minRole,
      maxRole: isUnrankedMode(nextMode) ? null : sourceLobby.maxRole,
      slots: normalizedNextSlots,
      lastActivityAt: changedAt,
      now: changedAt,
    }, sourceLobby, lobbySessionMutationOptions(c)) ?? sourceLobby
    const finalizedLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, finalizedLobby, movedLobbyQueueEntries)
    const snapshot = await syncRequestLobbyDerivedState(c, kv, finalizedLobby, {
      queueEntries: finalizedLobbyQueueEntries,
      slots: finalizedLobby.slots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(finalizedLobby.slots, finalizedLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = finalizedLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, finalizedLobby, slottedEntries)
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
      undefined,
      c.env.ALLOWED_DISCORD_GUILD_ID,
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

    const db = createDb(c.env.DB)
    const resolvedLobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
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

    const tournamentMatch = await getTournamentMatchBySessionId(db, lobby.id)
    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)
    let transferNotice: string | null = null

    const alreadyInTargetLobby = lobby.memberPlayerIds.includes(movingPlayerId) || lobby.slots.includes(movingPlayerId)
    if (lobby.draftConfig.closed === true && !isHost && !alreadyInTargetLobby) {
      return c.json({ error: 'This lobby is closed.' }, 403)
    }
    let blockingLobbyForPlayer: Awaited<ReturnType<typeof getCurrentSessionLobbyProjectionsForPlayer>>[number] | null = null
    if (!alreadyInTargetLobby) {
      const currentLobbiesForPlayer = await getCurrentSessionLobbyProjectionsForPlayer(db, movingPlayerId, {
        excludeLobbyIds: [lobby.id],
      })
      const blockingDraftMatchIds = await findPersistedBlockingDraftMatchIdsForPlayers(c.env.DB, [movingPlayerId])
      const hasLiveMatch = currentLobbiesForPlayer.some(candidate => candidate.status !== 'open')
        || blockingDraftMatchIds?.has(movingPlayerId) === true
      if (hasLiveMatch) {
        return c.json({ error: 'That player is already in a live match.' }, 400)
      }
      blockingLobbyForPlayer = currentLobbiesForPlayer.find(candidate => candidate.status === 'open') ?? null
      if (blockingLobbyForPlayer) {
        if (movingPlayerId !== auth.identity.userId) {
          return c.json({ error: 'That player is already in another lobby.' }, 400)
        }
        transferNotice = `Moved you from your previous ${formatModeLabel(blockingLobbyForPlayer.mode, blockingLobbyForPlayer.mode, { redDeath: blockingLobbyForPlayer.draftConfig.redDeath, civBlitz: blockingLobbyForPlayer.draftConfig.civBlitz })} lobby.`
      }
    }

    if (tournamentMatch && movingPlayerId !== auth.identity.userId) {
      return c.json({ error: 'Tournament lobbies only allow players to join themselves.' }, 403)
    }
    if (tournamentMatch && !alreadyInTargetLobby) {
      const validation = await validateTournamentLobbyJoin(db, lobby, {
        userId: auth.identity.userId,
        displayName: auth.identity.displayName?.trim() || auth.identity.userId,
        avatarUrl: auth.identity.avatarUrl,
      })
      if (!validation.ok) return c.json({ error: validation.error }, 403)
    }
    if (!alreadyInTargetLobby && movingPlayerId === auth.identity.userId) {
      if (!lobby.guildId) return c.json({ error: 'This lobby is missing owning-server data.' }, 409)
      const rankGateError = await getCalculatedRankGateError(
        db,
        kv,
        createStatsContext(lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID ?? ''),
        lobby,
        [movingPlayerId],
      )
      if (rankGateError) return c.json({ error: rankGateError }, 403)
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
      const snapshot = await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID)
      return c.json({
        lobby: snapshot,
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

    let transferSource: { lobby: NonNullable<typeof blockingLobbyForPlayer>, queueEntries: QueueEntry[] } | null = null
    let deferredTransferSource: DeferredOpenLobbyTransferSource | null = null
    const targetLobbyBeforeTransfer = lobby
    const targetQueueEntriesBeforeTransfer = [...lobbyQueueEntries]
    if (blockingLobbyForPlayer?.status === 'open') {
      const sourceRosterEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, blockingLobbyForPlayer)
      transferSource = { lobby: blockingLobbyForPlayer, queueEntries: sourceRosterEntries }
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
      deferredTransferSource = transferResult.deferredSource ?? null
    }

    const addedRosterEntry = !movingEntry
      ? {
          playerId: movingPlayerId,
          displayName: resolvedDisplayName ?? '',
          avatarUrl: auth.identity.avatarUrl,
          ...(auth.identity.sourceGuild ? { sourceGuild: auth.identity.sourceGuild } : {}),
          joinedAt: actionAt,
        }
      : null

    const nextMemberIds = lobby.memberPlayerIds.includes(movingPlayerId)
      ? lobby.memberPlayerIds
      : [...new Set([...lobby.memberPlayerIds, movingPlayerId])]
    const rosterPatchEntries = addedRosterEntry ? [addedRosterEntry] : []
    lobbyQueueEntries = buildLobbyQueueEntries({ ...lobby, memberPlayerIds: nextMemberIds }, [...lobbyQueueEntries, ...rosterPatchEntries])
    slots = normalizeLobbySlots(mode, slots, lobbyQueueEntries)
    let nextLobby = lobby
    if (!sameLobbySlots(slots, lobby.slots) || nextMemberIds.length !== lobby.memberPlayerIds.length || lobby.lastActivityAt !== actionAt) {
      try {
        nextLobby = await setLobbyRoster(kv, lobby.id, {
          memberPlayerIds: nextMemberIds,
          slots,
          lastActivityAt: actionAt,
          now: actionAt,
        }, lobby, lobbySessionMutationOptions(c, rosterPatchEntries)) ?? lobby
      }
      catch (error) {
        if (isSessionVersionStaleError(error) && !transferSource && !deferredTransferSource) {
          const currentRecord = await getSessionRecord(c.env.SessionDO, lobby.id).catch(() => null)
          if (currentRecord?.phase === 'open') {
            const currentLobby = buildLobbyStateFromSessionRecord(currentRecord, lobby)
            const currentEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, currentLobby, [...lobbyQueueEntries, ...rosterPatchEntries])
            const currentSlots = normalizeLobbySlots(mode, currentLobby.slots, currentEntries)
            if (currentLobby.memberPlayerIds.includes(movingPlayerId) && currentSlots[targetSlot] === movingPlayerId) {
              const snapshot = await buildOpenLobbySnapshotFromParts(kv, mode, currentLobby, currentEntries, currentSlots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID)
              return c.json({ lobby: snapshot, transferNotice })
            }
          }
          return c.json({ error: 'Lobby changed; please retry.' }, 409)
        }
        if (deferredTransferSource) {
          const restoredAdmission = await restoreDeferredOpenLobbyTransferSourceAdmission(deferredTransferSource, lobbySessionMutationOptions(c, deferredTransferSource.queueEntries))
          if (!restoredAdmission.ok) return c.json({ error: restoredAdmission.error }, 409)
        }
        if (transferSource) {
          const restored = await restoreOpenLobbyTransferSource(kv, c, transferSource.lobby, transferSource.queueEntries, actionAt)
          if (!restored.ok) return c.json({ error: restored.error }, 409)
        }
        if (isSessionAdmissionError(error)) return c.json({ error: formatSessionAdmissionError(error) }, 409)
        if (isSessionVersionStaleError(error)) return c.json({ error: 'Lobby changed; please retry.' }, 409)
        throw error
      }
    }

    if (deferredTransferSource) {
      const finalized = await finalizeDeferredOpenLobbyTransferSource(kv, c.env.DISCORD_TOKEN, deferredTransferSource, lobbySessionMutationOptions(c, deferredTransferSource.queueEntries))
      if (!finalized.ok) {
        const rolledBack = await rollbackDeferredOpenLobbyTransferTarget(kv, deferredTransferSource, {
          lobby: targetLobbyBeforeTransfer,
          queueEntries: targetQueueEntriesBeforeTransfer,
          at: actionAt,
        }, lobbySessionMutationOptions(c, targetQueueEntriesBeforeTransfer))
        if (!rolledBack.ok) return c.json({ error: `${finalized.error} Transfer rollback also failed: ${rolledBack.error}` }, 409)
        return c.json({ error: `${finalized.error} Transfer was rolled back; please try again.` }, 409)
      }
    }

    lobbyQueueEntries = buildLobbyQueueEntries(nextLobby, lobbyQueueEntries)
    slots = normalizeLobbySlots(mode, nextLobby.slots, lobbyQueueEntries)
    const snapshot = await syncRequestLobbyDerivedState(c, kv, nextLobby, {
      queueEntries: lobbyQueueEntries,
      slots,
      balanceSnapshot,
    })

    if (tournamentMatch) await updateTournamentMatchRoster(db, nextLobby.id, nextMemberIds)

    const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
    queueBackgroundTask(c, async () => {
      const currentLobby = nextLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after slot placement in ${mode}:`)

    const responseLobby = snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, lobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID)
    return c.json({
      lobby: responseLobby,
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

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (slot >= lobby.slots.length) {
      return c.json({ error: 'Invalid slot index' }, 400)
    }

    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const targetPlayerId = slots[slot]

    if (targetPlayerId == null) {
      return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
    }

    if (targetPlayerId === lobby.hostId) {
      return c.json({ error: 'Host cannot leave the lobby.' }, 400)
    }

    const isHost = auth.identity.userId === lobby.hostId
    if (!isHost && auth.identity.userId !== targetPlayerId) {
      return c.json({ error: 'You can only remove yourself from a slot.' }, 403)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)

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
    const snapshot = await syncRequestLobbyDerivedState(c, kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
      balanceSnapshot,
    })
    if (await getTournamentMatchBySessionId(db, nextLobby.id)) await updateTournamentMatchRoster(db, nextLobby.id, nextMemberIds)
    const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = nextLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after slot removal in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
  })

  app.post('/api/lobby/:mode/transfer-host', async (c) => {
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

    const { userId, targetPlayerId, lobbyId } = body as { userId?: string, targetPlayerId?: unknown, lobbyId?: unknown }

    if (typeof userId !== 'string' || userId.length === 0) {
      return c.json({ error: 'userId is required' }, 400)
    }

    const mismatch = rejectMismatchedActivityUser(c, userId, auth.identity.userId)
    if (mismatch) return mismatch

    if (typeof targetPlayerId !== 'string' || targetPlayerId.length === 0) {
      return c.json({ error: 'targetPlayerId is required' }, 400)
    }

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can transfer host' }, 403)
    }

    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

    if (targetPlayerId === lobby.hostId) {
      return c.json(await buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
    }

    if (!slots.includes(targetPlayerId)) {
      return c.json({ error: 'New host must be in a lobby slot.' }, 400)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)

    let nextLobby: LobbyState
    try {
      nextLobby = await setLobbyHost(kv, lobby.id, targetPlayerId, lobby, lobbySessionMutationOptions(c, lobbyQueueEntries)) ?? lobby
    }
    catch (error) {
      if (isSessionVersionStaleError(error)) return c.json({ error: 'Lobby changed; please retry.' }, 409)
      throw error
    }

    const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, lobbyQueueEntries)
    const nextSlots = normalizeLobbySlots(mode, nextLobby.slots, nextLobbyQueueEntries)
    const snapshot = await syncRequestLobbyDerivedState(c, kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots: nextSlots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(nextSlots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = nextLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after host transfer in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, nextSlots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
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

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can arrange the lobby' }, 403)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)
    const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
    const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
    const slottedPlayerIds = slots.filter((playerId): playerId is string => playerId != null)

    let ratingsByPlayerId = new Map<string, { mu: number, sigma: number }>()
    if (strategyRaw === 'balance' && slottedPlayerIds.length > 0) {
      const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: lobby.draftConfig.redDeath, civBlitz: lobby.draftConfig.civBlitz })
      if (leaderboardMode != null) {
        if (!lobby.guildId) return c.json({ error: 'Lobby is missing owning-server data' }, 409)
        const statsContext = createStatsContext(lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID ?? '')
        const rows = await db
          .select({
            playerId: playerRatings.playerId,
            mu: playerRatings.mu,
            sigma: playerRatings.sigma,
          })
          .from(playerRatings)
          .where(and(
            eq(playerRatings.statsKey, statsContext.statsKey),
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
      teamGuildPolicy: {
        primaryGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
        allowLegacyPrimarySource: false,
      },
    })

    if ('error' in arranged) {
      return c.json({ error: arranged.error }, 400)
    }

    const nextLobby = await setLobbyArranged(kv, lobby.id, {
      slots: arranged.slots,
      strategy: strategyRaw,
    }, lobby, lobbySessionMutationOptions(c)) ?? lobby
    const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, lobbyQueueEntries)
    const snapshot = await syncRequestLobbyDerivedState(c, kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots: arranged.slots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(arranged.slots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = nextLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after ${strategyRaw} arrange in ${mode}:`)

    return c.json(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, arranged.slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID))
  })

  app.post('/api/lobby/:mode/fill-test', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    if (!isDebugLobbyFillEnabled(c.env.ENABLE_DEBUG_LOBBY_FILL)) {
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

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby) {
      return c.json({ error: 'No open lobby for this mode' }, 404)
    }

    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can fill test players' }, 403)
    }

    const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz, lobby.guildId, c.env.ALLOWED_DISCORD_GUILD_ID)
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
    const snapshot = await syncRequestLobbyDerivedState(c, kv, nextLobby, {
      queueEntries: nextLobbyQueueEntries,
      slots,
      balanceSnapshot,
    })
    const slottedEntries = mapLobbySlotsToEntries(slots, nextLobbyQueueEntries)

    queueBackgroundTask(c, async () => {
      const currentLobby = nextLobby
      const renderPayload = await buildOpenLobbyRenderPayloadForMessage(db, kv, nextLobby, slottedEntries)
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, lobbySessionMutationOptions(c))
    }, `Failed to update lobby embed after test fill in ${mode}:`)

    return c.json({
      ...(snapshot ?? await buildOpenLobbySnapshotFromParts(kv, mode, nextLobby, nextLobbyQueueEntries, slots, undefined, c.env.ALLOWED_DISCORD_GUILD_ID)),
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

    const db = createDb(c.env.DB)
    const lobbyById = typeof lobbyId === 'string' ? await getSessionLobbyProjectionByMatch(db, lobbyId) ?? await getLobbyById(kv, lobbyId) : null
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
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
          sessionId: lobby.id,
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

      await syncRequestLobbyDerivedState(c, kv, lobbyForMessage)
      await markTournamentMatchDrafting(db, lobby.id, matchId)

      if (!started.idempotent && seats.length > 0) {
        queueBackgroundTask(c, async () => {
          const currentLobby = lobbyForMessage
          const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, {
            embeds: [lobbyDraftingEmbed(mode, seats, lobbyForMessage.draftConfig.leaderDataVersion, lobbyForMessage.draftConfig.redDeath, lobbyForMessage.draftConfig.civBlitz)],
            components: lobbyComponents(mode, currentLobby.id),
          }, lobbySessionMutationOptions(c))
          await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
        }, `Failed to update drafting lobby embed for mode ${mode}:`)
      }

      return c.json({
        ok: true as const,
        matchId,
        sessionAccessToken: await createSessionAccessToken(internalSecret, {
          userId: auth.identity.userId,
          sessionId: started.record.id,
          channelId: lobbyForMessage.channelId,
        }),
      })
    }
    catch (error) {
      console.error(`Failed to start lobby draft for mode ${mode}:`, error)
      const commandError = parseSessionDraftCommandError(error)
      if (commandError) return c.json({ error: commandError.message }, commandError.status)
      return c.json({ error: 'Failed to start draft. Please try again.' }, 500)
    }
  })

  app.post('/api/lobby/:mode/repeat-draft', async (c) => {
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

    const db = createDb(c.env.DB)
    const lobby = await resolveOpenLobbyFromBody(db, mode, { lobbyId })
    if (!lobby) return c.json({ error: 'No open lobby for this mode' }, 404)
    if (lobby.hostId !== auth.identity.userId) {
      return c.json({ error: 'Only the lobby host can repeat the draft' }, 403)
    }

    try {
      const repeated = await repeatSessionDraft(c.env.SessionDO, lobby.id, {
        expectedVersion: lobby.revision,
        hostId: auth.identity.userId,
      })
      if (repeated.record.mode !== mode) return c.json({ error: 'Session mode does not match lobby route.' }, 409)

      const { matchId, seats } = repeated
      const lobbyForMessage = buildLobbyStateFromSessionRecord(repeated.record, lobby)
      await syncRequestLobbyDerivedState(c, kv, lobbyForMessage)
      await markTournamentMatchDrafting(db, lobby.id, matchId)

      if (repeated.kind === 'resume') {
        queueBackgroundTask(c, async () => {
          const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobbyForMessage, {
            embeds: [lobbyDraftingEmbed(mode, seats, lobbyForMessage.draftConfig.leaderDataVersion, lobbyForMessage.draftConfig.redDeath, lobbyForMessage.draftConfig.civBlitz)],
            components: lobbyComponents(mode, lobbyForMessage.id),
          }, lobbySessionMutationOptions(c))
          await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
        }, `Failed to update repeated draft lobby embed for mode ${mode}:`)
      }

      return c.json({
        ok: true as const,
        kind: repeated.kind,
        matchId,
        sessionAccessToken: await createSessionAccessToken(internalSecret, {
          userId: auth.identity.userId,
          sessionId: repeated.record.id,
          channelId: lobbyForMessage.channelId,
        }),
      })
    }
    catch (error) {
      const commandError = parseSessionDraftCommandError(error)
      if (commandError) return c.json({ error: commandError.message }, commandError.status)
      console.error(`Failed to repeat lobby draft for mode ${mode}:`, error)
      return c.json({ error: 'Failed to repeat draft. Please try again.' }, 500)
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
    const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby, lobbySessionMutationOptions(c, lobbyQueueEntries)) ?? {
      ...lobby,
      status: 'cancelled' as const,
      updatedAt: Date.now(),
      revision: lobby.revision + 1,
    }

    queueBackgroundTask(c, async () => {
      await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, cancelledLobby, {
        embeds: [{
          title: `LOBBY CANCELLED  -  ${formatModeLabel(mode, mode, { redDeath: lobby.draftConfig.redDeath, civBlitz: lobby.draftConfig.civBlitz })}`,
          description: 'Host cancelled this lobby before draft start.',
          color: 0x6B7280,
        }],
        components: [],
      }, lobbySessionMutationOptions(c))
    }, `Failed to update cancelled lobby embed for mode ${mode}:`)
    return c.json({ ok: true })
  })
}

async function buildStoredLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: Awaited<ReturnType<typeof getLobbyById>> extends infer T ? Exclude<T, null> : never,
  legacyGuildId?: string | null,
) {
  const serverDefaults = await getServerDraftTimerDefaults(kv, { guildId: lobby.guildId, legacyGuildId })
  const slottedPlayerIds = lobby.slots.filter((playerId): playerId is string => playerId != null)
  const lobbyRank = await buildLobbyRankSnapshot(kv, lobby.guildId, slottedPlayerIds, {
    mode,
    playerCount: slottedPlayerIds.length,
    leaderDataVersion: lobby.draftConfig.leaderDataVersion,
    redDeath: lobby.draftConfig.redDeath,
    civBlitz: lobby.draftConfig.civBlitz,
  })
  return {
    id: lobby.id,
    revision: lobby.revision,
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    steamLobbyLink: lobby.steamLobbyLink,
    minRole: lobby.minRole,
    maxRole: lobby.maxRole,
    lobbyRank,
    entries: lobby.slots.map(() => null),
    minPlayers: lobbyMinPlayerCount(mode, lobby.slots.length, lobby.draftConfig.redDeath, lobby.draftConfig.permanentAlly),
    targetSize: lobby.slots.length,
    draftConfig: lobby.draftConfig,
    serverDefaults,
  }
}

function isSteamLobbyEditableStatus(status: 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'): boolean {
  return status === 'open' || status === 'drafting' || status === 'active'
}

function lockTournamentDraftConfig(config: LobbyDraftConfig, locked: boolean): LobbyDraftConfig {
  if (!locked) return config
  return {
    ...config,
    leaderPoolSize: null,
    mapVoteEnabled: false,
    blindBans: true,
    blindPicks: false,
    simultaneousPick: false,
    permanentAlly: false,
    redDeath: false,
    dealOptionsSize: null,
    civBlitz: false,
    civBlitzOptionCount: CIV_BLITZ_DEFAULT_OPTION_COUNT,
    civBlitzExcludeBbgExpanded: true,
    randomDraft: false,
    hiddenDraft: false,
    duplicateFactions: false,
  }
}

function getTournamentLockedConfigError(
  lobby: LobbyState,
  request: {
    hasTargetSize: boolean
    targetSize: number | undefined
    hasLeaderPoolSize: boolean
    leaderPoolSize: number | null
    hasMapVoteEnabled: boolean
    mapVoteEnabled: boolean
    hasBlindBans: boolean
    blindBans: boolean
    hasBlindPicks: boolean
    blindPicks: boolean
    hasSimultaneousPick: boolean
    simultaneousPick: boolean
    hasPermanentAlly: boolean
    permanentAlly: boolean
    hasRedDeath: boolean
    redDeath: boolean
    hasDealOptionsSize: boolean
    dealOptionsSize: number | null
    hasCivBlitz: boolean
    civBlitz: boolean
    hasCivBlitzOptionCount: boolean
    civBlitzOptionCount: number
    hasCivBlitzExcludeBbgExpanded: boolean
    civBlitzExcludeBbgExpanded: boolean
    hasRandomDraft: boolean
    randomDraft: boolean
    hasHiddenDraft: boolean
    hiddenDraft: boolean
    hasDuplicateFactions: boolean
    duplicateFactions: boolean
    hasMinRole: boolean
    minRole: LobbyState['minRole']
    hasMaxRole: boolean
    maxRole: LobbyState['maxRole']
  },
): string | null {
  if (lobby.mode !== '1v1') return 'Tournament lobbies are fixed at 1v1.'
  if (request.hasTargetSize && request.targetSize !== 2) return 'Tournament lobbies are fixed at 1v1.'
  if (isLockedValueChange(request.hasLeaderPoolSize, request.leaderPoolSize, lobby.draftConfig.leaderPoolSize, null)) return 'Tournament leader pool is fixed.'
  if (isLockedValueChange(request.hasMapVoteEnabled, request.mapVoteEnabled, lobby.draftConfig.mapVoteEnabled, false)) return 'Tournament lobbies do not use map vote.'
  if (isLockedValueChange(request.hasBlindBans, request.blindBans, lobby.draftConfig.blindBans, true)) return 'Tournament blind-ban settings are locked.'
  if (isLockedValueChange(request.hasBlindPicks, request.blindPicks, lobby.draftConfig.blindPicks, false)) return 'Tournament pick settings are locked.'
  if (isLockedValueChange(request.hasSimultaneousPick, request.simultaneousPick, lobby.draftConfig.simultaneousPick, false)) return 'Tournament pick settings are locked.'
  if (isLockedValueChange(request.hasPermanentAlly, request.permanentAlly, lobby.draftConfig.permanentAlly, false)) return 'Tournament ally settings are locked.'
  if (isLockedValueChange(request.hasRedDeath, request.redDeath, lobby.draftConfig.redDeath, false)) return 'Tournament lobbies cannot enable Red Death.'
  if (isLockedValueChange(request.hasDealOptionsSize, request.dealOptionsSize, lobby.draftConfig.dealOptionsSize, null)) return 'Tournament Red Death settings are locked.'
  if (isLockedValueChange(request.hasCivBlitz, request.civBlitz, lobby.draftConfig.civBlitz, false)) return 'Tournament lobbies cannot enable CivBlitz.'
  if (isLockedValueChange(request.hasCivBlitzOptionCount, request.civBlitzOptionCount, lobby.draftConfig.civBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT, CIV_BLITZ_DEFAULT_OPTION_COUNT)) return 'Tournament CivBlitz settings are locked.'
  if (isLockedValueChange(request.hasCivBlitzExcludeBbgExpanded, request.civBlitzExcludeBbgExpanded, lobby.draftConfig.civBlitzExcludeBbgExpanded, true)) return 'Tournament CivBlitz settings are locked.'
  if (isLockedValueChange(request.hasRandomDraft, request.randomDraft, lobby.draftConfig.randomDraft, false)) return 'Tournament draft visibility settings are locked.'
  if (isLockedValueChange(request.hasHiddenDraft, request.hiddenDraft, lobby.draftConfig.hiddenDraft, false)) return 'Tournament draft visibility settings are locked.'
  if (isLockedValueChange(request.hasDuplicateFactions, request.duplicateFactions, lobby.draftConfig.duplicateFactions, false)) return 'Tournament duplicate leader settings are locked.'
  if (request.hasMinRole && request.minRole !== lobby.minRole) return 'Tournament rank limits are locked.'
  if (request.hasMaxRole && request.maxRole !== lobby.maxRole) return 'Tournament rank limits are locked.'
  return null
}

function isLockedValueChange<T>(hasValue: boolean, requested: T, current: T, locked: T): boolean {
  return hasValue && requested !== current && requested !== locked
}

function getLeaderPoolSizeError(
  mode: GameMode,
  redDeath: boolean,
  leaderPoolSize: number | null,
  leaderDataVersion: 'live' | 'beta',
  playerCount: number,
): string | null {
  if (redDeath) return null
  if (leaderPoolSize == null) return null

  const maximumSize = getMaxLeaderPoolSize(leaderDataVersion)
  if (leaderPoolSize > maximumSize) return `Leaders must be at most ${maximumSize} for this BBG version.`

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

function parseLobbyPermanentAlly(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyBlindBans(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyBlindPicks(value: unknown): boolean | undefined {
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

function parseLobbyCivBlitz(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyCivBlitzOptionCount(value: unknown): number | null | undefined {
  if (value == null) return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return undefined
  if (numeric < CIV_BLITZ_MIN_OPTION_COUNT || numeric > CIV_BLITZ_MAX_OPTION_COUNT) return undefined
  return numeric
}

function parseLobbyCivBlitzExcludeBbgExpanded(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyRandomDraft(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyHiddenDraft(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyDuplicateFactions(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseLobbyClosed(value: unknown): boolean | undefined {
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

function openLobbyMessageRenderStateChanged(
  before: LobbyState,
  after: LobbyState,
  beforeSlots: (string | null)[],
  afterSlots: (string | null)[],
): boolean {
  return before.mode !== after.mode
    || !sameLobbySlots(beforeSlots, afterSlots)
    || before.minRole !== after.minRole
    || before.maxRole !== after.maxRole
    || before.draftConfig.leaderDataVersion !== after.draftConfig.leaderDataVersion
    || before.draftConfig.redDeath !== after.draftConfig.redDeath
    || before.draftConfig.civBlitz !== after.draftConfig.civBlitz
    || (before.draftConfig.closed === true) !== (after.draftConfig.closed === true)
}

export function isDebugLobbyFillEnabled(
  enabled: string | undefined,
): boolean {
  return isTruthyEnvFlag(enabled)
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
