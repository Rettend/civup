import type { CompetitiveTier, DraftSeat, GameMode, QueueEntry } from '@civup/game'
import type { SessionServerMessage } from '@civup/session'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { DraftSessionRecord, OpenSessionRecord, SessionConfig, SessionDraftStartSyncState, SessionLifecycleSyncState, SessionProjectionState, SessionProjectionSyncPayload, SessionProjectionSyncState, SessionRecord, SessionRoster, SessionTerminalSyncCommand, SessionTerminalSyncState } from './session-record.ts'
import { createDb, matchBans, matches } from '@civup/db'
import { canStartWithPlayerCount, formatModeLabel, GAME_MODES, getMinimumLeaderPoolSize } from '@civup/game'
import { CIVUP_ACTIVITY_USER_ID_HEADER, createSessionAccessToken, isAuthorizedInternalRequest } from '@civup/utils'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed } from '../embeds/match.ts'
import { buildDraftRuntimeConfig } from '../services/activity/index.ts'
import { buildLobbySnapshotFromSessionRecord } from '../services/activity/session-state.ts'
import { resolveDraftTimerConfig } from '../services/config/index.ts'
import { normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from '../services/lobby/normalize.ts'
import { upsertLobbyMessage } from '../services/lobby/message.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { mapLobbySlotsToEntries } from '../services/lobby/slots.ts'
import { activateDraftMatch, cancelDraftMatch, createDraftMatch } from '../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../services/match/message.ts'
import { isSessionAdmissionError, projectSessionRecord } from '../services/session/directory.ts'
import { publishActivitySessionUpdate } from './activity-feed-client.ts'
import { SessionDraftRuntime, type DraftRuntimeEnv } from './draft-room.ts'
import { buildLobbyDraftConfigFromSessionConfig, buildLobbyProjectionFromSessionRecord, buildOpenSessionRecordFromLobby, buildSessionRoster, buildSessionRosterQueueEntries, buildSessionRosterSlotEntries } from './session-record.ts'
import type { Connection, ConnectionContext } from './socket-server.ts'
import { canOpenSwapWindowForState } from './swap-window.ts'

interface SessionDOEnv extends DraftRuntimeEnv {
  DB?: D1Database
  KV?: KVNamespace
  Activity?: DurableObjectNamespace
  DISCORD_TOKEN?: string
  BOT_HOST?: string
  CIVUP_SECRET?: string
}

interface CreateSessionFromLobbyRequest {
  lobby: LobbyState
  queueEntries?: QueueEntry[]
}

interface StartDraftCommandRequest {
  expectedVersion?: number
  hostId?: string
  now?: number
}

interface StartDraftCommandResult {
  record: DraftSessionRecord
  matchId: string
  seats: DraftSeat[]
  idempotent?: boolean
}

interface SessionConnectionState {
  playerId: string | null
  openLobby?: boolean
}

type OpenLobbyCommandRequest
  = | {
    type: 'set-message'
    expectedVersion?: number
    channelId: string
    messageId: string
    now?: number
  }
  | {
    type: 'set-draft-config'
    expectedVersion?: number
    draftConfig: LobbyDraftConfig
    now?: number
  }
  | {
    type: 'set-min-role'
    expectedVersion?: number
    minRole: CompetitiveTier | null
    now?: number
  }
  | {
    type: 'set-max-role'
    expectedVersion?: number
    maxRole: CompetitiveTier | null
    now?: number
  }
  | {
    type: 'set-steam-lobby-link'
    expectedVersion?: number
    steamLobbyLink: string | null
    now?: number
  }
  | {
    type: 'set-slots'
    expectedVersion?: number
    slots: (string | null)[]
    queueEntries?: QueueEntry[]
    now?: number
  }
  | {
    type: 'set-member-player-ids'
    expectedVersion?: number
    memberPlayerIds: string[]
    queueEntries?: QueueEntry[]
    now?: number
  }
  | {
    type: 'set-last-activity-at'
    expectedVersion?: number
    lastActivityAt: number
    now?: number
  }
  | {
    type: 'arrange-roster'
    expectedVersion?: number
    slots: (string | null)[]
    strategy: LobbyArrangeMarker['strategy']
    at?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'set-roster'
    expectedVersion?: number
    memberPlayerIds: string[]
    slots: (string | null)[]
    lastActivityAt?: number
    now?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'change-mode'
    expectedVersion?: number
    mode: GameMode
    draftConfig: LobbyDraftConfig
    slots: (string | null)[]
    minRole: CompetitiveTier | null
    maxRole: CompetitiveTier | null
    lastActivityAt?: number
    now?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'cancel-open-session'
    expectedVersion?: number
    now?: number
  }

type DraftLifecycleCommandRequest
  = | {
    type: 'draft-completed'
    opensSwapWindow?: boolean
    at?: number
  }
  | {
    type: 'swap-accepted' | 'draft-finalized'
    at?: number
  }
  | {
    type: 'draft-cancelled'
    reason: 'cancel' | 'scrub' | 'timeout' | 'revert'
    at?: number
  }

type SessionProjectionCommandRequest
  = | {
    type: 'set-message'
    expectedVersion?: number
    channelId: string
    messageId: string
    now?: number
  }
  | {
    type: 'set-steam-lobby-link'
    expectedVersion?: number
    steamLobbyLink: string | null
    now?: number
  }

type SessionLifecycleCommandRequest
  = | {
    type: 'mark-reported'
    matchId?: string
    at?: number
    reportedById?: string | null
  }
  | {
    type: 'cancel-session'
    matchId?: string
    at?: number
  }

interface OpenSessionPatch {
  expectedVersion?: number
  mode?: GameMode
  channelId?: string
  messageId?: string
  steamLobbyLink?: string | null
  minRole?: CompetitiveTier | null
  maxRole?: CompetitiveTier | null
  draftConfig?: LobbyDraftConfig
  slots?: (string | null)[]
  memberPlayerIds?: string[]
  lastArrange?: LobbyArrangeMarker | null
  lastActivityAt?: number
  updatedAt?: number
  queueEntries?: QueueEntry[]
}

const SESSION_RECORD_STORAGE_KEY = 'session-record'
const SESSION_COMMIT_INTENT_STORAGE_KEY = 'session-commit-intent'

interface SessionCommitIntent {
  record: SessionRecord
  createdAt: number
}

class TerminalMatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`Match **${matchId}** not found.`)
    this.name = 'TerminalMatchNotFoundError'
  }
}

