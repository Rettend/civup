import type { CompetitiveTier, DraftSeat, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { DraftSessionRecord, OpenSessionRecord, SessionConfig, SessionLifecycleSyncState, SessionProjectionState, SessionRecord, SessionRoster } from './session-record.ts'
import { createDb } from '@civup/db'
import { canStartWithPlayerCount, formatModeLabel, GAME_MODES, getMinimumLeaderPoolSize } from '@civup/game'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed } from '../embeds/match.ts'
import { buildDraftRuntimeConfig } from '../services/activity/index.ts'
import { resolveDraftTimerConfig } from '../services/config/index.ts'
import { normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from '../services/lobby/normalize.ts'
import { upsertLobbyMessage } from '../services/lobby/message.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { mapLobbySlotsToEntries } from '../services/lobby/slots.ts'
import { clearLobbyById, putLobby } from '../services/lobby/store.ts'
import { activateDraftMatch, cancelDraftMatch, createDraftMatch } from '../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../services/match/message.ts'
import { isSessionAdmissionError, projectSessionRecord } from '../services/session/directory.ts'
import { publishActivitySessionUpdate } from './activity-feed-client.ts'
import { SessionDraftRuntime, type DraftRuntimeEnv } from './draft-room.ts'
import { buildLobbyDraftConfigFromSessionConfig, buildLobbyProjectionFromSessionRecord, buildOpenSessionRecordFromLobby, buildSessionRoster, buildSessionRosterQueueEntries, buildSessionRosterSlotEntries } from './session-record.ts'
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
    type: 'set-steam-lobby-link'
    expectedVersion?: number
    steamLobbyLink: string | null
    now?: number
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

export class SessionDO extends SessionDraftRuntime<SessionDOEnv> {
  private commandQueue: Promise<void> = Promise.resolve()

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/record') {
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

    if (request.method === 'POST' && url.pathname === '/commands/session-projection') {
      return await this.runSerializedCommand(() => this.handleSessionProjectionCommand(request))
    }

    return await super.onRequest(request)
  }

  override async onAlarm(): Promise<void> {
    await this.runSerializedCommand(async () => {
      await this.retryPendingLifecycleSync()
      await this.handleDraftRuntimeAlarmIfDue()
      await this.rescheduleSessionAlarm(await this.getRecord())
      return json({ ok: true })
    })
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.ctx.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
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
      if (expected < existing.version) return json({ ok: true, record: existing })
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
      const existingRoom = await this.getRoomRecord()
      return json({ ok: true, record, matchId: record.matchId, seats: existingRoom?.config.seats ?? [], idempotent: true } satisfies { ok: true } & StartDraftCommandResult)
    }
    if (record.phase !== 'open') {
      return json({ error: `Session is not open (phase: ${record.phase})` }, 409)
    }
    if (body?.hostId && body.hostId !== record.hostId) {
      return json({ error: 'Only the session host can start the draft' }, 403)
    }

    const expected = normalizeOptionalPositiveInteger(body?.expectedVersion)
    if (expected != null && expected < record.version) return json({ error: 'Session changed before draft start' }, 409)

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
    if (!this.env.KV) return json({ error: 'KV binding is not configured' }, 503)

    const now = normalizePositiveInteger(body?.now, Date.now())
    const matchId = record.id
    const timerConfig = await resolveDraftTimerConfig(this.env.KV, record.config)

    let room: { matchId: string, seats: DraftSeat[] }
    try {
      const existingRoom = await this.getRoomRecord()
      if (existingRoom && existingRoom.state.status !== 'cancelled') {
        if (existingRoom.state.matchId !== matchId) return json({ error: 'Existing draft runtime belongs to a different session' }, 409)
        room = { matchId: existingRoom.state.matchId, seats: existingRoom.config.seats }
      }
      else {
        const runtime = buildDraftRuntimeConfig(record.mode, selectedEntries, {
          matchId,
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
        await this.initializeDraftRuntime(runtime.config, { existing: existingRoom })
        room = { matchId: runtime.matchId, seats: runtime.seats }
      }
      await createDraftMatch(createDb(this.env.DB), { matchId: room.matchId, mode: record.mode, seats: room.seats })
    }
    catch (error) {
      console.error('[session-do] failed to start draft', error)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }

    const next: DraftSessionRecord = {
      ...record,
      phase: 'draft',
      matchId: room.matchId,
      version: record.version + 1,
      frozenAt: now,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
    }

    const commit = await this.commitRecord(next)
    if (commit) return commit

    return json({ ok: true, record: next, matchId: room.matchId, seats: room.seats } satisfies { ok: true } & StartDraftCommandResult)
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

  private async syncDraftLifecyclePayload(payload: DraftLifecyclePayload): Promise<{ ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }> {
    const existing = await this.getRecord()
    if (!existing) return { ok: false, status: 404, error: 'Session not found' }
    if (payload.matchId !== existing.id) return { ok: false, status: 409, error: `Lifecycle payload ${payload.matchId} does not belong to session ${existing.id}` }

    const marked = await this.markLifecycleSyncPending(existing, payload)
    if (!this.env.DB) return await this.deferLifecycleSync(marked, payload, 'D1 binding is not configured')
    if (!this.env.KV) return await this.deferLifecycleSync(marked, payload, 'KV binding is not configured')

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
    const committed = await this.finishLifecycleSync(transition.record)
    if (!committed.ok) return committed

    if (transition.ignored) return { ok: true, ignored: true }
    if (result.alreadyActive && payload.finalized !== true && transition.record === record) return { ok: true, synced: true }

    await this.updateCompletedDraftProjection(db, payload, result, transition.record, context)
    return { ok: true }
  }

  private async syncDraftCancelled(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'cancelled' }>,
    record: SessionRecord,
  ): Promise<{ ok: true, ignored?: boolean, synced?: boolean } | { ok: false, status: number, error: string }> {
    if (!this.env.KV) return { ok: false, status: 503, error: 'KV binding is not configured' }

    const context = buildDraftLifecycleLogContext(payload)
    const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
    if (!hostId) return { ok: false, status: 400, error: 'Draft lifecycle payload missing host identity' }

    const cancelled = await cancelDraftMatch(db, this.env.KV, {
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
    const committed = await this.finishLifecycleSync(transition.record)
    if (!committed.ok) return committed

    if (transition.ignored) return { ok: true, ignored: true }
    await this.updateCancelledDraftProjection(db, payload, cancelled, transition.record, context)
    return { ok: true }
  }

  private async updateCompletedDraftProjection(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'complete' }>,
    result: Awaited<ReturnType<typeof activateDraftMatch>> & { error?: never },
    record: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.env.KV) return
    if (!this.env.DISCORD_TOKEN) return

    const activeLobby = buildLobbyProjectionFromSessionRecord(record)
    try {
      const updatedLobby = await upsertLobbyMessage(this.env.KV, this.env.DISCORD_TOKEN, activeLobby, {
        embeds: [lobbyDraftCompleteEmbed(activeLobby.mode, result.participants, payload.mapVoteResult ?? null, activeLobby.draftConfig.leaderDataVersion, activeLobby.draftConfig.redDeath)],
        components: lobbyComponents(activeLobby.mode, activeLobby.id),
      })
      await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
    }
    catch (error) {
      console.error('[session-do] failed to update completion embed', context, error)
    }
  }

  private async updateCancelledDraftProjection(
    db: ReturnType<typeof createDb>,
    payload: Extract<DraftLifecyclePayload, { outcome: 'cancelled' }>,
    cancelled: Awaited<ReturnType<typeof cancelDraftMatch>> & { error?: never },
    record: SessionRecord,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.env.KV) return
    const lifecycleLobby = buildLobbyProjectionFromSessionRecord(record)
    if (payload.reason === 'timeout' || payload.reason === 'revert') {
      const queueEntries = buildSessionRosterQueueEntries(record)
      if (!this.env.DISCORD_TOKEN) return
      try {
        const slottedEntries = mapLobbySlotsToEntries(lifecycleLobby.slots, queueEntries)
        const renderPayload = await buildOpenLobbyRenderPayload(this.env.KV, lifecycleLobby, slottedEntries)
        const updatedLobby = await upsertLobbyMessage(this.env.KV, this.env.DISCORD_TOKEN, lifecycleLobby, renderPayload)
        await clearMatchMessageMapping(db, updatedLobby.messageId)
      }
      catch (error) {
        console.error('[session-do] failed to update reopened lobby embed', context, error)
      }
      return
    }

    if (this.env.DISCORD_TOKEN) {
      try {
        const updatedLobby = await upsertLobbyMessage(this.env.KV, this.env.DISCORD_TOKEN, lifecycleLobby, {
          embeds: [lobbyCancelledEmbed(lifecycleLobby.mode, cancelled.participants, payload.reason, undefined, lifecycleLobby.draftConfig.leaderDataVersion, lifecycleLobby.draftConfig.redDeath)],
          components: [],
        })
        await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
      }
      catch (error) {
        console.error('[session-do] failed to update cancelled embed', context, error)
      }
    }

    await clearLobbyById(this.env.KV, lifecycleLobby.id, lifecycleLobby)
  }

  private async markLifecycleSyncPending(record: SessionRecord, payload: DraftLifecyclePayload): Promise<SessionRecord> {
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
    if (existing.phase === 'reported' || existing.phase === 'cancelled') {
      return json({ error: `Session projection is closed (phase: ${existing.phase})` }, 409)
    }

    switch (body.type) {
      case 'set-steam-lobby-link': {
        const expected = normalizeOptionalPositiveInteger(body.expectedVersion)
        if (expected != null && expected < existing.version) return json({ ok: true, record: existing })
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
    try {
      if (this.env.DB) await projectSessionRecord(createDb(this.env.DB), record)
      await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, record)
    }
    catch (error) {
      if (isSessionAdmissionError(error)) {
        return json({ error: error.message, playerIds: error.playerIds }, 409)
      }
      console.error('[session-do] failed to commit session record', error)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }

    await this.writeSessionProjectionCache(record)
    await this.publishActivityUpdate(record)
    await this.scheduleLifecycleSyncAlarm(record).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after commit', error)
    })
    return null
  }

  private async writeSessionProjectionCache(record: SessionRecord): Promise<void> {
    if (!this.env.KV) return
    try {
      await putLobby(this.env.KV, buildLobbyProjectionFromSessionRecord(record))
    }
    catch (error) {
      console.error('[session-do] failed to write lobby projection cache', error)
    }
  }

  private async storeRecordOnly(record: SessionRecord): Promise<void> {
    await this.ctx.storage.put(SESSION_RECORD_STORAGE_KEY, record)
    await this.scheduleLifecycleSyncAlarm(record).catch((error) => {
      console.error('[session-do] failed to schedule session alarm after record store', error)
    })
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
    const lifecycleRetryAt = record?.lifecycleSync && record.lifecycleSync.nextRetryAt > 0
      ? record.lifecycleSync.nextRetryAt
      : null
    const draftRuntimeAlarmAt = await this.getDraftRuntimeAlarmAt()
    const candidates = [lifecycleRetryAt, draftRuntimeAlarmAt].filter((value): value is number => typeof value === 'number')
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

  private async publishActivityUpdate(record: SessionRecord): Promise<void> {
    try {
      await publishActivitySessionUpdate(this.env.Activity, record, this.env.CIVUP_SECRET)
    }
    catch (error) {
      console.warn('[session-do] failed to publish activity update', error)
    }
  }

  private async runSerializedCommand(operation: () => Promise<Response>): Promise<Response> {
    const previous = this.commandQueue
    let release!: () => void
    this.commandQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous.catch(() => undefined)
    try {
      return await operation()
    }
    finally {
      release()
    }
  }
}

const LIFECYCLE_SYNC_RETRY_BASE_MS = 1_000
const LIFECYCLE_SYNC_RETRY_MAX_MS = 60_000

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
    },
  }
}

function withLifecycleSync(record: SessionRecord, lifecycleSync: SessionLifecycleSyncState | null): SessionRecord {
  return {
    ...record,
    lifecycleSync,
  } as SessionRecord
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

function getLifecycleSyncRetryDelay(attempts: number): number {
  return Math.min(LIFECYCLE_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), LIFECYCLE_SYNC_RETRY_MAX_MS)
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
    version: Math.max(record.version + 1, (normalizeOptionalPositiveInteger(patch.expectedVersion) ?? record.version) + 1),
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
  }
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

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
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
