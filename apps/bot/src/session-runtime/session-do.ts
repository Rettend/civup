import type { CompetitiveTier, DraftDoublePickMetrics, DraftPreviewState, DraftSeat, DraftSelection, DraftState, GameMode, LeaderDataVersion, QueueEntry } from '@civup/game'
import type { SessionServerMessage } from '@civup/session'
import type { SQL } from 'drizzle-orm'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { ParticipantRow } from '../services/match/types.ts'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { DraftRuntimeEnv } from './draft-room.ts'
import type { RepeatDraftRoomSnapshot, RoomRecord } from './draft-room-domain.ts'
import type { StoredMapVoteState } from './map-vote-room-state.ts'
import type { ActiveSessionRecord, DraftSessionRecord, OpenSessionRecord, SessionConfig, SessionDraftStartSyncState, SessionLifecycleSyncState, SessionProjectionState, SessionProjectionSyncPayload, SessionProjectionSyncState, SessionRecord, SessionRoster, SessionTerminalSyncCommand, SessionTerminalSyncState } from './session-record.ts'
import type { Connection, ConnectionContext, WSMessage } from './socket-server.ts'
import { createDb, matchBans, matches, matchParticipants } from '@civup/db'
import { allFactionIds, canStartWithPlayerCount, EMPTY_MAP_VOTE_SNAPSHOT, formatModeLabel, GAME_MODES, getCurrentStep, getDraftFormat, getLeaderIds, getMaxLeaderPoolSize, getMinimumLeaderPoolSize, isTeamMode, MAP_VOTE_REVEAL_DURATION_MS, MAP_VOTE_VOTING_DURATION_MS, normalizeMapVoteSelection, slotToTeamIndex } from '@civup/game'
import { CIVUP_ACTIVITY_GUILD_ID_HEADER, CIVUP_ACTIVITY_USER_ID_HEADER, createSessionAccessToken, isAuthorizedInternalRequest, resolveApprovedDiscordGuildConfiguration, verifySessionAccessToken } from '@civup/utils'
import { eq, sql } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed, lobbyResultEmbed } from '../embeds/match.ts'
import { buildDraftRuntimeConfig, buildDraftSeats } from '../services/activity/index.ts'
import { attachTournamentLobbySnapshot, buildLobbySnapshotFromSessionRecord } from '../services/activity/session-state.ts'
import { resolveDraftTimerConfig } from '../services/config/index.ts'
import { createChannelMessage, createChannelMessageWithFile, editChannelMessage, editChannelMessageWithFile, isDiscordApiError } from '../services/discord/index.ts'
import { arrangeLobbySlots } from '../services/lobby/arrange.ts'
import { validateTeamGuildSlots } from '../services/lobby/team-guilds.ts'
import { upsertLobbyMessage } from '../services/lobby/message.ts'
import { normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from '../services/lobby/normalize.ts'
import { resolveLobbyRankTier } from '../services/lobby/rank.ts'
import { getCalculatedRankGateError } from '../services/ranked/admission.ts'
import { createStatsContext } from '../services/stats/context.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { mapLobbySlotsToEntries } from '../services/lobby/slots.ts'
import { getDoublePickMetricsFromDraftData, getDraftStateFromDraftData, getHiddenDraftFromDraftData, getLeaderDataVersionFromDraftData, getMapVoteResultFromDraftData, getReporterIdentityFromDraftData, getStoredGameModeContext } from '../services/match/draft-data.ts'
import { activateDraftMatch, cancelDraftMatch, createDraftMatch } from '../services/match/index.ts'
import { clearMatchMessageMapping, listMatchMessageIds, storeMatchMessageMapping } from '../services/match/message.ts'
import { hydrateModeRatingSnapshotsFromEvents } from '../services/match/rating-events.ts'
import { isSessionAdmissionError, projectSessionRecord } from '../services/session/directory.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { renderTournamentResultPng } from '../services/tournament/image.ts'
import { buildTournamentResultImageData, isMatchTournamentLinked, reopenTournamentMatchAfterDraftCancel, syncTournamentMatchAfterReport } from '../services/tournament/index.ts'
import { publishActivitySessionUpdate } from './activity-feed-client.ts'
import { createRoomRecord, ROOM_RECORD_KEY } from './draft-room-domain.ts'
import { SessionDraftRuntime } from './draft-room.ts'
import { EMPTY_STORED_MAP_VOTE_STATE, isMapVoteInProgress } from './map-vote-room-state.ts'
import { buildLobbyDraftConfigFromSessionConfig, buildLobbyProjectionFromSessionRecord, buildOpenSessionRecordFromLobby, buildSessionRoster, buildSessionRosterQueueEntries, buildSessionRosterSlotEntries } from './session-record.ts'
import { canOpenSwapWindowForState } from './swap-window.ts'

interface SessionDOEnv extends DraftRuntimeEnv {
  DB?: D1Database
  KV?: KVNamespace
  Activity?: DurableObjectNamespace
  DISCORD_TOKEN?: string
  CIVUP_SECRET?: string
  ALLOWED_DISCORD_GUILD_ID?: string
  ALLOWED_DISCORD_GUILD_IDS?: string
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

interface RepeatDraftCommandRequest {
  expectedVersion?: number
  hostId?: string
  now?: number
}

interface RepeatDraftAvailability {
  kind: 'resume' | 'complete'
  matchId: string
}

interface RepeatDraftCommandResult {
  kind: 'resume' | 'complete'
  record: DraftSessionRecord | ActiveSessionRecord
  matchId: string
  seats: DraftSeat[]
  participants?: ParticipantRow[]
}

type RepeatDraftSource
  = | {
    kind: 'resume'
    matchId: string
    state: DraftState
    mapVote: StoredMapVoteState
    previews?: RepeatDraftRoomSnapshot['previews']
    config?: RoomRecord['config']
    doublePickMetrics?: DraftDoublePickMetrics
  }
    | {
      kind: 'complete'
      matchId: string
      state: DraftState
      hiddenDraft: boolean
      permanentAlly: boolean
      leaderDataVersion: LeaderDataVersion
    }

interface RepeatDraftAvailabilityCache {
  key: string
  value: RepeatDraftAvailability | null
}

interface SessionConnectionState {
  playerId: string | null
  guildId: string
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
    type: 'set-host'
    expectedVersion?: number
    hostId: string
    lastActivityAt?: number
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
    type: 'draft-finalized'
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

interface ReportedDiscordSyncCommandRequest {
  matchId?: string
  reason?: string
  at?: number
}

type ReportClaimCommandRequest
  = | {
    type: 'claim'
    matchId?: string
    reporterId?: string | null
    at?: number
  }
  | {
    type: 'status'
    matchId?: string
    at?: number
  }
  | {
    type: 'release'
    matchId?: string
    claimId?: string
  }

interface OpenSessionPatch {
  expectedVersion?: number
  mode?: GameMode
  channelId?: string
  messageId?: string
  steamLobbyLink?: string | null
  hostId?: string
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
const REPORTED_DISCORD_SYNC_STORAGE_KEY = 'reported-discord-sync'
const REPORT_CLAIM_STORAGE_KEY = 'report-claim'
const REPORT_CLAIM_TTL_MS = 10 * 60 * 1000
const DRAFT_START_CREATION_GRACE_MS = 10 * 60 * 1000
const REPEAT_DRAFT_CANDIDATE_LIMIT = 120
const SOCKET_GUILD_RECHECK_INTERVAL_MS = 60 * 1000

interface SessionCommitIntent {
  record: SessionRecord
  createdAt: number
}

interface ReportedDiscordSyncMarker {
  matchId: string
  attempts: number
  nextRetryAt: number
  lastError: string
  createdAt: number
  updatedAt: number
}

interface SessionCommitFailure {
  response: Response
  pending: boolean
}

interface RepeatDraftDbSnapshot {
  matchId: string
  match: typeof matches.$inferSelect | null
  participants: Array<typeof matchParticipants.$inferSelect>
  bans: Array<typeof matchBans.$inferSelect>
}

interface ReportClaimMarker {
  matchId: string
  claimId: string
  reporterId: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

class TerminalMatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`Match **${matchId}** not found.`)
    this.name = 'TerminalMatchNotFoundError'
  }
}

export class SessionDO extends SessionDraftRuntime<SessionDOEnv> {
  private commandQueue: Promise<void> = Promise.resolve()
  private repeatDraftAvailabilityCache: RepeatDraftAvailabilityCache | null = null

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/record') {
      await this.recoverPendingCommitIntent()
      const record = await this.getRecord()
      if (!record) return json({ error: 'Session not found' }, 404)
      return json({ record })
    }

    if (request.method === 'GET' && url.pathname === '/repeat-draft') {
      return await this.runSerializedCommand(() => this.handleRepeatDraftAvailabilityRequest())
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

    if (request.method === 'POST' && url.pathname === '/commands/repeat-draft') {
      return await this.runSerializedCommand(() => this.handleRepeatDraftCommand(request))
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

    if (request.method === 'POST' && url.pathname === '/commands/report-claim') {
      return await this.runSerializedCommand(() => this.handleReportClaimCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/session-projection') {
      return await this.runSerializedCommand(() => this.handleSessionProjectionCommand(request))
    }

    if (request.method === 'POST' && url.pathname === '/commands/reported-discord-sync') {
      return await this.runSerializedCommand(() => this.handleReportedDiscordSyncCommand(request))
    }

    return await this.runSerializedCommand(async () => {
      const record = await this.getRecord()
      if (record && isTerminalSessionPhase(record.phase)) return json({ error: 'Session closed' }, 410)
      return await super.onRequest(request)
    })
  }

  override async onAlarm(): Promise<void> {
    await this.runSerializedCommand(async () => {
      this.closeUnsupportedConnections(await this.getRecord())
      await this.retryPendingDraftStartSync()
      await this.retryPendingLifecycleSync()
      await this.retryPendingTerminalSync()
      await this.retryPendingProjectionSync()
      await this.retryPendingReportedDiscordSync()
      const record = await this.getRecord()
      if (!record || !isTerminalSessionPhase(record.phase)) await this.handleDraftRuntimeAlarmIfDue()
      await this.rescheduleSessionAlarm(await this.getRecord())
      return json({ ok: true })
    })
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    await this.runSerializedOperation(async () => {
      let record = await this.getRecord()
      if (record && !isAllowedSessionGuild(record.guildId, this.env)) {
        connection.close(4403, 'Forbidden')
        return
      }
      const guildId = readActivityGuildId(ctx.request.headers)
      if (!guildId || !isAllowedSessionGuild(guildId, this.env)) {
        connection.close(4403, 'Forbidden')
        return
      }
      if (record?.phase === 'open') {
        await this.handleOpenSessionConnect(connection, ctx, record, guildId)
        return
      }

      if (record?.phase === 'draft') {
        record = await this.recoverDraftRuntimeBeforeSelectedAccess(connection, record)
        if (!record) return
      }

      if (record?.phase === 'active' && !await this.getRoomRecord()) {
        await this.handleActiveSessionConnectWithoutRuntime(connection, ctx, record, guildId)
        return
      }

      if (record && isTerminalSessionPhase(record.phase)) {
        connection.close(1000, 'Session closed')
        return
      }

      await super.onConnect(connection, ctx)
      const state = connection.state as Omit<SessionConnectionState, 'guildId'> | null
      if (state?.playerId && connection.readyState < 2) connection.setState({ ...state, guildId })
    }).finally(async () => {
      await this.rescheduleSessionAlarm(await this.getRecord())
    })
  }

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    await this.runSerializedOperation(async () => {
      let record = await this.getRecord()
      if (!this.isAllowedConnection(connection, record)) {
        if (connection.readyState < 2) connection.close(4403, 'Forbidden')
        return
      }
      if (record?.phase === 'draft') {
        record = await this.recoverDraftRuntimeBeforeSelectedAccess(connection, record)
        if (!record) return
      }
      if (record && isTerminalSessionPhase(record.phase)) {
        if (connection.readyState < 2) connection.close(1000, 'Session closed')
        return
      }

      await super.onMessage(connection, message)
    })
  }

  protected override async runBackgroundRoomOperation<T>(operation: () => Promise<T>): Promise<T> {
    return await this.runSerializedOperation(operation)
  }

  protected async getRecord(): Promise<SessionRecord | null> {
    return await this.ctx.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
  }

  protected override async getSessionAccessId(room: RoomRecord): Promise<string> {
    return (await this.getRecord())?.id ?? room.state.matchId
  }

  private async handleOpenSessionConnect(connection: Connection, ctx: ConnectionContext, record: OpenSessionRecord, guildId: string): Promise<void> {
    if (!isAuthorizedInternalRequest(ctx.request.headers, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const playerId = readActivityUserId(ctx.request.headers)
    if (!playerId) {
      connection.close(4401, 'Unauthorized')
      return
    }

    connection.setState({ playerId, guildId, openLobby: true } satisfies SessionConnectionState)
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
    let validateRoster = false
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
      case 'set-host':
        record = applyOpenSessionPatch(existing, {
          hostId: body.hostId,
          lastActivityAt: body.lastActivityAt,
          updatedAt: body.now,
        })
        break
      case 'set-slots':
        record = applyOpenSessionPatch(existing, {
          slots: body.slots,
          queueEntries: body.queueEntries,
          updatedAt: body.now,
        })
        validateRoster = true
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
        validateRoster = true
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
        validateRoster = true
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
        validateRoster = true
        break
      case 'cancel-open-session':
        record = cancelOpenSession(existing, body.now)
        break
      default:
        return json({ error: 'Unknown open lobby command' }, 400)
    }

    if (validateRoster && record.phase === 'open') {
      const validation = validateTeamGuildSlots(record.mode, record.roster.slots, buildSessionRosterQueueEntries(record), this.teamGuildPolicy(record))
      if (validation.error) return json({ error: validation.error }, 400)
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
    if (record.mode === 'ffa' && !record.config.redDeath && record.config.permanentAlly && selectedEntries.length % 2 !== 0) {
      return json({ error: 'Permanent Ally FFA requires an even player count.' }, 400)
    }
    if (!canStartWithPlayerCount(record.mode, selectedEntries.length, record.roster.slots.length, { redDeath: record.config.redDeath, permanentAlly: record.config.permanentAlly })) {
      return json({ error: 'Session cannot start with the current player count.' }, 400)
    }
    const leaderPoolError = getLeaderPoolSizeError(record.mode, record.config.redDeath, record.config.leaderPoolSize, selectedEntries.length, record.config.leaderDataVersion)
    if (leaderPoolError) return json({ error: leaderPoolError }, 400)

    if (!this.env.DB) return json({ error: 'D1 binding is not configured' }, 503)

    const now = normalizePositiveInteger(body?.now, Date.now())
    const matchId = record.id
    const arrangeStrategy = record.mode === 'ffa' ? 'randomize' : 'shuffle-teams'
    const arranged = arrangeLobbySlots({
      mode: record.mode,
      slots: record.roster.slots,
      queueEntries: buildSessionRosterQueueEntries(record),
      strategy: arrangeStrategy,
      teamGuildPolicy: this.teamGuildPolicy(record),
    })
    if ('error' in arranged) return json({ error: arranged.error }, 400)
    const teamValidation = validateTeamGuildSlots(record.mode, arranged.slots, buildSessionRosterQueueEntries(record), this.teamGuildPolicy(record))
    if (teamValidation.error) return json({ error: teamValidation.error }, 400)
    if (record.config.minRole || record.config.maxRole) {
      if (!this.env.KV) return json({ error: 'KV binding is not configured' }, 503)
      if (!record.guildId) return json({ error: 'Session is missing owning-server data' }, 409)
      const rankGateError = await getCalculatedRankGateError(
        createDb(this.env.DB),
        this.env.KV,
        createStatsContext(record.guildId, this.env.ALLOWED_DISCORD_GUILD_ID ?? ''),
        record.config,
        selectedEntries.map(entry => entry.playerId),
      )
      if (rankGateError) return json({ error: rankGateError }, 400)
    }

    const randomized = applyOpenSessionPatch(record, {
      slots: arranged.slots,
      lastArrange: { strategy: arrangeStrategy, at: now },
      lastActivityAt: now,
      updatedAt: now,
    })

    const next: DraftSessionRecord = {
      ...randomized,
      phase: 'draft',
      matchId,
      version: record.version + 1,
      frozenAt: now,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
      draftStartSync: { attempts: 0, nextRetryAt: 0, deadlineAt: now + DRAFT_START_CREATION_GRACE_MS },
    }

    const commit = await this.commitRecord(next)
    if (commit) return commit

    const ensured = await this.finishDraftStartSync(next)
    if (!ensured.ok) return json({ error: ensured.error }, ensured.status)

    return json({ ok: true, record: ensured.record, matchId: ensured.record.matchId, seats: ensured.seats } satisfies { ok: true } & StartDraftCommandResult)
  }

  private async handleRepeatDraftAvailabilityRequest(): Promise<Response> {
    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    if (record.phase !== 'open') return json({ repeatDraft: null })

    const repeatDraft = await this.getRepeatDraftAvailability(record)
    return json({ repeatDraft })
  }

  private async handleRepeatDraftCommand(request: Request): Promise<Response> {
    let body: RepeatDraftCommandRequest | null = null
    try {
      body = await request.json<RepeatDraftCommandRequest>()
    }
    catch {
      body = null
    }

    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    if (record.phase !== 'open') return json({ error: `Session is not open (phase: ${record.phase})` }, 409)
    if (body?.hostId && body.hostId !== record.hostId) {
      return json({ error: 'Only the session host can repeat the draft' }, 403)
    }

    const expected = normalizeOptionalPositiveInteger(body?.expectedVersion)
    if (expected != null && expected !== record.version) return json({ error: 'Session changed before draft repeat' }, 409)
    if (!this.env.DB) return json({ error: 'D1 binding is not configured' }, 503)

    const currentSeats = this.buildCurrentDraftSeats(record)
    const startError = getRepeatDraftStartError(record, currentSeats)
    if (startError) return json({ error: startError }, 400)

    const source = await this.findRepeatDraftSource(record, currentSeats)
    if (!source) return json({ error: 'No repeatable draft matches the current players and teams.' }, 409)

    const now = normalizePositiveInteger(body?.now, Date.now())
    if (source.kind === 'resume') return await this.repeatResumedDraft(record, source, currentSeats, now)
    return await this.repeatCompletedDraft(record, source, currentSeats, now)
  }

  private async repeatResumedDraft(
    record: OpenSessionRecord,
    source: Extract<RepeatDraftSource, { kind: 'resume' }>,
    currentSeats: DraftSeat[],
    now: number,
  ): Promise<Response> {
    const db = createDb(this.env.DB!)
    const previousRoom = await this.getRoomRecord()
    const dbSnapshot = await this.loadRepeatDraftDbSnapshot(db, record.id)
    const seatIndexMap = buildRepeatSeatIndexMap(source.state.seats, currentSeats)
    const state = prepareRepeatedDraftState(source.state, record.id, currentSeats, 'resume', seatIndexMap)
    const mapVote = prepareRepeatedMapVote(source.mapVote, now, seatIndexMap)
    const timing = getRepeatDraftTiming(state, mapVote, now)
    const runtimeConfig = await this.buildRepeatRuntimeConfig(record, state, currentSeats, source.config)
    const room = createRoomRecord(runtimeConfig, state, mapVote, {
      timerEndsAt: timing.timerEndsAt,
      alarmStepIndex: timing.alarmStepIndex,
      previews: prepareRepeatedDraftPreviews(source.previews, seatIndexMap),
      lifecycleEventSequence: previousRoom?.lifecycleEventSequence ?? record.lifecycleEventSequence ?? 0,
      repeatDraft: null,
      doublePickMetrics: source.doublePickMetrics ?? previousRoom?.doublePickMetrics,
    })

    try {
      await createDraftMatch(db, this.buildDraftMatchInput(record, record.id, currentSeats))
      await this.setRoomRecord(room)
    }
    catch (error) {
      await this.restoreRepeatDraftState(db, dbSnapshot, previousRoom)
      throw error
    }

    const next: DraftSessionRecord = {
      ...record,
      phase: 'draft',
      matchId: record.id,
      version: record.version + 1,
      frozenAt: now,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
      draftStartSync: null,
    }
    const commit = await this.commitRecordDetailed(next)
    if (commit) {
      if (!commit.pending) await this.restoreRepeatDraftState(db, dbSnapshot, previousRoom)
      return commit.response
    }
    await this.rescheduleRoomAlarm()

    return json({ kind: 'resume', record: next, matchId: next.matchId, seats: currentSeats } satisfies RepeatDraftCommandResult)
  }

  private async repeatCompletedDraft(
    record: OpenSessionRecord,
    source: Extract<RepeatDraftSource, { kind: 'complete' }>,
    currentSeats: DraftSeat[],
    now: number,
  ): Promise<Response> {
    const db = createDb(this.env.DB!)
    const previousRoom = await this.getRoomRecord()
    const dbSnapshot = await this.loadRepeatDraftDbSnapshot(db, record.id)
    const seatIndexMap = buildRepeatSeatIndexMap(source.state.seats, currentSeats)
    const state = prepareRepeatedDraftState(source.state, record.id, currentSeats, 'complete', seatIndexMap)
    const runtimeConfig = await this.buildRepeatRuntimeConfig(record, state, currentSeats)
    const room = createRoomRecord(runtimeConfig, state, { ...EMPTY_STORED_MAP_VOTE_STATE }, {
      completedAt: now,
      lifecycleEventSequence: previousRoom?.lifecycleEventSequence ?? record.lifecycleEventSequence ?? 0,
      repeatDraft: null,
    })

    let activated!: Awaited<ReturnType<typeof activateDraftMatch>> & { error?: never }
    try {
      await createDraftMatch(db, this.buildDraftMatchInput(record, record.id, currentSeats))
      const activation = await activateDraftMatch(db, {
        state,
        completedAt: now,
        hostId: record.hostId,
        leaderDataVersion: record.config.leaderDataVersion,
        mapVoteResult: null,
        hiddenDraft: source.hiddenDraft,
        permanentAlly: source.permanentAlly,
      })
      if ('error' in activation) {
        await this.restoreRepeatDraftState(db, dbSnapshot, previousRoom)
        return json({ error: activation.error }, 400)
      }
      activated = activation
      await this.setRoomRecord(room)
    }
    catch (error) {
      await this.restoreRepeatDraftState(db, dbSnapshot, previousRoom)
      throw error
    }

    const next: ActiveSessionRecord = {
      ...record,
      phase: 'active',
      matchId: record.id,
      version: record.version + 1,
      frozenAt: now,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
      draftStartSync: null,
    }
    const commit = await this.commitRecordDetailed(next)
    if (commit) {
      if (!commit.pending) await this.restoreRepeatDraftState(db, dbSnapshot, previousRoom)
      return commit.response
    }
    await this.rescheduleRoomAlarm()
    await this.updateCompletedRepeatProjection(db, next, state, activated, source, now)

    return json({ kind: 'complete', record: next, matchId: next.matchId, seats: currentSeats, participants: activated.participants } satisfies RepeatDraftCommandResult)
  }

  private async loadRepeatDraftDbSnapshot(db: ReturnType<typeof createDb>, matchId: string): Promise<RepeatDraftDbSnapshot> {
    const [matchRows, participants, bans] = await Promise.all([
      db.select().from(matches).where(eq(matches.id, matchId)).limit(1),
      db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId)),
      db.select().from(matchBans).where(eq(matchBans.matchId, matchId)),
    ])
    return { matchId, match: matchRows[0] ?? null, participants, bans }
  }

  private async restoreRepeatDraftState(db: ReturnType<typeof createDb>, snapshot: RepeatDraftDbSnapshot, previousRoom: RoomRecord | null): Promise<void> {
    await Promise.all([
      this.restoreRepeatDraftDbSnapshot(db, snapshot),
      this.restoreRepeatRoomRecord(previousRoom),
    ])
  }

  private async restoreRepeatDraftDbSnapshot(db: ReturnType<typeof createDb>, snapshot: RepeatDraftDbSnapshot): Promise<void> {
    await db.delete(matchBans).where(eq(matchBans.matchId, snapshot.matchId))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, snapshot.matchId))
    await db.delete(matches).where(eq(matches.id, snapshot.matchId))

    if (!snapshot.match) return
    await db.insert(matches).values(snapshot.match)
    if (snapshot.participants.length > 0) await db.insert(matchParticipants).values(snapshot.participants)
    if (snapshot.bans.length > 0) await db.insert(matchBans).values(snapshot.bans)
  }

  private async restoreRepeatRoomRecord(previousRoom: RoomRecord | null): Promise<void> {
    if (previousRoom) {
      await this.setRoomRecord(previousRoom)
      return
    }
    await this.ctx.storage.delete(ROOM_RECORD_KEY)
  }

  private async updateCompletedRepeatProjection(
    db: ReturnType<typeof createDb>,
    record: ActiveSessionRecord,
    state: DraftState,
    activated: Awaited<ReturnType<typeof activateDraftMatch>> & { error?: never },
    source: Extract<RepeatDraftSource, { kind: 'complete' }>,
    completedAt: number,
  ): Promise<void> {
    const eventSequence = (record.lifecycleEventSequence ?? 0) + 1
    const payload: Extract<DraftLifecyclePayload, { outcome: 'complete' }> = {
      eventId: `${record.id}:repeat-complete:${eventSequence}`,
      eventKind: 'DraftCompleted',
      eventSequence,
      outcome: 'complete',
      matchId: record.matchId,
      hostId: record.hostId,
      leaderDataVersion: record.config.leaderDataVersion,
      completedAt,
      finalized: true,
      state,
      mapVoteResult: null,
      hiddenDraft: source.hiddenDraft === true ? true : undefined,
    }
    await this.updateCompletedDraftProjection(db, payload, activated, record, { repeatDraft: true })
  }

  private async getRepeatDraftAvailability(record: OpenSessionRecord): Promise<RepeatDraftAvailability | null> {
    try {
      const currentSeats = this.buildCurrentDraftSeats(record)
      const key = buildRepeatDraftAvailabilityCacheKey(record, currentSeats)
      if (this.repeatDraftAvailabilityCache?.key === key) return this.repeatDraftAvailabilityCache.value

      const source = await this.findRepeatDraftSource(record, currentSeats)
      const value = source ? { kind: source.kind, matchId: source.matchId } : null
      this.repeatDraftAvailabilityCache = { key, value }
      return value
    }
    catch (error) {
      console.warn('[session-do] failed to resolve repeat draft availability', { sessionId: record.id }, error)
      return null
    }
  }

  private async findRepeatDraftSource(record: OpenSessionRecord, currentSeats: DraftSeat[]): Promise<RepeatDraftSource | null> {
    if (getRepeatDraftStartError(record, currentSeats)) return null

    const resume = await this.findResumeDraftSource(record, currentSeats)
    if (resume) return resume
    return await this.findCompletedRepeatDraftSource(record, currentSeats)
  }

  private async findResumeDraftSource(record: OpenSessionRecord, currentSeats: DraftSeat[]): Promise<Extract<RepeatDraftSource, { kind: 'resume' }> | null> {
    const room = await this.getRoomRecord()
    const repeatDraft = room?.repeatDraft ?? null
    if (repeatDraft && sameRepeatDraftRoster(record.mode, repeatDraft.state.seats, currentSeats) && (!room?.config || isRepeatRuntimeConfigCompatible(record, repeatDraft.state, room.config))) {
      return {
        kind: 'resume',
        matchId: record.id,
        state: repeatDraft.state,
        mapVote: repeatDraft.mapVote,
        previews: repeatDraft.previews,
        config: room?.config,
        doublePickMetrics: repeatDraft.doublePickMetrics,
      }
    }

    if (room?.state.status === 'cancelled'
      && (room.state.cancelReason === 'timeout' || room.state.cancelReason === 'revert')
      && sameRepeatDraftRoster(record.mode, room.state.seats, currentSeats)
      && isRepeatRuntimeConfigCompatible(record, room.state, room.config)) {
      return {
        kind: 'resume',
        matchId: record.id,
        state: room.state,
        mapVote: { ...EMPTY_STORED_MAP_VOTE_STATE },
        previews: room.previews,
        config: room.config,
        doublePickMetrics: room.doublePickMetrics,
      }
    }

    if (!this.env.DB) return null
    const [match] = await createDb(this.env.DB)
      .select({ draftData: matches.draftData, status: matches.status })
      .from(matches)
      .where(eq(matches.id, record.id))
      .limit(1)
    if (match?.status !== 'cancelled') return null

    const state = getDraftStateFromDraftData(match.draftData)
    if (!state || (state.cancelReason !== 'timeout' && state.cancelReason !== 'revert')) return null
    if (!sameRepeatDraftRoster(record.mode, state.seats, currentSeats)) return null
    const context = getStoredGameModeContext(record.mode, match.draftData)
    const leaderDataVersion = getLeaderDataVersionFromDraftData(match.draftData, record.config.leaderDataVersion)
    if (!context || !isRepeatDraftDataCompatible(record, state, {
      redDeath: context.redDeath,
      permanentAlly: context.permanentAlly,
      hiddenDraft: getHiddenDraftFromDraftData(match.draftData),
      leaderDataVersion,
    })) return null
    return {
      kind: 'resume',
      matchId: record.id,
      state,
      mapVote: { ...EMPTY_STORED_MAP_VOTE_STATE },
      doublePickMetrics: getDoublePickMetricsFromDraftData(match.draftData),
    }
  }

  private async findCompletedRepeatDraftSource(record: OpenSessionRecord, currentSeats: DraftSeat[]): Promise<Extract<RepeatDraftSource, { kind: 'complete' }> | null> {
    if (!this.env.DB || currentSeats.length === 0) return null
    const playerIds = [...new Set(currentSeats.map(seat => seat.playerId))]
    const placeholders = playerIds.map(() => '?').join(', ')
    const response = await this.env.DB.prepare(`
      SELECT matches.id AS id, matches.game_mode AS gameMode, matches.draft_data AS draftData
      FROM match_participants INDEXED BY match_participants_player_id_idx
      INNER JOIN matches ON match_participants.match_id = matches.id
      WHERE match_participants.player_id IN (${placeholders})
        AND matches.status IN ('active', 'completed')
      ORDER BY matches.created_at DESC
      LIMIT ?
    `)
      .bind(...playerIds, REPEAT_DRAFT_CANDIDATE_LIMIT)
      .all<{ id?: unknown, gameMode?: unknown, draftData?: unknown }>()

    const seen = new Set<string>()
    for (const row of response.results ?? []) {
      if (typeof row.id !== 'string' || typeof row.gameMode !== 'string') continue
      const draftData = typeof row.draftData === 'string' ? row.draftData : null
      if (seen.has(row.id) || row.id === record.id || row.gameMode !== record.mode) continue
      seen.add(row.id)
      const state = getDraftStateFromDraftData(draftData)
      if (!state || state.status !== 'complete') continue
      if (!sameRepeatDraftRoster(record.mode, state.seats, currentSeats)) continue
      const context = getStoredGameModeContext(row.gameMode, draftData)
      const hiddenDraft = getHiddenDraftFromDraftData(draftData)
      const leaderDataVersion = getLeaderDataVersionFromDraftData(draftData, record.config.leaderDataVersion)
      if (!context || !isRepeatDraftDataCompatible(record, state, {
        redDeath: context.redDeath,
        permanentAlly: context.permanentAlly,
        hiddenDraft,
        leaderDataVersion,
      })) continue
      return {
        kind: 'complete',
        matchId: row.id,
        state,
        hiddenDraft,
        permanentAlly: context.permanentAlly,
        leaderDataVersion,
      }
    }

    return null
  }

  private buildCurrentDraftSeats(record: OpenSessionRecord): DraftSeat[] {
    return buildDraftSeats(record.mode, buildSessionRosterSlotEntries(record))
  }

  private async buildRepeatRuntimeConfig(
    record: OpenSessionRecord,
    state: DraftState,
    currentSeats: DraftSeat[],
    sourceConfig?: RoomRecord['config'],
  ): Promise<RoomRecord['config']> {
    const timerConfig = await resolveDraftTimerConfig(this.env.KV, record.config, { guildId: record.guildId, legacyGuildId: this.env.ALLOWED_DISCORD_GUILD_ID })
    const runtime = buildDraftRuntimeConfig(record.mode, buildSessionRosterSlotEntries(record), {
      matchId: record.id,
      hostId: record.hostId,
      leaderDataVersion: record.config.leaderDataVersion,
      blindBans: record.config.blindBans,
      blindPicks: record.config.blindPicks,
      simultaneousPick: record.config.simultaneousPick,
      permanentAlly: record.config.permanentAlly,
      redDeath: record.config.redDeath,
      civBlitz: record.config.civBlitz,
      civBlitzOptionCount: record.config.civBlitzOptionCount,
      civBlitzExcludeBbgExpanded: record.config.civBlitzExcludeBbgExpanded,
      mapVoteEnabled: record.config.mapVoteEnabled,
      randomDraft: record.config.randomDraft,
      hiddenDraft: record.config.hiddenDraft,
      duplicateFactions: record.config.duplicateFactions,
      timerConfig,
      leaderPoolSize: record.config.leaderPoolSize,
      dealOptionsSize: record.config.dealOptionsSize,
      steamLobbyLink: record.projectionState.steamLobbyLink,
    })

    return {
      ...runtime.config,
      ...(sourceConfig ?? {}),
      matchId: record.id,
      hostId: record.hostId,
      formatId: state.formatId,
      seats: currentSeats,
      civPool: sourceConfig?.civPool ?? buildRepeatCivPool(state),
      timerConfig,
      steamLobbyLink: record.projectionState.steamLobbyLink,
    }
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
    if (result.ok) {
      await this.broadcastReopenedLobbyToDraftConnections(payload)
      return
    }

    console.error('[session-do] lifecycle sync deferred', buildDraftLifecycleLogContext(payload, {
      action,
      status: result.status,
      error: result.error,
    }))
  }

  private async broadcastReopenedLobbyToDraftConnections(payload: DraftLifecyclePayload): Promise<void> {
    if (payload.outcome !== 'cancelled') return
    if (payload.reason !== 'timeout' && payload.reason !== 'revert') return

    const record = await this.getRecord()
    if (!record || record.phase !== 'open') return

    const connections = Array.from(this.getConnections<SessionConnectionState>())
      .filter((connection) => {
        const state = connection.state as SessionConnectionState | null
        return state?.openLobby !== true && connection.readyState < 2
      })
    if (connections.length === 0) return

    try {
      const message = await this.buildOpenLobbySnapshotMessage(record)
      for (const connection of connections) this.sendConnectionMessage(connection, message)
    }
    catch (error) {
      console.error('[session-do] failed to broadcast reopened lobby snapshot', buildDraftLifecycleLogContext(payload), error)
    }
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

  private async recoverDraftRuntimeBeforeSelectedAccess(connection: Connection, record: DraftSessionRecord): Promise<SessionRecord | null> {
    await this.recoverTerminalDraftRuntime(record)
    const current = await this.getRecord()
    if (current?.phase !== 'draft') return current

    const room = await this.getRoomRecord()
    if (!current.draftStartSync && room) return current

    const result = await this.finishDraftStartSync(current)
    if (result.ok) return result.record

    this.sendSessionMessage(connection, { type: 'error', message: 'Draft room is still being prepared. Please reconnect shortly.' })
    connection.close(1013, 'Draft room is still initializing')
    return null
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
    const db = createDb(this.env.DB)

    const existingRoom = await this.getRoomRecord()
    let room: { matchId: string, seats: DraftSeat[] }
    if (existingRoom && existingRoom.state.status !== 'cancelled') {
      if (existingRoom.state.matchId !== record.matchId) throw new Error('Existing draft runtime belongs to a different session')
      room = { matchId: existingRoom.state.matchId, seats: existingRoom.config.seats }
    }
    else {
      const timerConfig = await resolveDraftTimerConfig(this.env.KV, record.config, { guildId: record.guildId, legacyGuildId: this.env.ALLOWED_DISCORD_GUILD_ID })
      const slotEntries = buildSessionRosterSlotEntries(record)
      const leaderPoolRankTier = record.config.leaderPoolSize == null && !record.config.redDeath && !record.config.civBlitz && !record.config.hiddenDraft && this.env.KV
        ? await resolveLobbyRankTier(this.env.KV, record.guildId, slotEntries.map(entry => entry.playerId))
        : null
      const runtime = buildDraftRuntimeConfig(record.mode, slotEntries, {
        matchId: record.matchId,
        hostId: record.hostId,
        leaderDataVersion: record.config.leaderDataVersion,
        blindBans: record.config.blindBans,
        blindPicks: record.config.blindPicks,
        simultaneousPick: record.config.simultaneousPick,
        permanentAlly: record.config.permanentAlly,
        redDeath: record.config.redDeath,
        civBlitz: record.config.civBlitz,
        civBlitzOptionCount: record.config.civBlitzOptionCount,
        civBlitzExcludeBbgExpanded: record.config.civBlitzExcludeBbgExpanded,
        mapVoteEnabled: record.config.mapVoteEnabled,
        randomDraft: record.config.randomDraft,
        hiddenDraft: record.config.hiddenDraft,
        duplicateFactions: record.config.duplicateFactions,
        timerConfig,
        leaderPoolSize: record.config.leaderPoolSize,
        leaderPoolRankTier,
        dealOptionsSize: record.config.dealOptionsSize,
        steamLobbyLink: record.projectionState.steamLobbyLink,
      })
      await createDraftMatch(db, this.buildDraftMatchInput(record, runtime.config.matchId, runtime.config.seats))
      const initialized = await this.initializeDraftRuntime(runtime.config, { existing: existingRoom })
      room = { matchId: initialized.state.matchId, seats: initialized.config.seats }
    }

    if (existingRoom && existingRoom.state.status !== 'cancelled') {
      await createDraftMatch(db, this.buildDraftMatchInput(record, room.matchId, room.seats))
    }
    return room
  }

  private async recoverTerminalDraftRuntime(record: SessionRecord): Promise<void> {
    if (record.phase !== 'draft') return
    const room = await this.getRoomRecord()
    if (!room || (room.state.status !== 'complete' && room.state.status !== 'cancelled')) return

    const eventSequence = Math.max(room.lifecycleEventSequence, (record.lifecycleEventSequence ?? 0) + 1)
    const basePayload = {
      eventId: `${room.state.matchId}:lifecycle:${eventSequence}`,
      eventSequence,
      matchId: room.state.matchId,
      hostId: room.config.hostId || room.state.seats[0]?.playerId || undefined,
      leaderDataVersion: room.config.leaderDataVersion ?? 'live',
      state: room.state,
      mapVoteResult: room.mapVote.result ?? null,
      hiddenDraft: room.config.hiddenDraft === true ? true : undefined,
    }
    const payload: DraftLifecyclePayload = room.state.status === 'complete'
      ? {
          ...basePayload,
          eventKind: 'DraftCompleted',
          outcome: 'complete',
          completedAt: room.completedAt ?? Date.now(),
        }
      : {
          ...basePayload,
          eventKind: 'DraftCancelled',
          outcome: 'cancelled',
          cancelledAt: room.cancelledAt ?? Date.now(),
          reason: room.state.cancelReason ?? 'scrub',
        }

    const result = await this.syncDraftLifecyclePayload(payload)
    if (!result.ok) {
      console.warn('[session-do] terminal draft runtime recovery deferred', buildDraftLifecycleLogContext(payload, {
        status: result.status,
        error: result.error,
      }))
    }
  }

  private async deferDraftStartSync(record: DraftSessionRecord, error: string): Promise<{ ok: false, status: number, error: string }> {
    const current = await this.getRecord()
    const target = current?.phase === 'draft' && current.id === record.id ? current : record
    const attempts = target.draftStartSync ? target.draftStartSync.attempts + 1 : 1
    const nextRetryAt = Date.now() + getLifecycleSyncRetryDelay(attempts)
    const deadlineAt = target.draftStartSync?.deadlineAt ?? target.frozenAt + DRAFT_START_CREATION_GRACE_MS
    const pending = withDraftStartSync(target, { attempts, nextRetryAt, deadlineAt })
    await this.storeRecordOnly(pending)
    console.warn('[session-do] draft start sync retry scheduled', {
      matchId: pending.matchId,
      attempts,
      nextRetryAt,
      error,
    })
    return { ok: false, status: 503, error }
  }

  private buildDraftMatchInput(record: Pick<SessionRecord, 'guildId' | 'sourceGuildPolicy' | 'mode'>, matchId: string, seats: DraftSeat[]) {
    const guildId = record.guildId?.trim() ?? ''
    const primaryGuildId = this.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? ''
    if (!guildId) throw new Error('Cannot create a match without an owning server')
    if (!primaryGuildId) throw new Error('Cannot create a match without a configured primary server')
    return {
      matchId,
      mode: record.mode,
      seats,
      guildId,
      primaryGuildId,
      allowLegacyPrimarySource: record.sourceGuildPolicy !== 'required' && guildId === primaryGuildId,
    }
  }

  private teamGuildPolicy(record: Pick<SessionRecord, 'sourceGuildPolicy'>) {
    return {
      primaryGuildId: this.env.ALLOWED_DISCORD_GUILD_ID,
      allowLegacyPrimarySource: record.sourceGuildPolicy !== 'required',
    }
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

  private async retryPendingReportedDiscordSync(): Promise<void> {
    const pending = await this.getReportedDiscordSyncMarker()
    if (!pending) return

    const now = Date.now()
    if (pending.nextRetryAt > now) {
      await this.rescheduleSessionAlarm(await this.getRecord())
      return
    }

    const result = await this.finishReportedDiscordSync(pending)
    if (!result.ok) {
      console.warn('[session-do] reported Discord sync retry deferred', {
        matchId: pending.matchId,
        status: result.status,
        error: result.error,
      })
    }
  }

  private async finishReportedDiscordSync(marker: ReportedDiscordSyncMarker): Promise<{ ok: true } | { ok: false, status: number, error: string }> {
    if (!this.env.DB) return await this.deferReportedDiscordSync(marker, 503, 'D1 binding is not configured')
    if (!this.env.KV) return await this.deferReportedDiscordSync(marker, 503, 'KV binding is not configured')
    if (!this.env.DISCORD_TOKEN) return await this.deferReportedDiscordSync(marker, 503, 'Discord token is not configured')

    const record = await this.getRecord()
    if (!record || (record.id !== marker.matchId && record.matchId !== marker.matchId)) {
      await this.clearReportedDiscordSyncMarker()
      return { ok: true }
    }

    if (await this.getActiveReportClaimMarker(marker.matchId)) {
      return await this.deferReportedDiscordSync(marker, 202, 'reported Discord sync is waiting for the active report request')
    }

    try {
      await this.syncReportedDiscordMessages(record, marker.matchId)
    }
    catch (error) {
      return await this.deferReportedDiscordSync(marker, 503, error instanceof Error ? error.message : String(error))
    }

    await this.clearReportedDiscordSyncMarker()
    await this.rescheduleSessionAlarm(await this.getRecord())
    return { ok: true }
  }

  private async syncReportedDiscordMessages(record: SessionRecord, matchId: string): Promise<void> {
    if (!this.env.DB || !this.env.KV || !this.env.DISCORD_TOKEN) throw new Error('Reported Discord sync bindings are not configured')
    const db = createDb(this.env.DB)
    const [match] = await db
      .select({ id: matches.id, gameMode: matches.gameMode, status: matches.status, draftData: matches.draftData })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1)

    if (!match) throw new Error(`Match **${matchId}** not found.`)
    if (match.status !== 'completed') return

    const context = getStoredGameModeContext(match.gameMode, match.draftData)
    const reportedMode = context?.mode ?? record.mode
    const reportedRedDeath = context?.redDeath ?? record.config.redDeath
    const reportedCivBlitz = context?.civBlitz ?? record.config.civBlitz
    const leaderDataVersion = getLeaderDataVersionFromDraftData(match.draftData, record.config.leaderDataVersion)
    const storedParticipants = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId)) as ParticipantRow[]
    const statsGuildId = record.guildId ?? this.env.ALLOWED_DISCORD_GUILD_ID
    const participants = statsGuildId
      ? await hydrateModeRatingSnapshotsFromEvents(
          db,
          createStatsContext(statsGuildId, this.env.ALLOWED_DISCORD_GUILD_ID ?? ''),
          storedParticipants.map(participant => ({ ...participant, gameMode: match.gameMode, draftData: match.draftData })),
        )
      : storedParticipants
    const tournamentLinked = await isMatchTournamentLinked(db, matchId)
    const tournamentResultPng = tournamentLinked
      ? await this.renderReportedTournamentResultImage(db, matchId, participants)
      : null
    const embed = tournamentLinked
      ? null
      : lobbyResultEmbed(reportedMode, participants, undefined, {
          mapVoteResult: getMapVoteResultFromDraftData(match.draftData),
          reporter: getReporterIdentityFromDraftData(match.draftData),
          leaderDataVersion,
          civBlitz: reportedCivBlitz,
          unranked: reportedCivBlitz || (context ? context.leaderboardMode == null : false),
        }, reportedRedDeath)

    const messageIds = await listMatchMessageIds(db, matchId)
    const candidateMessageIds = uniqueStrings([record.projectionState.messageId, ...messageIds])
    const draftMessageId = tournamentLinked
      ? await this.editOrRecreateReportedDraftImageMessage(record, matchId, candidateMessageIds, tournamentResultPng!)
      : await this.editOrRecreateReportedDraftMessage(record, matchId, candidateMessageIds, embed)
    await storeMatchMessageMapping(db, draftMessageId, matchId)

    const refreshedMessageIds = uniqueStrings([draftMessageId, ...await listMatchMessageIds(db, matchId)])
    if (refreshedMessageIds.length >= 2) return

    const archiveChannelId = await getSystemChannel(this.env.KV, tournamentLinked ? 'tournament-archive' : 'archive', {
      guildId: record.guildId,
      legacyGuildId: this.env.ALLOWED_DISCORD_GUILD_ID,
    })
    if (!archiveChannelId) return

    const archiveMessage = tournamentLinked
      ? await createChannelMessageWithFile({
          token: this.env.DISCORD_TOKEN,
          channelId: archiveChannelId,
          filename: 'tournament-result.png',
          contentType: 'image/png',
          data: tournamentResultPng!,
        })
      : await createChannelMessage(this.env.DISCORD_TOKEN, archiveChannelId, {
          embeds: [embed],
          allowed_mentions: { parse: [] },
        })
    await storeMatchMessageMapping(db, archiveMessage.id, matchId)
  }

  private async renderReportedTournamentResultImage(db: ReturnType<typeof createDb>, matchId: string, participants: ParticipantRow[]): Promise<Uint8Array> {
    const data = await buildTournamentResultImageData(db, matchId, participants)
    if (!data) throw new Error(`Tournament result data was not available for match ${matchId}`)
    return renderTournamentResultPng(data)
  }

  private async editOrRecreateReportedDraftMessage(record: SessionRecord, matchId: string, messageIds: string[], embed: unknown): Promise<string> {
    if (!this.env.DISCORD_TOKEN) throw new Error('Discord token is not configured')
    let lastError: unknown = null
    for (const messageId of messageIds) {
      try {
        await editChannelMessage(this.env.DISCORD_TOKEN, record.projectionState.channelId, messageId, {
          content: null,
          embeds: [embed],
          components: [],
          allowed_mentions: { parse: [] },
        })
        return messageId
      }
      catch (error) {
        lastError = error
        if (!isDiscordApiError(error, 404)) throw error
      }
    }

    const created = await createChannelMessage(this.env.DISCORD_TOKEN, record.projectionState.channelId, {
      content: null,
      embeds: [embed],
      components: [],
      allowed_mentions: { parse: [] },
    })
    await this.updateMessageProjection(record, created.id)
    if (lastError) console.warn('[session-do] recreated missing reported draft message', { matchId, messageId: created.id })
    return created.id
  }

  private async editOrRecreateReportedDraftImageMessage(record: SessionRecord, matchId: string, messageIds: string[], png: Uint8Array): Promise<string> {
    if (!this.env.DISCORD_TOKEN) throw new Error('Discord token is not configured')
    let lastError: unknown = null
    for (const messageId of messageIds) {
      try {
        await editChannelMessageWithFile({
          token: this.env.DISCORD_TOKEN,
          channelId: record.projectionState.channelId,
          messageId,
          filename: 'tournament-result.png',
          contentType: 'image/png',
          data: png,
          components: [],
        })
        return messageId
      }
      catch (error) {
        lastError = error
        if (!isDiscordApiError(error, 404)) throw error
      }
    }

    const created = await createChannelMessageWithFile({
      token: this.env.DISCORD_TOKEN,
      channelId: record.projectionState.channelId,
      filename: 'tournament-result.png',
      contentType: 'image/png',
      data: png,
      components: [],
    })
    await this.updateMessageProjection(record, created.id)
    if (lastError) console.warn('[session-do] recreated missing reported draft image message', { matchId, messageId: created.id })
    return created.id
  }

  private async deferReportedDiscordSync(marker: ReportedDiscordSyncMarker, status: number, error: string): Promise<{ ok: false, status: number, error: string }> {
    const now = Date.now()
    const attempts = marker.attempts + 1
    const pending: ReportedDiscordSyncMarker = {
      ...marker,
      attempts,
      nextRetryAt: now + getProjectionSyncRetryDelay(attempts),
      lastError: error,
      updatedAt: now,
    }
    await this.ctx.storage.put(REPORTED_DISCORD_SYNC_STORAGE_KEY, pending)
    await this.rescheduleSessionAlarm(await this.getRecord())
    console.warn('[session-do] reported Discord sync retry scheduled', {
      matchId: pending.matchId,
      attempts,
      nextRetryAt: pending.nextRetryAt,
      error,
    })
    return { ok: false, status, error }
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
      leaderDataVersion: payload.leaderDataVersion ?? record.config.leaderDataVersion,
      mapVoteResult: payload.mapVoteResult ?? null,
      hiddenDraft: payload.hiddenDraft === true,
      permanentAlly: record.config.permanentAlly === true,
      doublePickMetrics: payload.doublePickMetrics,
    })

    if ('error' in result) {
      if (isIgnorableDraftCompleteError(result.error)) {
        console.warn('[session-do] ignoring stale draft completion', { ...context, error: result.error })
        await this.clearLifecycleSyncMarker(record)
        return { ok: true, ignored: true }
      }
      if (isRetriableDraftCompleteError(result.error)) {
        return { ok: false, status: 503, error: result.error }
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
      leaderDataVersion: payload.leaderDataVersion ?? record.config.leaderDataVersion,
      mapVoteResult: payload.mapVoteResult ?? null,
      hiddenDraft: payload.hiddenDraft === true,
      permanentAlly: record.config.permanentAlly === true,
      doublePickMetrics: payload.doublePickMetrics,
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

    if (payload.reason === 'timeout' || payload.reason === 'revert') {
      await reopenTournamentMatchAfterDraftCancel(db, record.id)
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
      embeds: [lobbyDraftCompleteEmbed(activeLobby.mode, projection.participants, payload.mapVoteResult ?? null, activeLobby.draftConfig.leaderDataVersion, activeLobby.draftConfig.redDeath, activeLobby.draftConfig.civBlitz)],
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
      embeds: [lobbyCancelledEmbed(lifecycleLobby.mode, projection.participants, payload.reason, undefined, lifecycleLobby.draftConfig.leaderDataVersion, lifecycleLobby.draftConfig.redDeath, undefined, lifecycleLobby.draftConfig.civBlitz)],
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
        if (existing.phase !== 'active' && existing.phase !== 'swap' && existing.phase !== 'cancelled' && persistedMatchStatus !== 'completed') {
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

  private async handleReportClaimCommand(request: Request): Promise<Response> {
    let body: ReportClaimCommandRequest | null = null
    try {
      body = await request.json<ReportClaimCommandRequest>()
    }
    catch {
      body = null
    }

    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
      return json({ error: 'claim command type is required' }, 400)
    }

    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    const matchId = typeof body.matchId === 'string' && body.matchId.length > 0 ? body.matchId : record.matchId ?? record.id
    if (record.id !== matchId && record.matchId !== matchId) {
      return json({ error: `Session ${record.id} does not belong to match ${matchId}` }, 409)
    }

    if (body.type === 'release') {
      const released = await this.clearReportClaimMarker(matchId, body.claimId)
      if (released) await this.retryReportedDiscordSyncAfterReportClaimRelease(matchId)
      await this.rescheduleSessionAlarm(await this.getRecord())
      return json({ ok: true, released })
    }

    const now = normalizePositiveInteger(body.at, Date.now())
    const activeClaim = await this.getActiveReportClaimMarker(matchId, now)
    if (activeClaim) {
      return json({
        claimed: false,
        processing: true,
        claim: { matchId: activeClaim.matchId, claimId: activeClaim.claimId },
      })
    }

    if (record.phase === 'reported') {
      return json({ claimed: false, alreadyReported: true })
    }

    if (body.type === 'status') {
      if (record.phase === 'cancelled') return json({ error: 'Cancelled sessions cannot be reported' }, 409)
      if (record.phase !== 'active' && record.phase !== 'swap') {
        return json({ error: `Session is not reportable (phase: ${record.phase})` }, 409)
      }
      return json({ claimed: false })
    }

    if (body.type !== 'claim') return json({ error: 'Unknown report claim command' }, 400)

    const finalized = await this.finalizeSwapWindowForReportClaim(record)
    if (!finalized.ok) return finalized.response
    const reportableRecord = finalized.record

    if (reportableRecord.phase === 'cancelled') return json({ error: 'Cancelled sessions cannot be reported' }, 409)
    if (reportableRecord.phase !== 'active') {
      return json({ error: `Session is not reportable (phase: ${reportableRecord.phase})` }, 409)
    }

    const claim: ReportClaimMarker = {
      matchId,
      claimId: createReportClaimId(now),
      reporterId: typeof body.reporterId === 'string' && body.reporterId.trim().length > 0 ? body.reporterId.trim() : null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + REPORT_CLAIM_TTL_MS,
    }
    await this.ctx.storage.put(REPORT_CLAIM_STORAGE_KEY, claim)
    return json({ claimed: true, claim: { matchId: claim.matchId, claimId: claim.claimId }, finalized: finalized.finalized === true })
  }

  private async finalizeSwapWindowForReportClaim(record: SessionRecord): Promise<{ ok: true, record: SessionRecord, finalized?: boolean } | { ok: false, response: Response }> {
    if (record.phase !== 'swap') return { ok: true, record }

    await this.finalizeCompletedDraft()
    let current = await this.getRecord() ?? record
    if (current.phase !== 'swap') return { ok: true, record: current, finalized: current.phase === 'active' }

    const pendingPayload = current.lifecycleSync?.payload
    if (pendingPayload?.outcome === 'complete') {
      const retry = await this.syncDraftLifecyclePayload(pendingPayload)
      current = await this.getRecord() ?? current
      if (current.phase !== 'swap') return { ok: true, record: current, finalized: current.phase === 'active' }
      if (!retry.ok && retry.status < 500) return { ok: false, response: json({ error: retry.error }, retry.status) }
      return { ok: false, response: json({ claimed: false, processing: true, finalizing: true }) }
    }

    const now = Date.now()
    const activeRecord = {
      ...current,
      phase: 'active',
      version: current.version + 1,
      updatedAt: now,
      lastActivityAt: now,
      closedAt: null,
      draftStartSync: null,
    } satisfies SessionRecord
    const commit = await this.commitRecord(activeRecord)
    if (commit) return { ok: false, response: commit }
    return { ok: true, record: activeRecord, finalized: true }

  }

  private async handleReportedDiscordSyncCommand(request: Request): Promise<Response> {
    let body: ReportedDiscordSyncCommandRequest | null = null
    try {
      body = await request.json<ReportedDiscordSyncCommandRequest>()
    }
    catch {
      body = null
    }

    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    const matchId = typeof body?.matchId === 'string' && body.matchId.length > 0 ? body.matchId : record.matchId ?? record.id
    if (record.id !== matchId && record.matchId !== matchId) {
      return json({ error: `Session ${record.id} does not belong to match ${matchId}` }, 409)
    }

    const now = normalizePositiveInteger(body?.at, Date.now())
    const existing = await this.getReportedDiscordSyncMarker()
    const marker: ReportedDiscordSyncMarker = {
      matchId,
      attempts: existing?.matchId === matchId ? existing.attempts : 0,
      nextRetryAt: 0,
      lastError: typeof body?.reason === 'string' && body.reason.length > 0 ? body.reason : 'reported Discord sync requested',
      createdAt: existing?.matchId === matchId ? existing.createdAt : now,
      updatedAt: now,
    }
    await this.ctx.storage.put(REPORTED_DISCORD_SYNC_STORAGE_KEY, marker)

    const result = await this.finishReportedDiscordSync(marker)
    if (!result.ok) return json({ ok: true, queued: true, error: result.error })
    return json({ ok: true, queued: false })
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
        await this.syncDraftRuntimeProjectionState(record)
        return json({ ok: true, record })
      }
      default:
        return json({ error: 'Unknown session projection command' }, 400)
    }
  }

  private async commitRecord(record: SessionRecord): Promise<Response | null> {
    const failure = await this.commitRecordDetailed(record)
    return failure?.response ?? null
  }

  private async commitRecordDetailed(record: SessionRecord): Promise<SessionCommitFailure | null> {
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
        return { response: json({ error: error.message, playerIds: error.playerIds }, 409), pending: projected }
      }
      console.error('[session-do] failed to commit session record', error)
      return { response: json({ error: error instanceof Error ? error.message : String(error) }, 500), pending: projected }
    }

    await this.clearPendingCommitIntent().catch((error) => {
      console.error('[session-do] failed to clear completed commit intent', error)
    })

    await this.finalizeCommittedRecord(record, 'commit')
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

    await this.finalizeCommittedRecord(intent.record, 'commit-recovery')
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

  private async getReportedDiscordSyncMarker(): Promise<ReportedDiscordSyncMarker | null> {
    return await this.ctx.storage.get<ReportedDiscordSyncMarker>(REPORTED_DISCORD_SYNC_STORAGE_KEY) ?? null
  }

  private async clearReportedDiscordSyncMarker(): Promise<void> {
    await this.ctx.storage.delete(REPORTED_DISCORD_SYNC_STORAGE_KEY)
  }

  private async getReportClaimMarker(): Promise<ReportClaimMarker | null> {
    return await this.ctx.storage.get<ReportClaimMarker>(REPORT_CLAIM_STORAGE_KEY) ?? null
  }

  private async getActiveReportClaimMarker(matchId: string, now: number = Date.now()): Promise<ReportClaimMarker | null> {
    const marker = await this.getReportClaimMarker()
    if (!marker || marker.matchId !== matchId) return null
    if (marker.expiresAt > now) return marker

    await this.ctx.storage.delete(REPORT_CLAIM_STORAGE_KEY)
    return null
  }

  private async clearReportClaimMarker(matchId: string, claimId?: string | null): Promise<boolean> {
    const marker = await this.getReportClaimMarker()
    if (!marker || marker.matchId !== matchId) return false
    if (claimId && marker.claimId !== claimId) return false
    await this.ctx.storage.delete(REPORT_CLAIM_STORAGE_KEY)
    return true
  }

  private async retryReportedDiscordSyncAfterReportClaimRelease(matchId: string): Promise<void> {
    const marker = await this.getReportedDiscordSyncMarker()
    if (!marker || marker.matchId !== matchId) return

    const ready: ReportedDiscordSyncMarker = {
      ...marker,
      nextRetryAt: 0,
      updatedAt: Date.now(),
    }
    await this.ctx.storage.put(REPORTED_DISCORD_SYNC_STORAGE_KEY, ready)
    const result = await this.finishReportedDiscordSync(ready)
    if (!result.ok) {
      console.warn('[session-do] reported Discord sync after report claim release deferred', {
        matchId,
        status: result.status,
        error: result.error,
      })
    }
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
    const reportedDiscordSync = await this.getReportedDiscordSyncMarker()
    const reportedDiscordRetryAt = reportedDiscordSync
      ? reportedDiscordSync.nextRetryAt > 0 ? reportedDiscordSync.nextRetryAt : Date.now()
      : null
    const draftRuntimeAlarmAt = record && !isTerminalSessionPhase(record.phase)
      ? await this.getDraftRuntimeAlarmAt()
      : null
    const socketGuildRecheckAt = this.hasOpenConnections() ? Date.now() + SOCKET_GUILD_RECHECK_INTERVAL_MS : null
    const candidates = [draftStartRetryAt, lifecycleRetryAt, terminalRetryAt, projectionRetryAt, reportedDiscordRetryAt, draftRuntimeAlarmAt, socketGuildRecheckAt].filter((value): value is number => typeof value === 'number')
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
    await this.finalizeCommittedRecord(cleared, 'terminal-sync')
    this.closeSelectedDraftConnections('Session closed')
    return { ok: true, record: cleared }
  }

  private async applyTerminalLifecycleSideEffects(db: ReturnType<typeof createDb>, command: SessionTerminalSyncCommand): Promise<void> {
    if (command.type === 'mark-reported') {
      const [match] = await db
        .select({ draftData: matches.draftData, completedAt: matches.completedAt, status: matches.status })
        .from(matches)
        .where(eq(matches.id, command.matchId))
        .limit(1)
      if (!match) throw new TerminalMatchNotFoundError(command.matchId)
      const values: { status: string, completedAt: number, cancelledAt: null, resultRevision?: SQL, draftData?: string | null } = {
        status: 'completed',
        completedAt: match.completedAt ?? command.at,
        cancelledAt: null,
      }
      if (match.status !== 'completed') values.resultRevision = sql`${matches.resultRevision} + 1`
      if (command.reportedById && command.reportedById.trim().length > 0) {
        values.draftData = setReportedByInDraftData(match.draftData, command.reportedById)
      }

      const updated = await db.update(matches).set(values).where(eq(matches.id, command.matchId)).returning({ id: matches.id })
      if (updated.length === 0) throw new TerminalMatchNotFoundError(command.matchId)
      await db.delete(matchBans).where(eq(matchBans.matchId, command.matchId))
      await syncTournamentMatchAfterReport(db, command.matchId)
      return
    }

    const [match] = await db.select({ status: matches.status }).from(matches).where(eq(matches.id, command.matchId)).limit(1)
    if (!match) throw new TerminalMatchNotFoundError(command.matchId)
    const updated = await db.update(matches)
      .set({
        status: 'cancelled',
        cancelledAt: command.at,
        ...(match.status === 'cancelled' ? {} : { resultRevision: sql`${matches.resultRevision} + 1` }),
      })
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

  private queueActivityUpdate(record: SessionRecord): void {
    const task = this.publishActivityUpdate(record)
    if (typeof this.ctx.waitUntil === 'function') {
      this.ctx.waitUntil(task)
    }
  }

  private async finalizeCommittedRecord(record: SessionRecord, action: string): Promise<void> {
    await this.broadcastSelectedSessionUpdate(record)
    this.queueActivityUpdate(record)
    await this.scheduleLifecycleSyncAlarm(record).catch((error) => {
      console.error(`[session-do] failed to schedule session alarm after ${action}`, error)
    })
  }

  private closeSelectedDraftConnections(reason: string): void {
    for (const connection of this.getConnections<SessionConnectionState>()) {
      const state = connection.state as SessionConnectionState | null
      if (state?.openLobby === true || connection.readyState >= 2) continue
      connection.close(1000, reason)
    }
  }

  private closeUnsupportedConnections(record: SessionRecord | null): void {
    for (const connection of this.getConnections<SessionConnectionState>()) {
      if (this.isAllowedConnection(connection, record)) continue
      connection.close(4403, 'Forbidden')
    }
  }

  private isAllowedConnection<TState>(connection: Connection<TState>, record: SessionRecord | null): boolean {
    if (record && !isAllowedSessionGuild(record.guildId, this.env)) return false
    const state = connection.state as SessionConnectionState | null
    return isAllowedSessionGuild(state?.guildId ?? null, this.env)
  }

  private hasOpenConnections(): boolean {
    for (const _connection of this.getConnections()) return true
    return false
  }

  private async syncDraftRuntimeProjectionState(record: SessionRecord): Promise<void> {
    if (record.phase !== 'draft' && record.phase !== 'swap') return
    await this.syncDraftRuntimeSteamLobbyLink(record.projectionState.steamLobbyLink)
  }

  private async broadcastSelectedSessionUpdate(record: SessionRecord): Promise<void> {
    const openLobbyConnections = Array.from(this.getConnections()).filter((connection) => {
      const state = connection.state as SessionConnectionState | null
      return state?.openLobby === true
    })
    if (openLobbyConnections.length === 0) return

    if (record.phase === 'open') {
      const message = await this.buildOpenLobbySnapshotMessage(record)
      for (const connection of openLobbyConnections) this.sendConnectionMessage(connection, message)
      return
    }

    if ((record.phase === 'draft' || record.phase === 'active') && record.matchId) {
      await Promise.all(openLobbyConnections.map(connection => this.sendSessionStarted(connection, record)))
      return
    }

    if (record.phase === 'cancelled' || record.phase === 'reported') {
      const message = JSON.stringify({ type: 'lobby', lobbyId: record.id, snapshot: null } satisfies SessionServerMessage)
      for (const connection of openLobbyConnections) {
        this.sendConnectionMessage(connection, message)
      }
    }
  }

  private async sendOpenLobbySnapshot(connection: Connection, record: OpenSessionRecord): Promise<void> {
    this.sendConnectionMessage(connection, await this.buildOpenLobbySnapshotMessage(record))
  }

  private async buildOpenLobbySnapshotMessage(record: OpenSessionRecord): Promise<string> {
    if (!this.env.KV) {
      return JSON.stringify({ type: 'error', message: 'Session lobby snapshots are not configured' } satisfies SessionServerMessage)
    }
    const baseSnapshot = await buildLobbySnapshotFromSessionRecord(this.env.KV, record, undefined, undefined, { legacyGuildId: this.env.ALLOWED_DISCORD_GUILD_ID })
    const snapshot = this.env.DB
      ? await attachTournamentLobbySnapshot(createDb(this.env.DB), baseSnapshot)
      : baseSnapshot
    const repeatDraft = await this.getRepeatDraftAvailability(record)
    const nextSnapshot = repeatDraft ? { ...snapshot, repeatDraft } : snapshot
    return JSON.stringify({
      type: 'lobby',
      lobbyId: record.id,
      snapshot: nextSnapshot,
    } satisfies SessionServerMessage)
  }

  private async sendSessionStarted(connection: Connection, record: DraftSessionRecord | ActiveSessionRecord): Promise<void> {
    const state = connection.state as SessionConnectionState | null
    const playerId = state?.playerId ?? null
    const sessionAccessToken = playerId && this.env.CIVUP_SECRET
      ? await createSessionAccessToken(this.env.CIVUP_SECRET, {
          userId: playerId,
          sessionId: record.id,
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

  private async handleActiveSessionConnectWithoutRuntime(connection: Connection, ctx: ConnectionContext, record: Extract<SessionRecord, { phase: 'active' }>, guildId: string): Promise<void> {
    if (!isAuthorizedInternalRequest(ctx.request.headers, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const playerId = readActivityUserId(ctx.request.headers)
    if (!playerId) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const requestUrl = new URL(ctx.request.url)
    const hasAccess = await verifySessionAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      sessionId: record.id,
      userId: playerId,
    })
    if (!hasAccess) {
      this.sendSessionMessage(connection, { type: 'error', message: 'Session access token is invalid or expired' })
      connection.close(4403, 'Forbidden')
      return
    }

    connection.setState({ playerId, guildId } satisfies SessionConnectionState)
    const snapshot = await this.buildCompletedActiveSessionSnapshot(record, playerId)
    this.sendSessionMessage(connection, {
      type: 'init',
      state: snapshot.state,
      mapVote: EMPTY_MAP_VOTE_SNAPSHOT,
      leaderDataVersion: record.config.leaderDataVersion ?? 'live',
      hostId: record.hostId,
      seatIndex: snapshot.seatIndex,
      timerEndsAt: null,
      completedAt: snapshot.completedAt,
      previews: { bans: {}, picks: {} },
      swapState: null,
      steamLobbyLink: record.projectionState.steamLobbyLink,
      permanentAlly: record.config.permanentAlly === true,
    })
    connection.close(1000, 'Draft closed')
  }

  private async buildCompletedActiveSessionSnapshot(record: Extract<SessionRecord, { phase: 'active' }>, playerId: string): Promise<{
    state: DraftState
    completedAt: number | null
    seatIndex: number | null
  }> {
    const runtimeData = await this.loadCompletedActiveRuntimeData(record.matchId)
    const participantByPlayerId = new Map(runtimeData.participants.map(participant => [participant.playerId, participant]))
    const memberByPlayerId = new Map(record.roster.participants.map(member => [member.playerId, member]))
    const orderedPlayerIds = record.roster.slots.filter((slot): slot is string => typeof slot === 'string' && slot.length > 0)
    for (const participant of runtimeData.participants) {
      if (!orderedPlayerIds.includes(participant.playerId)) orderedPlayerIds.push(participant.playerId)
    }

    const seats = orderedPlayerIds.map((seatPlayerId, index): DraftSeat => {
      const member = memberByPlayerId.get(seatPlayerId)
      const participant = participantByPlayerId.get(seatPlayerId)
      const team = participant?.team ?? slotToTeamIndex(record.mode, index, orderedPlayerIds.length)
      return {
        playerId: seatPlayerId,
        displayName: member?.displayName ?? seatPlayerId,
        avatarUrl: member?.avatarUrl ?? null,
        ...(team == null ? {} : { team }),
      }
    })

    const format = getDraftFormat(record.mode, {
      simultaneousPick: record.config.simultaneousPick === true,
      randomDraft: record.config.randomDraft === true,
      redDeath: record.config.redDeath === true,
      blindBans: record.config.blindBans,
      blindPicks: record.config.blindPicks,
      seatCount: seats.length,
    })
    const steps = format.getSteps(seats.length)
    const seatIndexByPlayerId = new Map(seats.map((seat, index) => [seat.playerId, index]))
    const picks: DraftSelection[] = seats.flatMap((seat, index) => {
      const civId = participantByPlayerId.get(seat.playerId)?.civId
      if (!civId) return []
      return [{ civId, seatIndex: index, stepIndex: resolvePickStepIndex(steps, index) }]
    })
    const bans: DraftSelection[] = runtimeData.bans.map(ban => ({
      civId: ban.civId,
      seatIndex: seatIndexByPlayerId.get(ban.bannedBy) ?? 0,
      stepIndex: ban.phase,
    }))
    const unavailableCivIds = new Set([...picks, ...bans].map(selection => selection.civId))
    const availableCivIds = (record.config.redDeath === true ? allFactionIds : getLeaderIds(record.config.leaderDataVersion ?? 'live'))
      .filter(civId => !unavailableCivIds.has(civId))

    return {
      state: {
        matchId: record.matchId,
        formatId: format.id,
        seats,
        steps,
        currentStepIndex: Math.max(steps.length - 1, 0),
        submissions: {},
        bans,
        picks,
        availableCivIds,
        dealOptionsSize: record.config.redDeath === true ? record.config.dealOptionsSize ?? undefined : undefined,
        duplicateFactions: record.config.duplicateFactions === true,
        status: 'complete',
        cancelReason: null,
        pendingBlindBans: [],
      },
      completedAt: runtimeData.completedAt ?? record.updatedAt,
      seatIndex: seatIndexByPlayerId.get(playerId) ?? null,
    }
  }

  private async loadCompletedActiveRuntimeData(matchId: string): Promise<{
    completedAt: number | null
    participants: Array<{ playerId: string, team: number | null, civId: string | null }>
    bans: Array<{ civId: string, bannedBy: string, phase: number }>
  }> {
    if (!this.env.DB) return { completedAt: null, participants: [], bans: [] }

    try {
      const db = createDb(this.env.DB)
      const [matchRows, participants, bans] = await Promise.all([
        db.select({ completedAt: matches.completedAt, draftData: matches.draftData }).from(matches).where(eq(matches.id, matchId)).limit(1),
        db.select({ playerId: matchParticipants.playerId, team: matchParticipants.team, civId: matchParticipants.civId }).from(matchParticipants).where(eq(matchParticipants.matchId, matchId)),
        db.select({ civId: matchBans.civId, bannedBy: matchBans.bannedBy, phase: matchBans.phase }).from(matchBans).where(eq(matchBans.matchId, matchId)),
      ])
      const match = matchRows[0]
      return {
        completedAt: match?.completedAt ?? parseDraftCompletedAt(match?.draftData) ?? null,
        participants,
        bans,
      }
    }
    catch (error) {
      console.warn('[session-do] failed to load completed active runtime data', { matchId }, error)
      return { completedAt: null, participants: [], bans: [] }
    }
  }

  private sendSessionMessage(connection: Connection, message: SessionServerMessage): void {
    this.sendConnectionMessage(connection, JSON.stringify(message))
  }

  private async runSerializedCommand(operation: () => Promise<Response>): Promise<Response> {
    return await this.runSerializedOperation(operation)
  }

  private async runSerializedOperation<T>(operation: () => Promise<T>): Promise<T> {
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

type LifecycleTransitionResult
  = | { record: SessionRecord, ignored?: boolean }
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

function createReportClaimId(now: number): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  return `${now}-${random}`
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
    if (payload.eventKind !== 'DraftCompleted' && payload.eventKind !== 'DraftFinalized') return 'invalid complete eventKind'
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
    leaderDataVersion: payload.leaderDataVersion ?? 'live',
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

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
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

function isRetriableDraftCompleteError(error: string): boolean {
  return error.includes('not found')
    || error.includes('has no participants')
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
    hostId: typeof patch.hostId === 'string' && patch.hostId.length > 0 ? patch.hostId : record.hostId,
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

function getRepeatDraftStartError(record: OpenSessionRecord, currentSeats: readonly DraftSeat[]): string | null {
  if (!currentSeats.some(seat => seat.playerId === record.hostId)) {
    return 'Host must be in a lobby slot before repeating.'
  }
  if (record.mode === 'ffa' && !record.config.redDeath && record.config.permanentAlly && currentSeats.length % 2 !== 0) {
    return 'Permanent Ally FFA requires an even player count.'
  }
  if (!canStartWithPlayerCount(record.mode, currentSeats.length, record.roster.slots.length, { redDeath: record.config.redDeath, permanentAlly: record.config.permanentAlly })) {
    return 'Session cannot start with the current player count.'
  }
  return getLeaderPoolSizeError(record.mode, record.config.redDeath, record.config.leaderPoolSize, currentSeats.length, record.config.leaderDataVersion)
}

function buildRepeatDraftAvailabilityCacheKey(record: OpenSessionRecord, currentSeats: readonly DraftSeat[]): string {
  return JSON.stringify({
    mode: record.mode,
    hostId: record.hostId,
    targetSize: record.roster.slots.length,
    seats: currentSeats.map(seat => [seat.playerId, seat.team ?? null]),
    config: {
      blindBans: record.config.blindBans,
      blindPicks: record.config.blindPicks,
      civBlitz: record.config.civBlitz,
      civBlitzExcludeBbgExpanded: record.config.civBlitzExcludeBbgExpanded,
      civBlitzOptionCount: record.config.civBlitzOptionCount,
      duplicateFactions: record.config.duplicateFactions,
      hiddenDraft: record.config.hiddenDraft,
      leaderDataVersion: record.config.leaderDataVersion,
      leaderPoolSize: record.config.leaderPoolSize,
      mapVoteEnabled: record.config.mapVoteEnabled,
      permanentAlly: record.config.permanentAlly,
      randomDraft: record.config.randomDraft,
      redDeath: record.config.redDeath,
      simultaneousPick: record.config.simultaneousPick,
    },
  })
}

function isRepeatDraftDataCompatible(
  record: OpenSessionRecord,
  state: DraftState,
  source: { redDeath: boolean, permanentAlly: boolean, hiddenDraft: boolean, leaderDataVersion: LeaderDataVersion },
): boolean {
  return isRepeatDraftFormatCompatible(record, state)
    && source.redDeath === record.config.redDeath
    && (record.config.civBlitz !== true || state.civBlitz?.optionCount === record.config.civBlitzOptionCount)
    && (record.config.civBlitz !== true || state.civBlitz?.excludeBbgExpanded === record.config.civBlitzExcludeBbgExpanded)
    && source.permanentAlly === isPermanentAllyFfaConfig(record)
    && source.hiddenDraft === record.config.hiddenDraft
    && source.leaderDataVersion === (record.config.leaderDataVersion ?? 'live')
}

function isRepeatRuntimeConfigCompatible(record: OpenSessionRecord, state: DraftState, sourceConfig: RoomRecord['config']): boolean {
  return isRepeatDraftFormatCompatible(record, state)
    && (sourceConfig.leaderDataVersion ?? 'live') === record.config.leaderDataVersion
    && (sourceConfig.hiddenDraft === true) === record.config.hiddenDraft
    && (sourceConfig.civBlitz === true) === record.config.civBlitz
    && (!record.config.civBlitz || (sourceConfig.civBlitzOptionCount ?? undefined) === record.config.civBlitzOptionCount)
    && (!record.config.civBlitz || (sourceConfig.civBlitzExcludeBbgExpanded !== false) === record.config.civBlitzExcludeBbgExpanded)
    && (sourceConfig.permanentAlly === true) === isPermanentAllyFfaConfig(record)
    && (sourceConfig.mapVoteEnabled === true) === record.config.mapVoteEnabled
    && (sourceConfig.randomDraft === true) === (!record.config.hiddenDraft && record.config.randomDraft)
}

function isRepeatDraftFormatCompatible(record: OpenSessionRecord, state: DraftState): boolean {
  const redDeath = record.config.redDeath === true
  const hiddenDraft = record.config.hiddenDraft === true
  const format = getDraftFormat(record.mode, {
    simultaneousPick: record.mode === 'ffa' && !redDeath && record.config.simultaneousPick === true,
    randomDraft: !hiddenDraft && record.config.randomDraft === true,
    redDeath,
    civBlitz: record.config.civBlitz,
    blindBans: record.config.blindBans,
    blindPicks: record.config.blindPicks,
    seatCount: state.seats.length,
  })
  return state.formatId === format.id
}

function isPermanentAllyFfaConfig(record: OpenSessionRecord): boolean {
  return record.mode === 'ffa' && record.config.redDeath !== true && record.config.civBlitz !== true && record.config.permanentAlly === true
}

function prepareRepeatedDraftState(state: DraftState, matchId: string, seats: DraftSeat[], kind: 'resume' | 'complete', seatIndexMap: ReadonlyMap<number, number>): DraftState {
  const status: DraftState['status'] = kind === 'complete'
    ? 'complete'
    : state.status === 'cancelled'
      ? state.currentStepIndex >= 0 ? 'active' : 'waiting'
      : state.status === 'complete'
        ? 'active'
        : state.status

  return {
    ...state,
    matchId,
    seats,
    steps: remapDraftSteps(state.steps, seatIndexMap),
    status,
    cancelReason: null,
    submissions: kind === 'complete' ? {} : remapSeatSelectionRecord(state.submissions, seatIndexMap),
    bans: remapDraftSelections(state.bans, seatIndexMap),
    picks: remapDraftSelections(state.picks, seatIndexMap),
    pendingBlindBans: kind === 'complete' ? [] : remapDraftSelections(state.pendingBlindBans, seatIndexMap),
    dealtCivIds: kind === 'complete' ? null : state.dealtCivIds,
    dealtCivIdsBySeat: kind === 'complete' || !state.dealtCivIdsBySeat ? null : remapSeatSelectionRecord(state.dealtCivIdsBySeat, seatIndexMap),
    blindPickReveal: kind === 'complete' ? null : remapBlindPickReveal(state.blindPickReveal, seatIndexMap),
    blindPickBans: remapDraftSelections(state.blindPickBans ?? [], seatIndexMap),
    civBlitz: remapCivBlitzState(state.civBlitz, kind, seatIndexMap),
  }
}

function prepareRepeatedMapVote(mapVote: StoredMapVoteState, now: number, seatIndexMap: ReadonlyMap<number, number>): StoredMapVoteState {
  const remapped = remapStoredMapVote(mapVote, seatIndexMap)
  if (!isMapVoteInProgress(remapped)) return remapped
  return {
    ...remapped,
    endsAt: now + (remapped.phase === 'voting' ? MAP_VOTE_VOTING_DURATION_MS : MAP_VOTE_REVEAL_DURATION_MS),
  }
}

function prepareRepeatedDraftPreviews(previews: DraftPreviewState | undefined, seatIndexMap: ReadonlyMap<number, number>): DraftPreviewState | undefined {
  if (!previews) return undefined
  return {
    bans: remapSeatSelectionRecord(previews.bans, seatIndexMap),
    picks: remapSeatSelectionRecord(previews.picks, seatIndexMap),
  }
}

function getRepeatDraftTiming(state: DraftState, mapVote: StoredMapVoteState, now: number): { timerEndsAt: number | null, alarmStepIndex: number } {
  if (isMapVoteInProgress(mapVote)) return { timerEndsAt: null, alarmStepIndex: -1 }
  if (state.status !== 'active') return { timerEndsAt: null, alarmStepIndex: -1 }

  const step = getCurrentStep(state)
  if (!step || step.timer <= 0) return { timerEndsAt: null, alarmStepIndex: -1 }
  return { timerEndsAt: now + step.timer * 1000, alarmStepIndex: state.currentStepIndex }
}

function sameRepeatDraftRoster(mode: GameMode, left: readonly DraftSeat[], right: readonly DraftSeat[]): boolean {
  if (left.length !== right.length) return false
  const rightSeatsByPlayerId = new Map<string, DraftSeat>()
  for (const seat of right) {
    if (rightSeatsByPlayerId.has(seat.playerId)) return false
    rightSeatsByPlayerId.set(seat.playerId, seat)
  }
  const leftPlayerIds = new Set<string>()
  for (const leftSeat of left) {
    if (leftPlayerIds.has(leftSeat.playerId)) return false
    leftPlayerIds.add(leftSeat.playerId)
    if (!rightSeatsByPlayerId.has(leftSeat.playerId)) return false
  }
  return !isTeamMode(mode) || sameRepeatDraftTeamPartitions(left, right)
}

function sameRepeatDraftTeamPartitions(left: readonly DraftSeat[], right: readonly DraftSeat[]): boolean {
  const leftGroups = repeatDraftTeamGroupKeys(left)
  const rightGroups = repeatDraftTeamGroupKeys(right)
  if (!leftGroups || !rightGroups || leftGroups.length !== rightGroups.length) return false

  const remaining = new Set(rightGroups)
  for (const group of leftGroups) {
    if (!remaining.delete(group)) return false
  }
  return true
}

function repeatDraftTeamGroupKeys(seats: readonly DraftSeat[]): string[] | null {
  const playerIdsByTeam = new Map<number, string[]>()
  for (const seat of seats) {
    if (seat.team == null) return null

    const playerIds = playerIdsByTeam.get(seat.team) ?? []
    playerIds.push(seat.playerId)
    playerIdsByTeam.set(seat.team, playerIds)
  }

  return [...playerIdsByTeam.values()]
    .map(playerIds => playerIds.sort().join('\0'))
}

function buildRepeatSeatIndexMap(sourceSeats: readonly DraftSeat[], targetSeats: readonly DraftSeat[]): Map<number, number> {
  const targetIndexByPlayerId = new Map(targetSeats.map((seat, index) => [seat.playerId, index]))
  const seatIndexMap = new Map<number, number>()
  sourceSeats.forEach((seat, index) => {
    const nextIndex = targetIndexByPlayerId.get(seat.playerId)
    if (nextIndex != null) seatIndexMap.set(index, nextIndex)
  })
  return seatIndexMap
}

function remapDraftSelections(selections: readonly DraftSelection[], seatIndexMap: ReadonlyMap<number, number>): DraftSelection[] {
  return selections.map(selection => ({
    ...selection,
    seatIndex: remapSeatIndex(selection.seatIndex, seatIndexMap),
  }))
}

function remapBlindPickReveal(reveal: DraftState['blindPickReveal'], seatIndexMap: ReadonlyMap<number, number>): DraftState['blindPickReveal'] {
  if (!reveal) return null
  return {
    ...reveal,
    picks: remapDraftSelections(reveal.picks, seatIndexMap),
    conflictedSeatIndexes: reveal.conflictedSeatIndexes.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap)),
  }
}

function remapCivBlitzState(civBlitz: DraftState['civBlitz'], kind: 'resume' | 'complete', seatIndexMap: ReadonlyMap<number, number>): DraftState['civBlitz'] {
  if (!civBlitz) return civBlitz ?? null
  return {
    ...civBlitz,
    optionsBySeat: remapSeatValueRecord(civBlitz.optionsBySeat, seatIndexMap, cloneCivBlitzCategoryOptions),
    submissions: kind === 'complete' ? {} : remapSeatValueRecord(civBlitz.submissions, seatIndexMap, kit => ({ ...kit })),
    lockedKits: remapSeatValueRecord(civBlitz.lockedKits, seatIndexMap, kit => ({ ...kit })),
    reveal: kind === 'complete' ? null : remapCivBlitzReveal(civBlitz.reveal, seatIndexMap),
    conflictBans: civBlitz.conflictBans.map(selection => ({
      ...selection,
      seatIndex: remapSeatIndex(selection.seatIndex, seatIndexMap),
    })),
  }
}

function remapCivBlitzReveal(reveal: NonNullable<DraftState['civBlitz']>['reveal'], seatIndexMap: ReadonlyMap<number, number>): NonNullable<DraftState['civBlitz']>['reveal'] {
  if (!reveal) return null
  return {
    ...reveal,
    submissions: reveal.submissions.map(submission => ({
      ...submission,
      seatIndex: remapSeatIndex(submission.seatIndex, seatIndexMap),
    })),
    conflictedSeatIndexes: reveal.conflictedSeatIndexes.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap)),
    categoriesBySeat: remapSeatValueRecord(reveal.categoriesBySeat, seatIndexMap, categories => [...categories]),
  }
}

function cloneCivBlitzCategoryOptions(options: NonNullable<DraftState['civBlitz']>['optionsBySeat'][number]): NonNullable<DraftState['civBlitz']>['optionsBySeat'][number] {
  return {
    civilizationAbility: [...options.civilizationAbility],
    leaderAbility: [...options.leaderAbility],
    infrastructure: [...options.infrastructure],
    unit: [...options.unit],
  }
}

function remapSeatSelectionRecord(record: Record<number, string[]>, seatIndexMap: ReadonlyMap<number, number>): Record<number, string[]> {
  const next: Record<number, string[]> = {}
  for (const [seatIndex, selections] of Object.entries(record)) {
    const nextSeatIndex = remapSeatIndex(Number(seatIndex), seatIndexMap)
    next[nextSeatIndex] = [...selections]
  }
  return next
}

function remapDraftSteps(steps: DraftState['steps'], seatIndexMap: ReadonlyMap<number, number>): DraftState['steps'] {
  return steps.map((step) => {
    const fallbackPickOrder = step.fallbackPickOrder?.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap))
    const civBlitzCategoriesBySeat = step.civBlitzCategoriesBySeat
      ? remapSeatValueRecord(step.civBlitzCategoriesBySeat, seatIndexMap, categories => [...categories])
      : undefined
    const remappedMetadata = {
      ...(fallbackPickOrder ? { fallbackPickOrder } : {}),
      ...(civBlitzCategoriesBySeat ? { civBlitzCategoriesBySeat } : {}),
    }
    if (step.seats === 'all') return Object.keys(remappedMetadata).length > 0 ? { ...step, ...remappedMetadata } : step
    return {
      ...step,
      seats: step.seats.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap)),
      ...remappedMetadata,
    }
  })
}

