import type {
  DraftEvent,
  DraftPreviewState,
  DraftState,
  LeaderSwapState,
  MapVoteSelection,
  MapVoteSnapshot,
  PendingLeaderSwapRequest,
} from '@civup/game'
import type { DraftRuntimeConfig, SessionClientMessage, SessionServerMessage } from '@civup/session'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { StoredMapVoteState } from './map-vote-room-state.ts'
import type { Connection, ConnectionContext, WSMessage } from './socket-server.ts'
import {
  createDraft,
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  EMPTY_MAP_VOTE_SNAPSHOT,
  getCurrentStep,
  getPickSeatForPlayer,
  isDraftError,
  isMapVoteSupportedForMode,
  isRedDeathFormatId,
  MAP_SCRIPT_IDS,
  MAP_TYPE_IDS,
  MAX_TIMER_SECONDS,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
  processDraftInput,
  swapSeatPicks,
} from '@civup/game'
import {
  CIVUP_ACTIVITY_USER_ID_HEADER,
  isAuthorizedInternalRequest,
  verifySessionAccessToken,
} from '@civup/utils'
import {
  applyDraftPreview,
  censorDraftPreviews,
  createEmptyDraftPreviews,
  draftPreviewsEqual,
  resolvePickSubmissionWithPreviews,
  resolveTimeoutWithPreviews,
  sanitizeDraftPreviews,
} from './draft-previews.ts'
import {
  acceptSwapCommand,
  applyDraftResultCommand,
  clearSwapDisconnectFinalizeAtCommand,
  confirmMapVoteCommand,
  createEmptySwapState,
  createRoomRecord,
  finalizeCompletedDraftCommand,
  finishMapVoteRevealCommand,
  finishMapVoteVotingCommand,
  normalizeRoomSwapState,
  normalizeStoredRoomRecord,
  pruneExpiredSwapsCommand,
  ROOM_RECORD_KEY,
  type RoomEffect,
  type RoomRecord,
  setSwapDisconnectFinalizeAtCommand,
  setSwapStateCommand,
  startMapVoteCommand,
  updateConfigCommand,
  updateMapVoteSelectionCommand,
} from './draft-room-domain.ts'
import { resolveAcceptedSwapState } from './leader-swaps.ts'
import {
  createInitialMapVoteState,
  EMPTY_STORED_MAP_VOTE_STATE,
  isMapVoteInProgress,
  isMapVoteVoting,
  isValidMapVoteSelectionInput,

} from './map-vote-room-state.ts'
import {
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
}

// ── Connection State ─────────────────────────────────────────

interface ConnectionState {
  playerId: string | null
}

const DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX = 'bot:'
const DEBUG_ACTIVE_BOT_DELAY_MS = 5000
const DEBUG_ACTIVE_BOT_STAGGER_MS = 150
const SWAP_REQUEST_TIMEOUT_MS = 30_000
const SWAP_DISCONNECT_GRACE_MS = 5_000

// ── Draft Room Server ────────────────────────────────────────

export class SessionDraftRuntime<Env extends DraftRuntimeEnv = DraftRuntimeEnv> extends SessionSocketServer<Env> {
  static override options = {
    hibernate: true,
  }

  protected now(): number {
    return Date.now()
  }