export class SessionDO extends SessionDraftRuntime<SessionDOEnv> {
  private commandQueue: Promise<void> = Promise.resolve()

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/record') {
      await this.recoverPendingCommitIntent()
      const record = await this.getRecord()
      if (!record) return json({ error: 'Session not found' }, 404)
      return json({ record })
    }

    if (request.method === 'POST' && url.pathname === '/commands/create-from-lobby') {
      return await this.runSerializedCommand(() => this.handleCreateFromLobby(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/open-lobby') {
      return await this.runSerializedCommand(() => this.handleOpenLobbyCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/start-draft') {
      return await this.runSerializedCommand(() => this.handleStartDraftCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/draft-lifecycle') {
      return await this.runSerializedCommand(() => this.handleDraftLifecycleCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/draft-lifecycle-sync') {
      return await this.runSerializedCommand(() => this.handleDraftLifecycleSyncCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/session-lifecycle') {
      return await this.runSerializedCommand(() => this.handleSessionLifecycleCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/session-projection') {
      return await this.runSerializedCommand(() => this.handleSessionProjectionCommand(request))
    }

    return await super.onRequest(request)
  }

  override async onAlarm(): Promise<void> {
    await this.runSerializedCommand(async () => {
      await this.retryPendingDraftStartSync()
      await this.retryPendingLifecycleSync()
      await this.retryPendingTerminalSync()
      await this.retryPendingProjectionSync()
      await this.handleDraftRuntimeAlarmIfDue()
      await this.rescheduleSessionAlarm(await this.getRecord())
      return json({ ok: true })
    })
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    await this.recoverPendingCommitIntent()
    const record = await this.getRecord()
    if (record?.phase === 'open') {
      await this.handleOpenSessionConnect(connection, ctx, record)
      return
    }

    await super.onConnect(connection, ctx)
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.ctx.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
  }

  private async handleOpenSessionConnect(connection: Connection, ctx: ConnectionContext, record: OpenSessionRecord): Promise<void> {
    if (!isAuthorizedInternalRequest(ctx.request.headers, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const playerId = readActivityUserId(ctx.request.headers)
    if (!playerId) {
      connection.close(4401, 'Unauthorized')
      return
    }

    connection.setState({ playerId, openLobby: true } satisfies SessionConnectionState)
    await this.sendOpenLobbySnapshot(connection, record)
  }

  private async handleCreateFromLobby(request: Request): Promise<Response> {
    let body: CreateSessionFromLobbyRequest
    try {
      body = await request.json<CreateSessionFromLobbyRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body?.lobby || typeof body.lobby.id !== 'string') {
      return json({ error: 'lobby is required' }, 400)
    }
    if (body.lobby.status !== 'open') {
      return json({ error: 'create-from-lobby requires an open lobby' }, 400)
    }

    const existing = await this.getRecord()
    let record: OpenSessionRecord
    try {
      record = buildOpenSessionRecordFromLobby(body.lobby, body.queueEntries ?? [])
    }
    catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }

    if (existing) {
      if (existing.id !== record.id) return json({ error: 'Session id mismatch' }, 409)
      return json({ ok: true, record: existing })
    }

    const commit = await this.commitRecord(record)
    if (commit) return commit

    return json({ ok: true, record })
  }

  private async handleOpenLobbyCommand(request: Request): Promise<Response> {
    let body: OpenLobbyCommandRequest
    try {
      body = await request.json<OpenLobbyCommandRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
      return json({ error: 'command type is required' }, 400)
    }

    const existing = await this.getRecord()
    if (!existing) return json({ error: 'Session not found' }, 404)
    if (existing.phase !== 'open') {
      return json({ error: `Session is not open (phase: ${existing.phase})` }, 409)
    }

    const expected = normalizeOptionalPositiveInteger(body.expectedVersion)
    if (expected != null) {
      if (expected !== existing.version) return versionConflictResponse(expected, existing.version)
    }

    let record: SessionRecord
    switch (body.type) {
      case 'set-message':
        record = applyOpenSessionPatch(existing, {
          channelId: body.channelId,
          messageId: body.messageId,
          updatedAt: body.now,
        })
        break
      case 'set-draft-config':
        record = applyOpenSessionPatch(existing, {
          draftConfig: body.draftConfig,
          updatedAt: body.now,
        })
        break
      case 'set-min-role':
        record = applyOpenSessionPatch(existing, {
          minRole: body.minRole,
          updatedAt: body.now,
        })
        break
      case 'set-max-role':
        record = applyOpenSessionPatch(existing, {
          maxRole: body.maxRole,
          updatedAt: body.now,
        })
        break
      case 'set-steam-lobby-link':
        record = applyOpenSessionPatch(existing, {
          steamLobbyLink: body.steamLobbyLink,
          updatedAt: body.now,
        })
        break
      case 'set-slots':
        record = applyOpenSessionPatch(existing, {
          slots: body.slots,
          queueEntries: body.queueEntries,
          updatedAt: body.now,
        })
        break
      case 'set-member-player-ids':
        record = applyOpenSessionPatch(existing, {
          memberPlayerIds: body.memberPlayerIds,
          queueEntries: body.queueEntries,
          updatedAt: body.now,
        })
        break
      case 'set-last-activity-at':
        record = applyOpenSessionPatch(existing, {
          lastActivityAt: body.lastActivityAt,
          updatedAt: body.now,
        })
        break
      case 'arrange-roster': {
        const at = normalizePositiveInteger(body.at, Date.now())
        record = applyOpenSessionPatch(existing, {
          slots: body.slots,
          lastArrange: { strategy: body.strategy, at },
          lastActivityAt: at,
          updatedAt: at,
          queueEntries: body.queueEntries,
        })
        break
      }
      case 'set-roster':
        record = applyOpenSessionPatch(existing, {
          expectedVersion: body.expectedVersion,
          memberPlayerIds: body.memberPlayerIds,
          slots: body.slots,
          lastActivityAt: body.lastActivityAt,
          updatedAt: body.now,
          queueEntries: body.queueEntries,
        })
        break
      case 'change-mode':
        record = applyOpenSessionPatch(existing, {
          expectedVersion: body.expectedVersion,
          mode: body.mode,
          draftConfig: body.draftConfig,
          slots: body.slots,
          minRole: body.minRole,
          maxRole: body.maxRole,
          lastActivityAt: body.lastActivityAt,
          updatedAt: body.now,
          queueEntries: body.queueEntries,
        })
        break
      case 'cancel-open-session':
        record = cancelOpenSession(existing, body.now)
        break
      default:
        return json({ error: 'Unknown open lobby command' }, 400)
    }

    if (record === existing) return json({ ok: true, record })
    const commit = await this.commitRecord(record)
    if (commit) return commit
    return json({ ok: true, record })
  }

  private async handleStartDraftCommand(request: Request): Promise<Response> {
    let body: StartDraftCommandRequest | null = null
    try {
      body = await request.json<StartDraftCommandRequest>()
    }
    catch {
      body = null
    }

    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    if (record.phase === 'draft') {
      const ensured = await this.finishDraftStartSync(record)
      if (!ensured.ok) return json({ error: ensured.error }, ensured.status)
      return json({ ok: true, record: ensured.record, matchId: ensured.record.matchId, seats: ensured.seats, idempotent: true } satisfies { ok: true } & StartDraftCommandResult)
    }
    if (record.phase !== 'open') {
      return json({ error: `Session is not open (phase: ${record.phase})` }, 409)
    }
    if (body?.hostId && body.hostId !== record.hostId) {
      return json({ error: 'Only the session host can start the draft' }, 403)
    }

    const expected = normalizeOptionalPositiveInteger(body?.expectedVersion)
    if (expected != null && expected !== record.version) return json({ error: 'Session changed before draft start' }, 409)

    const selectedEntries = buildSessionRosterSlotEntries(record)
    if (!selectedEntries.some(entry => entry.playerId === record.hostId)) {
      return json({ error: 'Host must be in a lobby slot before starting.' }, 400)
    }
    if (!canStartWithPlayerCount(record.mode, selectedEntries.length, record.roster.slots.length, { redDeath: record.config.redDeath })) {
      return json({ error: 'Session cannot start with the current slotted player count.' }, 400)
    }
    const leaderPoolError = getLeaderPoolSizeError(record.mode, record.config.redDeath, record.config.leaderPoolSize, selectedEntries.length)
    if (leaderPoolError) return json({ error: leaderPoolError }, 400)

    if (!this.env.DB) return json({ error: 'D1 binding is not configured' }, 503)

    const now = normalizePositiveInteger(body?.now, Date.now())
    const matchId = record.id

    const next: DraftSessionRecord = {
      ...record,
      phase: 'draft',
      matchId,
      version: record.version + 1,
      frozenAt: now,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
      draftStartSync: { attempts: 0, nextRetryAt: 0 },
    }

    const commit = await this.commitRecord(next)
    if (commit) return commit

    const ensured = await this.finishDraftStartSync(next)
    if (!ensured.ok) return json({ error: ensured.error }, ensured.status)

    return json({ ok: true, record: ensured.record, matchId: ensured.record.matchId, seats: ensured.seats } satisfies { ok: true } & StartDraftCommandResult)
  }

  private async handleDraftLifecycleCommand(request: Request): Promise<Response> {
    let body: DraftLifecycleCommandRequest
    try {
      body = await request.json<DraftLifecycleCommandRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
      return json({ error: 'command type is required' }, 400)
    }

    const existing = await this.getRecord()
    if (!existing) return json({ error: 'Session not found' }, 404)

    const at = normalizePositiveInteger(body.at, Date.now())
    let record: SessionRecord
    switch (body.type) {
      case 'draft-completed':
        if (existing.phase === 'swap' || existing.phase === 'active') return json({ ok: true, record: existing })
        if (existing.phase !== 'draft') return json({ error: `Session is not in draft (phase: ${existing.phase})` }, 409)
        record = {
          ...existing,
          phase: body.opensSwapWindow === true ? 'swap' : 'active',
          version: existing.version + 1,
          updatedAt: at,
          lastActivityAt: at,
          closedAt: null,
          draftStartSync: null,
        }
        break
      case 'swap-accepted':
        if (existing.phase === 'active') return json({ ok: true, record: existing })
        if (existing.phase !== 'swap') return json({ error: `Session is not in swap (phase: ${existing.phase})` }, 409)
        record = {
          ...existing,
          version: existing.version + 1,
          updatedAt: at,
          lastActivityAt: at,
          closedAt: null,
          draftStartSync: null,
        }
        break
      case 'draft-finalized':
        if (existing.phase === 'active') return json({ ok: true, record: existing })
        if (existing.phase !== 'swap') return json({ error: `Session is not in swap (phase: ${existing.phase})` }, 409)
        record = {
          ...existing,
          phase: 'active',
          version: existing.version + 1,
          updatedAt: at,
          lastActivityAt: at,
          closedAt: null,
          draftStartSync: null,
        }
        break
      case 'draft-cancelled':
        if (body.reason === 'timeout' || body.reason === 'revert') {
          if (existing.phase === 'open') return json({ ok: true, record: existing })
          if (existing.phase !== 'draft') return json({ error: `Session is not in draft (phase: ${existing.phase})` }, 409)
          record = reopenDraftSession(existing, at)
          break
        }
        if (existing.phase === 'cancelled') return json({ ok: true, record: existing })
        if (existing.phase !== 'draft' && existing.phase !== 'swap') return json({ error: `Session is not cancellable (phase: ${existing.phase})` }, 409)
        record = {
          ...existing,
          phase: 'cancelled',
          version: existing.version + 1,
          updatedAt: at,
          lastActivityAt: at,
          closedAt: at,
          draftStartSync: null,
        }
        break
      default:
        return json({ error: 'Unknown draft lifecycle command' }, 400)
    }

    const commit = await this.commitRecord(record)
    if (commit) return commit
    return json({ ok: true, record })
  }

  private async handleDraftLifecycleSyncCommand(request: Request): Promise<Response> {
    let payload: DraftLifecyclePayload
    try {
      payload = await request.json<DraftLifecyclePayload>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    const validationError = validateDraftLifecyclePayload(payload)
    if (validationError) return json({ error: validationError }, 400)

    const result = await this.syncDraftLifecyclePayload(payload)
    if (!result.ok) return json({ error: result.error }, result.status)
    return json({ ok: true, ignored: result.ignored, synced: result.synced })
  }

  protected override async syncDraftRuntimeLifecyclePayload(payload: DraftLifecyclePayload, action: string): Promise<void> {
    const result = await this.syncDraftLifecyclePayload(payload)
    if (result.ok) return

    console.error('[session-do] lifecycle sync deferred', buildDraftLifecycleLogContext(payload, {
      action,
      status: result.status,
      error: result.error,
    }))
  }

  private async retryPendingDraftStartSync(): Promise<void> {
    const record = await this.getRecord()
    if (record?.phase !== 'draft' || !record.draftStartSync) return

    const now = Date.now()
    if (record.draftStartSync.nextRetryAt > now) {
      await this.scheduleLifecycleSyncAlarm(record)
      return
    }

    const result = await this.finishDraftStartSync(record)
    if (!result.ok) {
      console.warn('[session-do] draft start sync retry deferred', {
        matchId: record.matchId,
        status: result.status,
        error: result.error,
      })
    }
  }

  private async finishDraftStartSync(record: DraftSessionRecord): Promise<{ ok: true, record: DraftSessionRecord, seats: DraftSeat[] } | { ok: false, status: number, error: string }> {
    try {
      const room = await this.ensureDraftRuntimeAndMatch(record)
      const current = await this.getRecord()
      const target = current?.id === record.id ? current : record
      if (target.phase !== 'draft') return { ok: false, status: 409, error: `Session is not in draft (phase: ${target.phase})` }

      const cleared = withDraftStartSync(target, null)
      if (target.draftStartSync) await this.storeRecordOnly(cleared)
      return { ok: true, record: cleared, seats: room.seats }
    }
    catch (error) {
      return await this.deferDraftStartSync(record, error instanceof Error ? error.message : String(error))
    }
  }

  private async ensureDraftRuntimeAndMatch(record: DraftSessionRecord): Promise<{ matchId: string, seats: DraftSeat[] }> {
    if (!this.env.DB) throw new Error('D1 binding is not configured')

    const existingRoom = await this.getRoomRecord()
    let room: { matchId: string, seats: DraftSeat[] }
    if (existingRoom && existingRoom.state.status !== 'cancelled') {
      if (existingRoom.state.matchId !== record.matchId) throw new Error('Existing draft runtime belongs to a different session')
      room = { matchId: existingRoom.state.matchId, seats: existingRoom.config.seats }
    }
    else {
      const timerConfig = await resolveDraftTimerConfig(this.env.KV, record.config)
      const runtime = buildDraftRuntimeConfig(record.mode, buildSessionRosterSlotEntries(record), {
        matchId: record.matchId,
        hostId: record.hostId,
        leaderDataVersion: record.config.leaderDataVersion,
        blindBans: record.config.blindBans,
        simultaneousPick: record.config.simultaneousPick,
        redDeath: record.config.redDeath,
        mapVoteEnabled: record.config.mapVoteEnabled,
        randomDraft: record.config.randomDraft,
        duplicateFactions: record.config.duplicateFactions,
        timerConfig,
        leaderPoolSize: record.config.leaderPoolSize,
        dealOptionsSize: record.config.dealOptionsSize,
      })
      const initialized = await this.initializeDraftRuntime(runtime.config, { existing: existingRoom })
      room = { matchId: initialized.state.matchId, seats: initialized.config.seats }
    }

    await createDraftMatch(createDb(this.env.DB), { matchId: room.matchId, mode: record.mode, seats: room.seats })
    return room
  }

  private async deferDraftStartSync(record: DraftSessionRecord, error: string): Promise<{ ok: false, status: number, error: string }> {
    const current = await this.getRecord()
    const target = current?.phase === 'draft' && current.id === record.id ? current : record
    const attempts = target.draftStartSync ? target.draftStartSync.attempts + 1 : 1
    const nextRetryAt = Date.now() + getLifecycleSyncRetryDelay(attempts)
    const pending = withDraftStartSync(target, { attempts, nextRetryAt })
    await this.storeRecordOnly(pending)
    console.warn('[session-do] draft start sync retry scheduled', {
      matchId: pending.matchId,
      attempts,
      nextRetryAt,
      error,
    })
    return { ok: false, status: 503, error }
  }

  private async retryPendingLifecycleSync(): Promise<void> {
    const record = await this.getRecord()
    const pending = record?.lifecycleSync ?? null
    if (!record || !pending) {
      await this.clearLifecycleSyncAlarm()
      return
    }

    const now = Date.now()
    if (pending.nextRetryAt > now) {
      await this.scheduleLifecycleSyncAlarm(record)
      return
    }

    const result = await this.syncDraftLifecyclePayload(pending.payload)
    if (!result.ok) {
      console.warn('[session-do] lifecycle sync retry deferred', buildDraftLifecycleLogContext(pending.payload, {
        status: result.status,
        error: result.error,
      }))
    }
  }

  private async retryPendingTerminalSync(): Promise<void> {
    const record = await this.getRecord()
    const pending = record?.terminalSync ?? null
    if (!record || !pending) return

    const now = Date.now()
    if (pending.nextRetryAt > now) {
      await this.scheduleLifecycleSyncAlarm(record)
      return
    }

    const result = await this.finishTerminalSync(record)
    if (!result.ok) {
      console.warn('[session-do] terminal lifecycle sync retry deferred', {
        type: pending.command.type,
        matchId: pending.command.matchId,
        status: result.status,
        error: result.error,
      })
    }
  }

  private async retryPendingProjectionSync(): Promise<void> {
    const record = await this.getRecord()
    const pending = record?.projectionSync ?? null
    if (!record || !pending) return

    const now = Date.now()
    if (pending.nextRetryAt > now) {
      await this.scheduleLifecycleSyncAlarm(record)
      return
    }

    const result = await this.finishProjectionSync(record, pending)
    if (!result.ok) {
      console.warn('[session-do] projection sync retry deferred', buildProjectionSyncLogContext(pending.payload, {
        status: result.status,
        error: result.error,
      }))
    }
  }

  private async finishProjectionSync(
    record: SessionRecord,
    pending: SessionProjectionSyncState,
  ): Promise<{ ok: true } | { ok: false, status: number, error: string }> {
    if (!this.env.DISCORD_TOKEN) {
      await this.clearProjectionSyncMarker(record, pending.payload)
      return { ok: true }
    }

    if (!this.env.DB) return await this.deferProjectionSync(record, pending.payload, 'D1 binding is not configured')

    const current = await this.getRecord() ?? record
    if (isProjectionSyncObsolete(current, pending.payload)) {
      await this.clearProjectionSyncMarker(current, pending.payload)
      return { ok: true }
    }

    const applied = await this.tryApplyProjectionSync(createDb(this.env.DB), current, pending.payload)
    if (!applied.ok) return await this.deferProjectionSync(current, pending.payload, applied.error)

    await this.clearProjectionSyncMarker(current, pending.payload)
    return { ok: true }
  }

  private async syncDraftLifecyclePayload(payload: DraftLifecyclePayload): Promise<{ ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }> {
    const existing = await this.getRecord()
    if (!existing) return { ok: false, status: 404, error: 'Session not found' }
    if (payload.matchId !== existing.id) return { ok: false, status: 409, error: `Lifecycle payload ${payload.matchId} does not belong to session ${existing.id}` }
    if (isTerminalSessionPhase(existing.phase)) {
      if (existing.lifecycleSync) await this.clearLifecycleSyncMarker(existing)
      return { ok: true, ignored: true }
    }
    if (payload.eventSequence < (existing.lifecycleEventSequence ?? 0)) return { ok: true, ignored: true }
    if (existing.lifecycleSync && payload.eventSequence < existing.lifecycleSync.payload.eventSequence) return { ok: true, ignored: true }

    const marked = await this.markLifecycleSyncPending(existing, payload)
    if (!this.env.DB) return await this.deferLifecycleSync(marked, payload, 'D1 binding is not configured')

    const db = createDb(this.env.DB)
    let result: { ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }
    try {
      result = payload.outcome === 'complete'
        ? await this.syncDraftCompleted(db, payload, marked)
        : await this.syncDraftCancelled(db, payload, marked)
    }
    catch (error) {
      return await this.deferLifecycleSync(marked, payload, error instanceof Error ? error.message : String(error))
    }

    if (!result.ok && result.status >= 500) return await this.deferLifecycleSync(marked, payload, result.error)
    if (!result.ok) await this.clearLifecycleSyncMarker(marked)
    return result
  }

  private async syncDraftCompleted(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'complete' }>,
    record: SessionRecord,
  ): Promise<{ ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }> {
    const context = buildDraftLifecycleLogContext(payload)
    const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
    if (!hostId) return { ok: false, status: 400, error: 'Draft lifecycle payload missing host identity' }

    const result = await activateDraftMatch(db, {
      state: payload.state,
      completedAt: payload.completedAt,
      hostId,
      mapVoteResult: payload.mapVoteResult ?? null,
    })

    if ('error' in result) {
      if (isIgnorableDraftCompleteError(result.error)) {
        console.warn('[session-do] ignoring stale draft completion', { ...context, error: result.error })
        await this.clearLifecycleSyncMarker(record)
        return { ok: true, ignored: true }
      }
      return { ok: false, status: 400, error: result.error }
    }

    const transition = transitionRecordForDraftLifecycle(record, payload)
    if ('error' in transition) return transition
    const transitionWasNoop = transition.record === record
    const transitionRecord = withLifecycleEventSequence(transition.record, payload.eventSequence)
    const committed = await this.finishLifecycleSync(transitionRecord)
    if (!committed.ok) return committed

    if (transition.ignored) return { ok: true, ignored: true }
    if (result.alreadyActive && payload.finalized !== true && transitionWasNoop) return { ok: true, synced: true }

    await this.updateCompletedDraftProjection(db, payload, result, transitionRecord, context)
    return { ok: true }
  }

  private async syncDraftCancelled(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'cancelled' }>,
    record: SessionRecord,
  ): Promise<{ ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }> {
    const context = buildDraftLifecycleLogContext(payload)
    const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
    if (!hostId) return { ok: false, status: 400, error: 'Draft lifecycle payload missing host identity' }

    const cancelled = await cancelDraftMatch(db, {
      state: payload.state,
      cancelledAt: payload.cancelledAt,
      reason: payload.reason,
      hostId,
      mapVoteResult: payload.mapVoteResult ?? null,
      allowActive: record.phase === 'swap' && payload.state.picks.length > 0,
    })

    if ('error' in cancelled) {
      if (isIgnorableDraftCancelError(cancelled.error)) {
        console.warn('[session-do] ignoring stale draft cancellation', { ...context, error: cancelled.error })
        await this.clearLifecycleSyncMarker(record)
        return { ok: true, ignored: true }
      }
      return { ok: false, status: 400, error: cancelled.error }
    }

    const transition = transitionRecordForDraftLifecycle(record, payload)
    if ('error' in transition) return transition
    const transitionRecord = withLifecycleEventSequence(transition.record, payload.eventSequence)
    const committed = await this.finishLifecycleSync(transitionRecord)
    if (!committed.ok) return committed

    if (transition.ignored) return { ok: true, ignored: true }
    await this.updateCancelledDraftProjection(db, payload, cancelled, transitionRecord, context)
    return { ok: true }
  }

  private async updateCompletedDraftProjection(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'complete' }>,
    result: Awaited<ReturnType<typeof activateDraftMatch>> & { error?: never },
    record: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
    const projection = {
      type: 'draft-completed',
      payload,
      participants: result.participants,
    } satisfies SessionProjectionSyncPayload
    const applied = await this.tryApplyProjectionSync(db, record, projection)
    if (applied.ok) {
      await this.clearProjectionSyncMarker(record, projection)
      return
    }

    await this.deferProjectionSync(record, projection, applied.error, context)
  }

  private async updateCancelledDraftProjection(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'cancelled' }>,
    cancelled: Awaited<ReturnType<typeof cancelDraftMatch>> & { error?: never },
    record: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
    const projection = {
      type: 'draft-cancelled',
      payload,
      participants: cancelled.participants,
    } satisfies SessionProjectionSyncPayload
    const applied = await this.tryApplyProjectionSync(db, record, projection)
    if (applied.ok) {
      await this.clearProjectionSyncMarker(record, projection)
      return
    }

    await this.deferProjectionSync(record, projection, applied.error, context)
  }

  private async tryApplyProjectionSync(
    db: ReturnType<typeof createDb>,
    record: SessionRecord,
    projection: SessionProjectionSyncPayload,
  ): Promise<{ ok: true } | { ok: false, error: string }> {
    const token = this.env.DISCORD_TOKEN
    if (!token) return { ok: true }
    const kv = this.env.KV
    if (!kv) return { ok: false, error: 'KV binding is not configured' }
    if (isProjectionSyncObsolete(record, projection)) return { ok: true }

    try {
      if (projection.type === 'draft-completed') {
        await this.applyCompletedDraftProjection(db, kv, token, record, projection)
      }
      else {
        await this.applyCancelledDraftProjection(db, kv, token, record, projection)
      }
      return { ok: true }
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async applyCompletedDraftProjection(
    db: ReturnType<typeof createDb>,
    kv: KVNamespace,
    token: string,
    record: SessionRecord,
    projection: Extract<SessionProjectionSyncPayload, { type: 'draft-completed' }>,
  ): Promise<void> {
    const activeLobby = buildLobbyProjectionFromSessionRecord(record)
    const payload = projection.payload
    const updatedLobby = await upsertLobbyMessage(kv, token, activeLobby, {
      embeds: [lobbyDraftCompleteEmbed(activeLobby.mode, projection.participants, payload.mapVoteResult ?? null, activeLobby.draftConfig.leaderDataVersion, activeLobby.draftConfig.redDeath)],
      components: lobbyComponents(activeLobby.mode, activeLobby.id),
    })
    await this.updateMessageProjection(record, updatedLobby.messageId)
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }

  private async applyCancelledDraftProjection(
    db: ReturnType<typeof createDb>,
    kv: KVNamespace,
    token: string,
    record: SessionRecord,
    projection: Extract<SessionProjectionSyncPayload, { type: 'draft-cancelled' }>,
  ): Promise<void> {
    const payload = projection.payload
    const lifecycleLobby = buildLobbyProjectionFromSessionRecord(record)
    if (payload.reason === 'timeout' || payload.reason === 'revert') {
      const queueEntries = buildSessionRosterQueueEntries(record)
      const slottedEntries = mapLobbySlotsToEntries(lifecycleLobby.slots, queueEntries)
      const renderPayload = await buildOpenLobbyRenderPayload(kv, lifecycleLobby, slottedEntries)
      const updatedLobby = await upsertLobbyMessage(kv, token, lifecycleLobby, renderPayload)
      await this.updateMessageProjection(record, updatedLobby.messageId)
      await clearMatchMessageMapping(db, updatedLobby.messageId)
      return
    }

    const updatedLobby = await upsertLobbyMessage(kv, token, lifecycleLobby, {
      embeds: [lobbyCancelledEmbed(lifecycleLobby.mode, projection.participants, payload.reason, undefined, lifecycleLobby.draftConfig.leaderDataVersion, lifecycleLobby.draftConfig.redDeath)],
      components: [],
    })
    await this.updateMessageProjection(record, updatedLobby.messageId)
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }

  private async deferProjectionSync(
    record: SessionRecord,
    projection: SessionProjectionSyncPayload,
    error: string,
    context: Record<string, unknown> = {},
  ): Promise<{ ok: true } | { ok: false, status: number, error: string }> {
    const current = await this.getRecord() ?? record
    if (!this.env.DISCORD_TOKEN || isProjectionSyncObsolete(current, projection)) {
      await this.clearProjectionSyncMarker(current, projection)
      return { ok: true }
    }

    const existingPending = current.projectionSync
    if (existingPending && projectionEventSequence(existingPending.payload) > projectionEventSequence(projection)) return { ok: true }

    const existing = isSameProjectionSyncPayload(existingPending?.payload, projection) ? existingPending : null
    const attempts = existing ? existing.attempts + 1 : 1
    if (attempts >= PROJECTION_SYNC_MAX_ATTEMPTS) {
      await this.storeRecordOnly(withProjectionSync(current, null))
      console.error('[session-do] projection sync abandoned after bounded retries', buildProjectionSyncLogContext(projection, {
        ...context,
        attempts,
        error,
      }))
      return { ok: true }
    }

    const nextRetryAt = Date.now() + getProjectionSyncRetryDelay(attempts)
    const pending = withProjectionSync(current, { payload: projection, attempts, nextRetryAt })
    await this.storeRecordOnly(pending)
    console.warn('[session-do] projection sync retry scheduled', buildProjectionSyncLogContext(projection, {
      ...context,
      attempts,
      nextRetryAt,
      error,
    }))
    return { ok: false, status: 503, error }
  }

  private async clearProjectionSyncMarker(record: SessionRecord, projection: SessionProjectionSyncPayload): Promise<void> {
    const current = await this.getRecord() ?? record
    const pending = current.projectionSync
    if (!pending) return
    if (projectionEventSequence(pending.payload) > projectionEventSequence(projection)) return
    await this.storeRecordOnly(withProjectionSync(current, null))
  }

  private async markLifecycleSyncPending(record: SessionRecord, payload: DraftLifecyclePayload): Promise<SessionRecord> {
    if (record.lifecycleSync && payload.eventSequence < record.lifecycleSync.payload.eventSequence) return record
    const existing = record.lifecycleSync?.payload.eventId === payload.eventId ? record.lifecycleSync : null
    const marked = withLifecycleSync(record, {
      payload,
      attempts: existing?.attempts ?? 0,
      nextRetryAt: 0,
    })
    await this.storeRecordOnly(marked)
    return marked
  }

  private async deferLifecycleSync(record: SessionRecord, payload: DraftLifecyclePayload, error: string): Promise<{ ok: false, status: number, error: string }> {
    const current = await this.getRecord() ?? record
    if (current.lifecycleSync && payload.eventSequence < current.lifecycleSync.payload.eventSequence) {
      return { ok: false, status: 409, error: 'Older draft lifecycle event cannot overwrite a newer pending sync' }
    }
    const attempts = current.lifecycleSync?.payload.eventId === payload.eventId
      ? current.lifecycleSync.attempts + 1
      : 1
    const nextRetryAt = Date.now() + getLifecycleSyncRetryDelay(attempts)
    const pending = withLifecycleSync(current, { payload, attempts, nextRetryAt })
    await this.storeRecordOnly(pending)
    console.warn('[session-do] lifecycle sync retry scheduled', buildDraftLifecycleLogContext(payload, {
      attempts,
      nextRetryAt,
      error,
    }))
    return { ok: false, status: 503, error }
  }

  private async finishLifecycleSync(record: SessionRecord): Promise<{ ok: true } | { ok: false, status: number, error: string }> {
    const cleared = withLifecycleSync(record, null)
    const current = await this.getRecord()
    if (!current || cleared.version !== current.version) {
      const commit = await this.commitRecord(cleared)
      if (commit) return { ok: false, status: commit.status, error: await readErrorResponse(commit) }
      return { ok: true }
    }

    await this.storeRecordOnly(cleared)
    return { ok: true }
  }

  private async clearLifecycleSyncMarker(record: SessionRecord): Promise<void> {
    if (!record.lifecycleSync) return
    await this.storeRecordOnly(withLifecycleSync(record, null))
  }

  private async handleSessionLifecycleCommand(request: Request): Promise<Response> {
    let body: SessionLifecycleCommandRequest
    try {
      body = await request.json<SessionLifecycleCommandRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
      return json({ error: 'command type is required' }, 400)
    }

    const existing = await this.getRecord()
    if (!existing) return json({ error: 'Session not found' }, 404)
    if (typeof body.matchId === 'string' && body.matchId.length > 0 && existing.matchId !== body.matchId && existing.id !== body.matchId) {
      return json({ error: `Session ${existing.id} does not belong to match ${body.matchId}` }, 409)
    }

    const at = normalizePositiveInteger(body.at, Date.now())
    const terminalCommand = buildTerminalSyncCommand(body, existing, at)
    const persistedMatchStatus = await this.readPersistedMatchStatus(terminalCommand.matchId)
    if (persistedMatchStatus === null) return json({ error: `Match **${terminalCommand.matchId}** not found.` }, 409)
    let record: SessionRecord
    switch (body.type) {
      case 'mark-reported':
        if (existing.phase === 'reported') {
          const pendingRecord = existing.terminalSync ? existing : await this.markTerminalSyncPending(existing, terminalCommand)
          const finished = await this.finishTerminalSync(pendingRecord)
          if (!finished.ok) return json({ error: finished.error }, finished.status)
          return json({ ok: true, record: finished.record })
        }
        if (existing.phase === 'cancelled') return json({ error: 'Cancelled sessions cannot be reported' }, 409)
        if (existing.phase !== 'active' && existing.phase !== 'swap' && persistedMatchStatus !== 'completed') {
          return json({ error: `Session is not reportable (phase: ${existing.phase})` }, 409)
        }
        record = markActiveSessionReported(existing, at)
        break
      case 'cancel-session':
        if (existing.phase === 'cancelled') {
          const pendingRecord = existing.terminalSync ? existing : await this.markTerminalSyncPending(existing, terminalCommand)
          const finished = await this.finishTerminalSync(pendingRecord)
          if (!finished.ok) return json({ error: finished.error }, finished.status)
          return json({ ok: true, record: finished.record })
        }
        if (existing.phase === 'reported') return json({ error: 'Reported sessions cannot be cancelled' }, 409)
        if (existing.phase === 'open') return json({ error: 'Open sessions must use cancel-open-session' }, 409)
        record = cancelNonOpenSession(existing, at)
        break
      default:
        return json({ error: 'Unknown session lifecycle command' }, 400)
    }

    const pending = await this.markTerminalSyncPending(record, terminalCommand)
    const finished = await this.finishTerminalSync(pending)
    if (!finished.ok) return json({ error: finished.error }, finished.status)
    return json({ ok: true, record: finished.record })
  }

  private async handleSessionProjectionCommand(request: Request): Promise<Response> {
    let body: SessionProjectionCommandRequest
    try {
      body = await request.json<SessionProjectionCommandRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
      return json({ error: 'command type is required' }, 400)
    }

    const existing = await this.getRecord()
    if (!existing) return json({ error: 'Session not found' }, 404)
    if ((existing.phase === 'reported' || existing.phase === 'cancelled') && body.type !== 'set-message') {
      return json({ error: `Session projection is closed (phase: ${existing.phase})` }, 409)
    }

    switch (body.type) {
      case 'set-message': {
        const expected = normalizeOptionalPositiveInteger(body.expectedVersion)
        if (expected != null && expected !== existing.version) return versionConflictResponse(expected, existing.version)
        const channelId = typeof body.channelId === 'string' && body.channelId.length > 0 ? body.channelId : existing.projectionState.channelId
        const messageId = typeof body.messageId === 'string' && body.messageId.length > 0 ? body.messageId : existing.projectionState.messageId
        if (existing.projectionState.channelId === channelId && existing.projectionState.messageId === messageId) return json({ ok: true, record: existing })
        const at = normalizePositiveInteger(body.now, Date.now())
        const record = {
          ...existing,
          version: existing.version + 1,
          projectionState: {
            ...existing.projectionState,
            channelId,
            messageId,
          },
          updatedAt: at,
        } satisfies SessionRecord
        const commit = await this.commitRecord(record)
        if (commit) return commit
        return json({ ok: true, record })
      }
      case 'set-steam-lobby-link': {
        const expected = normalizeOptionalPositiveInteger(body.expectedVersion)
        if (expected != null && expected !== existing.version) return versionConflictResponse(expected, existing.version)
        const steamLobbyLink = typeof body.steamLobbyLink === 'string' ? body.steamLobbyLink : null
        if (existing.projectionState.steamLobbyLink === steamLobbyLink) return json({ ok: true, record: existing })
        const at = normalizePositiveInteger(body.now, Date.now())
        const record = {
          ...existing,
          version: existing.version + 1,
          projectionState: {
            ...existing.projectionState,
            steamLobbyLink,
          },
          updatedAt: at,
          lastActivityAt: at,
        } satisfies SessionRecord
        const commit = await this.commitRecord(record)
        if (commit) return commit
        return json({ ok: true, record })
      }
      default:
        return json({ error: 'Unknown session projection command' }, 400)
    }
  }

  private async commitRecord(record: SessionRecord): Promise<Response | null> {
    let projected = false
    try {
      await this.ctx.storage.put(SESSION_COMMIT_INTENT_STORAGE_KEY, { record, createdAt: Date.now() } satisfies SessionCommitIntent)
      await this.scheduleCommitIntentRepairAlarm()
      if (this.env.DB) await projectSessionRecord(createDb(this.env.DB), record)
      projected = true
      await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, record)
    }
    catch (error) {
      if (!projected) {
        await this.clearPendingCommitIntent().catch((clearError) => {
          console.error('[session-do] failed to clear unapplied commit intent', clearError)
        })
      }
      else {
        await this.scheduleCommitIntentRepairAlarm().catch((alarmError) => {
          console.error('[session-do] failed to schedule commit intent repair', alarmError)
        })
      }
      if (isSessionAdmissionError(error)) {
        return json({ error: error.message, playerIds: error.playerIds }, 409)
      }
      console.error('[session-do] failed to commit session record', error)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }

    await this.clearPendingCommitIntent().catch((error) => {
      console.error('[session-do] failed to clear completed commit intent', error)
    })

    await this.publishActivityUpdate(record)
    await this.broadcastSelectedSessionUpdate(record)
    await this.scheduleLifecycleSyncAlarm(record).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after commit', error)
    })
    return null
  }

  private async recoverPendingCommitIntent(): Promise<void> {
    const intent = await this.ctx.storage.get<SessionCommitIntent>(SESSION_COMMIT_INTENT_STORAGE_KEY) ?? null
    if (!intent?.record) return

    const current = await this.getRecord()
    if (current && current.version >= intent.record.version) {
      await this.clearPendingCommitIntent().catch((error) => {
        console.error('[session-do] failed to clear obsolete commit intent', error)
      })
      return
    }

    try {
      if (this.env.DB) await projectSessionRecord(createDb(this.env.DB), intent.record)
      await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, intent.record)
      await this.clearPendingCommitIntent()
    }
    catch (error) {
      console.error('[session-do] failed to recover pending commit intent', error)
      await this.scheduleCommitIntentRepairAlarm().catch((alarmError) => {
        console.error('[session-do] failed to reschedule commit intent repair', alarmError)
      })
      return
    }

    await this.publishActivityUpdate(intent.record)
    await this.broadcastSelectedSessionUpdate(intent.record)
    await this.scheduleLifecycleSyncAlarm(intent.record).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after commit intent recovery', error)
    })
  }

  private async clearPendingCommitIntent(): Promise<void> {
    await this.ctx.storage.delete(SESSION_COMMIT_INTENT_STORAGE_KEY)
  }

  private async scheduleCommitIntentRepairAlarm(): Promise<void> {
    const storage = this.ctx.storage as DurableObjectStorage & {
      setAlarm?: (scheduledTime: number | Date) => Promise<void>
    }
    if (typeof storage.setAlarm === 'function') await storage.setAlarm(Date.now() + LIFECYCLE_SYNC_RETRY_BASE_MS)
  }

  private async storeRecordOnly(record: SessionRecord): Promise<void> {
    await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, record)
    await this.scheduleLifecycleSyncAlarm(record).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after record store', error)
    })
  }

  private async updateMessageProjection(record: SessionRecord, messageId: string): Promise<void> {
    if (record.projectionState.messageId === messageId) return
    const current = await this.getRecord()
    if (!current || current.version !== record.version) return
    const updated = {
      ...current,
      version: current.version + 1,
      projectionState: {
        ...current.projectionState,
        messageId,
      },
      updatedAt: Date.now(),
    } satisfies SessionRecord
    const failed = await this.commitRecord(updated)
    if (failed) console.error('[session-do] failed to persist rebound lobby message id', await readErrorResponse(failed))
  }

  private async scheduleLifecycleSyncAlarm(record: SessionRecord): Promise<void> {
    await this.rescheduleSessionAlarm(record)
  }

  private async clearLifecycleSyncAlarm(): Promise<void> {
    await this.rescheduleSessionAlarm(await this.getRecord())
  }

  protected override async setDraftRuntimeAlarm(_nextAlarm: number | null): Promise<void> {
    await this.rescheduleSessionAlarm(await this.getRecord())
  }

  private async rescheduleSessionAlarm(record: SessionRecord | null): Promise<void> {
    const draftStartRetryAt = record?.phase === 'draft' && record.draftStartSync
      ? record.draftStartSync.nextRetryAt > 0 ? record.draftStartSync.nextRetryAt : Date.now()
      : null
    const lifecycleRetryAt = record?.lifecycleSync && record.lifecycleSync.nextRetryAt > 0
      ? record.lifecycleSync.nextRetryAt
      : null
    const terminalRetryAt = record?.terminalSync && record.terminalSync.nextRetryAt > 0
      ? record.terminalSync.nextRetryAt
      : null
    const projectionRetryAt = record?.projectionSync && record.projectionSync.nextRetryAt > 0
      ? record.projectionSync.nextRetryAt
      : null
    const draftRuntimeAlarmAt = await this.getDraftRuntimeAlarmAt()
    const candidates = [draftStartRetryAt, lifecycleRetryAt, terminalRetryAt, projectionRetryAt, draftRuntimeAlarmAt].filter((value): value is number => typeof value === 'number')
    const storage = this.ctx.storage as DurableObjectStorage & {
      setAlarm?: (scheduledTime: number | Date) => Promise<void>
      deleteAlarm?: () => Promise<void>
    }

    if (candidates.length === 0) {
      if (typeof storage.deleteAlarm === 'function') await storage.deleteAlarm()
      return
    }

    if (typeof storage.setAlarm === 'function') await storage.setAlarm(Math.min(...candidates))
  }

  private async markTerminalSyncPending(record: SessionRecord, command: SessionTerminalSyncCommand): Promise<SessionRecord> {
    const existing = isSameTerminalSyncCommand(record.terminalSync?.command, command) ? record.terminalSync : null
    const marked = withTerminalSync(record, {
      command,
      attempts: existing?.attempts ?? 0,
      nextRetryAt: 0,
    })
    await this.storeRecordOnly(marked)
    return marked
  }

  private async deferTerminalSync(record: SessionRecord, command: SessionTerminalSyncCommand, error: string): Promise<{ ok: false, status: number, error: string }> {
    const current = await this.getRecord() ?? record
    const attempts = isSameTerminalSyncCommand(current.terminalSync?.command, command)
      ? current.terminalSync!.attempts + 1
      : 1
    const nextRetryAt = Date.now() + getLifecycleSyncRetryDelay(attempts)
    const pending = withTerminalSync(current, { command, attempts, nextRetryAt })
    await this.storeRecordOnly(pending)
    console.warn('[session-do] terminal lifecycle sync retry scheduled', {
      type: command.type,
      matchId: command.matchId,
      attempts,
      nextRetryAt,
      error,
    })
    return { ok: false, status: 503, error }
  }

  private async finishTerminalSync(record: SessionRecord): Promise<{ ok: true, record: SessionRecord } | { ok: false, status: number, error: string }> {
    const pending = record.terminalSync ?? null
    if (!pending) return { ok: true, record }
    if (!this.env.DB) return await this.deferTerminalSync(record, pending.command, 'D1 binding is not configured')

    const cleared = withTerminalSync(record, null)
    try {
      const db = createDb(this.env.DB)
      await this.applyTerminalLifecycleSideEffects(db, pending.command)
      await projectSessionRecord(db, cleared)
    }
    catch (error) {
      if (error instanceof TerminalMatchNotFoundError) return { ok: false, status: 409, error: error.message }
      return await this.deferTerminalSync(record, pending.command, error instanceof Error ? error.message : String(error))
    }

    await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, cleared)
    await this.publishActivityUpdate(cleared)
    await this.broadcastSelectedSessionUpdate(cleared)
    await this.scheduleLifecycleSyncAlarm(cleared).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after terminal sync', error)
    })
    return { ok: true, record: cleared }
  }

  private async applyTerminalLifecycleSideEffects(db: ReturnType<typeof createDb>, command: SessionTerminalSyncCommand): Promise<void> {
    if (command.type === 'mark-reported') {
      const [match] = await db
        .select({ draftData: matches.draftData, completedAt: matches.completedAt })
        .from(matches)
        .where(eq(matches.id, command.matchId))
        .limit(1)
      if (!match) throw new TerminalMatchNotFoundError(command.matchId)
      const values: { status: string, completedAt: number, draftData?: string | null } = {
        status: 'completed',
        completedAt: match.completedAt ?? command.at,
      }
      if (command.reportedById && command.reportedById.trim().length > 0) {
        values.draftData = setReportedByInDraftData(match.draftData, command.reportedById)
      }

      const updated = await db.update(matches).set(values).where(eq(matches.id, command.matchId)).returning({ id: matches.id })
      if (updated.length === 0) throw new TerminalMatchNotFoundError(command.matchId)
      await db.delete(matchBans).where(eq(matchBans.matchId, command.matchId))
      return
    }

    const updated = await db.update(matches)
      .set({ status: 'cancelled', completedAt: command.at })
      .where(eq(matches.id, command.matchId))
      .returning({ id: matches.id })
    if (updated.length === 0) throw new TerminalMatchNotFoundError(command.matchId)
    await db.delete(matchBans).where(eq(matchBans.matchId, command.matchId))
  }

  private async readPersistedMatchStatus(matchId: string): Promise<string | null | undefined> {
    if (!this.env.DB) return undefined
    try {
      const [match] = await createDb(this.env.DB)
        .select({ status: matches.status })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      return match?.status ?? null
    }
    catch {
      return undefined
    }
  }

  private async publishActivityUpdate(record: SessionRecord): Promise<void> {
    try {
      await publishActivitySessionUpdate(this.env.Activity, record, this.env.CIVUP_SECRET)
    }
    catch (error) {
      console.warn('[session-do] failed to publish activity update', error)
    }
  }

  private async broadcastSelectedSessionUpdate(record: SessionRecord): Promise<void> {
    const openLobbyConnections = Array.from(this.getConnections()).filter((connection) => {
      const state = connection.state as SessionConnectionState | null
      return state?.openLobby === true
    })
    if (openLobbyConnections.length === 0) return

    if (record.phase === 'open') {
      await Promise.all(openLobbyConnections.map(connection => this.sendOpenLobbySnapshot(connection, record)))
      return
    }

    if (record.phase === 'draft' && record.matchId) {
      await Promise.all(openLobbyConnections.map(connection => this.sendSessionStarted(connection, record)))
      return
    }

    if (record.phase === 'cancelled' || record.phase === 'reported') {
      for (const connection of openLobbyConnections) {
        this.sendSessionMessage(connection, { type: 'lobby', lobbyId: record.id, snapshot: null })
      }
    }
  }

  private async sendOpenLobbySnapshot(connection: Connection, record: OpenSessionRecord): Promise<void> {
    if (!this.env.KV) {
      this.sendSessionMessage(connection, { type: 'error', message: 'Session lobby snapshots are not configured' })
      return
    }
    this.sendSessionMessage(connection, {
      type: 'lobby',
      lobbyId: record.id,
      snapshot: await buildLobbySnapshotFromSessionRecord(this.env.KV, record),
    })
  }

  private async sendSessionStarted(connection: Connection, record: DraftSessionRecord): Promise<void> {
    const state = connection.state as SessionConnectionState | null
    const playerId = state?.playerId ?? null
    const sessionAccessToken = playerId && this.env.CIVUP_SECRET
      ? await createSessionAccessToken(this.env.CIVUP_SECRET, {
        userId: playerId,
        sessionId: record.matchId,
        channelId: record.projectionState.channelId,
      })
      : null

    this.sendSessionMessage(connection, {
      type: 'session-started',
      lobbyId: record.id,
      matchId: record.matchId,
      steamLobbyLink: record.projectionState.steamLobbyLink,
      sessionAccessToken,
      mode: record.mode,
    })
  }

  private sendSessionMessage(connection: Connection, message: SessionServerMessage): void {
    connection.send(JSON.stringify(message))
  }

  private async runSerializedCommand(operation: () => Promise<Response>): Promise<Response> {
    const previous = this.commandQueue
    let release!: () => void
    this.commandQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous.catch(() => undefined)
    try {
      await this.recoverPendingCommitIntent()
      return await operation()
    }
    finally {
      release()
    }
  }
}

