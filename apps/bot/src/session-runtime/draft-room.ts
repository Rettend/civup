import type {
  CivBlitzPartialKit,
  DraftEvent,
  DraftPreviewState,
  DraftState,
  LeaderSwapState,
  MapVoteSelection,
  MapVoteSnapshot,
} from '@civup/game'
import type { DraftRuntimeConfig, SessionClientMessage, SessionServerMessage } from '@civup/session'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { RoomEffect, RoomRecord } from './draft-room-domain.ts'
import type { StoredMapVoteState } from './map-vote-room-state.ts'
import type { Connection, ConnectionContext, WSMessage } from './socket-server.ts'
import {
  createDraft,
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  EMPTY_MAP_VOTE_SNAPSHOT,
  getCivBlitzRegistry,
  getCivBlitzStepCategories,
  getCurrentStep,
  getPickSeatForPlayer,
  isCivBlitzFormatId,
  isDraftError,
  isMapVoteSupportedForMode,
  isRedDeathFormatId,
  MAP_VOTE_MAP_IDS,
  MAX_TIMER_SECONDS,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
  processDraftInput,
  swapSeatDraftChoices,
} from '@civup/game'
import {
  CIVUP_ACTIVITY_USER_ID_HEADER,
  isAuthorizedInternalRequest,
  verifySessionAccessToken,
} from '@civup/utils'
import {
  applyDraftPreview,
  censorDraftPreviews,
  censorSanitizedDraftPreviews,
  createEmptyDraftPreviews,
  draftPreviewsEqual,
  resolvePickSubmissionWithPreviews,
  resolveTimeoutWithPreviews,
  sanitizeDraftPreviews,
} from './draft-previews.ts'
import {
  applyDraftResultCommand,
  applyLeaderSwapCommand,
  clearSwapDisconnectFinalizeAtCommand,
  confirmMapVoteCommand,
  createEmptySwapState,
  createRoomRecord,
  finalizeCompletedDraftCommand,
  finishMapVoteRevealCommand,
  finishMapVoteVotingCommand,
  normalizeRoomSwapState,
  normalizeStoredRoomRecord,
  ROOM_RECORD_KEY,

  setSwapDisconnectFinalizeAtCommand,
  startMapVoteCommand,
  updateConfigCommand,
  updateMapVoteSelectionCommand,
} from './draft-room-domain.ts'
import {
  createInitialMapVoteState,
  EMPTY_STORED_MAP_VOTE_STATE,
  isMapVoteInProgress,
  isMapVoteVoting,
  isValidMapVoteSelectionInput,

} from './map-vote-room-state.ts'
import {
  buildHiddenDraftResult,
  buildRandomDraftResult,
  pickRandomDistinct,
} from './random-draft.ts'
import { syncSessionDraftLifecyclePayload } from './session-do-client.ts'
import { SessionSocketServer } from './socket-server.ts'
import {
  countConnectedDraftParticipants,
  getNextSwapLifecycleAlarmAt,
  getSwapDisconnectFinalizeAtAfterDisconnect,
  getSwapWindowAlarmAction,
} from './swap-window.ts'

export interface DraftRuntimeEnv extends Cloudflare.Env {
  CIVUP_SECRET?: string
  DB?: D1Database
  KV?: KVNamespace
  DISCORD_TOKEN?: string
  SessionDO?: DurableObjectNamespace
  ENABLE_DEBUG_LOBBY_FILL?: string
}

// ── Connection State ─────────────────────────────────────────

interface ConnectionState {
  playerId: string | null
}

const DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX = 'bot:'
const DEBUG_ACTIVE_BOT_DELAY_MS = 5_000
const DEBUG_ACTIVE_BOT_STAGGER_MS = 150
const SWAP_DISCONNECT_GRACE_MS = 5_000

// ── Draft Room Server ────────────────────────────────────────

export class SessionDraftRuntime<Env extends DraftRuntimeEnv = DraftRuntimeEnv> extends SessionSocketServer<Env> {
  protected now(): number {
    return Date.now()
  }

  protected random(): number {
    return Math.random()
  }

  protected sleep(ms: number): Promise<void> {
    return wait(ms)
  }

  protected async runBackgroundRoomOperation<T>(operation: () => Promise<T>): Promise<T> {
    return operation()
  }

  // ── HTTP: Draft runtime initialization & status ─────────────