  protected random(): number {
    return Math.random()
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

    const baseState = createDraft(config.matchId, format, config.seats, config.civPool, {
      dealOptionsSize: config.dealOptionsSize,
      duplicateFactions: config.duplicateFactions,
    })
    const mapVoteEnabled = normalizeMapVoteEnabled(format.gameMode, config.mapVoteEnabled === true, { redDeath: format.redDeath })
    const state = withWaitingTimerConfig(format, baseState, config.timerConfig)
    const nextConfig: DraftRuntimeConfig = {
      ...config,
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
      mapVote,
      completedAt: room.completedAt,
      cancelledAt: room.cancelledAt,
      previews: censorDraftPreviews(room.state, room.previews, seatIndex),
      swapState: room.swapWindowOpen ? this.getNormalizedSwapState(room) : null,
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
    return await this.setRoomRecord(updater(await this.requireRoomRecord()))
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

        case 'broadcast-swap-update':
          this.broadcastSwapUpdate(room.state, this.getNormalizedSwapState(room), effect.picks)
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

    const room = await this.getRoomRecord()
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
      timerEndsAt: room.timerEndsAt,
      completedAt: room.completedAt,
      previews: censorDraftPreviews(room.state, room.previews, seatIndex),
      swapState: room.swapWindowOpen ? this.getNormalizedSwapState(room) : null,
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

        await this.updateRoomRecord(current => ({
          ...current,
          previews: nextPreviews,
        }))
        this.broadcastPreviewUpdate(state, nextPreviews)
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

      case 'swap-request': {
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

        const swapState = await this.getSwapState()
        const nextSwapState = createPendingSwap(state, swapState, seatIndex, msg.toSeat, this.now() + SWAP_REQUEST_TIMEOUT_MS)
        if ('error' in nextSwapState) {
          this.send(sender, { type: 'error', message: nextSwapState.error })
          return
        }

        await this.applyRoomTransition(setSwapStateCommand(room, {
          type: 'set-swap-state',
          swapState: nextSwapState,
        }), 'swap-request', {
          fromSeat: seatIndex,
          toSeat: msg.toSeat,
        })
        break
      }

      case 'swap-accept': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!(await this.isSwapWindowOpen())) {
          this.send(sender, { type: 'error', message: 'Leader swaps are not available right now' })
          return
        }

        const swapState = await this.getSwapState()
        const pendingSwap = getIncomingSwapForSeat(swapState, seatIndex)
        if (!pendingSwap) {
          this.send(sender, { type: 'error', message: 'No pending swap request' })
          return
        }

        const swappedPicks = swapSeatPicks(state, pendingSwap.fromSeat, pendingSwap.toSeat)
        if ('error' in swappedPicks) {
          this.send(sender, { type: 'error', message: swappedPicks.error })
          return
        }

        const nextState: DraftState = {
          ...state,
          picks: swappedPicks,
        }
        const nextSwapState = resolveAcceptedSwapState(swapState, pendingSwap)

        await this.applyRoomTransition(acceptSwapCommand(room, {
          type: 'accept-swap',
          nextState,
          swapState: nextSwapState,
          picks: swappedPicks,
        }), 'swap-accept', {
          fromSeat: pendingSwap.fromSeat,
          toSeat: pendingSwap.toSeat,
        })
        break
      }

      case 'swap-cancel': {
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Not a participant' })
          return
        }
        if (!(await this.isSwapWindowOpen())) {
          this.send(sender, { type: 'error', message: 'Leader swaps are not available right now' })
          return
        }

        const swapState = await this.getSwapState()
        const pendingSwap = getOutgoingSwapForSeat(swapState, seatIndex) ?? getIncomingSwapForSeat(swapState, seatIndex)
        if (!pendingSwap) return
        if (pendingSwap.fromSeat !== seatIndex && pendingSwap.toSeat !== seatIndex) {
          this.send(sender, { type: 'error', message: 'Only the players in this swap can cancel it' })
          return
        }