const LIFECYCLE_SYNC_RETRY_BASE_MS = 1_000
const LIFECYCLE_SYNC_RETRY_MAX_MS = 60_000
const PROJECTION_SYNC_RETRY_BASE_MS = 2_000
const PROJECTION_SYNC_RETRY_MAX_MS = 60_000
const PROJECTION_SYNC_MAX_ATTEMPTS = 5

type LifecycleTransitionResult =
  | { record: SessionRecord, ignored?: boolean }
  | { ok: false, status: number, error: string }

function transitionRecordForDraftLifecycle(record: SessionRecord, payload: DraftLifecyclePayload): LifecycleTransitionResult {
  const at = payload.outcome === 'complete' ? payload.completedAt : payload.cancelledAt

  if (payload.outcome === 'complete') {
    switch (payload.eventKind) {
      case 'DraftCompleted':
        if (record.phase === 'swap' || record.phase === 'active') return { record }
        if (record.phase !== 'draft') return { record, ignored: true }
        return {
          record: {
            ...record,
            phase: canOpenSwapWindowForState(payload.state) ? 'swap' : 'active',
            version: record.version + 1,
            updatedAt: at,
            lastActivityAt: at,
            closedAt: null,
            draftStartSync: null,
          },
        }
      case 'SwapAccepted':
        if (record.phase === 'active') return { record }
        if (record.phase !== 'swap' && record.phase !== 'draft') return { record, ignored: true }
        return {
          record: {
            ...record,
            phase: 'swap',
            version: record.version + 1,
            updatedAt: at,
            lastActivityAt: at,
            closedAt: null,
            draftStartSync: null,
          },
        }
      case 'DraftFinalized':
        if (record.phase === 'active') return { record }
        if (record.phase !== 'swap' && record.phase !== 'draft') return { record, ignored: true }
        return {
          record: {
            ...record,
            phase: 'active',
            version: record.version + 1,
            updatedAt: at,
            lastActivityAt: at,
            closedAt: null,
            draftStartSync: null,
          },
        }
      default:
        return { ok: false, status: 400, error: 'Unknown draft lifecycle event kind' }
    }
  }

  if (payload.reason === 'timeout' || payload.reason === 'revert') {
    if (record.phase === 'open') return { record }
    if (record.phase !== 'draft') return { record, ignored: true }
    return { record: reopenDraftSession(record, at) }
  }

  if (record.phase === 'cancelled') return { record }
  if (record.phase !== 'draft' && record.phase !== 'swap') return { record, ignored: true }
  return {
    record: {
      ...record,
      phase: 'cancelled',
      version: record.version + 1,
        updatedAt: at,
        lastActivityAt: at,
        closedAt: at,
        draftStartSync: null,
      },
    }
  }

