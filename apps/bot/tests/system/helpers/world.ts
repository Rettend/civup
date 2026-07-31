import type { Database as CivupDatabase, Database } from '@civup/db'
import type { CompetitiveTier, DraftState, GameMode, QueueEntry } from '@civup/game'
import type { DraftRuntimeConfig } from '@civup/session'
import type { Env } from '../../../src/env.ts'
import type { LobbyState } from '../../../src/services/lobby/index.ts'
import type { DraftLifecycleCancelledPayload, DraftLifecycleCompletePayload, DraftLifecyclePayload } from '../../../src/session-runtime/draft-lifecycle-events.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { createDraft, draftFormatMap, getCurrentStep, getPendingSeats, isDraftError, processDraftInput } from '@civup/game'
import { CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
import { eq } from 'drizzle-orm'
import { buildDraftRuntimeConfig, getLobbyForUser, getMatchForUser } from '../../../src/services/activity/index.ts'
import { channelIndexKey, hostKey } from '../../../src/services/lobby/keys.ts'
import { syncLobbyDerivedState } from '../../../src/services/lobby/live-snapshot.ts'
import { handleDraftLifecyclePayload } from '../../../src/services/match/draft-lifecycle.ts'
import { listMatchMessageIds } from '../../../src/services/match/message.ts'
import { getCurrentSessionLobbyProjectionsForPlayer, getOpenSessionLobbyProjectionHostedBy, getSessionLobbyProjectionByMatch } from '../../../src/services/session/index.ts'
import { setSystemChannel } from '../../../src/services/system/channels.ts'
import { buildBotTestEnv, createBotTestApp, createExecutionContextHarness } from '../../helpers/app-harness.ts'
import { createSqliteD1Database } from '../../helpers/d1.ts'
import { installFetchHandler } from '../../helpers/fetch-router.ts'
import { createLobby, getLobby, getLobbyById, setLobbyMemberPlayerIds, setLobbySlots } from '../../helpers/lobby-runtime.ts'
import { createTestSessionNamespace } from '../../helpers/session-runtime.ts'
import { createTestDatabase } from '../../helpers/test-env.ts'
import { createTrackedKv } from '../../helpers/tracked-kv.ts'
import { createRuntimeControls } from './runtime-controls.ts'

const BOT_ORIGIN = 'https://bot.test'
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

interface CapturedDraftRuntimeRecord {
  config: DraftRuntimeConfig
  completionPayloads: DraftLifecycleCompletePayload[]
  cancellationPayloads: DraftLifecycleCancelledPayload[]
  nextLifecycleEventSequence: number
}

function createCapturedDraftRuntimeRecord(config: DraftRuntimeConfig, previous?: CapturedDraftRuntimeRecord): CapturedDraftRuntimeRecord {
  return {
    config,
    completionPayloads: previous?.completionPayloads ?? [],
    cancellationPayloads: previous?.cancellationPayloads ?? [],
    nextLifecycleEventSequence: previous?.nextLifecycleEventSequence ?? 0,
  }
}

interface CompleteDraftOptions {
  finalized?: boolean
  transformState?: (state: DraftState) => DraftState
  mapVoteResult?: DraftLifecycleCompletePayload['mapVoteResult']
}

interface CancelDraftOptions {
  reason?: 'cancel' | 'scrub' | 'revert'
  state?: DraftState
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
    createOpen: (input: { mode: GameMode, players: WorldPlayerInput[], hostId?: string, channelId?: string, guildId?: string | null, memberPlayerIds?: string[], slots?: (string | null)[] }) => Promise<LobbyState>
    get: (mode: Parameters<typeof getLobby>[1]) => Promise<LobbyState | null>
    getById: (lobbyId: string) => Promise<LobbyState | null>
    config: (mode: GameMode, input: { hostId: string, lobbyId?: string, banTimerSeconds?: number | null, pickTimerSeconds?: number | null, leaderPoolSize?: number | null, leaderDataVersion?: 'live' | 'beta' | null, mapVoteEnabled?: boolean, blindBans?: boolean, simultaneousPick?: boolean, permanentAlly?: boolean, redDeath?: boolean, dealOptionsSize?: number | null, randomDraft?: boolean, duplicateFactions?: boolean, minRole?: CompetitiveTier | null, maxRole?: CompetitiveTier | null, steamLobbyLink?: string | null, targetSize?: number | null }) => Promise<RouteResult>
    changeMode: (mode: GameMode, input: { hostId: string, lobbyId?: string, nextMode: GameMode }) => Promise<RouteResult>
    arrange: (mode: GameMode, input: { hostId: string, lobbyId?: string, strategy: 'randomize' | 'balance' | 'shuffle-teams' }) => Promise<RouteResult>
    cancel: (mode: GameMode, input: { hostId: string, lobbyId?: string }) => Promise<RouteResult>
    start: (mode: GameMode, input: { hostId: string, lobbyId?: string }) => Promise<{ ok: boolean, matchId: string, sessionAccessToken: string | null, idempotent?: boolean }>
    repeat: (mode: GameMode, input: { hostId: string, lobbyId?: string }) => Promise<{ ok: boolean, kind: 'resume' | 'complete', matchId: string, sessionAccessToken: string | null, error?: string }>
    place: (mode: GameMode, input: { userId: string, targetSlot: number, lobbyId?: string, playerId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, transferNotice?: string | null, error?: string }>>
    remove: (mode: GameMode, input: { userId: string, slot: number, lobbyId?: string, displayName?: string, avatarUrl?: string | null }) => Promise<RouteResult<{ lobby?: unknown, error?: string }>>
  }
  party: {
    rooms: () => CapturedDraftRuntimeRecord[]
    draftComplete: (matchId: string, options?: CompleteDraftOptions) => DraftLifecycleCompletePayload
    draftTimeout: (matchId: string) => DraftLifecycleCancelledPayload
    draftCancel: (matchId: string, options?: CancelDraftOptions) => DraftLifecycleCancelledPayload
    completeDraft: (matchId: string, options?: CompleteDraftOptions) => Promise<Response>
    timeoutDraft: (matchId: string) => Promise<Response>
    cancelDraft: (matchId: string, options?: CancelDraftOptions) => Promise<Response>
    replayDraftComplete: (matchId: string, options?: { index?: number }) => Promise<Response>
    replayDraftCancel: (matchId: string, options?: { index?: number }) => Promise<Response>
  }
  match: {
    report: (matchId: string, input: { reporterId: string, placements: string }) => Promise<{ ok: boolean }>
    scrub: (matchId: string, input: { userId: string, displayName?: string | null, avatarUrl?: string | null }) => Promise<RouteResult<{ ok?: boolean, error?: string }>>
    get: (matchId: string) => Promise<(typeof matches.$inferSelect) | null>
    getParticipants: (matchId: string) => Promise<(typeof matchParticipants.$inferSelect)[]>
    getBans: (matchId: string) => Promise<(typeof matchBans.$inferSelect)[]>
    getMessageIds: (matchId: string) => Promise<string[]>
  }
  activity: {
    launch: (input: { channelId: string, userId: string }) => Promise<RouteResult>
    currentLobby: (input: { userId: string }) => Promise<RouteResult>
    currentMatch: (input: { userId: string }) => Promise<RouteResult>
    targetLobby: (input: { channelId: string, userId: string, lobbyId: string }) => Promise<RouteResult>
    targetMatch: (input: { channelId: string, userId: string, matchId: string }) => Promise<RouteResult>
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
    lobbyHost: (hostId: string, lobbyId: string | null) => Promise<void>
    lobbyChannel: (lobbyId: string, indexedChannelId: string | null) => Promise<void>
    openLobbyResidue: (lobbyId: string, input: { memberPlayerIds: string[], slots: (string | null)[] }) => Promise<LobbyState | null>
  }
  inspect: {
    lobbyMapping: (userId: string) => Promise<string | null>
    currentHostedLobby: (hostId: string) => Promise<LobbyState | null>
    matchMapping: (userId: string) => Promise<string | null>
    lobbiesForPlayer: (userId: string) => Promise<LobbyState[]>
    lobbyByMatch: (matchId: string) => Promise<LobbyState | null>
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
  const draftRuntimeRecords = new Map<string, CapturedDraftRuntimeRecord>()
  const runtime = createRuntimeControls()
  let nextDiscordMessageId = 1

  const d1 = createSqliteD1Database(sqlite)
  const env = buildBotTestEnv({
    DB: d1,
    KV: kv,
    SessionDO: createTestSessionNamespace({ DB: d1, KV: kv, DISCORD_TOKEN: 'token', CIVUP_SECRET }),
    Activity: createTestActivityNamespace(),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'public-key',
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET,
  })

  await setSystemChannel(kv, 'draft', DEFAULT_CHANNEL_ID)
  await setSystemChannel(kv, 'archive', DEFAULT_ARCHIVE_CHANNEL_ID)

  const restoreFetchHandler = installFetchHandler(async (request) => {
    const url = new URL(request.url)

    if (url.origin === BOT_ORIGIN && request.method === 'POST' && /^\/parties\/main\/[^/]+$/.test(url.pathname)) {
      const body = await request.json() as DraftRuntimeConfig
      draftRuntimeRecords.set(body.matchId, createCapturedDraftRuntimeRecord(body, draftRuntimeRecords.get(body.matchId)))
      return jsonResponse({ ok: true })
    }

    if (url.origin === BOT_ORIGIN) {
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
    return app.fetch(new Request(`${BOT_ORIGIN}${path}`, { ...init, headers }), env, execution.executionCtx)
  }

  const deliverDraftLifecycle = async (_room: CapturedDraftRuntimeRecord, payload: DraftLifecyclePayload): Promise<Response> => {
    const result = await handleDraftLifecyclePayload(env, payload)
    if (!result.ok) return jsonResponse({ error: result.error }, result.status)
    return jsonResponse({ ok: true, ignored: result.ignored, synced: result.synced })
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
      async getById(lobbyId) {
        const lobby = await getLobbyById(kv, lobbyId)
        return isLiveLobbyProjection(lobby) ? lobby : null
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
            permanentAlly: input.permanentAlly,
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
        const lobbyBeforeStart = input.lobbyId ? await getLobbyById(kv, input.lobbyId) : await getLobby(kv, mode)
        const response = await requestAs(`/api/lobby/${mode}/start`, {
          method: 'POST',
          body: JSON.stringify({ userId: input.hostId, lobbyId: input.lobbyId }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
        const body = await response.json() as { ok: boolean, matchId: string, sessionAccessToken: string | null, idempotent?: boolean, error?: string }
        if (!response.ok) throw new Error(body.error ?? `Failed to start lobby: ${response.status}`)
        if (!body.idempotent && lobbyBeforeStart) {
          const lobbyAfterStart = await getLobbyById(kv, lobbyBeforeStart.id) ?? lobbyBeforeStart
          const runtime = buildDraftRuntimeConfig(lobbyAfterStart.mode, buildTestDraftEntries(lobbyAfterStart), {
            matchId: body.matchId,
            hostId: lobbyAfterStart.hostId,
            leaderDataVersion: lobbyAfterStart.draftConfig.leaderDataVersion,
            blindBans: lobbyAfterStart.draftConfig.blindBans,
            simultaneousPick: lobbyAfterStart.draftConfig.simultaneousPick,
            permanentAlly: lobbyAfterStart.draftConfig.permanentAlly,
            redDeath: lobbyAfterStart.draftConfig.redDeath,
            mapVoteEnabled: lobbyAfterStart.draftConfig.mapVoteEnabled,
            randomDraft: lobbyAfterStart.draftConfig.randomDraft,
            duplicateFactions: lobbyAfterStart.draftConfig.duplicateFactions,
            leaderPoolSize: lobbyAfterStart.draftConfig.leaderPoolSize,
            dealOptionsSize: lobbyAfterStart.draftConfig.dealOptionsSize,
          })
          draftRuntimeRecords.set(runtime.matchId, createCapturedDraftRuntimeRecord(runtime.config, draftRuntimeRecords.get(runtime.matchId)))
        }
        return body
      },
      async repeat(mode, input) {
        const response = await requestAs(`/api/lobby/${mode}/repeat-draft`, {
          method: 'POST',
          body: JSON.stringify({ userId: input.hostId, lobbyId: input.lobbyId }),
        }, {
          userId: input.hostId,
          displayName: input.hostId,
        })
        const body = await response.json() as { ok: boolean, kind: 'resume' | 'complete', matchId: string, sessionAccessToken: string | null, error?: string }
        if (!response.ok) throw new Error(body.error ?? `Failed to repeat lobby draft: ${response.status}`)
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
        return [...draftRuntimeRecords.values()]
      },
      draftComplete(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = buildCompletedPayload(room, options)
        room.completionPayloads.push(payload)
        return payload
      },
      draftTimeout(matchId) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = buildTimeoutPayload(room)
        room.cancellationPayloads.push(payload)
        return payload
      },
      draftCancel(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = buildCancelledPayload(room, options.reason ?? 'scrub', options.state)
        room.cancellationPayloads.push(payload)
        return payload
      },
      async completeDraft(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = this.draftComplete(matchId, options)
        return deliverDraftLifecycle(room, payload)
      },
      async timeoutDraft(matchId) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = this.draftTimeout(matchId)
        return deliverDraftLifecycle(room, payload)
      },
      async cancelDraft(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = this.draftCancel(matchId, options)
        return deliverDraftLifecycle(room, payload)
      },
      async replayDraftComplete(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = room.completionPayloads[options.index ?? room.completionPayloads.length - 1]
        if (!payload) throw new Error(`No completion payload recorded for match ${matchId}`)
        return deliverDraftLifecycle(room, payload)
      },
      async replayDraftCancel(matchId, options = {}) {
        const room = getDraftRuntimeRecord(draftRuntimeRecords, matchId)
        const payload = room.cancellationPayloads[options.index ?? room.cancellationPayloads.length - 1]
        if (!payload) throw new Error(`No cancellation payload recorded for match ${matchId}`)
        return deliverDraftLifecycle(room, payload)
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
      scrub(matchId, input) {
        return requestJsonAs(`/api/match/${matchId}/scrub`, {
          method: 'POST',
          body: JSON.stringify({ reporterId: input.userId }),
        }, {
          userId: input.userId,
          displayName: input.displayName ?? input.userId,
          avatarUrl: input.avatarUrl ?? null,
        })
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
        const result = await requestJsonAs('/api/activity/target', {
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
        if (result.status >= 400) {
          throw new Error(`Failed to target lobby: ${JSON.stringify(result.body)}`)
        }
        return result
      },
      async targetMatch(input) {
        const result = await requestJsonAs('/api/activity/target', {
          method: 'POST',
          body: JSON.stringify({
            channelId: input.channelId,
            userId: input.userId,
            kind: 'match',
            id: input.matchId,
          }),
        }, {
          userId: input.userId,
          displayName: input.userId,
        })
        if (result.status >= 400) {
          throw new Error(`Failed to target match: ${JSON.stringify(result.body)}`)
        }
        return result
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
    },
    inspect: {
      lobbyMapping(userId) {
        return getLobbyForUser(db, userId)
      },
      currentHostedLobby(hostId) {
        return getOpenSessionLobbyProjectionHostedBy(db, hostId)
      },
      matchMapping(userId) {
        return getMatchForUser(db, userId)
      },
      lobbiesForPlayer(userId) {
        return getCurrentSessionLobbyProjectionsForPlayer(db, userId)
      },
      async lobbyByMatch(matchId) {
        const lobby = await getSessionLobbyProjectionByMatch(db, matchId)
        return isLiveLobbyProjection(lobby) ? lobby : null
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

function createTestActivityNamespace(): DurableObjectNamespace {
  const rooms = new Map<string, Map<string, unknown>>()
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const roomId = String(id)
      let storage = rooms.get(roomId)
      if (!storage) {
        storage = new Map<string, unknown>()
        rooms.set(roomId, storage)
      }
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          const key = new URL(request.url).pathname === '/activity-follow-target'
            ? 'activity-follow-target'
            : 'activity-launch-target'
          if (request.method === 'GET') return Response.json({ target: storage.get(key) ?? null })
          if (request.method === 'POST') {
            storage.set(key, await request.json())
            return Response.json({ ok: true })
          }
          if (request.method === 'DELETE') {
            storage.delete(key)
            return Response.json({ ok: true })
          }
          return new Response('Method not allowed', { status: 405 })
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function isLiveLobbyProjection(lobby: LobbyState | null): lobby is LobbyState {
  return lobby != null && (lobby.status === 'open' || lobby.status === 'drafting' || lobby.status === 'active')
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

function getDraftRuntimeRecord(rooms: Map<string, CapturedDraftRuntimeRecord>, matchId: string): CapturedDraftRuntimeRecord {
  const room = rooms.get(matchId)
  if (!room) throw new Error(`No captured draft runtime config for match ${matchId}`)
  return room
}

function buildTestDraftEntries(lobby: LobbyState): QueueEntry[] {
  const joinedAt = Math.max(1, lobby.createdAt)
  return lobby.slots.flatMap((playerId) => {
    if (!playerId) return []
    return [{ playerId, displayName: playerId, avatarUrl: null, joinedAt }]
  })
}

function buildCompletedPayload(room: CapturedDraftRuntimeRecord, options: CompleteDraftOptions = {}): DraftLifecycleCompletePayload {
  const { config } = room
  const baseState = buildCompletedDraftState(config)
  const state = options.transformState ? options.transformState(baseState) : baseState
  const eventSequence = nextTestLifecycleSequence(room)
  const eventKind = options.finalized === true
    ? 'DraftFinalized'
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

function buildTimeoutPayload(room: CapturedDraftRuntimeRecord): DraftLifecycleCancelledPayload {
  const { config } = room
  const eventSequence = nextTestLifecycleSequence(room)
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

function buildCancelledPayload(room: CapturedDraftRuntimeRecord, reason: 'cancel' | 'scrub' | 'revert', stateOverride?: DraftState): DraftLifecycleCancelledPayload {
  const { config } = room
  const eventSequence = nextTestLifecycleSequence(room)
  const state = stateOverride
    ? { ...stateOverride, status: 'cancelled' as const, cancelReason: reason }
    : buildCancelledDraftState(config, reason === 'cancel' ? 'cancel' : reason)
  return {
    eventId: `${config.matchId}:test:${eventSequence}`,
    eventKind: 'DraftCancelled',
    eventSequence,
    outcome: 'cancelled',
    matchId: config.matchId,
    hostId: config.hostId,
    cancelledAt: Date.now(),
    reason,
    state,
    mapVoteResult: null,
  }
}

function nextTestLifecycleSequence(room: CapturedDraftRuntimeRecord): number {
  room.nextLifecycleEventSequence += 1
  return room.nextLifecycleEventSequence
}

function buildCompletedDraftState(config: DraftRuntimeConfig) {
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

function buildTimedOutDraftState(config: DraftRuntimeConfig) {
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

function buildCancelledDraftState(config: DraftRuntimeConfig, reason: 'cancel' | 'scrub' | 'revert') {
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

function assignTestDealOptions(state: DraftState, config: DraftRuntimeConfig): DraftState {
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
        payload: parseDiscordRequestPayload(bodyText),
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
        payload: parseDiscordRequestPayload(bodyText),
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

function parseDiscordRequestPayload(bodyText: string | null): unknown {
  if (!bodyText) return null
  try {
    return JSON.parse(bodyText)
  }
  catch {
    return bodyText
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
