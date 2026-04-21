import type { Database as CivupDatabase, Database } from '@civup/db'
import type { DraftCancelledWebhookPayload, DraftCompleteWebhookPayload, DraftState, DraftWebhookPayload, RoomConfig } from '@civup/game'
import type { Env } from '../../../src/env.ts'
import type { ActivityTargetSelection, MatchActivityTargetSelection } from '../../../src/services/activity/index.ts'
import type { LobbyState } from '../../../src/services/lobby/index.ts'
import { matchParticipants, matches } from '@civup/db'
import { allLeaderIds, createDraft, draftFormatMap, getCurrentStep, getPendingSeats, isDraftError, processDraftInput } from '@civup/game'
import { CIVUP_INTERNAL_SECRET_HEADER, createSignedWebhookHeaders } from '@civup/utils'
import { and, eq } from 'drizzle-orm'
import { activityLobbyUserKey, activityMatchKey, activityUserKey, getLobbyForUser, getMatchForUser, getUserActivityTarget } from '../../../src/services/activity/index.ts'
import { addToQueue, getQueueState } from '../../../src/services/queue/index.ts'
import { createLobby, getCurrentLobbiesForPlayer, getLobby, getLobbyById, getLobbyByMatch, setLobbyMemberPlayerIds, setLobbySlots } from '../../../src/services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../../src/services/lobby/live-snapshot.ts'
import { lobbySnapshotKey } from '../../../src/services/lobby/live-snapshot.ts'
import { hostKey, matchKey } from '../../../src/services/lobby/keys.ts'
import { listMatchMessageIds } from '../../../src/services/match/message.ts'
import { createStateStore } from '../../../src/services/state/store.ts'
import { setSystemChannel } from '../../../src/services/system/channels.ts'
import { buildBotTestEnv, createBotTestApp, createExecutionContextHarness } from '../../helpers/app-harness.ts'
import { createSqliteD1Database } from '../../helpers/d1.ts'
import { installFetchHandler } from '../../helpers/fetch-router.ts'
import { createTestDatabase } from '../../helpers/test-env.ts'
import { createTrackedKv } from '../../helpers/tracked-kv.ts'

const BOT_HOST = 'https://bot.test'
const PARTY_HOST = 'https://party.test'
const CIVUP_SECRET = 'secret'
const DEFAULT_CHANNEL_ID = 'channel-draft'
const DEFAULT_ARCHIVE_CHANNEL_ID = 'channel-archive'

interface DiscordRequestRecord {
  method: string
  url: string
  bodyText: string | null
}

interface DiscordMessageRecord {
  id: string
  channelId: string
  payload: unknown
}

interface PartyRoomRecord {
  config: RoomConfig
  completionPayloads: DraftCompleteWebhookPayload[]
  cancellationPayloads: DraftCancelledWebhookPayload[]
}

interface CompleteDraftOptions {
  finalized?: boolean
  transformState?: (state: DraftState) => DraftState
}

interface WorldPlayerInput {
  id: string
  displayName?: string
  avatarUrl?: string | null
}

interface RequestAsOptions {
  userId: string
  displayName?: string
  avatarUrl?: string | null
}

interface RouteResult<T = unknown> {
  status: number
  body: T
}