function withDraftStartSync(record: DraftSessionRecord, draftStartSync: SessionDraftStartSyncState | null): DraftSessionRecord {
  return {
    ...record,
    draftStartSync,
  }
}

function withLifecycleEventSequence(record: SessionRecord, eventSequence: number): SessionRecord {
  return {
    ...record,
    lifecycleEventSequence: Math.max(record.lifecycleEventSequence ?? 0, eventSequence),
  } as SessionRecord
}

function withLifecycleSync(record: SessionRecord, lifecycleSync: SessionLifecycleSyncState | null): SessionRecord {
  return {
    ...record,
    lifecycleSync,
  } as SessionRecord
}

function withProjectionSync(record: SessionRecord, projectionSync: SessionProjectionSyncState | null): SessionRecord {
  return {
    ...record,
    projectionSync,
  } as SessionRecord
}

function withTerminalSync(record: SessionRecord, terminalSync: SessionTerminalSyncState | null): SessionRecord {
  return {
    ...record,
    terminalSync,
  } as SessionRecord
}

function isTerminalSessionPhase(phase: SessionRecord['phase']): boolean {
  return phase === 'reported' || phase === 'cancelled'
}

function buildTerminalSyncCommand(
  body: Extract<SessionLifecycleCommandRequest, { type: 'mark-reported' | 'cancel-session' }>,
  record: SessionRecord,
  at: number,
): SessionTerminalSyncCommand {
  const matchId = typeof body.matchId === 'string' && body.matchId.length > 0
    ? body.matchId
    : record.matchId ?? record.id
  if (body.type === 'mark-reported') {
    return {
      type: 'mark-reported',
      matchId,
      at,
      reportedById: typeof body.reportedById === 'string' && body.reportedById.trim().length > 0 ? body.reportedById.trim() : null,
    }
  }
  return { type: 'cancel-session', matchId, at }
}

