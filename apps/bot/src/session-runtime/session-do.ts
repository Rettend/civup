import type { CompetitiveTier, DraftSeat, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { DraftSessionRecord, OpenSessionRecord, SessionConfig, SessionProjectionState, SessionRecord, SessionRoster } from './session-record.ts'
import { createDb } from '@civup/db'
import { canStartWithPlayerCount, formatModeLabel, GAME_MODES, getMinimumLeaderPoolSize } from '@civup/game'
import { createDraftRoom } from '../services/activity/index.ts'
import { resolveDraftTimerConfig } from '../services/config/index.ts'
import { normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from '../services/lobby/normalize.ts'
import { syncLobbyDerivedState } from '../services/lobby/live-snapshot.ts'
import { putLobby } from '../services/lobby/store.ts'
import { createDraftMatch } from '../services/match/index.ts'
import { clearQueue } from '../services/queue/index.ts'
import { isSessionAdmissionError, projectSessionRecord } from '../services/session/directory.ts'
import { buildLobbyDraftConfigFromSessionConfig, buildLobbyProjectionFromSessionRecord, buildOpenSessionRecordFromLobby, buildSessionRoster, buildSessionRosterQueueEntries, buildSessionRosterSlotEntries } from './session-record.ts'

interface SessionDOEnv extends Cloudflare.Env {
  DB?: D1Database
  KV?: KVNamespace
  Main?: DurableObjectNamespace
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
    type: 'update-open-lobby'
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
  | {
    type: 'cancel-open-session'
    expectedVersion?: number
    now?: number
  }

type DraftLifecycleCommandRequest
  = | {
    type: 'draft-completed' | 'swap-accepted' | 'draft-finalized'
    at?: number
  }
  | {
    type: 'draft-cancelled'
    reason: 'cancel' | 'scrub' | 'timeout' | 'revert'
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

export class SessionDO {
  private commandQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: SessionDOEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
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

    return json({ error: 'Not found' }, 404)
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.state.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
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
      case 'update-open-lobby':
        record = applyOpenSessionPatch(existing, body)
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
      return json({ ok: true, record, matchId: record.matchId, seats: [], idempotent: true } satisfies { ok: true } & StartDraftCommandResult)
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
      room = await createDraftRoom(record.mode, selectedEntries, {
        mainNamespace: this.env.Main,
        matchId,
        hostId: record.hostId,
        leaderDataVersion: record.config.leaderDataVersion,
        blindBans: record.config.blindBans,
        simultaneousPick: record.config.simultaneousPick,
        redDeath: record.config.redDeath,
        mapVoteEnabled: record.config.mapVoteEnabled,
        randomDraft: record.config.randomDraft,
        duplicateFactions: record.config.duplicateFactions,
        botHost: this.env.BOT_HOST,
        internalSecret: this.env.CIVUP_SECRET,
        timerConfig,
        leaderPoolSize: record.config.leaderPoolSize,
        dealOptionsSize: record.config.dealOptionsSize,
      })
      await createDraftMatch(createDb(this.env.DB), { matchId: room.matchId, mode: record.mode, seats: room.seats })
      await clearQueue(this.env.KV, record.mode, record.roster.participants.map(member => member.playerId))
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
      case 'swap-accepted':
      case 'draft-finalized':
        if (existing.phase === 'active') return json({ ok: true, record: existing })
        if (existing.phase !== 'draft') return json({ error: `Session is not in draft (phase: ${existing.phase})` }, 409)
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
        if (existing.phase !== 'draft') return json({ error: `Session is not in draft (phase: ${existing.phase})` }, 409)
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

  private async commitRecord(record: SessionRecord): Promise<Response | null> {
    try {
      if (this.env.DB) await projectSessionRecord(createDb(this.env.DB), record)
      await this.state.storage.put(SESSION_RECORD_STORAGE_KEY, record)
      if (this.env.KV) {
        const lobby = buildLobbyProjectionFromSessionRecord(record)
        await putLobby(this.env.KV, lobby)
        await syncLobbyDerivedState(this.env.KV, lobby)
      }
      return null
    }
    catch (error) {
      if (isSessionAdmissionError(error)) {
        return json({ error: error.message, playerIds: error.playerIds }, 409)
      }
      console.error('[session-do] failed to commit session record', error)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
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