export interface SystemWorld {
  db: CivupDatabase
  env: Env['Bindings']
  kv: KVNamespace
  lobby: {
    createOpen: (input: { mode: Parameters<typeof getQueueState>[1], players: WorldPlayerInput[], hostId?: string, channelId?: string, guildId?: string | null }) => Promise<LobbyState>
    get: (mode: Parameters<typeof getLobby>[1]) => Promise<LobbyState | null>
    getById: (lobbyId: string) => Promise<LobbyState | null>
    start: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string }) => Promise<{ ok: boolean, matchId: string, roomAccessToken: string | null, idempotent?: boolean }>
    place: (mode: Parameters<typeof getQueueState>[1], input: { userId: string, targetSlot: number, lobbyId?: string, playerId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, transferNotice?: string | null, error?: string }>>
    remove: (mode: Parameters<typeof getQueueState>[1], input: { userId: string, slot: number, lobbyId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, error?: string }>>
  }
  party: {
    rooms: () => PartyRoomRecord[]
    completeDraft: (matchId: string, options?: CompleteDraftOptions) => Promise<Response>
    timeoutDraft: (matchId: string) => Promise<Response>
    cancelDraft: (matchId: string, options?: { reason?: 'cancel' | 'scrub' | 'revert' }) => Promise<Response>
    replayDraftComplete: (matchId: string, options?: { index?: number }) => Promise<Response>
    replayDraftCancel: (matchId: string, options?: { index?: number }) => Promise<Response>
  }
  match: {
    report: (matchId: string, input: { reporterId: string, placements: string }) => Promise<{ ok: boolean }>
    get: (matchId: string) => Promise<(typeof matches.$inferSelect) | null>
    getParticipants: (matchId: string) => Promise<(typeof matchParticipants.$inferSelect)[]>
    getMessageIds: (matchId: string) => Promise<string[]>
  }
  activity: {
    launch: (input: { channelId: string, userId: string }) => Promise<RouteResult>
    currentLobby: (input: { userId: string }) => Promise<RouteResult>
    targetLobby: (input: { channelId: string, userId: string, lobbyId: string }) => Promise<void>
  }
  discord: {
    requests: () => DiscordRequestRecord[]
    messages: () => DiscordMessageRecord[]
    message: (messageId: string) => DiscordMessageRecord | null
    deleteMessage: (messageId: string) => void
    failNextPatch: (messageId: string) => void
    currentLobbyMessage: (lobbyId: string) => Promise<DiscordMessageRecord | null>
    deleteCurrentLobbyMessage: (lobbyId: string) => Promise<void>
  }
  corrupt: {
    activityLobbyUser: (userId: string, lobbyId: string | null) => Promise<void>
    activityUser: (userId: string, matchId: string | null) => Promise<void>
    lobbySnapshot: (lobbyId: string, snapshot: unknown | null) => Promise<void>
    lobbyHost: (hostId: string, lobbyId: string | null) => Promise<void>
    lobbyMatch: (matchId: string, lobbyId: string | null) => Promise<void>
    openLobbyResidue: (lobbyId: string, input: { memberPlayerIds: string[], slots: (string | null)[] }) => Promise<LobbyState | null>
  }
  inspect: {
    lobbyMapping: (userId: string) => Promise<string | null>
    matchMapping: (userId: string) => Promise<string | null>
    activityTarget: (channelId: string, userId: string) => Promise<ActivityTargetSelection | MatchActivityTargetSelection | null>
    lobbiesForPlayer: (userId: string) => Promise<LobbyState[]>
    lobbyByMatch: (matchId: string) => Promise<LobbyState | null>
  }
  flushBackgroundTasks: () => Promise<void>
  dispose: () => Promise<void>
}