function isSameTerminalSyncCommand(left: SessionTerminalSyncCommand | null | undefined, right: SessionTerminalSyncCommand): boolean {
  return left?.type === right.type && left.matchId === right.matchId && left.at === right.at
}

function validateDraftLifecyclePayload(payload: DraftLifecyclePayload): string | null {
  if (!payload || typeof payload !== 'object') return 'payload is required'
  if (typeof payload.eventId !== 'string' || payload.eventId.length === 0) return 'eventId is required'
  if (typeof payload.eventSequence !== 'number' || !Number.isFinite(payload.eventSequence)) return 'eventSequence is required'
  if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) return 'matchId is required'
  if (!payload.state || typeof payload.state !== 'object') return 'state is required'
  if (payload.outcome === 'complete') {
    if (payload.eventKind !== 'DraftCompleted' && payload.eventKind !== 'SwapAccepted' && payload.eventKind !== 'DraftFinalized') return 'invalid complete eventKind'
    if (typeof payload.completedAt !== 'number' || !Number.isFinite(payload.completedAt)) return 'completedAt is required'
    if (payload.state.status !== 'complete') return 'complete lifecycle state must be complete'
    return null
  }
  if (payload.outcome === 'cancelled') {
    if (payload.eventKind !== 'DraftCancelled') return 'invalid cancelled eventKind'
    if (typeof payload.cancelledAt !== 'number' || !Number.isFinite(payload.cancelledAt)) return 'cancelledAt is required'
    if (payload.state.status !== 'cancelled') return 'cancelled lifecycle state must be cancelled'
    if (payload.reason !== 'cancel' && payload.reason !== 'scrub' && payload.reason !== 'timeout' && payload.reason !== 'revert') return 'invalid cancel reason'
    return null
  }
  return 'invalid lifecycle outcome'
}