function remapStoredMapVote(mapVote: StoredMapVoteState, seatIndexMap: ReadonlyMap<number, number>): StoredMapVoteState {
  return {
    ...mapVote,
    selections: remapSeatValueRecord(mapVote.selections, seatIndexMap, selection => ({
      maps: [...normalizeMapVoteSelection(selection).maps],
    })),
    confirmations: remapSeatValueRecord(mapVote.confirmations, seatIndexMap, confirmed => confirmed),
    revealedVotes: mapVote.revealedVotes?.map(ballot => ({
      seatIndex: remapSeatIndex(ballot.seatIndex, seatIndexMap),
      confirmed: ballot.confirmed,
      maps: [...normalizeMapVoteSelection(ballot).maps],
    })) ?? null,
  }
}

function remapSeatValueRecord<T>(record: Record<number, T>, seatIndexMap: ReadonlyMap<number, number>, clone: (value: T) => T): Record<number, T> {
  const next: Record<number, T> = {}
  for (const [seatIndex, value] of Object.entries(record)) {
    next[remapSeatIndex(Number(seatIndex), seatIndexMap)] = clone(value)
  }
  return next
}

function remapSeatIndex(seatIndex: number, seatIndexMap: ReadonlyMap<number, number>): number {
  return seatIndexMap.get(seatIndex) ?? seatIndex
}

