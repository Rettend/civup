import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { OpenSessionRecord, SessionConfig, SessionProjectionState, SessionRecord, SessionRoster } from './session-record.ts'
import { createDb } from '@civup/db'
import { GAME_MODES } from '@civup/game'
import { normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from '../services/lobby/normalize.ts'
import { isSessionAdmissionError, projectSessionRecord } from '../services/session/directory.ts'
import { buildLobbyDraftConfigFromSessionConfig, buildSessionRoster, buildSessionRosterQueueEntries, syncSessionRecordFromLobby } from './session-record.ts'

interface SessionDOEnv extends Cloudflare.Env {
  DB?: D1Database
}

interface CreateSessionFromLobbyRequest {
  lobby: LobbyState
  queueEntries?: QueueEntry[]
}

type SyncSessionFromLobbyRequest = CreateSessionFromLobbyRequest

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
      return await this.runSerializedCommand(() => this.handleSyncFromLobby(request, { requireOpenCreate: true }))
    }

    if (request.method === 'POST' && url.pathname === '/commands/sync-from-lobby') {
      return await this.runSerializedCommand(() => this.handleSyncFromLobby(request, { requireOpenCreate: false }))
    }

    if (request.method === 'POST' && url.pathname === '/commands/open-lobby') {
      return await this.runSerializedCommand(() => this.handleOpenLobbyCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/prepare-draft-start') {
      return await this.runSerializedCommand(() => this.handlePrepareDraftStart())
    }

    return json({ error: 'Not found' }, 404)
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.state.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
  }

  private async handleSyncFromLobby(
    request: Request,
    options: { requireOpenCreate: boolean },
  ): Promise<Response> {
    let body: SyncSessionFromLobbyRequest
    try {
      body = await request.json<SyncSessionFromLobbyRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body?.lobby || typeof body.lobby.id !== 'string') {
      return json({ error: 'lobby is required' }, 400)
    }
    if (options.requireOpenCreate && body.lobby.status !== 'open') {
      return json({ error: 'create-from-lobby requires an open lobby' }, 400)
    }

    const existing = await this.getRecord()
    let record: SessionRecord
    try {
      record = syncSessionRecordFromLobby(existing, body.lobby, body.queueEntries ?? [])
    }
    catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }

    if (!existing || record.version > existing.version) {
      const commit = await this.commitRecord(record)
      if (commit) return commit
    }

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

  private async handlePrepareDraftStart(): Promise<Response> {
    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    if (record.phase !== 'open') {
      return json({ error: `Session is not open (phase: ${record.phase})` }, 409)
    }

    return json({ ok: true, record })
  }

  private async commitRecord(record: SessionRecord): Promise<Response | null> {
    try {
      if (this.env.DB) await projectSessionRecord(createDb(this.env.DB), record)
      await this.state.storage.put(SESSION_RECORD_STORAGE_KEY, record)
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