  override async onRequest(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      return this.handleCreate(req)
    }
    if (req.method === 'GET') {
      return this.handleStatus(req)
    }
    return new Response('Method not allowed', { status: 405 })
  }

  private async handleCreate(req: Request): Promise<Response> {
    if (!isAuthorizedRequest(req, this.env.CIVUP_SECRET)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const existing = await this.getRoomRecord()
    if (existing && existing.state.status !== 'cancelled') {
      return json({ error: 'Draft runtime already initialized' }, 409)
    }

    const config: DraftRuntimeConfig = await req.json()

    try {
      await this.initializeDraftRuntime(config, { existing })
    }
    catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }

    return json({ ok: true, matchId: config.matchId }, 201)
  }

  protected async initializeDraftRuntime(
    config: DraftRuntimeConfig,
    options: {
      existing?: RoomRecord | null
    } = {},
  ): Promise<RoomRecord> {
    const existing = options.existing ?? null

    if (typeof config.hostId !== 'string' || config.hostId.length === 0) {
      throw new Error('Missing hostId')
    }

    const format = draftFormatMap.get(config.formatId)
    if (!format) {
      throw new Error(`Unknown format: ${config.formatId}`)
    }
    if (config.seats.length === 0) {
      throw new Error('No seats provided')
    }
    if (config.civPool.length === 0) {
      throw new Error('Empty civ pool')
    }

    const civBlitzRegistry = config.civBlitz === true || isCivBlitzFormatId(config.formatId)
      ? getCivBlitzRegistry(config.leaderDataVersion ?? 'live', { excludeBbgExpanded: config.civBlitzExcludeBbgExpanded !== false })
      : null
    const baseState = createDraft(config.matchId, format, config.seats, config.civPool, {
      dealOptionsSize: config.dealOptionsSize,
      duplicateFactions: config.duplicateFactions,
      civBlitz: civBlitzRegistry
        ? {
            componentPools: civBlitzRegistry.componentPools,
            optionCount: config.civBlitzOptionCount ?? 4,
            excludeBbgExpanded: config.civBlitzExcludeBbgExpanded !== false,
            random: () => this.random(),
          }
        : undefined,
    })
    const mapVoteEnabled = normalizeMapVoteEnabled(format.gameMode, config.mapVoteEnabled === true, { redDeath: format.redDeath })
    const state = withWaitingTimerConfig(format, baseState, config.timerConfig)
    const nextConfig: DraftRuntimeConfig = {
      ...config,
      randomDraft: config.hiddenDraft === true ? false : config.randomDraft,
      mapVoteEnabled,
    }
    const previews = createEmptyDraftPreviews()
    const mapVote = createInitialMapVoteState(state, nextConfig, format.redDeath)
    const room = createRoomRecord(nextConfig, state, mapVote, {
      previews,
      lifecycleEventSequence: existing?.lifecycleEventSequence ?? 0,
    })

    await this.setRoomRecord(room)

    return room
  }

  private async handleStatus(req: Request): Promise<Response> {
    const room = await this.getRoomRecord()
    if (!room) {
      return json({ error: 'Room not initialized' }, 404)
    }

    const activityUserId = readActivityUserId(req.headers)
    if (!isAuthorizedRequest(req, this.env.CIVUP_SECRET) || !activityUserId) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const requestUrl = new URL(req.url)
    const hasAccess = await verifySessionAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      sessionId: room.state.matchId,
      userId: activityUserId,
    })
    if (!hasAccess) {
      return json({ error: 'Forbidden' }, 403)
    }

    const seatIndex = room.state.seats.findIndex(seat => seat.playerId === activityUserId)
    const mapVote = this.buildMapVoteSnapshot(room.mapVote, seatIndex, room.state)
    return json({
      state: this.censorState(room.state, seatIndex),
      timerEndsAt: room.timerEndsAt,
      serverNow: Date.now(),
      mapVote,
      completedAt: room.completedAt,
      cancelledAt: room.cancelledAt,
      previews: censorDraftPreviews(room.state, room.previews, seatIndex),
      swapState: room.swapWindowOpen ? this.getNormalizedSwapState(room) : null,
      steamLobbyLink: room.config.steamLobbyLink ?? null,
      permanentAlly: room.config.permanentAlly === true,
      hiddenDraft: room.config.hiddenDraft === true,
    })
  }

  protected async getRoomRecord(): Promise<RoomRecord | null> {
    return normalizeStoredRoomRecord(await this.ctx.storage.get<unknown>(ROOM_RECORD_KEY))
  }

  protected async requireRoomRecord(): Promise<RoomRecord> {
    const room = await this.getRoomRecord()
    if (!room) {
      throw new Error('Room not initialized')
    }
    return room
  }

  protected async setRoomRecord(room: RoomRecord): Promise<RoomRecord> {
    await this.ctx.storage.put(ROOM_RECORD_KEY, room)
    return room
  }

  protected async updateRoomRecord(updater: (room: RoomRecord) => RoomRecord): Promise<RoomRecord> {
    return this.setRoomRecord(updater(await this.requireRoomRecord()))
  }

  protected getNormalizedSwapState(room: Pick<RoomRecord, 'swapState'>): LeaderSwapState {
    return normalizeRoomSwapState(room)
  }

  private async applyRoomTransition(
    transition: { room: RoomRecord, effects: RoomEffect[] },
    action: string,
    _details?: Record<string, unknown>,
  ): Promise<RoomRecord> {
    const room = await this.setRoomRecord(transition.room)
    await this.executeRoomEffects(room, transition.effects, action)
    return room
  }

  private async executeRoomEffects(room: RoomRecord, effects: RoomEffect[], action: string) {
    let needsAlarmReschedule = false

    for (const effect of effects) {
      switch (effect.type) {
        case 'set-alarm':
          needsAlarmReschedule = true
          break

        case 'delete-alarm':
          needsAlarmReschedule = true
          break

        case 'schedule-swap-alarm':
          needsAlarmReschedule = true
          break

        case 'broadcast-update':
          this.broadcastRoomRecord(room, effect.events)
          break

        case 'sync-draft-lifecycle': {
          const task = this.syncDraftRuntimeLifecyclePayload(effect.payload, action)
          if (effect.delivery === 'await') {
            await task
          }
          else {
            this.ctx.waitUntil(task.catch((error) => {
              console.error('[draft-room] room effect failed', buildDraftRoomLogContext(action, room.state, {
                effect: effect.type,
              }), error)
            }))
          }
          break
        }

        case 'schedule-debug-active-bots':
          this.scheduleDebugActiveBotActions(room.state, effect.blindBans)
          break

        case 'schedule-debug-map-vote-bots':
          this.scheduleDebugMapVoteBotActions(room.state, room.config)
          break

        case 'close-connections':
          this.closeAllConnections(effect.reason)
          break
      }
    }

    if (needsAlarmReschedule) {
      await this.rescheduleRoomAlarm()
    }
  }

  private broadcastRoomRecord(room: RoomRecord, events: DraftEvent[]) {
    const swapState = room.state.status === 'complete' && room.swapWindowOpen
      ? this.getNormalizedSwapState(room)
      : null

    this.broadcastUpdate(
      room.state,
      room.config.hostId,
      room.config.leaderDataVersion ?? 'live',
      events,
      room.timerEndsAt,
      room.completedAt,
      room.previews,
      swapState,
      room.mapVote,
      room.config.steamLobbyLink ?? null,
      room.config.permanentAlly === true,
      room.config.hiddenDraft === true,
    )
  }

  // ── WebSocket: Connection ──────────────────────────────────

  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    if (!isAuthorizedRequest(ctx.request, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const playerId = readActivityUserId(ctx.request.headers)
    if (!playerId) {
      connection.close(4401, 'Unauthorized')
      return
    }

    connection.setState({ playerId } satisfies ConnectionState)

    let room = await this.getRoomRecord()
    if (!room) {
      this.send(connection, { type: 'error', message: 'Room not initialized' })
      connection.close(4000, 'Room not initialized')
      return
    }

    const requestUrl = new URL(ctx.request.url)
    const hasAccess = await verifySessionAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      sessionId: room.state.matchId,
      userId: playerId,
    })
    if (!hasAccess) {
      this.send(connection, { type: 'error', message: 'Session access token is invalid or expired' })
      connection.close(4403, 'Forbidden')
      return
    }

    if (await this.handleDraftRuntimeAlarmIfDue()) {
      room = await this.requireRoomRecord()
      if (connection.readyState >= 2) return
    }

    const hostId = room.config.hostId ?? room.state.seats[0]?.playerId ?? ''
    const seatIndex = playerId
      ? room.state.seats.findIndex(s => s.playerId === playerId)
      : -1
    const mapVote = this.buildMapVoteSnapshot(room.mapVote, seatIndex, room.state)

    this.send(connection, {
      type: 'init',
      state: this.censorState(room.state, seatIndex),
      mapVote,
      leaderDataVersion: room.config.leaderDataVersion ?? 'live',
      hostId,
      seatIndex: seatIndex >= 0 ? seatIndex : null,
      serverNow: Date.now(),
      timerEndsAt: room.timerEndsAt,
      completedAt: room.completedAt,
      previews: censorDraftPreviews(room.state, room.previews, seatIndex),
      swapState: room.swapWindowOpen ? this.getNormalizedSwapState(room) : null,
      steamLobbyLink: room.config.steamLobbyLink ?? null,
      permanentAlly: room.config.permanentAlly === true,
      hiddenDraft: room.config.hiddenDraft === true,
    })

    if (room.swapWindowOpen && seatIndex >= 0 && room.swapDisconnectFinalizeAt != null) {
      await this.applyRoomTransition(clearSwapDisconnectFinalizeAtCommand(room, {
        type: 'clear-swap-disconnect-finalize-at',
      }), 'swap-connect-clear-disconnect', {
        playerId,
      })
    }

    if ((room.state.status === 'complete' && !room.swapWindowOpen) || room.state.status === 'cancelled') {
      connection.close(1000, 'Draft closed')
    }
  }

  // ── WebSocket: Messages ────────────────────────────────────

  override async onMessage(sender: Connection, message: WSMessage) {
    if (typeof message !== 'string') return

    let msg: SessionClientMessage
    try {
      msg = JSON.parse(message)
    }
    catch {
      this.send(sender, { type: 'error', message: 'Invalid JSON' })
      return
    }

    const room = await this.getRoomRecord()
    if (!room) {
      this.send(sender, { type: 'error', message: 'Room not initialized' })
      return
    }

    const state = room.state
    const config = room.config

    const format = draftFormatMap.get(config.formatId)
    if (!format) {
      this.send(sender, { type: 'error', message: 'Unknown format' })
      return
    }

    const connState = sender.state as ConnectionState | null
    const playerId = connState?.playerId
    if (!playerId) {
      this.send(sender, { type: 'error', message: 'Not identified — reconnect through the activity' })
      return
    }

    const seatIndex = state.seats.findIndex(s => s.playerId === playerId)

    switch (msg.type) {
      case 'start': {
        if (playerId !== config.hostId) {
          this.send(sender, { type: 'error', message: 'Only the host can start the draft' })
          return
        }
        const startResult = await this.handleStart(state, config, format)
        if (startResult) {
          this.send(sender, { type: 'error', message: startResult })
        }
        break
      }

      case 'map-vote-selection': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!isValidMapVoteSelectionInput(msg.selection)) {
          this.send(sender, { type: 'error', message: 'Invalid map vote selection' })
          return
        }
        const nextMapVote = await this.updateMapVoteSelection(state, config, seatIndex, msg.selection)
        if (nextMapVote === 'inactive') {
          this.send(sender, { type: 'error', message: 'Map voting is not active' })
          return
        }
        if (nextMapVote === 'locked') {
          this.send(sender, { type: 'error', message: 'Map vote already confirmed' })
          return
        }
        await this.broadcastRoomState(state, config, [])
        break
      }

      case 'map-vote-confirm': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        const confirmResult = await this.confirmMapVote(state, config, seatIndex)
        if (confirmResult === 'inactive') {
          this.send(sender, { type: 'error', message: 'Map voting is not active' })
          return
        }
        if (confirmResult === 'invalid-selection') {
          this.send(sender, { type: 'error', message: 'Map vote selection is incomplete' })
        }
        break
      }

      case 'ban': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!Array.isArray(msg.civIds)) {
          this.send(sender, { type: 'error', message: 'civIds must be an array' })
          return
        }
        const result = processDraftInput(
          state,
          { type: 'BAN', seatIndex, civIds: msg.civIds },
          format.blindBans,
        )
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
        break
      }

      case 'pick': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (typeof msg.civId !== 'string') {
          this.send(sender, { type: 'error', message: 'civId must be a string' })
          return
        }
        const previews = sanitizeDraftPreviews(
          state,
          room.previews,
        )
        const pickSeatIndex = getPickSeatForPlayer(state, seatIndex) ?? seatIndex
        const result = resolvePickSubmissionWithPreviews(
          state,
          format.blindBans,
          previews.picks,
          pickSeatIndex,
          msg.civId,
        )
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
        break
      }

      case 'civ-blitz-submit': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!msg.kit || typeof msg.kit !== 'object') {
          this.send(sender, { type: 'error', message: 'kit must be an object' })
          return
        }
        const result = processDraftInput(
          state,
          { type: 'CIV_BLITZ_SUBMIT', seatIndex, kit: msg.kit },
          { blindBans: format.blindBans, random: () => this.random() },
        )
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
        break
      }

      case 'preview': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }

        const previews = sanitizeDraftPreviews(
          state,
          room.previews,
        )
        const nextPreviews = applyDraftPreview(state, previews, seatIndex, msg.action, msg.civIds)
        if ('error' in nextPreviews) {
          this.send(sender, { type: 'error', message: nextPreviews.error })
          return
        }
        if (draftPreviewsEqual(previews, nextPreviews)) return

        await this.setRoomRecord({
          ...room,
          previews: nextPreviews,
        })
        this.broadcastPreviewUpdate(state, nextPreviews, previews)
        break
      }

      case 'cancel': {
        if (playerId !== config.hostId) {
          this.send(sender, { type: 'error', message: 'Only the host can cancel or scrub the draft' })
          return
        }

        if (msg.reason !== 'cancel' && msg.reason !== 'scrub' && msg.reason !== 'revert') {
          this.send(sender, { type: 'error', message: 'Invalid cancel reason' })
          return
        }

        if (msg.reason === 'revert' && state.status !== 'active' && !isMapVoteInProgress(await this.getStoredMapVoteState())) {
          this.send(sender, { type: 'error', message: 'Draft can only be reverted during an active draft' })
          return
        }

        const result = processDraftInput(
          state,
          { type: 'CANCEL', reason: msg.reason },
          format.blindBans,
        )
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
        break
      }

      case 'leader-swap': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!Number.isInteger(msg.toSeat)) {
          this.send(sender, { type: 'error', message: 'Swap target must be a seat index' })
          return
        }
        if (!(await this.isSwapWindowOpen())) {
          this.send(sender, { type: 'error', message: 'Leader swaps are not available right now' })
          return
        }

        const swappedState = swapSeatDraftChoices(state, seatIndex, msg.toSeat)
        if ('error' in swappedState) {
          this.send(sender, { type: 'error', message: swappedState.error })
          return
        }

        const swapState = await this.getSwapState()
        const nextSwapState: LeaderSwapState = {
          completedSwaps: [...swapState.completedSwaps, { fromSeat: seatIndex, toSeat: msg.toSeat }],
        }

        await this.applyRoomTransition(applyLeaderSwapCommand(room, {
          type: 'apply-leader-swap',
          nextState: swappedState,
          swapState: nextSwapState,
        }), 'leader-swap', {
          fromSeat: seatIndex,
          toSeat: msg.toSeat,
        })
        break
      }

      case 'config': {
        if (playerId !== config.hostId) {
          this.send(sender, { type: 'error', message: 'Only the host can update draft config' })
          return
        }
        if (state.status !== 'waiting') {
          this.send(sender, { type: 'error', message: 'Draft config can only be changed before start' })
          return
        }

        const banTimerSeconds = parseConfigTimer(msg.banTimerSeconds)
        const pickTimerSeconds = parseConfigTimer(msg.pickTimerSeconds)
        if (banTimerSeconds === undefined || pickTimerSeconds === undefined) {
          this.send(sender, { type: 'error', message: `Timers must be numbers between 0 and ${MAX_TIMER_SECONDS}` })
          return
        }

        const timerConfig = { banTimerSeconds, pickTimerSeconds }
        const nextState = withWaitingTimerConfig(format, state, timerConfig)
        const nextConfig = {
          ...config,
          timerConfig,
        } satisfies DraftRuntimeConfig
        await this.applyRoomTransition(updateConfigCommand(room, {
          type: 'update-config',
          nextState,
          nextConfig,
        }), 'config-update', {
          actor: playerId,
        })
        break
      }

      default:
        this.send(sender, { type: 'error', message: 'Unknown message type' })
    }
  }

  // ── WebSocket: Disconnect ──────────────────────────────────

  override async onClose(connection: Connection) {
    const room = await this.getRoomRecord()
    if (!room || room.state.status !== 'complete' || !room.swapWindowOpen) return

    const disconnectFinalizeAt = room.swapDisconnectFinalizeAt
    const nextDisconnectFinalizeAt = getSwapDisconnectFinalizeAtAfterDisconnect({
      connectedParticipantCount: this.getConnectedParticipantCount(room.state, connection),
      existingDisconnectFinalizeAt: disconnectFinalizeAt,
      now: this.now(),
      graceMs: SWAP_DISCONNECT_GRACE_MS,
    })
    if (nextDisconnectFinalizeAt == null || nextDisconnectFinalizeAt === disconnectFinalizeAt) return

    await this.applyRoomTransition(setSwapDisconnectFinalizeAtCommand(room, {
      type: 'set-swap-disconnect-finalize-at',
      disconnectFinalizeAt: nextDisconnectFinalizeAt,
    }), 'connection-close', {
      disconnectedPlayerId: (connection.state as ConnectionState | null)?.playerId ?? null,
    })
  }

  override async onError(_connection: Connection, _error: unknown) {
    // Same as onClose — no special handling needed.
  }

  // ── Timer: Alarm ───────────────────────────────────────────

  override async onAlarm() {
    await this.handleDraftRuntimeAlarmIfDue()
  }

  protected async handleDraftRuntimeAlarmIfDue(now = this.now()): Promise<boolean> {
    const room = await this.getRoomRecord()
    if (!room) return false

    const dueAt = getNextRoomAlarmAt(room)
    if (dueAt != null && dueAt > now + 50) {
      await this.rescheduleRoomAlarm()
      return false
    }

    const state = room.state
    const config = room.config

    if (await this.handleMapVoteAlarm(state, config)) {
      return true
    }

    if (state.status === 'complete' && room.swapWindowOpen) {
      const disconnectFinalizeAt = room.swapDisconnectFinalizeAt
      const safetyEndsAt = room.swapSafetyEndsAt
      const alarmAction = getSwapWindowAlarmAction({
        now,
        connectedParticipantCount: this.getConnectedParticipantCount(state),
        disconnectFinalizeAt,
        safetyEndsAt,
      })
      if (alarmAction === 'clear-disconnect-grace') {
        await this.applyRoomTransition(clearSwapDisconnectFinalizeAtCommand(await this.requireRoomRecord(), {
          type: 'clear-swap-disconnect-finalize-at',
        }), 'swap-alarm-clear-disconnect', {
          now,
        })
      }
      else if (alarmAction === 'finalize') {
        await this.finalizeCompletedDraft(state)
        return true
      }

      await this.rescheduleRoomAlarm()
      return true
    }

    if (dueAt == null) return false
    if (state.status !== 'active') return false

    // Guard against stale alarms (step already advanced)
    if (room.alarmStepIndex !== state.currentStepIndex) return false

    const format = draftFormatMap.get(config.formatId)
    if (!format) return false

    const previews = sanitizeDraftPreviews(state, room.previews)
    const result = resolveTimeoutWithPreviews(state, format.blindBans, previews, () => this.random())
    if (isDraftError(result)) {
      return this.recoverFailedDraftTimeout(room, result.error, format.blindBans)
    }

    await this.applyResult(result.state, result.events)
    return true
  }

  // ── Internal: Apply result & broadcast ─────────────────────

  private async applyResult(newState: DraftState, events: DraftEvent[]) {
    const room = await this.requireRoomRecord()
    const transition = applyDraftResultCommand(room, {
      type: 'apply-draft-result',
      nextState: newState,
      events,
      now: this.now(),
      random: () => this.random(),
    })
    console.log('[draft-room] transition', buildDraftRoomLogContext('apply-result', transition.room.state, {
      eventTypes: events.map(event => event.type),
    }))
    await this.applyRoomTransition(transition, 'apply-result', {
      eventTypes: events.map(event => event.type),
    })
  }

  private async recoverFailedDraftTimeout(room: RoomRecord, error: string, blindBans: boolean): Promise<boolean> {
    const state = room.state
    const step = getCurrentStep(state)
    console.error('[draft-room] timeout resolution failed; cancelling draft to recover stale timer', buildDraftRoomLogContext('alarm-timeout-recovery', state, {
      error,
      timerEndsAt: room.timerEndsAt,
      alarmStepIndex: room.alarmStepIndex,
      stepAction: step?.action ?? null,
      stepSeats: step?.seats ?? null,
      stepCount: step?.count ?? null,
      mapVotePhase: room.mapVote.phase,
      mapVoteEndsAt: room.mapVote.endsAt,
    }))

    const cancelResult = processDraftInput(state, { type: 'CANCEL', reason: 'timeout' }, blindBans)
    if (isDraftError(cancelResult)) {
      console.error('[draft-room] timeout recovery cancellation failed', buildDraftRoomLogContext('alarm-timeout-recovery', state, {
        error: cancelResult.error,
        originalError: error,
        timerEndsAt: room.timerEndsAt,
        alarmStepIndex: room.alarmStepIndex,
        mapVotePhase: room.mapVote.phase,
        mapVoteEndsAt: room.mapVote.endsAt,
      }))
      await this.rescheduleRoomAlarm()
      return false
    }

    await this.applyResult(cancelResult.state, cancelResult.events)
    return true
  }

  private scheduleDebugActiveBotActions(state: DraftState, blindBans: boolean) {
    if (!this.debugActiveBotActionsEnabled()) return

    const step = getCurrentStep(state)
    if (!step) return

    const activeSeats = step.seats === 'all'
      ? Array.from({ length: state.seats.length }, (_, i) => i)
      : step.seats

    let delayMs = DEBUG_ACTIVE_BOT_DELAY_MS
    for (const seatIndex of activeSeats) {
      const playerId = state.seats[seatIndex]?.playerId
      if (!isDebugActiveBotPlayerId(playerId)) continue

      const submittedCount = state.submissions[seatIndex]?.length ?? 0
      if (submittedCount >= step.count) continue

      const scheduledStepIndex = state.currentStepIndex
      const scheduledDelayMs = delayMs
      delayMs += DEBUG_ACTIVE_BOT_STAGGER_MS

      this.ctx.waitUntil(this.sleep(scheduledDelayMs)
        .then(() => this.runBackgroundRoomOperation(() => this.runDebugActiveBotAction(scheduledStepIndex, seatIndex, blindBans)))
        .catch((error) => {
          console.error(`Debug active bot action failed for seat ${seatIndex} in match ${state.matchId}:`, error)
        }))
    }
  }

  private scheduleDebugMapVoteBotActions(state: DraftState, config: DraftRuntimeConfig) {
    if (!this.debugActiveBotActionsEnabled()) return

    let delayMs = DEBUG_ACTIVE_BOT_DELAY_MS
    for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
      const playerId = state.seats[seatIndex]?.playerId
      if (!isDebugActiveBotPlayerId(playerId)) continue

      const scheduledDelayMs = delayMs
      delayMs += DEBUG_ACTIVE_BOT_STAGGER_MS

      this.ctx.waitUntil(this.sleep(scheduledDelayMs)
        .then(() => this.runBackgroundRoomOperation(() => this.runDebugMapVoteBotAction(seatIndex, config)))
        .catch((error) => {
          console.error(`Debug map vote bot action failed for seat ${seatIndex} in match ${state.matchId}:`, error)
        }))
    }
  }

  private async runDebugActiveBotAction(stepIndex: number, seatIndex: number, blindBans: boolean) {
    const room = await this.getRoomRecord()
    const state = room?.state
    if (!state || state.status !== 'active') return
    if (state.currentStepIndex !== stepIndex) return

    const step = state.steps[state.currentStepIndex]
    if (!step || !isSeatInStep(step, seatIndex, state.seats.length)) return

    const seat = state.seats[seatIndex]
    if (!seat || !isDebugActiveBotPlayerId(seat.playerId)) return

    const submittedCount = state.submissions[seatIndex]?.length ?? 0
    if (submittedCount >= step.count) return

    let result:
      | { state: DraftState, events: DraftEvent[] }
      | { error: string }

    if (step.civBlitz) {
      const kit = buildDebugCivBlitzKit(state, seatIndex, () => this.random())
      if (!kit) return
      result = processDraftInput(
        state,
        { type: 'CIV_BLITZ_SUBMIT', seatIndex, kit },
        { blindBans, random: () => this.random() },
      )
    }
    else if (step.action === 'ban') {
      const availablePool = [...(state.dealtCivIdsBySeat?.[seatIndex]?.length ? state.dealtCivIdsBySeat[seatIndex]! : state.dealtCivIds?.length ? state.dealtCivIds : state.availableCivIds)]
      if (availablePool.length === 0) return
      const remainingCount = Math.min(step.count - submittedCount, availablePool.length)
      if (remainingCount <= 0) return

      const civIds = pickRandomDistinct(availablePool, remainingCount, () => this.random())
      result = processDraftInput(
        state,
        { type: 'BAN', seatIndex, civIds },
        blindBans,
      )
    }
    else {
      const availablePool = getDebugPickPool(state, step, seatIndex)
      if (availablePool.length === 0) return
      const [civId] = pickRandomDistinct(availablePool, 1, () => this.random())
      if (!civId) return
      result = processDraftInput(
        state,
        { type: 'PICK', seatIndex, civId },
        blindBans,
      )
    }
    if (isDraftError(result)) return

    const nextState = result.state
    await this.applyResult(result.state, result.events)

    const nextStep = nextState.steps[nextState.currentStepIndex]
    const nextSubmittedCount = nextState.submissions[seatIndex]?.length ?? 0
    const needsFollowUpOnSameStep = nextState.status === 'active'
      && nextState.currentStepIndex === stepIndex
      && nextStep != null
      && isSeatInStep(nextStep, seatIndex, nextState.seats.length)
      && nextSubmittedCount < nextStep.count

    if (needsFollowUpOnSameStep) {
      this.ctx.waitUntil(this.sleep(DEBUG_ACTIVE_BOT_DELAY_MS)
        .then(() => this.runBackgroundRoomOperation(() => this.runDebugActiveBotAction(stepIndex, seatIndex, blindBans)))
        .catch((error) => {
          console.error(`Debug active bot follow-up action failed for seat ${seatIndex} in match ${nextState.matchId}:`, error)
        }))
    }
  }

  private async runDebugMapVoteBotAction(seatIndex: number, config: DraftRuntimeConfig) {
    const room = await this.getRoomRecord()
    const state = room?.state
    if (!state || !room) return

    const seat = state.seats[seatIndex]
    if (!seat || !isDebugActiveBotPlayerId(seat.playerId)) return

    const mapVoteState = room.mapVote
    if (!isMapVoteVoting(mapVoteState) || mapVoteState.confirmations[seatIndex] === true) return

    const selection = mapVoteState.selections[seatIndex] ?? DEFAULT_MAP_VOTE_SELECTION
    const normalizedSelection = normalizeMapVoteSelection(selection)
    const nextSelection: MapVoteSelection = {
      maps: normalizedSelection.maps.length > 0
        ? normalizedSelection.maps
        : pickRandomDistinct([...MAP_VOTE_MAP_IDS], 1 + Math.floor(this.random() * 3), () => this.random()),
    }

    const updated = await this.updateMapVoteSelection(state, config, seatIndex, nextSelection)
    if (typeof updated !== 'string') {
      await this.broadcastRoomState(state, config, [])
    }

    await this.confirmMapVote(state, config, seatIndex)
  }

  private async isSwapWindowOpen(): Promise<boolean> {
    return (await this.getRoomRecord())?.swapWindowOpen === true
  }

  private async getSwapState(): Promise<LeaderSwapState> {
    const room = await this.getRoomRecord()
    if (!room) return createEmptySwapState()
    return this.getNormalizedSwapState(room)
  }

  protected async syncDraftRuntimeLifecyclePayload(payload: DraftLifecyclePayload, action: string): Promise<void> {
    const result = await syncSessionDraftLifecyclePayload(this.env.SessionDO, payload.matchId, payload)
    if (result.ok) return

    console.error('[draft-room] lifecycle sync deferred to session runtime', buildDraftLifecycleLogContext(payload, {
      action,
      status: result.status,
      error: result.error,
    }))
  }

  protected async rescheduleRoomAlarm() {
    await this.setDraftRuntimeAlarm(await this.getDraftRuntimeAlarmAt())
  }

  protected async getDraftRuntimeAlarmAt(): Promise<number | null> {
    const room = await this.getRoomRecord()
    if (!room) return null
    return getNextRoomAlarmAt(room)
  }

  protected async setDraftRuntimeAlarm(nextAlarm: number | null): Promise<void> {
    const storage = this.ctx.storage as DurableObjectStorage & {
      setAlarm?: (scheduledTime: number | Date) => Promise<void>
      deleteAlarm?: () => Promise<void>
    }
    if (nextAlarm == null) {
      if (typeof storage.deleteAlarm === 'function') await storage.deleteAlarm()
      return
    }

    if (typeof storage.setAlarm === 'function') await storage.setAlarm(nextAlarm)
  }

  protected async finalizeCompletedDraft(_state?: DraftState): Promise<boolean> {
    const room = await this.getRoomRecord()
    if (!room?.swapWindowOpen || room.state.status !== 'complete') return false
    const transition = finalizeCompletedDraftCommand(room, {
      type: 'finalize-completed-draft',
      now: this.now(),
    })
    await this.applyRoomTransition(transition, 'finalize-complete', {
      finalized: true,
    })
    return transition.response === true
  }

  private async handleStart(state: DraftState, config: DraftRuntimeConfig, format: NonNullable<ReturnType<typeof draftFormatMap.get>>): Promise<string | null> {
    if (state.status !== 'waiting') {
      const result = processDraftInput(state, { type: 'START' }, format.blindBans)
      if (isDraftError(result)) return result.error
      await this.applyResult(result.state, result.events)
      return null
    }

    const room = await this.requireRoomRecord()
    const mapVoteState = room.mapVote
    if (mapVoteState.enabled && mapVoteState.phase === 'idle') {
      await this.applyRoomTransition(startMapVoteCommand(room, {
        type: 'start-map-vote',
        now: this.now(),
      }), 'start-map-vote')
      return null
    }

    if (mapVoteState.enabled && mapVoteState.phase !== 'done') {
      return 'Map voting is already in progress'
    }

    return this.startActualDraft(state, config, format)
  }

  private async handleMapVoteAlarm(state: DraftState, _config: DraftRuntimeConfig): Promise<boolean> {
    const room = await this.requireRoomRecord()
    if (!room.mapVote.enabled || room.mapVote.endsAt == null) return false

    if (room.mapVote.phase === 'voting') {
      await this.finishMapVoteVoting(state, room.config)
      return true
    }

    if (room.mapVote.phase === 'reveal') {
      await this.finishMapVoteReveal(state, room.config)
      return true
    }

    return false
  }

  private async updateMapVoteSelection(
    _state: DraftState,
    _config: DraftRuntimeConfig,
    seatIndex: number,
    selection: MapVoteSelection,
  ): Promise<ReturnType<typeof updateMapVoteSelectionCommand>['response']> {
    const room = await this.requireRoomRecord()
    const transition = updateMapVoteSelectionCommand(room, {
      type: 'update-map-vote-selection',
      seatIndex,
      selection,
    })
    if (typeof transition.response === 'string') return transition.response

    await this.applyRoomTransition(transition, 'map-vote-selection', {
      seatIndex,
    })
    return transition.response
  }

  private async confirmMapVote(
    state: DraftState,
    _config: DraftRuntimeConfig,
    seatIndex: number,
  ): Promise<'inactive' | 'invalid-selection' | 'ok'> {
    const room = await this.requireRoomRecord()
    const transition = confirmMapVoteCommand(room, {
      type: 'confirm-map-vote',
      state,
      seatIndex,
      now: this.now(),
    })
    if (transition.response !== 'ok') return transition.response

    await this.applyRoomTransition(transition, 'map-vote-confirm', {
      seatIndex,
    })
    return 'ok'
  }

  private async finishMapVoteVoting(state: DraftState, _config: DraftRuntimeConfig) {
    const room = await this.requireRoomRecord()
    const transition = finishMapVoteVotingCommand(room, {
      type: 'finish-map-vote-voting',
      state,
      now: this.now(),
    })
    if (!transition.response) return

    await this.applyRoomTransition(transition, 'map-vote-finish-voting')
  }

  private async finishMapVoteReveal(_state: DraftState, _config: DraftRuntimeConfig) {
    const room = await this.requireRoomRecord()
    const transition = finishMapVoteRevealCommand(room, {
      type: 'finish-map-vote-reveal',
    })
    if (!transition.response) return

    const nextRoom = await this.applyRoomTransition(transition, 'map-vote-finish-reveal')
    const format = draftFormatMap.get(nextRoom.config.formatId)
    if (!format) return
    await this.startActualDraft(nextRoom.state, nextRoom.config, format)
  }

  private async startActualDraft(state: DraftState, config: DraftRuntimeConfig, format: NonNullable<ReturnType<typeof draftFormatMap.get>>): Promise<string | null> {
    if (config.hiddenDraft) {
      const result = buildHiddenDraftResult(state)
      await this.applyResult(result.state, result.events)
      return null
    }

    if (config.randomDraft) {
      const result = buildRandomDraftResult(state, () => this.random())
      await this.applyResult(result.state, result.events)
      return null
    }

    const result = processDraftInput(state, { type: 'START' }, format.blindBans)
    if (isDraftError(result)) return result.error
    await this.applyResult(result.state, result.events)
    return null
  }

  private async broadcastRoomState(_state: DraftState, _config: DraftRuntimeConfig, events: DraftEvent[]) {
    const room = await this.requireRoomRecord()
    this.broadcastRoomRecord(room, events)
  }

  protected async syncDraftRuntimeSteamLobbyLink(steamLobbyLink: string | null): Promise<void> {
    const room = await this.getRoomRecord()
    if (!room) return
    if ((room.config.steamLobbyLink ?? null) === steamLobbyLink) return

    await this.setRoomRecord({
      ...room,
      config: {
        ...room.config,
        steamLobbyLink,
      },
    })

    for (const connection of this.getConnections()) {
      this.send(connection, { type: 'projection-update', steamLobbyLink })
    }
  }

  private async getStoredMapVoteState(): Promise<StoredMapVoteState> {
    return (await this.getRoomRecord())?.mapVote ?? { ...EMPTY_STORED_MAP_VOTE_STATE }
  }

  private async getMapVoteSnapshot(state: DraftState, seatIndex: number): Promise<MapVoteSnapshot> {
    return this.buildMapVoteSnapshot(await this.getStoredMapVoteState(), seatIndex, state)
  }

  private buildMapVoteSnapshot(mapVoteState: StoredMapVoteState, seatIndex: number, state?: DraftState): MapVoteSnapshot {
    if (!mapVoteState.enabled) return { ...EMPTY_MAP_VOTE_SNAPSHOT }
    const resolvedSeatIndex = seatIndex >= 0 ? seatIndex : null
    const confirmedSeatIndices = Object.entries(mapVoteState.confirmations)
      .filter(([, confirmed]) => confirmed === true)
      .map(([index]) => Number(index))
      .filter(index => Number.isInteger(index) && index >= 0)
      .sort((left, right) => left - right)

    return {
      enabled: mapVoteState.enabled,
      supported: state ? isMapVoteSupportedForMode(draftFormatMap.get(state.formatId)?.gameMode ?? 'ffa', { redDeath: isRedDeathFormatId(state.formatId) }) : mapVoteState.enabled,
      phase: mapVoteState.phase,
      endsAt: mapVoteState.endsAt,
      selection: resolvedSeatIndex == null ? null : normalizeMapVoteSelection(mapVoteState.selections[resolvedSeatIndex] ?? DEFAULT_MAP_VOTE_SELECTION),
      hasConfirmed: resolvedSeatIndex == null ? false : mapVoteState.confirmations[resolvedSeatIndex] === true,
      confirmedSeatIndices,
      revealedVotes: mapVoteState.phase === 'reveal' || mapVoteState.phase === 'done'
        ? mapVoteState.revealedVotes?.map(ballot => ({
            seatIndex: ballot.seatIndex,
            confirmed: ballot.confirmed,
            maps: [...normalizeMapVoteSelection(ballot).maps],
          })) ?? null
        : null,
      result: mapVoteState.phase === 'reveal' || mapVoteState.phase === 'done' ? mapVoteState.result : null,
    }
  }

  private getConnectedParticipantCount(state: DraftState, excludedConnection?: Connection): number {
    return countConnectedDraftParticipants(
      state.seats.map(seat => seat.playerId),
      Array.from(this.getConnections(), connection => ({
        connection,
        playerId: (connection.state as ConnectionState | null)?.playerId,
      })),
      excludedConnection,
    )
  }

  private broadcastUpdate(
    state: DraftState,
    hostId: string,
    leaderDataVersion: DraftRuntimeConfig['leaderDataVersion'],
    events: DraftEvent[],
    timerEndsAt: number | null,
    completedAt: number | null,
    previews: DraftPreviewState,
    swapState: LeaderSwapState | null,
    mapVoteState: StoredMapVoteState,
    steamLobbyLink: string | null,
    permanentAlly: boolean,
    hiddenDraft: boolean,
  ) {
    const sanitizedPreviews = sanitizeDraftPreviews(state, previews)
    const previewCache = new Map<number, DraftPreviewState>()
    const seatIndexCache = new Map<string, number>()

    for (const conn of this.getConnections()) {
      const connState = conn.state as ConnectionState | null
      const seatIndex = getCachedSeatIndex(state, seatIndexCache, connState?.playerId)

      this.send(conn, {
        type: 'update',
        state: this.censorState(state, seatIndex),
        mapVote: this.buildMapVoteSnapshot(mapVoteState, seatIndex),
        leaderDataVersion: leaderDataVersion ?? 'live',
        hostId,
        events: this.censorEvents(events, seatIndex),
        serverNow: Date.now(),
        timerEndsAt,
        completedAt,
        previews: getCachedCensoredPreviews(state, sanitizedPreviews, seatIndex, previewCache),
        swapState,
        steamLobbyLink,
        permanentAlly,
        hiddenDraft,
      })
    }
  }

  private broadcastPreviewUpdate(state: DraftState, previews: DraftPreviewState, previousPreviews: DraftPreviewState) {
    const nextPreviewCache = new Map<number, DraftPreviewState>()
    const previousPreviewCache = new Map<number, DraftPreviewState>()
    const seatIndexCache = new Map<string, number>()

    for (const conn of this.getConnections()) {
      const connState = conn.state as ConnectionState | null
      const seatIndex = getCachedSeatIndex(state, seatIndexCache, connState?.playerId)
      const next = getCachedCensoredPreviews(state, previews, seatIndex, nextPreviewCache)
      const previous = getCachedCensoredPreviews(state, previousPreviews, seatIndex, previousPreviewCache)
      if (draftPreviewsEqual(next, previous)) continue

      this.send(conn, {
        type: 'preview',
        previews: next,
      })
    }
  }

  // ── Internal: Censoring for blind draft data ────────────────

  /** Filters state for blind picks/bans and private dealt options. */
  private censorState(state: DraftState, seatIndex: number): DraftState {
    return censorDraftStateForSeat(state, seatIndex)
  }

  /** Censors events for blind bans: hides other players' selections */
  private censorEvents(events: DraftEvent[], seatIndex: number): DraftEvent[] {
    return events.map((e) => {
      if (e.type === 'BAN_SUBMITTED' && e.blind && e.seatIndex !== seatIndex) {
        return { ...e, civIds: [] }
      }
      if (e.type === 'PICK_SUBMITTED' && e.blind) {
        return { ...e, civId: '' }
      }
      if (e.type === 'CIV_BLITZ_SUBMITTED' && e.blind) {
        return { ...e, categories: [] }
      }
      return e
    })
  }

  // ── Internal: Send message ─────────────────────────────────

  private send(connection: Connection, message: SessionServerMessage) {
    this.sendConnectionMessage(connection, JSON.stringify(message))
  }

  private closeAllConnections(reason: string) {
    for (const conn of this.getConnections()) {
      conn.close(1000, reason)
    }
  }

  protected debugActiveBotActionsEnabled(): boolean {
    return isTruthyEnvFlag(this.env.ENABLE_DEBUG_LOBBY_FILL)
  }
}

