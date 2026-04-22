import type {
  ClientMessage,
  DraftEvent,
  DraftPreviewState,
  DraftState,
  DraftWebhookPayload,
  LeaderSwapRequest,
  LeaderSwapState,
  MapVoteSelection,
  MapVoteSnapshot,
  PendingLeaderSwapRequest,
  RevealedMapVoteSeatBallot,
  RoomConfig,
  ServerMessage,
} from '@civup/game'
import type { Connection, ConnectionContext, WSMessage } from 'partyserver'
import type { MapVoteSelectionUpdateResult, StoredMapVoteState } from './map-vote-room-state.ts'
import {
  createDraft,
  createMapVoteRng,
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
  MAP_VOTE_REVEAL_DURATION_MS,
  MAP_VOTE_VOTING_DURATION_MS,
  MAX_TIMER_SECONDS,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
  processDraftInput,
  resolveMapVoteWinner,
  swapSeatPicks,
} from '@civup/game'
import {
  api,
  ApiError,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  createSignedWebhookHeaders,
  isAuthorizedInternalRequest,
  verifyDraftRoomAccessToken,
} from '@civup/utils'
import { Server } from 'partyserver'
import {
  applyDraftPreview,
  censorDraftPreviews,
  createEmptyDraftPreviews,
  draftPreviewsEqual,
  resolvePickSubmissionWithPreviews,
  resolveTimeoutWithPreviews,
  sanitizeDraftPreviews,
} from './draft-previews.ts'
import { resolveAcceptedSwapState } from './leader-swaps.ts'
import {
  applyMapVoteSelectionUpdate,
  createInitialMapVoteState,
  EMPTY_STORED_MAP_VOTE_STATE,
  isMapVoteInProgress,
  isMapVoteSelectionConfirmable,
  isMapVoteVoting,
  isValidMapVoteSelectionInput,

} from './map-vote-room-state.ts'
import {
  buildRandomDraftResult,
  pickRandomDistinct,
} from './random-draft.ts'
import { assertDraftRoomInvariants } from './draft-room-invariants.ts'
import {
  canOpenSwapWindowForState,
  countConnectedDraftParticipants,
  getNextSwapLifecycleAlarmAt,
  getSwapDisconnectFinalizeAtAfterDisconnect,
  getSwapWindowAlarmAction,
} from './swap-window.ts'

interface PartyEnv extends Cloudflare.Env {
  CIVUP_SECRET?: string
}

interface RoomRecord {
  version: number
  config: RoomConfig
  state: DraftState
  timerEndsAt: number | null
  alarmStepIndex: number
  completedAt: number | null
  cancelledAt: number | null
  previews: DraftPreviewState
  swapWindowOpen: boolean
  swapState: LeaderSwapState | null
  swapPendingExpiresAt: number | null
  swapDisconnectFinalizeAt: number | null
  swapSafetyEndsAt: number | null
  mapVote: StoredMapVoteState
}

// ── Connection State ─────────────────────────────────────────

interface ConnectionState {
  playerId: string | null
}

const WEBHOOK_MAX_ATTEMPTS = 4
const WEBHOOK_RETRY_BASE_MS = 250
const WEBHOOK_RETRY_MAX_MS = 1500
const DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX = 'bot:'
const DEBUG_ACTIVE_BOT_DELAY_MS = 5000
const DEBUG_ACTIVE_BOT_STAGGER_MS = 150
const ROOM_RECORD_KEY = 'room'
const ROOM_RECORD_VERSION = 1
const SWAP_REQUEST_TIMEOUT_MS = 30_000
const SWAP_DISCONNECT_GRACE_MS = 5_000
const SWAP_WINDOW_TIMEOUT_MS = 5 * 60_000

