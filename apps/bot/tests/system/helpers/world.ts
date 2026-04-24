import type { Database as CivupDatabase, Database } from '@civup/db'
import type { CompetitiveTier, DraftCancelledWebhookPayload, DraftCompleteWebhookPayload, DraftState, DraftWebhookPayload, GameMode, QueueEntry, RoomConfig } from '@civup/game'
import type { Env } from '../../../src/env.ts'
import type { ActivityTargetSelection, MatchActivityTargetSelection } from '../../../src/services/activity/index.ts'
import type { LobbyState } from '../../../src/services/lobby/index.ts'
import { matchBans, matchParticipants, matches } from '@civup/db'
import { allLeaderIds, createDraft, draftFormatMap, getCurrentStep, getPendingSeats, isDraftError, processDraftInput } from '@civup/game'
import { CIVUP_INTERNAL_SECRET_HEADER, createSignedWebhookHeaders } from '@civup/utils'
import { and, eq } from 'drizzle-orm'
import { activityLobbyUserKey, activityMatchKey, activityUserKey, getLobbyForUser, getMatchForUser, getUserActivityTarget } from '../../../src/services/activity/index.ts'
import { addToQueue, getQueueState, setQueueEntries } from '../../../src/services/queue/index.ts'
import { createLobby, getCurrentLobbiesForPlayer, getCurrentLobbyHostedBy, getLobby, getLobbyById, getLobbyByMatch, setLobbyMemberPlayerIds, setLobbySlots } from '../../../src/services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../../src/services/lobby/live-snapshot.ts'
import { lobbySnapshotKey } from '../../../src/services/lobby/live-snapshot.ts'
import { channelIndexKey, hostKey } from '../../../src/services/lobby/keys.ts'
import { listMatchMessageIds } from '../../../src/services/match/message.ts'
import { createStateStore } from '../../../src/services/state/store.ts'
import { setSystemChannel } from '../../../src/services/system/channels.ts'
import { SessionDO } from '../../../src/session-runtime/session-do.ts'
import { buildBotTestEnv, createBotTestApp, createExecutionContextHarness } from '../../helpers/app-harness.ts'
import { createSqliteD1Database } from '../../helpers/d1.ts'
import { installFetchHandler } from '../../helpers/fetch-router.ts'
import { createTestDatabase } from '../../helpers/test-env.ts'
import { createTrackedKv } from '../../helpers/tracked-kv.ts'
import { createRuntimeControls } from './runtime-controls.ts'

const BOT_HOST = 'https://bot.test'
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

interface DiscordGuildRoleRecord {
  id: string
  name: string
  color?: number
}

interface PartyRoomRecord {
  config: RoomConfig
  completionPayloads: DraftCompleteWebhookPayload[]
  cancellationPayloads: DraftCancelledWebhookPayload[]
  nextWebhookEventSequence: number
}

function createCapturedPartyRoomRecord(config: RoomConfig, previous?: PartyRoomRecord): PartyRoomRecord {
  return {
    config,
    completionPayloads: previous?.completionPayloads ?? [],
    cancellationPayloads: previous?.cancellationPayloads ?? [],
    nextWebhookEventSequence: previous?.nextWebhookEventSequence ?? 0,
  }
}