function buildDraftLifecycleLogContext(payload: DraftLifecyclePayload, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'lifecycle-sync',
    eventId: payload.eventId,
    eventKind: payload.eventKind,
    eventSequence: payload.eventSequence,
    matchId: payload.matchId,
    outcome: payload.outcome,
    finalized: payload.outcome === 'complete' ? payload.finalized === true : false,
    stateStatus: payload.state.status,
    currentStepIndex: payload.state.currentStepIndex,
    ...extra,
  }
}

function buildProjectionSyncLogContext(projection: SessionProjectionSyncPayload, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = projection.payload
  return buildDraftLifecycleLogContext(payload, {
    projectionType: projection.type,
    ...extra,
  })
}

function getLifecycleSyncRetryDelay(attempts: number): number {
  return Math.min(LIFECYCLE_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), LIFECYCLE_SYNC_RETRY_MAX_MS)
}

function getProjectionSyncRetryDelay(attempts: number): number {
  return Math.min(PROJECTION_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), PROJECTION_SYNC_RETRY_MAX_MS)
}

function isSameProjectionSyncPayload(left: SessionProjectionSyncPayload | null | undefined, right: SessionProjectionSyncPayload): boolean {
  return left?.type === right.type && projectionEventId(left) === projectionEventId(right)
}