// ── Utility ──────────────────────────────────────────────────

function isDebugActiveBotPlayerId(playerId: string | null | undefined): boolean {
  return typeof playerId === 'string' && playerId.startsWith(DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX)
}

function getDebugPickPool(state: DraftState, step: DraftState['steps'][number], seatIndex: number): string[] {
  const pool = [...(state.dealtCivIdsBySeat?.[seatIndex]?.length ? state.dealtCivIdsBySeat[seatIndex]! : state.dealtCivIds?.length ? state.dealtCivIds : state.availableCivIds)]
  if (!step.blind || state.duplicateFactions) return pool
  return pool.filter(civId => !hasSameTeamPickSubmission(state, seatIndex, civId))
}

function hasSameTeamPickSubmission(state: DraftState, seatIndex: number, civId: string): boolean {
  const team = state.seats[seatIndex]?.team

  for (const [rawSubmittedSeatIndex, civIds] of Object.entries(state.submissions)) {
    const submittedSeatIndex = Number(rawSubmittedSeatIndex)
    if (!civIds.includes(civId)) continue
    if (submittedSeatIndex === seatIndex) return true
    if (team != null && state.seats[submittedSeatIndex]?.team === team) return true
  }

  return false
}

function buildDebugCivBlitzKit(
  state: DraftState,
  seatIndex: number,
  random: () => number,
): CivBlitzPartialKit | null {
  const step = getCurrentStep(state)
  const options = state.civBlitz?.optionsBySeat[seatIndex]
  if (!step?.civBlitz || !options) return null

  const categories = getCivBlitzStepCategories(step, seatIndex)
  const kit: CivBlitzPartialKit = {}
  for (const category of categories) {
    const choices = options[category] ?? []
    if (choices.length === 0) return null
    kit[category] = choices[Math.floor(random() * choices.length)]
  }
  return kit
}