        const nextSwapState: LeaderSwapState = {
          pendingSwaps: swapState.pendingSwaps.filter(swap => !isSamePendingSwap(swap, pendingSwap)),
          completedSwaps: swapState.completedSwaps,
        }
        await this.applyRoomTransition(setSwapStateCommand(room, {
          type: 'set-swap-state',
          swapState: nextSwapState,
        }), 'swap-cancel', {
          fromSeat: pendingSwap.fromSeat,
          toSeat: pendingSwap.toSeat,
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
    let room = await this.getRoomRecord()
    if (!room) return false

    const dueAt = getNextRoomAlarmAt(room, this.getNormalizedSwapState(room))
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
      const swapState = this.getNormalizedSwapState(room)
      const prunedSwapState = pruneExpiredSwapsCommand(room, {
        type: 'prune-expired-swaps',
        now,
      })
      if (prunedSwapState.response) {
        await this.applyRoomTransition(prunedSwapState, 'swap-alarm-prune', {
          now,
        })
      }

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

    if (state.status !== 'active') return false

    // Guard against stale alarms (step already advanced)
    if (room.alarmStepIndex !== state.currentStepIndex) return false

    const format = draftFormatMap.get(config.formatId)
    if (!format) return false

    const previews = sanitizeDraftPreviews(state, room.previews)
    const result = resolveTimeoutWithPreviews(state, format.blindBans, previews, () => this.random())
    if (isDraftError(result)) return false

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

  private scheduleDebugActiveBotActions(state: DraftState, blindBans: boolean) {
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

      this.ctx.waitUntil(wait(scheduledDelayMs)
        .then(() => this.runDebugActiveBotAction(scheduledStepIndex, seatIndex, blindBans))
        .catch((error) => {
          console.error(`Debug active bot action failed for seat ${seatIndex} in match ${state.matchId}:`, error)
        }))
    }
  }

  private scheduleDebugMapVoteBotActions(state: DraftState, config: DraftRuntimeConfig) {
    let delayMs = DEBUG_ACTIVE_BOT_DELAY_MS
    for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
      const playerId = state.seats[seatIndex]?.playerId
      if (!isDebugActiveBotPlayerId(playerId)) continue

      const scheduledDelayMs = delayMs
      delayMs += DEBUG_ACTIVE_BOT_STAGGER_MS

      this.ctx.waitUntil(wait(scheduledDelayMs)
        .then(() => this.runDebugMapVoteBotAction(seatIndex, config))
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

    const availablePool = [...(state.dealtCivIds?.length ? state.dealtCivIds : state.availableCivIds)]
    if (availablePool.length === 0) return

    let result:
      | { state: DraftState, events: DraftEvent[] }
      | { error: string }

    if (step.action === 'ban') {
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
      this.ctx.waitUntil(wait(DEBUG_ACTIVE_BOT_DELAY_MS)
        .then(() => this.runDebugActiveBotAction(stepIndex, seatIndex, blindBans))
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
      mapTypes: normalizedSelection.mapTypes.length > 0
        ? normalizedSelection.mapTypes
        : pickRandomDistinct([...MAP_TYPE_IDS], 1 + Math.floor(this.random() * MAP_TYPE_IDS.length), () => this.random()),
      mapScripts: normalizedSelection.mapScripts.length > 0
        ? normalizedSelection.mapScripts
        : pickRandomDistinct([...MAP_SCRIPT_IDS], 1 + Math.floor(this.random() * 3), () => this.random()),
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
    return getNextRoomAlarmAt(room, this.getNormalizedSwapState(room))
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

  private async finalizeCompletedDraft(state: DraftState) {
    const room = await this.getRoomRecord()
    if (!room?.swapWindowOpen) return
    await this.applyRoomTransition(finalizeCompletedDraftCommand(room, {
      type: 'finalize-completed-draft',
      now: this.now(),
    }), 'finalize-complete', {
      finalized: true,
    })
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

    return await this.startActualDraft(state, config, format)
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
      revealedVotes: mapVoteState.phase === 'reveal' || mapVoteState.phase === 'done' ? mapVoteState.revealedVotes : null,
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
  ) {
    for (const conn of this.getConnections()) {
      const connState = conn.state as ConnectionState | null
      const playerId = connState?.playerId
      const seatIndex = playerId
        ? state.seats.findIndex(s => s.playerId === playerId)
        : -1

      this.send(conn, {
        type: 'update',
        state: this.censorState(state, seatIndex),
        mapVote: this.buildMapVoteSnapshot(mapVoteState, seatIndex),
        leaderDataVersion: leaderDataVersion ?? 'live',
        hostId,
        events: this.censorEvents(events, seatIndex),
        timerEndsAt,
        completedAt,
        previews: censorDraftPreviews(state, previews, seatIndex),
        swapState,
      })
    }
  }

  private broadcastSwapUpdate(_state: DraftState, swapState: LeaderSwapState, picks?: DraftState['picks']) {
    for (const conn of this.getConnections()) {
      this.send(conn, {
        type: 'swap-update',
        swapState,
        picks,
      })
    }
  }

  private broadcastPreviewUpdate(state: DraftState, previews: DraftPreviewState) {
    for (const conn of this.getConnections()) {
      const connState = conn.state as ConnectionState | null
      const playerId = connState?.playerId
      const seatIndex = playerId
        ? state.seats.findIndex(s => s.playerId === playerId)
        : -1

      this.send(conn, {
        type: 'preview',
        previews: censorDraftPreviews(state, previews, seatIndex),
      })
    }
  }

  // ── Internal: Censoring for blind bans ─────────────────────

  /** Filters state for blind bans: players only see their own pending bans */
  private censorState(state: DraftState, seatIndex: number): DraftState {
    let nextState = state

    if (state.pendingBlindBans.length > 0) {
      nextState = {
        ...nextState,
        pendingBlindBans: state.pendingBlindBans.filter(
          b => b.seatIndex === seatIndex,
        ),
      }
    }

    if (seatCanSeeDealtOptions(nextState, seatIndex)) return nextState
    if (nextState.dealtCivIds == null && !isRedDeathDraftState(nextState)) return nextState

    return {
      ...nextState,
      dealtCivIds: null,
      availableCivIds: isRedDeathDraftState(nextState) ? [] : nextState.availableCivIds,
    }
  }

  /** Censors events for blind bans: hides other players' selections */
  private censorEvents(events: DraftEvent[], seatIndex: number): DraftEvent[] {
    return events.map((e) => {
      if (e.type === 'BAN_SUBMITTED' && e.blind && e.seatIndex !== seatIndex) {
        return { ...e, civIds: [] }
      }
      return e
    })
  }

  // ── Internal: Send message ─────────────────────────────────

  private send(connection: Connection, message: SessionServerMessage) {
    connection.send(JSON.stringify(message))
  }

  private closeAllConnections(reason: string) {
    for (const conn of this.getConnections()) {
      conn.close(1000, reason)
    }
  }

}

// ── Utility ──────────────────────────────────────────────────

function isDebugActiveBotPlayerId(playerId: string | null | undefined): boolean {
  return typeof playerId === 'string' && playerId.startsWith(DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX)
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

function getNextRoomAlarmAt(room: RoomRecord, swapState: LeaderSwapState): number | null {
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
      swapState,
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

function seatCanSeeDealtOptions(state: DraftState, seatIndex: number): boolean {
  if (seatIndex < 0 || state.status !== 'active') return false
  if (!isRedDeathDraftState(state)) return true
  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick' || step.seats === 'all') return false

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
    if (step.action === 'pick' && pickTimer != null) return { ...step, timer: pickTimer }
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

function createPendingSwap(
  state: DraftState,
  swapState: LeaderSwapState,
  fromSeat: number,
  toSeat: number,
  expiresAt: number,
): LeaderSwapState | { error: string } {
  if (findPendingSwapBetweenSeats(swapState, fromSeat, toSeat)) {
    return { error: 'A swap request between those players is already pending' }
  }
  if (getOutgoingSwapForSeat(swapState, fromSeat)) {
    return { error: 'You already have a pending outgoing swap request' }
  }
  if (getIncomingSwapForSeat(swapState, toSeat)) {
    return { error: 'That player already has a pending incoming swap request' }
  }

  const validation = swapSeatPicks(state, fromSeat, toSeat)
  if ('error' in validation) return validation

  return {
    pendingSwaps: [...swapState.pendingSwaps, { fromSeat, toSeat, expiresAt }],
    completedSwaps: swapState.completedSwaps,
  }
}

function getIncomingSwapForSeat(
  swapState: LeaderSwapState,
  seatIndex: number,
): PendingLeaderSwapRequest | null {
  return swapState.pendingSwaps.find(swap => swap.toSeat === seatIndex) ?? null
}

function getOutgoingSwapForSeat(
  swapState: LeaderSwapState,
  seatIndex: number,
): PendingLeaderSwapRequest | null {
  return swapState.pendingSwaps.find(swap => swap.fromSeat === seatIndex) ?? null
}

function findPendingSwapBetweenSeats(
  swapState: LeaderSwapState,
  leftSeat: number,
  rightSeat: number,
): PendingLeaderSwapRequest | null {
  return swapState.pendingSwaps.find(
    swap => (swap.fromSeat === leftSeat && swap.toSeat === rightSeat)
      || (swap.fromSeat === rightSeat && swap.toSeat === leftSeat),
  ) ?? null
}

function isSamePendingSwap(
  left: Pick<PendingLeaderSwapRequest, 'fromSeat' | 'toSeat'>,
  right: Pick<PendingLeaderSwapRequest, 'fromSeat' | 'toSeat'>,
): boolean {
  return left.fromSeat === right.fromSeat && left.toSeat === right.toSeat
}

function isAuthorizedRequest(request: Request, expectedSecret: string | undefined): boolean {
  return isAuthorizedInternalRequest(request.headers, expectedSecret)
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}