function projectionEventId(projection: SessionProjectionSyncPayload): string {
  return projection.payload.eventId
}

function projectionEventSequence(projection: SessionProjectionSyncPayload): number {
  return projection.payload.eventSequence
}

function isProjectionSyncObsolete(record: SessionRecord, projection: SessionProjectionSyncPayload): boolean {
  if ((record.matchId ?? record.id) !== projection.payload.matchId && record.id !== projection.payload.matchId) return true
  if (projection.type === 'draft-completed') return record.phase !== 'swap' && record.phase !== 'active'
  if (projection.payload.reason === 'timeout' || projection.payload.reason === 'revert') return record.phase !== 'open'
  return record.phase !== 'cancelled'
}

function setReportedByInDraftData(draftData: string | null, reporterId: string): string | null {
  const normalizedReporterId = reporterId.trim()
  if (normalizedReporterId.length === 0) return draftData
  if (!draftData) return JSON.stringify({ reportedById: normalizedReporterId })

  try {
    const parsed = JSON.parse(draftData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return draftData
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      reportedById: normalizedReporterId,
    })
  }
  catch {
    return draftData
  }
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const body = await response.json<{ error?: unknown }>()
    if (typeof body.error === 'string' && body.error.length > 0) return body.error
  }
  catch {}
  return `Session command failed: ${response.status}`
}