function buildMapVoteSeed(matchId: string, ballots: readonly RevealedMapVoteSeatBallot[]): string {
  const serialized = ballots
    .map(ballot => `${ballot.seatIndex}:${ballot.confirmed ? 1 : 0}:${ballot.mapTypes.join(',')}:${ballot.mapScripts.join(',')}`)
    .join('|')

  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `${matchId}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

// ── Draft Room Server ────────────────────────────────────────

export class Main extends Server<PartyEnv> {
  static override options = {
    hibernate: true,
  }

  // ── HTTP: Room initialization & status ─────────────────────

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
    if (existing) {
      return json({ error: 'Room already initialized' }, 409)
    }

    const config: RoomConfig = await req.json()

    if (typeof config.hostId !== 'string' || config.hostId.length === 0) {
      return json({ error: 'Missing hostId' }, 400)
    }

    const format = draftFormatMap.get(config.formatId)
    if (!format) {
      return json({ error: `Unknown format: ${config.formatId}` }, 400)
    }
    if (config.seats.length === 0) {
      return json({ error: 'No seats provided' }, 400)
    }
    if (config.civPool.length === 0) {
      return json({ error: 'Empty civ pool' }, 400)
    }

    const baseState = createDraft(config.matchId, format, config.seats, config.civPool, {
      dealOptionsSize: config.dealOptionsSize,
      duplicateFactions: config.duplicateFactions,
    })
    const mapVoteEnabled = normalizeMapVoteEnabled(format.gameMode, config.mapVoteEnabled === true, { redDeath: format.redDeath })
    const state = withWaitingTimerConfig(format, baseState, config.timerConfig)
    const nextConfig: RoomConfig = {
      ...config,
      mapVoteEnabled,
    }
    const previews = createEmptyDraftPreviews()
    const mapVote = createInitialMapVoteState(state, nextConfig, format.redDeath)
    const room = createRoomRecord(nextConfig, state, mapVote, {
      previews,
    })

    await this.setRoomRecord(room)
    await this.assertRoomInvariants(room.state, room.config, {
      alarmStepIndex: room.alarmStepIndex,
      cancelledAt: room.cancelledAt,
      completedAt: room.completedAt,
      context: buildDraftRoomLogContext('handleCreate', room.state),
      mapVote: room.mapVote,
      previews: room.previews,
      swapDisconnectFinalizeAt: room.swapDisconnectFinalizeAt,
      swapSafetyEndsAt: room.swapSafetyEndsAt,
      swapState: room.swapState,
      swapWindowOpen: room.swapWindowOpen,
      timerEndsAt: room.timerEndsAt,
    })

    return json({ ok: true, matchId: config.matchId }, 201)
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
    const hasAccess = await verifyDraftRoomAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      roomId: room.state.matchId,
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

  private async getRoomRecord(): Promise<RoomRecord | null> {
    const stored = normalizeStoredRoomRecord(await this.ctx.storage.get<unknown>(ROOM_RECORD_KEY))
    if (stored) return stored
    return await this.migrateLegacyRoomRecord()
  }

  private async requireRoomRecord(): Promise<RoomRecord> {
    const room = await this.getRoomRecord()
    if (!room) {
      throw new Error('Room not initialized')
    }
    return room
  }

  private async setRoomRecord(room: RoomRecord): Promise<RoomRecord> {
    await this.ctx.storage.put(ROOM_RECORD_KEY, room)
    return room
  }

  private async updateRoomRecord(updater: (room: RoomRecord) => RoomRecord): Promise<RoomRecord> {
    return await this.setRoomRecord(updater(await this.requireRoomRecord()))
  }

  private getNormalizedSwapState(room: Pick<RoomRecord, 'swapState' | 'swapPendingExpiresAt'>): LeaderSwapState {
    return normalizeStoredSwapState(room.swapState, room.swapPendingExpiresAt)
  }

  private async migrateLegacyRoomRecord(): Promise<RoomRecord | null> {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) return null

    const config = await this.ctx.storage.get<RoomConfig>('config')
    if (!config) return null

    const room = createRoomRecord(config, state, await this.ctx.storage.get<StoredMapVoteState>('mapVote') ?? { ...EMPTY_STORED_MAP_VOTE_STATE }, {
      timerEndsAt: await this.ctx.storage.get<number | null>('timerEndsAt') ?? null,
      alarmStepIndex: await this.ctx.storage.get<number>('alarmStepIndex') ?? -1,
      completedAt: await this.ctx.storage.get<number | null>('completedAt') ?? null,
      cancelledAt: await this.ctx.storage.get<number | null>('cancelledAt') ?? null,
      previews: sanitizeDraftPreviews(
        state,
        await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
      ),
      swapWindowOpen: await this.ctx.storage.get<boolean>('swapWindowOpen') === true,
      swapState: await this.ctx.storage.get<LeaderSwapState | null>('swapState'),
      swapPendingExpiresAt: await this.ctx.storage.get<number | null>('swapPendingExpiresAt') ?? null,
      swapDisconnectFinalizeAt: await this.ctx.storage.get<number | null>('swapDisconnectFinalizeAt') ?? null,
      swapSafetyEndsAt: await this.ctx.storage.get<number | null>('swapSafetyEndsAt') ?? null,
    })

    await this.setRoomRecord(room)
    return room
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
    const hasAccess = await verifyDraftRoomAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      roomId: room.state.matchId,
      userId: playerId,
    })
    if (!hasAccess) {
      this.send(connection, { type: 'error', message: 'Draft access token is invalid or expired' })
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
      await this.clearSwapDisconnectFinalizeAt()
      await this.scheduleSwapAlarm()
    }

    if ((room.state.status === 'complete' && !room.swapWindowOpen) || room.state.status === 'cancelled') {
      connection.close(1000, 'Draft closed')
    }
  }

  // ── WebSocket: Messages ────────────────────────────────────

  override async onMessage(sender: Connection, message: WSMessage) {
    if (typeof message !== 'string') return

    let msg: ClientMessage
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
    await this.assertRoomInvariants(state, config, {
      context: buildDraftRoomLogContext('before-message', state, {
        messageType: msg.type,
        playerId,
      }),
    })

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
        await this.assertRoomInvariants(state, config, {
          context: buildDraftRoomLogContext('preview-update', state, {
            actor: playerId,
            action: msg.action,
          }),
          previews: nextPreviews,
        })
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
        const nextSwapState = createPendingSwap(state, swapState, seatIndex, msg.toSeat, Date.now() + SWAP_REQUEST_TIMEOUT_MS)
        if ('error' in nextSwapState) {
          this.send(sender, { type: 'error', message: nextSwapState.error })
          return
        }

        const nextRoom = await this.updateRoomRecord(current => ({
          ...current,
          swapState: nextSwapState,
        }))
        await this.scheduleSwapAlarm()
        await this.assertRoomInvariants(state, config, {
          completedAt: nextRoom.completedAt,
          context: buildDraftRoomLogContext('swap-request', state, {
            fromSeat: seatIndex,
            toSeat: msg.toSeat,
          }),
          swapDisconnectFinalizeAt: nextRoom.swapDisconnectFinalizeAt,
          swapSafetyEndsAt: nextRoom.swapSafetyEndsAt,
          swapState: nextSwapState,
          swapWindowOpen: true,
          timerEndsAt: nextRoom.timerEndsAt,
        })
        this.broadcastSwapUpdate(state, nextSwapState)
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

        const nextRoom = await this.updateRoomRecord(current => ({
          ...current,
          state: nextState,
          swapState: nextSwapState,
        }))
        await this.scheduleSwapAlarm()
        await this.assertRoomInvariants(nextState, config, {
          completedAt: nextRoom.completedAt,
          context: buildDraftRoomLogContext('swap-accept', nextState, {
            fromSeat: pendingSwap.fromSeat,
            toSeat: pendingSwap.toSeat,
          }),
          swapDisconnectFinalizeAt: nextRoom.swapDisconnectFinalizeAt,
          swapSafetyEndsAt: nextRoom.swapSafetyEndsAt,
          swapState: nextSwapState,
          swapWindowOpen: true,
          timerEndsAt: nextRoom.timerEndsAt,
        })
        this.broadcastSwapUpdate(nextState, nextSwapState, swappedPicks)
        if (nextRoom.completedAt != null) {
          await this.notifyDraftComplete(nextState, config, nextRoom.completedAt)
        }
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
        const nextRoom = await this.updateRoomRecord(current => ({
          ...current,
          swapState: nextSwapState,
        }))
        await this.scheduleSwapAlarm()
        await this.assertRoomInvariants(state, config, {
          completedAt: nextRoom.completedAt,
          context: buildDraftRoomLogContext('swap-cancel', state, {
            fromSeat: pendingSwap.fromSeat,
            toSeat: pendingSwap.toSeat,
          }),
          swapDisconnectFinalizeAt: nextRoom.swapDisconnectFinalizeAt,
          swapSafetyEndsAt: nextRoom.swapSafetyEndsAt,
          swapState: nextSwapState,
          swapWindowOpen: true,
          timerEndsAt: nextRoom.timerEndsAt,
        })
        this.broadcastSwapUpdate(state, nextSwapState)
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
        } satisfies RoomConfig
        const previews = sanitizeDraftPreviews(
          nextState,
          room.previews,
        )
        const nextRoom = await this.updateRoomRecord(current => ({
          ...current,
          state: nextState,
          config: nextConfig,
          previews,
        }))
        const mapVoteState = nextRoom.mapVote
        await this.assertRoomInvariants(nextState, nextConfig, {
          completedAt: nextRoom.completedAt,
          context: buildDraftRoomLogContext('config-update', nextState, {
            actor: playerId,
          }),
          mapVote: mapVoteState,
          previews,
          timerEndsAt: nextRoom.timerEndsAt,
        })
        this.broadcastUpdate(nextState, nextConfig.hostId, nextConfig.leaderDataVersion ?? 'live', [], nextRoom.timerEndsAt, nextRoom.completedAt, previews, null, mapVoteState)
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
      now: Date.now(),
      graceMs: SWAP_DISCONNECT_GRACE_MS,
    })
    if (nextDisconnectFinalizeAt == null || nextDisconnectFinalizeAt === disconnectFinalizeAt) return

    const nextRoom = await this.updateRoomRecord(current => ({
      ...current,
      swapDisconnectFinalizeAt: nextDisconnectFinalizeAt,
    }))
    await this.scheduleSwapAlarm()
    await this.assertRoomInvariants(room.state, nextRoom.config, {
      completedAt: nextRoom.completedAt,
      context: buildDraftRoomLogContext('connection-close', room.state, {
        disconnectedPlayerId: (connection.state as ConnectionState | null)?.playerId ?? null,
      }),
      swapDisconnectFinalizeAt: nextDisconnectFinalizeAt,
      swapSafetyEndsAt: nextRoom.swapSafetyEndsAt,
      swapState: this.getNormalizedSwapState(nextRoom),
      swapWindowOpen: true,
      timerEndsAt: nextRoom.timerEndsAt,
    })
  }

  override async onError(_connection: Connection, _error: unknown) {
    // Same as onClose — no special handling needed.
  }

  // ── Timer: Alarm ───────────────────────────────────────────

  override async onAlarm() {
    const room = await this.getRoomRecord()
    if (!room) return
    const state = room.state
    const config = room.config
    await this.assertRoomInvariants(state, config, {
      context: buildDraftRoomLogContext('before-alarm', state),
    })

    if (await this.handleMapVoteAlarm(state, config)) {
      return
    }

    if (state.status === 'complete' && room.swapWindowOpen) {
      const now = Date.now()
      const disconnectFinalizeAt = room.swapDisconnectFinalizeAt
      const safetyEndsAt = room.swapSafetyEndsAt
      const swapState = this.getNormalizedSwapState(room)
      const nextPendingSwaps = swapState.pendingSwaps.filter(swap => swap.expiresAt > now)
      if (nextPendingSwaps.length !== swapState.pendingSwaps.length) {
        const nextSwapState: LeaderSwapState = {
          pendingSwaps: nextPendingSwaps,
          completedSwaps: swapState.completedSwaps,
        }
        await this.updateRoomRecord(current => ({
          ...current,
          swapState: nextSwapState,
        }))
        this.broadcastSwapUpdate(state, nextSwapState)
      }

      const alarmAction = getSwapWindowAlarmAction({
        now,
        connectedParticipantCount: this.getConnectedParticipantCount(state),
        disconnectFinalizeAt,
        safetyEndsAt,
      })
      if (alarmAction === 'clear-disconnect-grace') {
        await this.clearSwapDisconnectFinalizeAt()
      }
      else if (alarmAction === 'finalize') {
        await this.finalizeCompletedDraft(state)
        return
      }

      await this.scheduleSwapAlarm()
      return
    }

    if (state.status !== 'active') return

    // Guard against stale alarms (step already advanced)
    if (room.alarmStepIndex !== state.currentStepIndex) return

    const format = draftFormatMap.get(config.formatId)
    if (!format) return

    const previews = sanitizeDraftPreviews(state, room.previews)
    const result = resolveTimeoutWithPreviews(state, format.blindBans, previews)
    if (isDraftError(result)) return

    await this.applyResult(result.state, result.events)
  }

  // ── Internal: Apply result & broadcast ─────────────────────

  private async applyResult(newState: DraftState, events: DraftEvent[]) {
    const room = await this.requireRoomRecord()
    const config = room.config
    const format = draftFormatMap.get(config.formatId)
    let webhookTask: Promise<void> | null = null
    let immediateSwapWindowSyncTask: Promise<void> | null = null

    // Set timer when a new step starts
    const stepAdvanced = events.some(
      e => e.type === 'STEP_ADVANCED' || e.type === 'DRAFT_STARTED',
    )

    let alarmMode: 'preserve' | 'set-step' | 'delete' | 'swap-window' = 'preserve'
    let alarmStepIndex = room.alarmStepIndex
    let timerEndsAt = room.timerEndsAt
    let completedAt = room.completedAt
    let cancelledAt = room.cancelledAt
    let swapState: LeaderSwapState | null = null

    const nextState = this.assignDealtCivIds(newState, config)
    if (nextState !== newState) {
      newState = nextState
    }
    const previews = sanitizeDraftPreviews(newState, room.previews)
    let nextRoom: RoomRecord = {
      ...room,
      state: newState,
      previews,
    }

    if (stepAdvanced && newState.status === 'active') {
      const step = getCurrentStep(newState)
      if (step && step.timer > 0) {
        timerEndsAt = Date.now() + step.timer * 1000
        alarmStepIndex = newState.currentStepIndex
        alarmMode = 'set-step'
      }
      else {
        timerEndsAt = null
        alarmStepIndex = -1
        alarmMode = 'delete'
      }
      nextRoom = {
        ...nextRoom,
        alarmStepIndex,
        timerEndsAt,
      }
      if (format) {
        this.scheduleDebugActiveBotActions(newState, format.blindBans)
      }
    }

    if (newState.status === 'complete') {
      timerEndsAt = null
      alarmStepIndex = -1
      if (completedAt == null) {
        completedAt = Date.now()
      }
      nextRoom = {
        ...nextRoom,
        alarmStepIndex,
        timerEndsAt: null,
        completedAt,
      }

      if (this.shouldOpenSwapWindow(newState)) {
        swapState = createEmptySwapState()
        nextRoom = {
          ...nextRoom,
          swapWindowOpen: true,
          swapState,
          swapPendingExpiresAt: null,
          swapDisconnectFinalizeAt: null,
          swapSafetyEndsAt: completedAt + SWAP_WINDOW_TIMEOUT_MS,
        }
        alarmMode = 'swap-window'
        immediateSwapWindowSyncTask = this.notifyDraftComplete(newState, config, completedAt)
      }
      else {
        nextRoom = {
          ...nextRoom,
          swapWindowOpen: false,
          swapState: null,
          swapPendingExpiresAt: null,
          swapDisconnectFinalizeAt: null,
          swapSafetyEndsAt: null,
        }
        alarmMode = 'delete'
        webhookTask = this.notifyDraftComplete(newState, config, completedAt)
      }
    }

    if (newState.status === 'cancelled') {
      timerEndsAt = null
      alarmStepIndex = -1
      if (cancelledAt == null) {
        cancelledAt = Date.now()
      }
      nextRoom = {
        ...nextRoom,
        alarmStepIndex,
        timerEndsAt: null,
        cancelledAt,
        swapWindowOpen: false,
        swapState: null,
        swapPendingExpiresAt: null,
        swapDisconnectFinalizeAt: null,
        swapSafetyEndsAt: null,
      }
      alarmMode = 'delete'
      webhookTask = this.notifyDraftCancelled(newState, config, cancelledAt)
    }

    if (newState.status !== 'complete') {
      nextRoom = {
        ...nextRoom,
        swapWindowOpen: false,
        swapState: null,
        swapPendingExpiresAt: null,
        swapDisconnectFinalizeAt: null,
        swapSafetyEndsAt: null,
      }
    }

    await this.setRoomRecord(nextRoom)

    if (alarmMode === 'set-step' && timerEndsAt != null) {
      await this.ctx.storage.setAlarm(timerEndsAt)
    }
    else if (alarmMode === 'delete') {
      await this.ctx.storage.deleteAlarm()
    }
    else if (alarmMode === 'swap-window') {
      await this.scheduleSwapAlarm()
    }

    if (newState.status === 'complete' && swapState == null && nextRoom.swapWindowOpen) {
      swapState = this.getNormalizedSwapState(nextRoom)
    }

    const hostId = config.hostId ?? newState.seats[0]?.playerId ?? ''
    const mapVoteState = nextRoom.mapVote
    const swapWindowOpen = newState.status === 'complete' && nextRoom.swapWindowOpen
    const swapDisconnectFinalizeAt = swapWindowOpen
      ? nextRoom.swapDisconnectFinalizeAt
      : null
    const swapSafetyEndsAt = swapWindowOpen
      ? nextRoom.swapSafetyEndsAt
      : null
    const transitionContext = buildDraftRoomLogContext('apply-result', newState, {
      eventTypes: events.map(event => event.type),
    })
    console.log('[draft-room] transition', transitionContext)
    await this.assertRoomInvariants(newState, config ?? null, {
      alarmStepIndex,
      cancelledAt: cancelledAt ?? null,
      completedAt: completedAt ?? null,
      context: transitionContext,
      mapVote: mapVoteState,
      previews,
      swapDisconnectFinalizeAt,
      swapSafetyEndsAt,
      swapState,
      swapWindowOpen,
      timerEndsAt: timerEndsAt ?? null,
    })
    this.broadcastUpdate(newState, hostId, config.leaderDataVersion ?? 'live', events, timerEndsAt ?? null, completedAt ?? null, previews, swapState, mapVoteState)

    if (immediateSwapWindowSyncTask) {
      await immediateSwapWindowSyncTask
    }

    if ((newState.status === 'complete' && !swapState) || newState.status === 'cancelled') {
      this.closeAllConnections('Draft closed')
    }

    if (webhookTask) {
      this.ctx.waitUntil(webhookTask.catch((error) => {
        console.error('[draft-room] deferred webhook delivery failed', buildDraftRoomLogContext('apply-result', newState), error)
      }))
    }
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

  private scheduleDebugMapVoteBotActions(state: DraftState, config: RoomConfig) {
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

      const civIds = pickRandomDistinct(availablePool, remainingCount)
      result = processDraftInput(
        state,
        { type: 'BAN', seatIndex, civIds },
        blindBans,
      )
    }
    else {
      const [civId] = pickRandomDistinct(availablePool, 1)
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

  private async runDebugMapVoteBotAction(seatIndex: number, config: RoomConfig) {
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
        : pickRandomDistinct([...MAP_TYPE_IDS], 1 + Math.floor(Math.random() * MAP_TYPE_IDS.length)),
      mapScripts: normalizedSelection.mapScripts.length > 0
        ? normalizedSelection.mapScripts
        : pickRandomDistinct([...MAP_SCRIPT_IDS], 1 + Math.floor(Math.random() * 3)),
    }

    const updated = await this.updateMapVoteSelection(state, config, seatIndex, nextSelection)
    if (typeof updated !== 'string') {
      await this.broadcastRoomState(state, config, [])
    }

    await this.confirmMapVote(state, config, seatIndex)
  }

  private shouldOpenSwapWindow(state: DraftState): boolean {
    return canOpenSwapWindowForState(state)
  }

  private async isSwapWindowOpen(): Promise<boolean> {
    return (await this.getRoomRecord())?.swapWindowOpen === true
  }

  private async getSwapState(): Promise<LeaderSwapState> {
    const room = await this.getRoomRecord()
    if (!room) return createEmptySwapState()
    return this.getNormalizedSwapState(room)
  }

  private async clearSwapWindowState() {
    await this.updateRoomRecord(room => ({
      ...room,
      swapWindowOpen: false,
      swapState: null,
      swapPendingExpiresAt: null,
      swapDisconnectFinalizeAt: null,
      swapSafetyEndsAt: null,
    }))
  }

  private async clearSwapDisconnectFinalizeAt() {
    await this.updateRoomRecord(room => ({
      ...room,
      swapDisconnectFinalizeAt: null,
    }))
  }

  private async scheduleSwapAlarm() {
    const room = await this.getRoomRecord()
    if (!room?.swapWindowOpen) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    const nextAlarm = getNextSwapLifecycleAlarmAt({
      swapState: this.getNormalizedSwapState(room),
      disconnectFinalizeAt: room.swapDisconnectFinalizeAt,
      safetyEndsAt: room.swapSafetyEndsAt,
    })

    if (nextAlarm == null) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    await this.ctx.storage.setAlarm(nextAlarm)
  }

  private async finalizeCompletedDraft(state: DraftState) {
    const room = await this.getRoomRecord()
    if (!room?.swapWindowOpen) return
    await this.ctx.storage.deleteAlarm()

    const completedAt = room.completedAt ?? Date.now()
    const nextRoom = {
      ...room,
      alarmStepIndex: -1,
      timerEndsAt: null,
      completedAt,
      swapWindowOpen: false,
      swapState: null,
      swapPendingExpiresAt: null,
      swapDisconnectFinalizeAt: null,
      swapSafetyEndsAt: null,
    } satisfies RoomRecord
    await this.setRoomRecord(nextRoom)
    await this.assertRoomInvariants(state, nextRoom.config, {
      alarmStepIndex: -1,
      completedAt,
      context: buildDraftRoomLogContext('finalize-complete', state, {
        finalized: true,
      }),
      swapDisconnectFinalizeAt: null,
      swapSafetyEndsAt: null,
      swapState: null,
      swapWindowOpen: false,
      timerEndsAt: null,
    })
    this.closeAllConnections('Draft closed')
    this.ctx.waitUntil(this.notifyDraftComplete(state, nextRoom.config, completedAt, { finalized: true }).catch((error) => {
      console.error('[draft-room] finalized webhook delivery failed', buildDraftRoomLogContext('finalize-complete', state, {
        finalized: true,
      }), error)
    }))
  }

  private async handleStart(state: DraftState, config: RoomConfig, format: NonNullable<ReturnType<typeof draftFormatMap.get>>): Promise<string | null> {
    if (state.status !== 'waiting') {
      const result = processDraftInput(state, { type: 'START' }, format.blindBans)
      if (isDraftError(result)) return result.error
      await this.applyResult(result.state, result.events)
      return null
    }

    const mapVoteState = await this.getStoredMapVoteState()
    if (mapVoteState.enabled && mapVoteState.phase === 'idle') {
      const nextMapVote: StoredMapVoteState = {
        ...mapVoteState,
        phase: 'voting',
        endsAt: Date.now() + MAP_VOTE_VOTING_DURATION_MS,
      }
      await this.updateRoomRecord(room => ({
        ...room,
        mapVote: nextMapVote,
        timerEndsAt: null,
        alarmStepIndex: -1,
      }))
      await this.ctx.storage.setAlarm(nextMapVote.endsAt!)
      await this.broadcastRoomState(state, config, [])
      this.scheduleDebugMapVoteBotActions(state, config)
      return null
    }

    if (mapVoteState.enabled && mapVoteState.phase !== 'done') {
      return 'Map voting is already in progress'
    }

    return await this.startActualDraft(state, config, format)
  }

  private async handleMapVoteAlarm(state: DraftState, config: RoomConfig): Promise<boolean> {
    const mapVoteState = await this.getStoredMapVoteState()
    if (!mapVoteState.enabled || mapVoteState.endsAt == null) return false

    if (mapVoteState.phase === 'voting') {
      await this.finishMapVoteVoting(state, config, mapVoteState)
      return true
    }

    if (mapVoteState.phase === 'reveal') {
      await this.finishMapVoteReveal(state, config, mapVoteState)
      return true
    }

    return false
  }

  private async updateMapVoteSelection(
    state: DraftState,
    config: RoomConfig,
    seatIndex: number,
    selection: MapVoteSelection,
  ): Promise<MapVoteSelectionUpdateResult> {
    const mapVoteState = await this.getStoredMapVoteState()
    const nextMapVote = applyMapVoteSelectionUpdate(mapVoteState, seatIndex, selection)
    if (typeof nextMapVote === 'string') return nextMapVote

    await this.updateRoomRecord(room => ({
      ...room,
      mapVote: nextMapVote,
    }))
    return nextMapVote
  }

  private async confirmMapVote(
    state: DraftState,
    config: RoomConfig,
    seatIndex: number,
  ): Promise<'inactive' | 'invalid-selection' | 'ok'> {
    const mapVoteState = await this.getStoredMapVoteState()
    if (!mapVoteState.enabled || mapVoteState.phase !== 'voting') return 'inactive'

    const selection = mapVoteState.selections[seatIndex]
    if (!isMapVoteSelectionConfirmable(selection)) return 'invalid-selection'

    const nextMapVote: StoredMapVoteState = {
      ...mapVoteState,
      confirmations: {
        ...mapVoteState.confirmations,
        [seatIndex]: true,
      },
    }
    await this.updateRoomRecord(room => ({
      ...room,
      mapVote: nextMapVote,
    }))

    if (state.seats.every((_, index) => nextMapVote.confirmations[index] === true)) {
      await this.finishMapVoteVoting(state, config, nextMapVote)
      return 'ok'
    }

    await this.broadcastRoomState(state, config, [])
    return 'ok'
  }

  private async finishMapVoteVoting(state: DraftState, config: RoomConfig, currentMapVote?: StoredMapVoteState) {
    const mapVoteState = currentMapVote ?? await this.getStoredMapVoteState()
    if (!mapVoteState.enabled || mapVoteState.phase !== 'voting') return

    const revealedVotes = state.seats.map((_, seatIndex) => {
      const selection = mapVoteState.selections[seatIndex] ?? DEFAULT_MAP_VOTE_SELECTION
      const confirmed = mapVoteState.confirmations[seatIndex] === true
      const normalizedSelection = normalizeMapVoteSelection(selection)
      return {
        seatIndex,
        confirmed,
        mapTypes: [...normalizedSelection.mapTypes],
        mapScripts: [...normalizedSelection.mapScripts],
      } satisfies RevealedMapVoteSeatBallot
    })
    const seed = buildMapVoteSeed(state.matchId, revealedVotes)
    const rng = createMapVoteRng(seed)
    const result = resolveMapVoteWinner(revealedVotes, rng, seed)
    const nextMapVote: StoredMapVoteState = {
      ...mapVoteState,
      phase: 'reveal',
      endsAt: Date.now() + MAP_VOTE_REVEAL_DURATION_MS,
      revealedVotes,
      result,
    }
    await this.updateRoomRecord(room => ({
      ...room,
      mapVote: nextMapVote,
    }))
    await this.ctx.storage.setAlarm(nextMapVote.endsAt!)
    await this.broadcastRoomState(state, config, [])
  }

  private async finishMapVoteReveal(state: DraftState, config: RoomConfig, currentMapVote?: StoredMapVoteState) {
    const mapVoteState = currentMapVote ?? await this.getStoredMapVoteState()
    if (!mapVoteState.enabled || mapVoteState.phase !== 'reveal') return

    const nextMapVote: StoredMapVoteState = {
      ...mapVoteState,
      phase: 'done',
      endsAt: null,
    }
    await this.updateRoomRecord(room => ({
      ...room,
      mapVote: nextMapVote,
    }))

    const format = draftFormatMap.get(config.formatId)
    if (!format) return
    await this.startActualDraft(state, config, format)
  }

  private async startActualDraft(state: DraftState, config: RoomConfig, format: NonNullable<ReturnType<typeof draftFormatMap.get>>): Promise<string | null> {
    if (config.randomDraft) {
      const result = buildRandomDraftResult(state)
      await this.applyResult(result.state, result.events)
      return null
    }

    const result = processDraftInput(state, { type: 'START' }, format.blindBans)
    if (isDraftError(result)) return result.error
    await this.applyResult(result.state, result.events)
    return null
  }

  private async broadcastRoomState(state: DraftState, config: RoomConfig, events: DraftEvent[]) {
    const room = await this.requireRoomRecord()
    const previews = sanitizeDraftPreviews(state, room.previews)
    const swapWindowOpen = room.swapWindowOpen
    const swapState = swapWindowOpen ? this.getNormalizedSwapState(room) : null
    const mapVoteState = room.mapVote
    await this.assertRoomInvariants(state, config, {
      completedAt: room.completedAt,
      context: buildDraftRoomLogContext('broadcast-room-state', state, {
        eventTypes: events.map(event => event.type),
      }),
      mapVote: mapVoteState,
      previews,
      swapDisconnectFinalizeAt: swapWindowOpen
        ? room.swapDisconnectFinalizeAt
        : null,
      swapSafetyEndsAt: swapWindowOpen
        ? room.swapSafetyEndsAt
        : null,
      swapState,
      swapWindowOpen,
      timerEndsAt: room.timerEndsAt,
    })
    this.broadcastUpdate(state, config.hostId, config.leaderDataVersion ?? 'live', events, room.timerEndsAt, room.completedAt, previews, swapState, mapVoteState)
  }

  private async assertRoomInvariants(
    state: DraftState,
    config: RoomConfig | null,
    options: {
      alarmStepIndex?: number
      cancelledAt?: number | null
      completedAt?: number | null
      context?: Record<string, unknown>
      mapVote?: StoredMapVoteState
      previews?: DraftPreviewState
      swapDisconnectFinalizeAt?: number | null
      swapSafetyEndsAt?: number | null
      swapState?: LeaderSwapState | null
      swapWindowOpen?: boolean
      timerEndsAt?: number | null
    } = {},
  ) {
    const room = await this.getRoomRecord()
    const swapWindowOpen = options.swapWindowOpen ?? room?.swapWindowOpen ?? false
    assertDraftRoomInvariants({
      alarmStepIndex: options.alarmStepIndex ?? room?.alarmStepIndex ?? -1,
      cancelledAt: options.cancelledAt ?? room?.cancelledAt ?? null,
      completedAt: options.completedAt ?? room?.completedAt ?? null,
      config,
      mapVote: options.mapVote ?? room?.mapVote ?? { ...EMPTY_STORED_MAP_VOTE_STATE },
      matchId: state.matchId,
      previews: options.previews ?? sanitizeDraftPreviews(
        state,
        room?.previews ?? createEmptyDraftPreviews(),
      ),
      state,
      swapDisconnectFinalizeAt: options.swapDisconnectFinalizeAt ?? (swapWindowOpen
        ? room?.swapDisconnectFinalizeAt ?? null
        : null),
      swapSafetyEndsAt: options.swapSafetyEndsAt ?? (swapWindowOpen
        ? room?.swapSafetyEndsAt ?? null
        : null),
      swapState: options.swapState !== undefined
        ? options.swapState
        : (swapWindowOpen && room ? this.getNormalizedSwapState(room) : null),
      swapWindowOpen,
      timerEndsAt: options.timerEndsAt ?? room?.timerEndsAt ?? null,
    }, {
      context: options.context,
    })
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
    leaderDataVersion: RoomConfig['leaderDataVersion'],
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

  private send(connection: Connection, message: ServerMessage) {
    connection.send(JSON.stringify(message))
  }

  private assignDealtCivIds(state: DraftState, config: RoomConfig | null): DraftState {
    if (!config || !isRedDeathDraftConfig(config)) {
      if (state.dealtCivIds == null) return state
      return { ...state, dealtCivIds: null }
    }

    if (state.status !== 'active') {
      if (state.dealtCivIds == null) return state
      return { ...state, dealtCivIds: null }
    }

    const step = getCurrentStep(state)
    if (!step || step.action !== 'pick') {
      if (state.dealtCivIds == null) return state
      return { ...state, dealtCivIds: null }
    }

    if (state.dealtCivIds?.length) return state

    const dealSize = normalizeDealOptionsSize(config.dealOptionsSize)
    const dealtCivIds = pickRandomDistinct(state.availableCivIds, Math.min(dealSize, state.availableCivIds.length))
    return { ...state, dealtCivIds }
  }

  private closeAllConnections(reason: string) {
    for (const conn of this.getConnections()) {
      conn.close(1000, reason)
    }
  }

  private async notifyDraftComplete(
    state: DraftState,
    config: RoomConfig,
    completedAt: number,
    options: {
      finalized?: boolean
    } = {},
  ) {
    const hostId = config.hostId || state.seats[0]?.playerId || undefined
    const payload: DraftWebhookPayload = {
      outcome: 'complete',
      matchId: state.matchId,
      hostId,
      completedAt,
      finalized: options.finalized === true ? true : undefined,
      state,
      mapVoteResult: (await this.getStoredMapVoteState()).result,
    }
    await this.sendDraftWebhook(state.matchId, config, payload)
  }

  private async notifyDraftCancelled(state: DraftState, config: RoomConfig, cancelledAt: number) {
    const hostId = config.hostId || state.seats[0]?.playerId || undefined
    const payload: DraftWebhookPayload = {
      outcome: 'cancelled',
      matchId: state.matchId,
      hostId,
      cancelledAt,
      reason: state.cancelReason ?? 'scrub',
      state,
      mapVoteResult: (await this.getStoredMapVoteState()).result,
    }
    await this.sendDraftWebhook(state.matchId, config, payload)
  }

  private async sendDraftWebhook(
    matchId: string,
    config: RoomConfig,
    payload: DraftWebhookPayload,
  ) {
    const webhookContext = buildDraftWebhookLogContext(payload, {
      webhookUrl: config.webhookUrl ?? null,
    })
    if (!config.webhookUrl) {
      console.warn('[draft-room] missing webhook URL', webhookContext)
      return
    }

    console.log('[draft-room] sending webhook', webhookContext)
    const body = JSON.stringify(payload)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.webhookSecret ? await createSignedWebhookHeaders(config.webhookSecret, body) : {}),
    }

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        await api.post(config.webhookUrl, body, { headers })
        console.log('[draft-room] webhook delivered', {
          ...webhookContext,
          attempt,
        })
        return
      }
      catch (err) {
        const status = err instanceof ApiError ? err.status : 'Unknown'
        if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
          console.error('[draft-room] webhook failed', {
            ...webhookContext,
            attempt,
            status,
          }, err)
          return
        }

        const retryDelay = Math.min(WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1), WEBHOOK_RETRY_MAX_MS)
        console.error('[draft-room] webhook retry scheduled', {
          ...webhookContext,
          attempt,
          retryDelay,
          status,
        }, err)
        await wait(retryDelay)
      }
    }
  }
}

// ── Utility ──────────────────────────────────────────────────

function createRoomRecord(
  config: RoomConfig,
  state: DraftState,
  mapVote: StoredMapVoteState,
  overrides: Partial<Omit<RoomRecord, 'version' | 'config' | 'state' | 'mapVote'>> = {},
): RoomRecord {
  return {
    version: ROOM_RECORD_VERSION,
    config,
    state,
    timerEndsAt: overrides.timerEndsAt ?? null,
    alarmStepIndex: overrides.alarmStepIndex ?? -1,
    completedAt: overrides.completedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    previews: overrides.previews ?? createEmptyDraftPreviews(),
    swapWindowOpen: overrides.swapWindowOpen ?? false,
    swapState: overrides.swapState ?? null,
    swapPendingExpiresAt: overrides.swapPendingExpiresAt ?? null,
    swapDisconnectFinalizeAt: overrides.swapDisconnectFinalizeAt ?? null,
    swapSafetyEndsAt: overrides.swapSafetyEndsAt ?? null,
    mapVote,
  }
}

function normalizeStoredRoomRecord(value: unknown): RoomRecord | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<RoomRecord>
  if (!raw.config || !raw.state) return null

  return createRoomRecord(
    raw.config,
    raw.state,
    raw.mapVote && typeof raw.mapVote === 'object'
      ? raw.mapVote
      : { ...EMPTY_STORED_MAP_VOTE_STATE },
    {
      timerEndsAt: typeof raw.timerEndsAt === 'number' && Number.isFinite(raw.timerEndsAt) ? raw.timerEndsAt : null,
      alarmStepIndex: typeof raw.alarmStepIndex === 'number' && Number.isFinite(raw.alarmStepIndex) ? raw.alarmStepIndex : -1,
      completedAt: typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : null,
      cancelledAt: typeof raw.cancelledAt === 'number' && Number.isFinite(raw.cancelledAt) ? raw.cancelledAt : null,
      previews: sanitizeDraftPreviews(
        raw.state,
        raw.previews ?? createEmptyDraftPreviews(),
      ),
      swapWindowOpen: raw.swapWindowOpen === true,
      swapState: raw.swapState ?? null,
      swapPendingExpiresAt: typeof raw.swapPendingExpiresAt === 'number' && Number.isFinite(raw.swapPendingExpiresAt) ? raw.swapPendingExpiresAt : null,
      swapDisconnectFinalizeAt: typeof raw.swapDisconnectFinalizeAt === 'number' && Number.isFinite(raw.swapDisconnectFinalizeAt) ? raw.swapDisconnectFinalizeAt : null,
      swapSafetyEndsAt: typeof raw.swapSafetyEndsAt === 'number' && Number.isFinite(raw.swapSafetyEndsAt) ? raw.swapSafetyEndsAt : null,
    },
  )
}

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

function buildDraftWebhookLogContext(
  payload: DraftWebhookPayload,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildDraftRoomLogContext('webhook', payload.state, {
    outcome: payload.outcome,
    finalized: payload.outcome === 'complete' ? payload.finalized === true : false,
    ...extra,
  })
}

function isSeatInStep(step: DraftState['steps'][number], seatIndex: number, totalSeats: number): boolean {
  if (step.seats === 'all') return seatIndex >= 0 && seatIndex < totalSeats
  return step.seats.includes(seatIndex)
}

function normalizeDealOptionsSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2
  return Math.max(1, Math.round(value))
}

function isRedDeathDraftConfig(config: Pick<RoomConfig, 'formatId'>): boolean {
  return isRedDeathFormatId(config.formatId)
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
  timerConfig: RoomConfig['timerConfig'] | undefined,
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
  timerConfig: RoomConfig['timerConfig'] | undefined,
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

function createEmptySwapState(): LeaderSwapState {
  return {
    pendingSwaps: [],
    completedSwaps: [],
  }
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

function normalizeStoredSwapState(
  value: unknown,
  legacyPendingExpiresAt: number | null,
): LeaderSwapState {
  if (!value || typeof value !== 'object') return createEmptySwapState()

  const raw = value as {
    pendingSwaps?: unknown
    completedSwaps?: unknown
    pendingSwap?: unknown
  }

  if (Array.isArray(raw.pendingSwaps)) {
    return {
      pendingSwaps: raw.pendingSwaps.flatMap(normalizePendingSwapRequest),
      completedSwaps: Array.isArray(raw.completedSwaps)
        ? raw.completedSwaps.flatMap(normalizeCompletedSwapRequest)
        : [],
    }
  }

  const legacyPendingSwap = normalizeCompletedSwapRequest(raw.pendingSwap)[0] ?? null
  return {
    pendingSwaps: legacyPendingSwap
      ? [{ ...legacyPendingSwap, expiresAt: legacyPendingExpiresAt ?? Date.now() + SWAP_REQUEST_TIMEOUT_MS }]
      : [],
    completedSwaps: Array.isArray(raw.completedSwaps)
      ? raw.completedSwaps.flatMap(normalizeCompletedSwapRequest)
      : [],
  }
}

function normalizePendingSwapRequest(value: unknown): PendingLeaderSwapRequest[] {
  if (!value || typeof value !== 'object') return []
  const request = value as Partial<PendingLeaderSwapRequest>
  if (!Number.isInteger(request.fromSeat) || !Number.isInteger(request.toSeat) || !Number.isFinite(request.expiresAt)) return []
  const fromSeat = Number(request.fromSeat)
  const toSeat = Number(request.toSeat)
  const expiresAt = Number(request.expiresAt)
  return [{
    fromSeat,
    toSeat,
    expiresAt,
  }]
}

function normalizeCompletedSwapRequest(value: unknown): LeaderSwapRequest[] {
  if (!value || typeof value !== 'object') return []
  const request = value as Partial<LeaderSwapRequest>
  if (!Number.isInteger(request.fromSeat) || !Number.isInteger(request.toSeat)) return []
  const fromSeat = Number(request.fromSeat)
  const toSeat = Number(request.toSeat)
  return [{
    fromSeat,
    toSeat,
  }]
}

function isAuthorizedRequest(request: Request, expectedSecret: string | undefined): boolean {
  return isAuthorizedInternalRequest(request.headers, expectedSecret)
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}