export async function createSystemWorld(): Promise<SystemWorld> {
  const { db, sqlite } = await createTestDatabase()
  const { kv } = createTrackedKv({ trackReads: true })
  const app = createBotTestApp()
  const execution = createExecutionContextHarness()
  const discordRequests: DiscordRequestRecord[] = []
  const discordMessages = new Map<string, DiscordMessageRecord>()
  const discordPatchFailures = new Set<string>()
  const partyRooms = new Map<string, PartyRoomRecord>()
  let nextDiscordMessageId = 1

  const env = buildBotTestEnv({
    DB: createSqliteD1Database(sqlite),
    KV: kv,
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'public-key',
    DISCORD_TOKEN: 'token',
    PARTY_HOST,
    BOT_HOST,
    CIVUP_SECRET,
  })

  await setSystemChannel(createStateStore(env), 'draft', DEFAULT_CHANNEL_ID)
  await setSystemChannel(createStateStore(env), 'archive', DEFAULT_ARCHIVE_CHANNEL_ID)

  const restoreFetchHandler = installFetchHandler(async (request) => {
    const url = new URL(request.url)

    if (url.origin === BOT_HOST) {
      return app.fetch(request, env, execution.executionCtx)
    }

    if (url.origin === PARTY_HOST && request.method === 'POST' && /^\/parties\/main\/[^/]+$/.test(url.pathname)) {
      const body = await request.json() as RoomConfig
      partyRooms.set(body.matchId, {
        config: body,
        completionPayloads: [],
        cancellationPayloads: [],
      })
      return jsonResponse({ ok: true })
    }

    if (url.origin === PARTY_HOST && request.method === 'POST' && url.pathname === '/parties/state/global') {
      return handleStateStoreRequest(request, kv)
    }

    if (url.origin === 'https://discord.com' && url.pathname.startsWith('/api/v10/')) {
      return handleDiscordRequest(request, discordRequests, discordMessages, discordPatchFailures, () => `discord-message-${nextDiscordMessageId++}`)
    }

    return undefined
  })

  const requestAs = async (path: string, init: RequestInit, options: RequestAsOptions): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    headers.set(CIVUP_INTERNAL_SECRET_HEADER, CIVUP_SECRET)
    headers.set('X-CivUp-Activity-User-Id', options.userId)
    headers.set('X-CivUp-Activity-Display-Name', encodeURIComponent(options.displayName ?? options.userId))
    if (options.avatarUrl) headers.set('X-CivUp-Activity-Avatar-Url', options.avatarUrl)
    return app.fetch(new Request(`${BOT_HOST}${path}`, { ...init, headers }), env, execution.executionCtx)
  }

  const sendWebhook = async (room: PartyRoomRecord, payload: DraftWebhookPayload): Promise<Response> => {
    if (!room.config.webhookUrl) throw new Error(`Captured Party room ${room.config.matchId} has no webhookUrl configured`)

    const body = JSON.stringify(payload)
    const headers = new Headers(
      room.config.webhookSecret
        ? await createSignedWebhookHeaders(room.config.webhookSecret, body)
        : undefined,
    )
    headers.set('Content-Type', 'application/json')

    return fetch(new Request(room.config.webhookUrl, {
      method: 'POST',
      headers,
      body,
    }))
  }

  const requestJsonAs = async <T>(path: string, init: RequestInit, options: RequestAsOptions): Promise<RouteResult<T>> => {
    const response = await requestAs(path, init, options)
    return {
      status: response.status,
      body: await response.json() as T,
    }
  }

  return {
    db,
    env,
    kv,
    lobby: {
      async createOpen(input) {
        const hostId = input.hostId ?? input.players[0]?.id
        if (!hostId) throw new Error('createOpen requires at least one player')
        const mode = input.mode
        const channelId = input.channelId ?? DEFAULT_CHANNEL_ID
        const entries = input.players.map((player, index) => ({
          playerId: player.id,
          displayName: player.displayName ?? player.id,
          avatarUrl: player.avatarUrl ?? null,
          joinedAt: index + 1,
        }))

        for (const entry of entries) {
          await addToQueue(kv, mode, entry)
        }

        const lobby = await createLobby(kv, {
          mode,
          guildId: input.guildId ?? null,
          hostId,
          channelId,
          messageId: `seed-message-${hostId}-${mode}`,
          queueEntries: entries,
        })
        discordMessages.set(lobby.messageId, {
          id: lobby.messageId,
          channelId,
          payload: null,
        })

        const memberPlayerIds = entries.map(entry => entry.playerId)
        const slots = [...lobby.slots]
        for (let index = 0; index < memberPlayerIds.length; index++) {
          slots[index] = memberPlayerIds[index] ?? null
        }

        const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, memberPlayerIds, lobby) ?? lobby
        const withSlots = await setLobbySlots(kv, lobby.id, slots, withMembers) ?? { ...withMembers, slots }
        await syncLobbyDerivedState(kv, withSlots, { queueEntries: entries, slots })
        return withSlots
      },
      get(mode) {
        return getLobby(kv, mode)
      },
      getById(lobbyId) {
        return getLobbyById(kv, lobbyId)
      },
      async start(mode, input) {
        const response = await requestAs(`/api/lobby/${mode}/start`, {
          method: 'POST',
          body: JSON.stringify({ userId: input.hostId, lobbyId: input.lobbyId }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
        const body = await response.json() as { ok: boolean, matchId: string, roomAccessToken: string | null, idempotent?: boolean, error?: string }
        if (!response.ok) throw new Error(body.error ?? `Failed to start lobby: ${response.status}`)
        return body
      },
      place(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/place`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.userId,
            targetSlot: input.targetSlot,
            lobbyId: input.lobbyId,
            playerId: input.playerId,
            displayName: input.displayName,
            avatarUrl: input.avatarUrl ?? null,
          }),
        }, {
          userId: input.userId,
          displayName: input.displayName ?? input.userId,
          avatarUrl: input.avatarUrl ?? null,
        })
      },
      remove(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/remove`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.userId,
            slot: input.slot,
            lobbyId: input.lobbyId,
          }),
        }, {
          userId: input.userId,
          displayName: input.displayName ?? input.userId,
          avatarUrl: input.avatarUrl ?? null,
        })
      },
    },
    party: {
      rooms() {
        return [...partyRooms.values()]
      },
      async completeDraft(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildCompletedPayload(room.config, options)
        room.completionPayloads.push(payload)
        return sendWebhook(room, payload)
      },
      async timeoutDraft(matchId) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildTimeoutPayload(room.config)
        room.cancellationPayloads.push(payload)
        return sendWebhook(room, payload)
      },
      async cancelDraft(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildCancelledPayload(room.config, options.reason ?? 'scrub')
        room.cancellationPayloads.push(payload)
        return sendWebhook(room, payload)
      },
      async replayDraftComplete(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = room.completionPayloads[options.index ?? room.completionPayloads.length - 1]
        if (!payload) throw new Error(`No completion payload recorded for match ${matchId}`)
        return sendWebhook(room, payload)
      },
      async replayDraftCancel(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = room.cancellationPayloads[options.index ?? room.cancellationPayloads.length - 1]
        if (!payload) throw new Error(`No cancellation payload recorded for match ${matchId}`)
        return sendWebhook(room, payload)
      },
    },
    match: {
      async report(matchId, input) {
        const response = await requestAs(`/api/match/${matchId}/report`, {
          method: 'POST',
          body: JSON.stringify({ reporterId: input.reporterId, placements: input.placements }),
        }, {
          userId: input.reporterId,
          displayName: input.reporterId,
        })
        const body = await response.json() as { ok?: boolean, error?: string }
        if (!response.ok) throw new Error(body.error ?? `Failed to report match ${matchId}`)
        return { ok: body.ok === true }
      },
      async get(matchId) {
        const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
        return match ?? null
      },
      getParticipants(matchId) {
        return db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      },
      getMessageIds(matchId) {
        return listMatchMessageIds(db as Database, matchId)
      },
    },
    activity: {
      launch(input) {
        return requestJsonAs(`/api/activity/launch/${input.channelId}/${input.userId}`, {
          method: 'GET',
        }, {
          userId: input.userId,
          displayName: input.userId,
        })
      },
      currentLobby(input) {
        return requestJsonAs(`/api/lobby/user/${input.userId}`, {
          method: 'GET',
        }, {
          userId: input.userId,
          displayName: input.userId,
        })
      },
      async targetLobby(input) {
        const response = await requestAs('/api/activity/target', {
          method: 'POST',
          body: JSON.stringify({
            channelId: input.channelId,
            userId: input.userId,
            kind: 'lobby',
            id: input.lobbyId,
          }),
        }, {
          userId: input.userId,
          displayName: input.userId,
        })
        if (!response.ok) {
          const body = await response.json() as { error?: string }
          throw new Error(body.error ?? `Failed to target lobby: ${response.status}`)
        }
      },
    },
    discord: {
      requests() {
        return [...discordRequests]
      },
      messages() {
        return [...discordMessages.values()]
      },
      message(messageId) {
        return discordMessages.get(messageId) ?? null
      },
      deleteMessage(messageId) {
        discordMessages.delete(messageId)
      },
      failNextPatch(messageId) {
        discordPatchFailures.add(messageId)
      },
      async currentLobbyMessage(lobbyId) {
        const lobby = await getLobbyById(kv, lobbyId)
        return lobby ? (discordMessages.get(lobby.messageId) ?? null) : null
      },
      async deleteCurrentLobbyMessage(lobbyId) {
        const lobby = await getLobbyById(kv, lobbyId)
        if (!lobby) return
        discordMessages.delete(lobby.messageId)
      },
    },
    corrupt: {
      activityLobbyUser(userId, lobbyId) {
        return putOrDeleteKv(kv, activityLobbyUserKey(userId), lobbyId)
      },
      activityUser(userId, matchId) {
        return putOrDeleteKv(kv, activityUserKey(userId), matchId)
      },
      lobbySnapshot(lobbyId, snapshot) {
        return putOrDeleteKv(kv, lobbySnapshotKey(lobbyId), snapshot)
      },
      lobbyHost(hostId, lobbyId) {
        return putOrDeleteKv(kv, hostKey(hostId), lobbyId)
      },
      lobbyMatch(matchId, lobbyId) {
        return putOrDeleteKv(kv, matchKey(matchId), lobbyId)
      },
      async openLobbyResidue(lobbyId, input) {
        const lobby = await getLobbyById(kv, lobbyId)
        if (!lobby) return null
        const withMembers = await setLobbyMemberPlayerIds(kv, lobbyId, input.memberPlayerIds, lobby)
        return setLobbySlots(kv, lobbyId, input.slots, withMembers ?? lobby)
      },
    },
    inspect: {
      lobbyMapping(userId) {
        return getLobbyForUser(kv, userId)
      },
      matchMapping(userId) {
        return getMatchForUser(kv, userId)
      },
      activityTarget(channelId, userId) {
        return getUserActivityTarget(kv, channelId, userId)
      },
      lobbiesForPlayer(userId) {
        return getCurrentLobbiesForPlayer(kv, userId)
      },
      lobbyByMatch(matchId) {
        return getLobbyByMatch(kv, matchId)
      },
    },
    flushBackgroundTasks: execution.flushBackgroundTasks,
    async dispose() {
      restoreFetchHandler()
      sqlite.close()
    },
  }
}