function createCapturedMainNamespace(partyRooms: Map<string, PartyRoomRecord>): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const roomName = String(id)
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url)
          if (url.pathname === '/cdn-cgi/partyserver/set-name/') return Response.json({ ok: true })
          if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

          const body = await request.json() as RoomConfig
          partyRooms.set(body.matchId, createCapturedPartyRoomRecord(body, partyRooms.get(body.matchId)))
          if (body.matchId !== roomName) return new Response('Room name mismatch', { status: 409 })

          return Response.json({ ok: true }, { status: 201 })
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function createCapturedStateNamespace(requestHandler: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get() {
      return {
        fetch(request: Request) {
          return requestHandler(request)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function createCapturedSessionNamespace(db: D1Database): DurableObjectNamespace {
  const rooms = new Map<string, SessionDO>()
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const sessionId = String(id)
      let room = rooms.get(sessionId)
      if (!room) {
        room = new SessionDO(createFakeDurableObjectState(), { DB: db } as any)
        rooms.set(sessionId, room)
      }
      const sessionRoom = room

      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          return sessionRoom.fetch(request)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function createFakeDurableObjectState(): DurableObjectState {
  const storage = new Map<string, unknown>()
  return {
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
      },
    },
  } as unknown as DurableObjectState
}

interface CompleteDraftOptions {
  finalized?: boolean
  transformState?: (state: DraftState) => DraftState
  mapVoteResult?: DraftCompleteWebhookPayload['mapVoteResult']
}

interface WebhookDeliveryOptions {
  sign?: boolean
  secret?: string
  rawBody?: string
}

interface WorldPlayerInput {
  id: string
  displayName?: string
  avatarUrl?: string | null
  partyIds?: string[]
  joinedAt?: number
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
    createOpen: (input: { mode: Parameters<typeof getQueueState>[1], players: WorldPlayerInput[], hostId?: string, channelId?: string, guildId?: string | null, memberPlayerIds?: string[], slots?: (string | null)[] }) => Promise<LobbyState>
    get: (mode: Parameters<typeof getLobby>[1]) => Promise<LobbyState | null>
    getById: (lobbyId: string) => Promise<LobbyState | null>
    config: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string, banTimerSeconds?: number | null, pickTimerSeconds?: number | null, leaderPoolSize?: number | null, leaderDataVersion?: 'live' | 'beta' | null, mapVoteEnabled?: boolean, blindBans?: boolean, simultaneousPick?: boolean, redDeath?: boolean, dealOptionsSize?: number | null, randomDraft?: boolean, duplicateFactions?: boolean, minRole?: CompetitiveTier | null, maxRole?: CompetitiveTier | null, steamLobbyLink?: string | null, targetSize?: number | null }) => Promise<RouteResult>
    changeMode: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string, nextMode: GameMode }) => Promise<RouteResult>
    arrange: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string, strategy: 'randomize' | 'balance' | 'shuffle-teams' }) => Promise<RouteResult>
    cancel: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string }) => Promise<RouteResult>
    start: (mode: Parameters<typeof getQueueState>[1], input: { hostId: string, lobbyId?: string }) => Promise<{ ok: boolean, matchId: string, roomAccessToken: string | null, idempotent?: boolean }>
    place: (mode: Parameters<typeof getQueueState>[1], input: { userId: string, targetSlot: number, lobbyId?: string, playerId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, transferNotice?: string | null, error?: string }>>
    remove: (mode: Parameters<typeof getQueueState>[1], input: { userId: string, slot: number, lobbyId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, error?: string }>>
  }
  party: {
    rooms: () => PartyRoomRecord[]
    draftComplete: (matchId: string, options?: CompleteDraftOptions) => DraftCompleteWebhookPayload
    draftTimeout: (matchId: string) => DraftCancelledWebhookPayload
    draftCancel: (matchId: string, options?: { reason?: 'cancel' | 'scrub' | 'revert' }) => DraftCancelledWebhookPayload
    completeDraft: (matchId: string, options?: CompleteDraftOptions) => Promise<Response>
    timeoutDraft: (matchId: string) => Promise<Response>
    cancelDraft: (matchId: string, options?: { reason?: 'cancel' | 'scrub' | 'revert' }) => Promise<Response>
    replayDraftComplete: (matchId: string, options?: { index?: number } & WebhookDeliveryOptions) => Promise<Response>
    replayDraftCancel: (matchId: string, options?: { index?: number } & WebhookDeliveryOptions) => Promise<Response>
  }
  match: {
    report: (matchId: string, input: { reporterId: string, placements: string }) => Promise<{ ok: boolean }>
    get: (matchId: string) => Promise<(typeof matches.$inferSelect) | null>
    getParticipants: (matchId: string) => Promise<(typeof matchParticipants.$inferSelect)[]>
    getBans: (matchId: string) => Promise<(typeof matchBans.$inferSelect)[]>
    getMessageIds: (matchId: string) => Promise<string[]>
  }
  activity: {
    launch: (input: { channelId: string, userId: string }) => Promise<RouteResult>
    currentLobby: (input: { userId: string }) => Promise<RouteResult>
    currentMatch: (input: { userId: string }) => Promise<RouteResult>
    targetLobby: (input: { channelId: string, userId: string, lobbyId: string }) => Promise<void>
  }
  discord: {
    requests: () => DiscordRequestRecord[]
    messages: () => DiscordMessageRecord[]
    message: (messageId: string) => DiscordMessageRecord | null
    deleteMessage: (messageId: string) => void
    failNextPatch: (messageId: string) => void
    failNextPost: (channelId: string, status?: number) => void
    failNextGuildMemberLookup: (guildId: string, userId: string, status?: number) => void
    failNextGuildRolesLookup: (guildId: string, status?: number) => void
    setGuildMemberRoles: (guildId: string, userId: string, roleIds: string[]) => void
    setGuildRoles: (guildId: string, roles: DiscordGuildRoleRecord[]) => void
    currentLobbyMessage: (lobbyId: string) => Promise<DiscordMessageRecord | null>
    deleteCurrentLobbyMessage: (lobbyId: string) => Promise<void>
  }
  corrupt: {
    activityLobbyUser: (userId: string, lobbyId: string | null) => Promise<void>
    activityUser: (userId: string, matchId: string | null) => Promise<void>
    activityMatch: (matchId: string, channelId: string | null) => Promise<void>
    lobbySnapshot: (lobbyId: string, snapshot: unknown | null) => Promise<void>
    lobbyHost: (hostId: string, lobbyId: string | null) => Promise<void>
    lobbyChannel: (lobbyId: string, indexedChannelId: string | null) => Promise<void>
    openLobbyResidue: (lobbyId: string, input: { memberPlayerIds: string[], slots: (string | null)[] }) => Promise<LobbyState | null>
    queueEntries: (mode: Parameters<typeof getQueueState>[1], entries: QueueEntry[]) => Promise<void>
  }
  inspect: {
    lobbyMapping: (userId: string) => Promise<string | null>
    currentHostedLobby: (hostId: string) => Promise<LobbyState | null>
    matchMapping: (userId: string) => Promise<string | null>
    matchChannel: (matchId: string) => Promise<string | null>
    activityTarget: (channelId: string, userId: string) => Promise<ActivityTargetSelection | MatchActivityTargetSelection | null>
    lobbiesForPlayer: (userId: string) => Promise<LobbyState[]>
    lobbyByMatch: (matchId: string) => Promise<LobbyState | null>
    lobbySnapshot: (lobbyId: string) => Promise<unknown | null>
  }
  runtime: {
    clock: {
      freeze: (now: number) => number
      advance: (ms: number) => number
      now: () => number
      reset: () => void
    }
    random: {
      seed: (value: number | string) => void
      next: () => number
      reset: () => void
    }
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
  const discordPostFailures = new Map<string, number>()
  const discordGuildMemberFailures = new Map<string, number>()
  const discordGuildRolesFailures = new Map<string, number>()
  const discordGuildMemberRoles = new Map<string, string[]>()
  const discordGuildRoles = new Map<string, DiscordGuildRoleRecord[]>()
  const partyRooms = new Map<string, PartyRoomRecord>()
  const runtime = createRuntimeControls()
  let stateStoreRequestQueue = Promise.resolve()
  let nextDiscordMessageId = 1
  const enqueueStateStoreRequest = (request: Request) => {
    const response = stateStoreRequestQueue.then(() => handleStateStoreRequest(request, kv))
    stateStoreRequestQueue = response.then(() => undefined, () => undefined)
    return response
  }

  const d1 = createSqliteD1Database(sqlite)
  const env = buildBotTestEnv({
    DB: d1,
    KV: kv,
    Main: createCapturedMainNamespace(partyRooms),
    State: createCapturedStateNamespace(enqueueStateStoreRequest),
    SessionDO: createCapturedSessionNamespace(d1),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'public-key',
    DISCORD_TOKEN: 'token',
    BOT_HOST,
    CIVUP_SECRET,
  })

  await setSystemChannel(createStateStore(env), 'draft', DEFAULT_CHANNEL_ID)
  await setSystemChannel(createStateStore(env), 'archive', DEFAULT_ARCHIVE_CHANNEL_ID)

  const restoreFetchHandler = installFetchHandler(async (request) => {
    const url = new URL(request.url)

    if (url.origin === BOT_HOST && request.method === 'POST' && /^\/parties\/main\/[^/]+$/.test(url.pathname)) {
      const body = await request.json() as RoomConfig
      partyRooms.set(body.matchId, createCapturedPartyRoomRecord(body, partyRooms.get(body.matchId)))
      return jsonResponse({ ok: true })
    }

    if (url.origin === BOT_HOST) {
      return app.fetch(request, env, execution.executionCtx)
    }

    if (url.origin === 'https://discord.com' && url.pathname.startsWith('/api/v10/')) {
      return handleDiscordRequest(
        request,
        discordRequests,
        discordMessages,
        discordPatchFailures,
        discordPostFailures,
        discordGuildMemberFailures,
        discordGuildRolesFailures,
        discordGuildMemberRoles,
        discordGuildRoles,
        () => `discord-message-${nextDiscordMessageId++}`,
      )
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

  const sendWebhook = async (room: PartyRoomRecord, payload: DraftWebhookPayload, options: WebhookDeliveryOptions = {}): Promise<Response> => {
    if (!room.config.webhookUrl) throw new Error(`Captured Party room ${room.config.matchId} has no webhookUrl configured`)

    const body = options.rawBody ?? JSON.stringify(payload)
    const signingSecret = options.secret ?? room.config.webhookSecret
    const headers = new Headers()
    if (options.sign !== false && signingSecret) {
      const signedHeaders = await createSignedWebhookHeaders(signingSecret, body)
      for (const [key, value] of Object.entries(signedHeaders)) {
        headers.set(key, value)
      }
    }
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
          joinedAt: player.joinedAt ?? index + 1,
          partyIds: player.partyIds,
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
          db,
          sessionNamespace: env.SessionDO,
        })
        discordMessages.set(lobby.messageId, {
          id: lobby.messageId,
          channelId,
          payload: null,
        })

        const memberPlayerIds = input.memberPlayerIds ?? entries.map(entry => entry.playerId)
        const slots = input.slots ? [...input.slots] : [...lobby.slots]
        if (!input.slots) {
          for (let index = 0; index < memberPlayerIds.length; index++) {
            slots[index] = memberPlayerIds[index] ?? null
          }
        }

        const sessionOptions = { db, sessionNamespace: env.SessionDO, queueEntries: entries }
        const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, memberPlayerIds, lobby, sessionOptions) ?? lobby
        const withSlots = await setLobbySlots(kv, lobby.id, slots, withMembers, sessionOptions) ?? { ...withMembers, slots }
        await syncLobbyDerivedState(kv, withSlots, { queueEntries: entries, slots })
        return withSlots
      },
      get(mode) {
        return getLobby(kv, mode)
      },
      getById(lobbyId) {
        return getLobbyById(kv, lobbyId)
      },
      config(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/config`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.hostId,
            lobbyId: input.lobbyId,
            banTimerSeconds: input.banTimerSeconds,
            pickTimerSeconds: input.pickTimerSeconds,
            leaderPoolSize: input.leaderPoolSize,
            leaderDataVersion: input.leaderDataVersion,
            mapVoteEnabled: input.mapVoteEnabled,
            blindBans: input.blindBans,
            simultaneousPick: input.simultaneousPick,
            redDeath: input.redDeath,
            dealOptionsSize: input.dealOptionsSize,
            randomDraft: input.randomDraft,
            duplicateFactions: input.duplicateFactions,
            minRole: input.minRole,
            maxRole: input.maxRole,
            steamLobbyLink: input.steamLobbyLink,
            targetSize: input.targetSize,
          }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
      },
      changeMode(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/mode`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.hostId,
            lobbyId: input.lobbyId,
            nextMode: input.nextMode,
          }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
      },
      arrange(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/arrange`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.hostId,
            lobbyId: input.lobbyId,
            strategy: input.strategy,
          }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
      },
      cancel(mode, input) {
        return requestJsonAs(`/api/lobby/${mode}/cancel`, {
          method: 'POST',
          body: JSON.stringify({
            userId: input.hostId,
            lobbyId: input.lobbyId,
          }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
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
      draftComplete(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildCompletedPayload(room, options)
        room.completionPayloads.push(payload)
        return payload
      },
      draftTimeout(matchId) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildTimeoutPayload(room)
        room.cancellationPayloads.push(payload)
        return payload
      },
      draftCancel(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = buildCancelledPayload(room, options.reason ?? 'scrub')
        room.cancellationPayloads.push(payload)
        return payload
      },
      async completeDraft(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = this.draftComplete(matchId, options)
        return sendWebhook(room, payload)
      },
      async timeoutDraft(matchId) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = this.draftTimeout(matchId)
        return sendWebhook(room, payload)
      },
      async cancelDraft(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = this.draftCancel(matchId, options)
        return sendWebhook(room, payload)
      },
      async replayDraftComplete(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = room.completionPayloads[options.index ?? room.completionPayloads.length - 1]
        if (!payload) throw new Error(`No completion payload recorded for match ${matchId}`)
        return sendWebhook(room, payload, options)
      },
      async replayDraftCancel(matchId, options = {}) {
        const room = getPartyRoom(partyRooms, matchId)
        const payload = room.cancellationPayloads[options.index ?? room.cancellationPayloads.length - 1]
        if (!payload) throw new Error(`No cancellation payload recorded for match ${matchId}`)
        return sendWebhook(room, payload, options)
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
      getBans(matchId) {
        return db.select().from(matchBans).where(eq(matchBans.matchId, matchId))
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
      currentMatch(input) {
        return requestJsonAs(`/api/match/user/${input.userId}`, {
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
      failNextPost(channelId, status = 400) {
        discordPostFailures.set(channelId, status)
      },
      failNextGuildMemberLookup(guildId, userId, status = 500) {
        discordGuildMemberFailures.set(`${guildId}:${userId}`, status)
      },
      failNextGuildRolesLookup(guildId, status = 500) {
        discordGuildRolesFailures.set(guildId, status)
      },
      setGuildMemberRoles(guildId, userId, roleIds) {
        discordGuildMemberRoles.set(`${guildId}:${userId}`, [...roleIds])
      },
      setGuildRoles(guildId, roles) {
        discordGuildRoles.set(guildId, roles.map(role => ({ ...role })))
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
      activityMatch(matchId, channelId) {
        return putOrDeleteKv(kv, activityMatchKey(matchId), channelId)
      },
      lobbySnapshot(lobbyId, snapshot) {
        return putOrDeleteKv(kv, lobbySnapshotKey(lobbyId), snapshot)
      },
      lobbyHost(hostId, lobbyId) {
        return putOrDeleteKv(kv, hostKey(hostId), lobbyId)
      },
      async lobbyChannel(lobbyId, indexedChannelId) {
        const lobby = await getLobbyById(kv, lobbyId)
        if (!lobby) return

        await kv.delete(channelIndexKey(lobby.channelId, lobbyId))
        if (indexedChannelId) {
          await kv.put(channelIndexKey(indexedChannelId, lobbyId), String(lobby.revision))
        }
      },
      async openLobbyResidue(lobbyId, input) {
        const lobby = await getLobbyById(kv, lobbyId)
        if (!lobby) return null
        const withMembers = await setLobbyMemberPlayerIds(kv, lobbyId, input.memberPlayerIds, lobby)
        return setLobbySlots(kv, lobbyId, input.slots, withMembers ?? lobby)
      },
      queueEntries(mode, entries) {
        return setQueueEntries(kv, mode, entries)
      },
    },
    inspect: {
      lobbyMapping(userId) {
        return getLobbyForUser(kv, userId)
      },
      currentHostedLobby(hostId) {
        return getCurrentLobbyHostedBy(kv, hostId)
      },
      matchMapping(userId) {
        return getMatchForUser(kv, userId)
      },
      matchChannel(matchId) {
        return kv.get(activityMatchKey(matchId))
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
      lobbySnapshot(lobbyId) {
        return kv.get(lobbySnapshotKey(lobbyId), 'json')
      },
    },
    runtime: {
      clock: runtime.clock,
      random: runtime.random,
    },
    flushBackgroundTasks: execution.flushBackgroundTasks,
    async dispose() {
      runtime.restore()
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

function buildCompletedPayload(room: PartyRoomRecord, options: CompleteDraftOptions = {}): DraftCompleteWebhookPayload {
  const { config } = room
  const baseState = buildCompletedDraftState(config)
  const state = options.transformState ? options.transformState(baseState) : baseState
  const eventSequence = nextTestWebhookSequence(room)
  const eventKind = options.finalized === true
    ? 'DraftFinalized'
    : options.transformState
      ? 'SwapAccepted'
      : 'DraftCompleted'

  return {
    eventId: `${config.matchId}:test:${eventSequence}`,
    eventKind,
    eventSequence,
    outcome: 'complete',
    matchId: config.matchId,
    hostId: config.hostId,
    completedAt: Date.now(),
    finalized: options.finalized === true,
    state,
    mapVoteResult: options.mapVoteResult ?? null,
  }
}

function buildTimeoutPayload(room: PartyRoomRecord): DraftCancelledWebhookPayload {
  const { config } = room
  const eventSequence = nextTestWebhookSequence(room)
  return {
    eventId: `${config.matchId}:test:${eventSequence}`,
    eventKind: 'DraftCancelled',
    eventSequence,
    outcome: 'cancelled',
    matchId: config.matchId,
    hostId: config.hostId,
    cancelledAt: Date.now(),
    reason: 'timeout',
    state: buildTimedOutDraftState(config),
    mapVoteResult: null,
  }
}

function buildCancelledPayload(room: PartyRoomRecord, reason: 'cancel' | 'scrub' | 'revert'): DraftCancelledWebhookPayload {
  const { config } = room
  const eventSequence = nextTestWebhookSequence(room)
  return {
    eventId: `${config.matchId}:test:${eventSequence}`,
    eventKind: 'DraftCancelled',
    eventSequence,
    outcome: 'cancelled',
    matchId: config.matchId,
    hostId: config.hostId,
    cancelledAt: Date.now(),
    reason,
    state: buildCancelledDraftState(config, reason === 'cancel' ? 'cancel' : reason),
    mapVoteResult: null,
  }
}

function nextTestWebhookSequence(room: PartyRoomRecord): number {
  room.nextWebhookEventSequence += 1
  return room.nextWebhookEventSequence
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
    const reserved = new Set<string>()
    for (const seatIndex of pendingSeats) {
      const civId = pickDraftCiv(state.dealtCivIds?.length ? state.dealtCivIds : state.availableCivIds, reserved, config.duplicateFactions === true)
      if (!civId) throw new Error(`No civ available for seat ${seatIndex} in match ${config.matchId}`)
      state = applyDraftInput(state, { type: 'PICK', seatIndex, civId }, format.blindBans)
      if (config.duplicateFactions !== true) reserved.add(civId)
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

function pickDraftCiv(availableCivIds: string[], reserved: Set<string>, allowDuplicate: boolean): string | null {
  for (const civId of availableCivIds) {
    if (!allowDuplicate && reserved.has(civId)) continue
    return civId
  }

  return null
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
  postFailures: Map<string, number>,
  guildMemberFailures: Map<string, number>,
  guildRolesFailures: Map<string, number>,
  guildMemberRoles: Map<string, string[]>,
  guildRoles: Map<string, DiscordGuildRoleRecord[]>,
  createMessageId: () => string,
): Promise<Response> {
  const url = new URL(request.url)
  const bodyText = request.method === 'GET' || request.method === 'DELETE' ? null : await request.text()
  requests.push({ method: request.method, url: request.url, bodyText })

  const channelMatch = url.pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/)
  if (channelMatch) {
    const [, channelId, messageId] = channelMatch
    if (request.method === 'POST' && !messageId) {
      const failureStatus = postFailures.get(channelId!)
      if (failureStatus != null) {
        postFailures.delete(channelId!)
        return jsonResponse({ error: 'Injected message create failure' }, failureStatus)
      }
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

  const guildMemberMatch = url.pathname.match(/^\/api\/v10\/guilds\/([^/]+)\/members\/([^/]+)$/)
  if (request.method === 'GET' && guildMemberMatch) {
    const [, guildId, userId] = guildMemberMatch
    const failureKey = `${guildId}:${userId}`
    const failureStatus = guildMemberFailures.get(failureKey)
    if (failureStatus != null) {
      guildMemberFailures.delete(failureKey)
      return jsonResponse({ error: 'Injected guild member lookup failure' }, failureStatus)
    }

    return jsonResponse({
      roles: guildMemberRoles.get(failureKey) ?? [],
    })
  }

  const guildRolesMatch = url.pathname.match(/^\/api\/v10\/guilds\/([^/]+)\/roles$/)
  if (request.method === 'GET' && guildRolesMatch) {
    const [, guildId] = guildRolesMatch
    const failureStatus = guildRolesFailures.get(guildId)
    if (failureStatus != null) {
      guildRolesFailures.delete(guildId)
      return jsonResponse({ error: 'Injected guild role lookup failure' }, failureStatus)
    }

    return jsonResponse(guildRoles.get(guildId) ?? [])
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
    case 'putIfAbsent': {
      const existing = await kv.get(payload.key!)
      if (existing != null) return jsonResponse({ inserted: false })
      await kv.put(payload.key!, payload.value!, { expirationTtl: payload.expirationTtl } as any)
      return jsonResponse({ inserted: true })
    }
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