function getCachedSeatIndex(state: DraftState, cache: Map<string, number>, playerId: string | null | undefined): number {
  if (!playerId) return -1
  const cached = cache.get(playerId)
  if (cached != null) return cached

  const seatIndex = state.seats.findIndex(s => s.playerId === playerId)
  cache.set(playerId, seatIndex)
  return seatIndex
}

function getCachedCensoredPreviews(
  state: DraftState,
  sanitizedPreviews: DraftPreviewState,
  seatIndex: number,
  cache: Map<number, DraftPreviewState>,
): DraftPreviewState {
  const cached = cache.get(seatIndex)
  if (cached) return cached

  const censored = censorSanitizedDraftPreviews(state, sanitizedPreviews, seatIndex)
  cache.set(seatIndex, censored)
  return censored
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function buildDraftRoomLogContext(
  phase: string,
  state: DraftState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phase,
    matchId: state.matchId,
    status: state.status,
    currentStepIndex: state.currentStepIndex,
    ...extra,
  }
}

function buildDraftLifecycleLogContext(
  payload: DraftLifecyclePayload,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildDraftRoomLogContext('lifecycle-sync', payload.state, {
    eventId: payload.eventId,
    eventKind: payload.eventKind,
    eventSequence: payload.eventSequence,
    outcome: payload.outcome,
    finalized: payload.outcome === 'complete' ? payload.finalized === true : false,
    ...extra,
  })
}