async function putOrDeleteKv(kv: KVNamespace, key: string, value: unknown | null): Promise<void> {
  if (value == null) {
    await kv.delete(key)
    return
  }

  await kv.put(
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}

function getPartyRoom(rooms: Map<string, PartyRoomRecord>, matchId: string): PartyRoomRecord {
  const room = rooms.get(matchId)
  if (!room) throw new Error(`No captured Party room for match ${matchId}`)
  return room
}

function buildCompletedPayload(config: RoomConfig, options: CompleteDraftOptions = {}): DraftCompleteWebhookPayload {
  const baseState = buildCompletedDraftState(config)
  const state = options.transformState ? options.transformState(baseState) : baseState

  return {
    outcome: 'complete',
    matchId: config.matchId,
    hostId: config.hostId,
    completedAt: Date.now(),
    finalized: options.finalized === true,
    state,
    mapVoteResult: null,
  }
}

function buildTimeoutPayload(config: RoomConfig): DraftCancelledWebhookPayload {
  return {
    outcome: 'cancelled',
    matchId: config.matchId,
    hostId: config.hostId,
    cancelledAt: Date.now(),
    reason: 'timeout',
    state: buildTimedOutDraftState(config),
    mapVoteResult: null,
  }
}

function buildCancelledPayload(config: RoomConfig, reason: 'cancel' | 'scrub' | 'revert'): DraftCancelledWebhookPayload {
  return {
    outcome: 'cancelled',
    matchId: config.matchId,
    hostId: config.hostId,
    cancelledAt: Date.now(),
    reason,
    state: buildCancelledDraftState(config, reason === 'cancel' ? 'cancel' : reason),
    mapVoteResult: null,
  }
}

function buildCompletedDraftState(config: RoomConfig) {
  const format = draftFormatMap.get(config.formatId)
  if (!format) throw new Error(`Unknown draft format: ${config.formatId}`)
  let state = createDraft(config.matchId, format, config.seats, config.civPool, {
    dealOptionsSize: config.dealOptionsSize,
    duplicateFactions: config.duplicateFactions,
  })
  state = applyDraftInput(state, { type: 'START' }, format.blindBans)

  while (state.status === 'active') {
    const step = getCurrentStep(state)
    if (!step) break
    const pendingSeats = getPendingSeats(state)
    if (step.action === 'ban') {
      const reserved = new Set<string>()
      for (const seatIndex of pendingSeats) {
        const picks = pickUniqueCivs(state.availableCivIds, step.count, reserved)
        state = applyDraftInput(state, { type: 'BAN', seatIndex, civIds: picks }, format.blindBans)
      }
      continue
    }

    state = assignTestDealOptions(state, config)
    for (const seatIndex of pendingSeats) {
      const civId = state.dealtCivIds?.[0] ?? state.availableCivIds[0]
      if (!civId) throw new Error(`No civ available for seat ${seatIndex} in match ${config.matchId}`)
      state = applyDraftInput(state, { type: 'PICK', seatIndex, civId }, format.blindBans)
    }
  }

  if (state.status !== 'complete') throw new Error(`Draft did not complete for match ${config.matchId}`)
  return state
}

function buildTimedOutDraftState(config: RoomConfig) {
  const format = draftFormatMap.get(config.formatId)
  if (!format) throw new Error(`Unknown draft format: ${config.formatId}`)
  let state = createDraft(config.matchId, format, config.seats, config.civPool, {
    dealOptionsSize: config.dealOptionsSize,
    duplicateFactions: config.duplicateFactions,
  })
  state = applyDraftInput(state, { type: 'START' }, format.blindBans)

  while (state.status === 'active') {
    const step = getCurrentStep(state)
    if (!step) break
    if (step.action === 'pick') {
      state = assignTestDealOptions(state, config)
      state = applyDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
      if (state.status === 'cancelled') break
      continue
    }

    const reserved = new Set<string>()
    for (const seatIndex of getPendingSeats(state)) {
      state = applyDraftInput(state, {
        type: 'BAN',
        seatIndex,
        civIds: pickUniqueCivs(state.availableCivIds, step.count, reserved),
      }, format.blindBans)
    }
  }

  if (state.status !== 'cancelled' || state.cancelReason !== 'timeout') {
    throw new Error(`Draft did not timeout for match ${config.matchId}`)
  }
  return state
}

function buildCancelledDraftState(config: RoomConfig, reason: 'cancel' | 'scrub' | 'revert') {
  const format = draftFormatMap.get(config.formatId)
  if (!format) throw new Error(`Unknown draft format: ${config.formatId}`)
  let state = createDraft(config.matchId, format, config.seats, config.civPool, {
    dealOptionsSize: config.dealOptionsSize,
    duplicateFactions: config.duplicateFactions,
  })
  state = applyDraftInput(state, { type: 'START' }, format.blindBans)
  state = applyDraftInput(state, { type: 'CANCEL', reason }, format.blindBans)
  if (state.status !== 'cancelled') throw new Error(`Draft did not cancel for match ${config.matchId}`)
  return state
}

function assignTestDealOptions(state: DraftState, config: RoomConfig): DraftState {
  if ((config.dealOptionsSize ?? 0) <= 0) return state
  if (state.status !== 'active') return state
  if (state.dealtCivIds?.length) return state

  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick') return state

  return {
    ...state,
    dealtCivIds: state.availableCivIds.slice(0, Math.min(config.dealOptionsSize ?? 0, state.availableCivIds.length)),
  }
}

function pickUniqueCivs(availableCivIds: string[], count: number, reserved: Set<string>): string[] {
  const picks: string[] = []

  for (const civId of availableCivIds) {
    if (reserved.has(civId)) continue
    reserved.add(civId)
    picks.push(civId)
    if (picks.length >= count) break
  }

  if (picks.length !== count) throw new Error(`Expected ${count} unique civs, got ${picks.length}`)
  return picks
}

function applyDraftInput(
  state: ReturnType<typeof createDraft>,
  input: Parameters<typeof processDraftInput>[1],
  blindBans: boolean,
) {
  const result = processDraftInput(state, input, blindBans)
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

async function handleDiscordRequest(
  request: Request,
  requests: DiscordRequestRecord[],
  messages: Map<string, DiscordMessageRecord>,
  patchFailures: Set<string>,
  createMessageId: () => string,
): Promise<Response> {
  const url = new URL(request.url)
  const bodyText = request.method === 'GET' || request.method === 'DELETE' ? null : await request.text()
  requests.push({ method: request.method, url: request.url, bodyText })

  const channelMatch = url.pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/)
  if (channelMatch) {
    const [, channelId, messageId] = channelMatch
    if (request.method === 'POST' && !messageId) {
      const id = createMessageId()
      messages.set(id, {
        id,
        channelId: channelId!,
        payload: bodyText ? JSON.parse(bodyText) : null,
      })
      return jsonResponse({ id })
    }

    if (request.method === 'PATCH' && messageId) {
      if (patchFailures.delete(messageId)) {
        messages.delete(messageId)
        return jsonResponse({ error: 'Unknown message' }, 404)
      }
      const existing = messages.get(messageId)
      if (!existing) return jsonResponse({ error: 'Unknown message' }, 404)
      messages.set(messageId, {
        ...existing,
        payload: bodyText ? JSON.parse(bodyText) : null,
      })
      return jsonResponse({ id: messageId })
    }

    if (request.method === 'DELETE' && messageId) {
      messages.delete(messageId)
      return new Response(null, { status: 204 })
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/v10/users/@me/channels') {
    return jsonResponse({ id: 'dm-channel-1' })
  }

  if (request.method === 'GET' && /\/api\/v10\/guilds\/[^/]+\/members\/[^/]+$/.test(url.pathname)) {
    return jsonResponse({ roles: [] })
  }

  if (request.method === 'GET' && /\/api\/v10\/guilds\/[^/]+\/roles$/.test(url.pathname)) {
    return jsonResponse([])
  }

  if ((request.method === 'PATCH' || request.method === 'PUT' || request.method === 'DELETE') && /\/api\/v10\/guilds\//.test(url.pathname)) {
    return new Response(null, { status: 204 })
  }

  return jsonResponse({ error: `Unhandled Discord request ${request.method} ${url.pathname}` }, 500)
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleStateStoreRequest(request: Request, kv: KVNamespace): Promise<Response> {
  const payload = await request.json() as {
    op?: string
    key?: string
    type?: 'json'
    value?: string
    expirationTtl?: number
    prefix?: string
    keys?: string[]
    entries?: Array<{ key: string, type?: 'json', value?: string, expirationTtl?: number }>
  }

  switch (payload.op) {
    case 'get':
      return jsonResponse({ value: await kv.get(payload.key!, payload.type) })
    case 'put':
      await kv.put(payload.key!, payload.value!, { expirationTtl: payload.expirationTtl } as any)
      return jsonResponse({ ok: true })
    case 'delete':
      await kv.delete(payload.key!)
      return jsonResponse({ ok: true })
    case 'list':
      return jsonResponse(await kv.list({ prefix: payload.prefix }))
    case 'mget':
      return jsonResponse({
        values: await Promise.all((payload.entries ?? []).map(entry => kv.get(entry.key, entry.type))),
      })
    case 'mput':
      await Promise.all((payload.entries ?? []).map(entry => kv.put(entry.key, entry.value ?? '', { expirationTtl: entry.expirationTtl } as any)))
      return jsonResponse({ ok: true })
    case 'mdelete':
      await Promise.all((payload.keys ?? []).map(key => kv.delete(key)))
      return jsonResponse({ ok: true })
    default:
      return jsonResponse({ error: `Unsupported state op: ${payload.op ?? 'unknown'}` }, 400)
  }
}