function isIgnorableDraftCompleteError(error: string): boolean {
  return error.includes('cannot be activated (status: cancelled)')
    || error.includes('cannot be activated (status: completed)')
}

function isIgnorableDraftCancelError(error: string): boolean {
  return error.includes('cannot be cancelled (status: active)')
    || error.includes('cannot be cancelled (status: completed)')
}

function applyOpenSessionPatch(record: OpenSessionRecord, patch: OpenSessionPatch): OpenSessionRecord {
  const mode = isGameMode(patch.mode) ? patch.mode : record.mode
  const slots = patch.slots !== undefined
    ? normalizeStoredSlots(mode, patch.slots)
    : [...record.roster.slots]
  const memberPlayerIds = patch.memberPlayerIds !== undefined
    ? normalizeMemberPlayerIds(patch.memberPlayerIds)
    : record.roster.participants.map(member => member.playerId)
  const draftConfig = patch.draftConfig !== undefined || mode !== record.mode || slots.length !== record.roster.slots.length
    ? normalizeDraftConfigForMode(mode, patch.draftConfig ?? buildLobbyDraftConfigFromSessionConfig(record.config), slots.length)
    : buildLobbyDraftConfigFromSessionConfig(record.config)
  const config: SessionConfig = {
    ...draftConfig,
    minRole: patch.minRole !== undefined ? normalizeCompetitiveTier(patch.minRole) : record.config.minRole,
    maxRole: patch.maxRole !== undefined ? normalizeCompetitiveTier(patch.maxRole) : record.config.maxRole,
  }
  const projectionState: SessionProjectionState = {
    channelId: typeof patch.channelId === 'string' && patch.channelId.length > 0 ? patch.channelId : record.projectionState.channelId,
    messageId: typeof patch.messageId === 'string' && patch.messageId.length > 0 ? patch.messageId : record.projectionState.messageId,
    steamLobbyLink: patch.steamLobbyLink !== undefined ? patch.steamLobbyLink : record.projectionState.steamLobbyLink,
  }
  const roster = buildNextRoster(record, memberPlayerIds, slots, patch.queueEntries)
  const nextLastActivityAt = patch.lastActivityAt !== undefined
    ? normalizePositiveInteger(patch.lastActivityAt, record.lastActivityAt)
    : record.lastActivityAt
  const lastArrange = patch.lastArrange !== undefined ? normalizeLobbyArrangeMarker(patch.lastArrange) : record.lastArrange

  const next = {
    ...record,
    mode,
    config,
    roster,
    lastArrange,
    projectionState,
    lastActivityAt: nextLastActivityAt,
  } satisfies OpenSessionRecord

  if (sameOpenSessionRecord(record, next)) return record
  return {
    ...next,
    version: record.version + 1,
    updatedAt: normalizePositiveInteger(patch.updatedAt, Date.now()),
  }
}

function cancelOpenSession(record: OpenSessionRecord, at: number | undefined): SessionRecord {
  const now = normalizePositiveInteger(at, Date.now())
  return {
    ...record,
    phase: 'cancelled',
    version: record.version + 1,
    frozenAt: null,
    updatedAt: now,
    closedAt: now,
    projectionSync: null,
  }
}

function markActiveSessionReported(record: SessionRecord, at: number): SessionRecord {
  return {
    ...record,
    phase: 'reported',
    version: record.version + 1,
    updatedAt: at,
    lastActivityAt: at,
    closedAt: at,
    projectionSync: null,
  } as SessionRecord
}

function cancelNonOpenSession(record: SessionRecord, at: number): SessionRecord {
  return {
    ...record,
    phase: 'cancelled',
    version: record.version + 1,
    frozenAt: 'frozenAt' in record ? record.frozenAt : null,
    updatedAt: at,
    lastActivityAt: at,
    closedAt: at,
    projectionSync: null,
  } as SessionRecord
}

function reopenDraftSession(record: DraftSessionRecord, at: number): OpenSessionRecord {
  return {
    id: record.id,
    phase: 'open',
    version: record.version + 1,
    hostId: record.hostId,
    guildId: record.guildId,
    channelId: record.channelId,
    mode: record.mode,
    matchId: null,
    config: record.config,
    roster: record.roster,
    lastArrange: record.lastArrange,
    projectionState: record.projectionState,
    createdAt: record.createdAt,
    updatedAt: at,
    lastActivityAt: at,
    closedAt: null,
    draftStartSync: null,
    lifecycleEventSequence: record.lifecycleEventSequence ?? 0,
    lifecycleSync: record.lifecycleSync ?? null,
    projectionSync: null,
    terminalSync: record.terminalSync ?? null,
  }
}

function buildNextRoster(
  record: OpenSessionRecord,
  memberPlayerIds: string[],
  slots: (string | null)[],
  queueEntries: QueueEntry[] | undefined,
): SessionRoster {
  const existingEntries = buildSessionRosterQueueEntries(record)
  const entryByPlayerId = new Map(existingEntries.map(entry => [entry.playerId, entry]))
  for (const entry of queueEntries ?? []) {
    if (entry?.playerId) entryByPlayerId.set(entry.playerId, entry)
  }
  return buildSessionRoster({ memberPlayerIds, slots }, [...entryByPlayerId.values()])
}

function sameOpenSessionRecord(left: OpenSessionRecord, right: OpenSessionRecord): boolean {
  return left.mode === right.mode
    && sameSessionConfig(left.config, right.config)
    && sameSessionRoster(left.roster, right.roster)
    && sameProjectionState(left.projectionState, right.projectionState)
    && left.lastActivityAt === right.lastActivityAt
    && sameLobbyArrangeMarker(left.lastArrange, right.lastArrange)
}

function sameSessionConfig(left: SessionConfig, right: SessionConfig): boolean {
  return sameDraftConfig(left, right)
    && left.minRole === right.minRole
    && left.maxRole === right.maxRole
}

function sameSessionRoster(left: SessionRoster, right: SessionRoster): boolean {
  return sameStringArray(left.slots.map(value => value ?? ''), right.slots.map(value => value ?? ''))
    && JSON.stringify(left.participants) === JSON.stringify(right.participants)
}

function sameProjectionState(left: SessionProjectionState, right: SessionProjectionState): boolean {
  return left.channelId === right.channelId
    && left.messageId === right.messageId
    && left.steamLobbyLink === right.steamLobbyLink
}

function sameLobbyArrangeMarker(left: LobbyArrangeMarker | null, right: LobbyArrangeMarker | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.strategy === right.strategy && left.at === right.at
}

function normalizeLobbyArrangeMarker(value: LobbyArrangeMarker | null): LobbyArrangeMarker | null {
  if (!value) return null
  if (value.strategy !== 'randomize' && value.strategy !== 'balance' && value.strategy !== 'shuffle-teams') return null
  return { strategy: value.strategy, at: normalizePositiveInteger(value.at, Date.now()) }
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return normalizeOptionalPositiveInteger(value) ?? Math.max(1, Math.round(fallback))
}

function versionConflictResponse(expectedVersion: number, currentVersion: number): Response {
  const label = expectedVersion < currentVersion ? 'stale' : 'mismatched'
  return json({ error: `Session version is ${label} (expected ${expectedVersion}, current ${currentVersion})` }, 409)
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
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

  if (mode === 'ffa') return `Leaders must be at least ${minimumSize} for a ${playerCount}-player FFA.`
  return `Leaders must be at least ${minimumSize} for ${formatModeLabel(mode)}.`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