function buildRepeatCivPool(state: DraftState): string[] {
  return uniqueStrings([
    ...state.availableCivIds,
    ...state.bans.map(selection => selection.civId),
    ...state.picks.map(selection => selection.civId),
    ...state.pendingBlindBans.map(selection => selection.civId),
    ...(state.blindPickBans ?? []).map(selection => selection.civId),
    ...(state.blindPickReveal?.picks ?? []).map(selection => selection.civId),
    ...Object.values(state.submissions).flat(),
    ...(state.dealtCivIds ?? []),
    ...Object.values(state.dealtCivIdsBySeat ?? {}).flat(),
  ])
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
  return left.hostId === right.hostId
    && left.mode === right.mode
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

function resolvePickStepIndex(steps: DraftState['steps'], seatIndex: number): number {
  const stepIndex = steps.findIndex(step => step.action === 'pick' && (step.seats === 'all' || step.seats.includes(seatIndex)))
  return stepIndex >= 0 ? stepIndex : Math.max(steps.length - 1, 0)
}

function parseDraftCompletedAt(raw: string | null | undefined): number | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { completedAt?: unknown } | null
    return normalizeOptionalPositiveInteger(parsed?.completedAt)
  }
  catch {
    return null
  }
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}

function readActivityGuildId(headers: Headers): string | null {
  const guildId = headers.get(CIVUP_ACTIVITY_GUILD_ID_HEADER)?.trim() ?? ''
  return guildId.length > 0 ? guildId : null
}

function isAllowedSessionGuild(sessionGuildId: string | null, env: SessionDOEnv): boolean {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  return config.ok && sessionGuildId != null && config.guildIds.includes(sessionGuildId)
}

function getLeaderPoolSizeError(
  mode: GameMode,
  redDeath: boolean,
  leaderPoolSize: number | null,
  playerCount: number,
  leaderDataVersion: LeaderDataVersion,
): string | null {
  if (redDeath) return null
  if (leaderPoolSize == null) return null

  const maximumSize = getMaxLeaderPoolSize(leaderDataVersion)
  if (leaderPoolSize > maximumSize) return `Leaders must be at most ${maximumSize} for this BBG version.`

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