function getNextRoomAlarmAt(room: RoomRecord): number | null {
  const candidates: number[] = []

  if (
    room.state.status === 'active'
    && room.timerEndsAt != null
    && room.alarmStepIndex === room.state.currentStepIndex
  ) {
    candidates.push(room.timerEndsAt)
  }

  if (
    room.mapVote.enabled
    && (room.mapVote.phase === 'voting' || room.mapVote.phase === 'reveal')
    && room.mapVote.endsAt != null
  ) {
    candidates.push(room.mapVote.endsAt)
  }

  if (room.state.status === 'complete' && room.swapWindowOpen) {
    const swapAlarmAt = getNextSwapLifecycleAlarmAt({
      disconnectFinalizeAt: room.swapDisconnectFinalizeAt,
      safetyEndsAt: room.swapSafetyEndsAt,
    })
    if (swapAlarmAt != null) {
      candidates.push(swapAlarmAt)
    }
  }

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

function isSeatInStep(step: DraftState['steps'][number], seatIndex: number, totalSeats: number): boolean {
  if (step.seats === 'all') return seatIndex >= 0 && seatIndex < totalSeats
  return step.seats.includes(seatIndex)
}

function isRedDeathDraftState(state: DraftState): boolean {
  return isRedDeathFormatId(state.formatId)
}

export function censorDraftStateForSeat(state: DraftState, seatIndex: number): DraftState {
  let nextState = state

  const step = getCurrentStep(state)
  if (step?.action === 'pick' && step.blind && state.status === 'active') {
    const submissions: DraftState['submissions'] = {}
    for (const [rawSeatIndex, civIds] of Object.entries(state.submissions)) {
      const submittedSeatIndex = Number(rawSeatIndex)
      submissions[submittedSeatIndex] = canViewBlindPickSubmission(state, seatIndex, submittedSeatIndex)
        ? [...civIds]
        : Array.from({ length: civIds.length }, () => '__blind__')
    }
    nextState = {
      ...nextState,
      submissions,
    }
  }

  if (state.civBlitz && state.status === 'active') {
    const ownOptions = seatIndex >= 0 ? state.civBlitz.optionsBySeat[seatIndex] ?? null : null
    nextState = {
      ...nextState,
      civBlitz: {
        ...state.civBlitz,
        optionsBySeat: ownOptions ? { [seatIndex]: ownOptions } : {},
        submissions: Object.fromEntries(Object.entries(state.civBlitz.submissions).map(([rawSeatIndex, kit]) => [
          rawSeatIndex,
          canViewBlindPickSubmission(state, seatIndex, Number(rawSeatIndex))
            ? { ...kit }
            : Object.fromEntries(Object.keys(kit).map(category => [category, '__blind__'])),
        ])),
      },
    }
  }

  if (state.pendingBlindBans.length > 0) {
    nextState = {
      ...nextState,
      pendingBlindBans: state.pendingBlindBans.filter(
        b => b.seatIndex === seatIndex,
      ),
    }
  }

  if (nextState.dealtCivIdsBySeat) {
    const ownDealt = seatIndex >= 0 ? nextState.dealtCivIdsBySeat[seatIndex] ?? null : null
    nextState = {
      ...nextState,
      dealtCivIds: ownDealt,
      dealtCivIdsBySeat: ownDealt ? { [seatIndex]: ownDealt } : null,
    }
  }

  if (seatCanSeeDealtOptions(nextState, seatIndex)) return nextState
  if (nextState.dealtCivIds == null && nextState.dealtCivIdsBySeat == null && !isRedDeathDraftState(nextState)) return nextState

  return {
    ...nextState,
    dealtCivIds: null,
    dealtCivIdsBySeat: null,
    availableCivIds: isRedDeathDraftState(nextState) ? [] : nextState.availableCivIds,
  }
}

function canViewBlindPickSubmission(state: DraftState, viewerSeatIndex: number, submittedSeatIndex: number): boolean {
  if (viewerSeatIndex === submittedSeatIndex) return true

  const viewerSeat = state.seats[viewerSeatIndex]
  const submittedSeat = state.seats[submittedSeatIndex]
  if (!viewerSeat || !submittedSeat) return false
  if (viewerSeat.team == null || submittedSeat.team == null) return false
  return viewerSeat.team === submittedSeat.team
}

function seatCanSeeDealtOptions(state: DraftState, seatIndex: number): boolean {
  if (seatIndex < 0 || state.status !== 'active') return false
  if (!isRedDeathDraftState(state)) return true
  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick') return false
  if (step.blind) return isSeatInStep(step, seatIndex, state.seats.length)
  if (step.seats === 'all') return false

  const activeSeat = step.seats[0]
  if (activeSeat == null) return false
  if (activeSeat === seatIndex) return true

  const activeTeam = state.seats[activeSeat]?.team
  const viewerTeam = state.seats[seatIndex]?.team
  if (activeTeam == null || viewerTeam == null) return false
  return activeTeam === viewerTeam
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function withWaitingTimerConfig(
  format: { getSteps: (seatCount: number) => DraftState['steps'] },
  state: DraftState,
  timerConfig: DraftRuntimeConfig['timerConfig'] | undefined,
): DraftState {
  const baseSteps = format.getSteps(state.seats.length)
  const configuredSteps = applyTimerConfigToSteps(baseSteps, timerConfig)
  return {
    ...state,
    steps: configuredSteps,
  }
}

function applyTimerConfigToSteps(
  steps: DraftState['steps'],
  timerConfig: DraftRuntimeConfig['timerConfig'] | undefined,
): DraftState['steps'] {
  if (!timerConfig) return steps

  const banTimer = normalizeTimerSeconds(timerConfig.banTimerSeconds)
  const pickTimer = normalizeTimerSeconds(timerConfig.pickTimerSeconds)
  if (banTimer == null && pickTimer == null) return steps

  return steps.map((step) => {
    if (step.action === 'ban' && banTimer != null) return { ...step, timer: banTimer }
    if (step.action === 'pick' && pickTimer != null) {
      return {
        ...step,
        timer: step.fallbackTimer != null ? Math.min(pickTimer * 2, MAX_TIMER_SECONDS) : pickTimer,
        fallbackTimer: step.fallbackTimer != null ? pickTimer : step.fallbackTimer,
      }
    }
    return step
  })
}

function normalizeTimerSeconds(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 0) return null
  return Math.min(rounded, MAX_TIMER_SECONDS)
}

function parseConfigTimer(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > MAX_TIMER_SECONDS) return undefined
  return rounded
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isAuthorizedRequest(request: Request, expectedSecret: string | undefined): boolean {
  return isAuthorizedInternalRequest(request.headers, expectedSecret)
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}
