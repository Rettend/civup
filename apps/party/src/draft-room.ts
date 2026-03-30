import type {
  ClientMessage,
  DraftEvent,
  DraftPreviewState,
  DraftState,
  DraftWebhookPayload,
  LeaderSwapRequest,
  LeaderSwapState,
  PendingLeaderSwapRequest,
  RoomConfig,
  ServerMessage,
} from '@civup/game'
import type { Connection, ConnectionContext, WSMessage } from 'partyserver'
import { createDraft, draftFormatMap, getCurrentStep, isDraftError, isRedDeathFormatId, MAX_TIMER_SECONDS, processDraftInput, swapSeatPicks } from '@civup/game'
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
import {
  countConnectedDraftParticipants,
  getNextSwapLifecycleAlarmAt,
  getSwapDisconnectFinalizeAtAfterDisconnect,
  getSwapWindowAlarmAction,
} from './swap-window.ts'

interface PartyEnv extends Cloudflare.Env {
  CIVUP_SECRET?: string
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
const SWAP_REQUEST_TIMEOUT_MS = 30_000
const SWAP_DISCONNECT_GRACE_MS = 5_000
const SWAP_WINDOW_TIMEOUT_MS = 5 * 60_000

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

    const existing = await this.ctx.storage.get<DraftState>('state')
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
    })
    const state = withWaitingTimerConfig(format, baseState, config.timerConfig)

    await this.ctx.storage.put('config', config)
    await this.ctx.storage.put('state', state)
    await this.ctx.storage.put('timerEndsAt', null)
    await this.ctx.storage.put('alarmStepIndex', -1)
    await this.ctx.storage.put('completedAt', null)
    await this.ctx.storage.put('cancelledAt', null)
    await this.ctx.storage.put('previews', createEmptyDraftPreviews())
    await this.ctx.storage.put('swapWindowOpen', false)
    await this.ctx.storage.put('swapState', null)
    await this.ctx.storage.put('swapPendingExpiresAt', null)
    await this.ctx.storage.put('swapDisconnectFinalizeAt', null)
    await this.ctx.storage.put('swapSafetyEndsAt', null)

    return json({ ok: true, matchId: config.matchId }, 201)
  }

  private async handleStatus(req: Request): Promise<Response> {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) {
      return json({ error: 'Room not initialized' }, 404)
    }

    const activityUserId = readActivityUserId(req.headers)
    if (!isAuthorizedRequest(req, this.env.CIVUP_SECRET) || !activityUserId) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const requestUrl = new URL(req.url)
    const hasAccess = await verifyDraftRoomAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      roomId: state.matchId,
      userId: activityUserId,
    })
    if (!hasAccess) {
      return json({ error: 'Forbidden' }, 403)
    }

    const timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    const completedAt = await this.ctx.storage.get<number | null>('completedAt')
    const cancelledAt = await this.ctx.storage.get<number | null>('cancelledAt')
    const swapWindowOpen = await this.ctx.storage.get<boolean>('swapWindowOpen') === true
    const seatIndex = state.seats.findIndex(seat => seat.playerId === activityUserId)
    const previews = sanitizeDraftPreviews(
      state,
      await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
    )
    return json({
      state: this.censorState(state, seatIndex),
      timerEndsAt,
      completedAt,
      cancelledAt,
      previews: censorDraftPreviews(state, previews, seatIndex),
      swapState: swapWindowOpen ? await this.getSwapState() : null,
    })
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

    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) {
      this.send(connection, { type: 'error', message: 'Room not initialized' })
      connection.close(4000, 'Room not initialized')
      return
    }

    const requestUrl = new URL(ctx.request.url)
    const hasAccess = await verifyDraftRoomAccessToken(this.env.CIVUP_SECRET, requestUrl.searchParams.get('accessToken'), {
      roomId: state.matchId,
      userId: playerId,
    })
    if (!hasAccess) {
      this.send(connection, { type: 'error', message: 'Draft access token is invalid or expired' })
      connection.close(4403, 'Forbidden')
      return
    }

    const config = await this.ctx.storage.get<RoomConfig>('config')
    const hostId = config?.hostId ?? state.seats[0]?.playerId ?? ''

    const timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    const completedAt = await this.ctx.storage.get<number | null>('completedAt')
    const swapWindowOpen = await this.ctx.storage.get<boolean>('swapWindowOpen') === true
    const swapDisconnectFinalizeAt = swapWindowOpen
      ? await this.ctx.storage.get<number | null>('swapDisconnectFinalizeAt')
      : null
    const swapState = swapWindowOpen
      ? await this.getSwapState()
      : null
    const previews = sanitizeDraftPreviews(
      state,
      await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
    )
    const seatIndex = playerId
      ? state.seats.findIndex(s => s.playerId === playerId)
      : -1

    this.send(connection, {
      type: 'init',
      state: this.censorState(state, seatIndex),
      leaderDataVersion: config?.leaderDataVersion ?? 'live',
      hostId,
      seatIndex: seatIndex >= 0 ? seatIndex : null,
      timerEndsAt: timerEndsAt ?? null,
      completedAt: completedAt ?? null,
      previews: censorDraftPreviews(state, previews, seatIndex),
      swapState,
    })

    if (swapWindowOpen && seatIndex >= 0 && swapDisconnectFinalizeAt != null) {
      await this.clearSwapDisconnectFinalizeAt()
      await this.scheduleSwapAlarm()
    }

    if ((state.status === 'complete' && !swapWindowOpen) || state.status === 'cancelled') {
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

    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) {
      this.send(sender, { type: 'error', message: 'Room not initialized' })
      return
    }

    const config = await this.ctx.storage.get<RoomConfig>('config')
    if (!config) {
      this.send(sender, { type: 'error', message: 'Room config missing' })
      return
    }

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
        if (config.randomDraft && isRedDeathDraftConfig(config)) {
          const result = buildRandomDraftResult(state)
          await this.applyResult(result.state, result.events)
          return
        }
        const result = processDraftInput(state, { type: 'START' }, format.blindBans)
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
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
          await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
        )
        const result = resolvePickSubmissionWithPreviews(
          state,
          format.blindBans,
          previews.picks,
          seatIndex,
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
          await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
        )
        const nextPreviews = applyDraftPreview(state, previews, seatIndex, msg.action, msg.civIds)
        if ('error' in nextPreviews) {
          this.send(sender, { type: 'error', message: nextPreviews.error })
          return
        }
        if (draftPreviewsEqual(previews, nextPreviews)) return

        await this.ctx.storage.put('previews', nextPreviews)
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

        if (msg.reason === 'revert' && state.status !== 'active') {
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

        await this.ctx.storage.put('swapState', nextSwapState)
        await this.scheduleSwapAlarm()
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
        const nextSwapState: LeaderSwapState = {
          pendingSwaps: swapState.pendingSwaps.filter(swap => !isSamePendingSwap(swap, pendingSwap)),
          completedSwaps: [...swapState.completedSwaps, pendingSwap],
        }

        await this.ctx.storage.put('state', nextState)
        await this.ctx.storage.put('swapState', nextSwapState)
        await this.scheduleSwapAlarm()
        this.broadcastSwapUpdate(nextState, nextSwapState, swappedPicks)
        const completedAt = await this.ctx.storage.get<number | null>('completedAt')
        if (config && completedAt != null) {
          await this.notifyDraftComplete(nextState, config, completedAt)
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
        await this.ctx.storage.put('swapState', nextSwapState)
        await this.scheduleSwapAlarm()
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
        await this.ctx.storage.put('state', nextState)
        await this.ctx.storage.put('config', {
          ...config,
          timerConfig,
        } satisfies RoomConfig)

        const timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
        const completedAt = await this.ctx.storage.get<number | null>('completedAt')
        const previews = sanitizeDraftPreviews(
          nextState,
          await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
        )
        await this.ctx.storage.put('previews', previews)
        this.broadcastUpdate(nextState, config.hostId, config.leaderDataVersion ?? 'live', [], timerEndsAt ?? null, completedAt ?? null, previews, null)
        break
      }

      default:
        this.send(sender, { type: 'error', message: 'Unknown message type' })
    }
  }

  // ── WebSocket: Disconnect ──────────────────────────────────

  override async onClose(connection: Connection) {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state || state.status !== 'complete') return
    if (!(await this.isSwapWindowOpen())) return

    const disconnectFinalizeAt = await this.ctx.storage.get<number | null>('swapDisconnectFinalizeAt') ?? null
    const nextDisconnectFinalizeAt = getSwapDisconnectFinalizeAtAfterDisconnect({
      connectedParticipantCount: this.getConnectedParticipantCount(state, connection),
      existingDisconnectFinalizeAt: disconnectFinalizeAt,
      now: Date.now(),
      graceMs: SWAP_DISCONNECT_GRACE_MS,
    })
    if (nextDisconnectFinalizeAt == null || nextDisconnectFinalizeAt === disconnectFinalizeAt) return

    await this.ctx.storage.put('swapDisconnectFinalizeAt', nextDisconnectFinalizeAt)
    await this.scheduleSwapAlarm()
  }

  override async onError(_connection: Connection, _error: unknown) {
    // Same as onClose — no special handling needed.
  }

  // ── Timer: Alarm ───────────────────────────────────────────

  override async onAlarm() {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) return

    if (state.status === 'complete' && await this.isSwapWindowOpen()) {
      const now = Date.now()
      const disconnectFinalizeAt = await this.ctx.storage.get<number | null>('swapDisconnectFinalizeAt') ?? null
      const safetyEndsAt = await this.ctx.storage.get<number | null>('swapSafetyEndsAt') ?? null

      const swapState = await this.getSwapState()
      const nextPendingSwaps = swapState.pendingSwaps.filter(swap => swap.expiresAt > now)
      if (nextPendingSwaps.length !== swapState.pendingSwaps.length) {
        const nextSwapState: LeaderSwapState = {
          pendingSwaps: nextPendingSwaps,
          completedSwaps: swapState.completedSwaps,
        }
        await this.ctx.storage.put('swapState', nextSwapState)
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
    const alarmStepIndex = await this.ctx.storage.get<number>('alarmStepIndex')
    if (alarmStepIndex !== state.currentStepIndex) return

    const config = await this.ctx.storage.get<RoomConfig>('config')
    if (!config) return

    const format = draftFormatMap.get(config.formatId)
    if (!format) return

    const previews = sanitizeDraftPreviews(
      state,
      await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
    )
    const result = resolveTimeoutWithPreviews(state, format.blindBans, previews)
    if (isDraftError(result)) return

    await this.applyResult(result.state, result.events)
  }

  // ── Internal: Apply result & broadcast ─────────────────────

  private async applyResult(newState: DraftState, events: DraftEvent[]) {
    await this.ctx.storage.put('state', newState)
    const config = await this.ctx.storage.get<RoomConfig>('config')
    const format = config ? draftFormatMap.get(config.formatId) : null
    let webhookTask: Promise<void> | null = null
    let immediateSwapWindowSyncTask: Promise<void> | null = null
    const previews = sanitizeDraftPreviews(
      newState,
      await this.ctx.storage.get<DraftPreviewState>('previews') ?? createEmptyDraftPreviews(),
    )
    await this.ctx.storage.put('previews', previews)

    // Set timer when a new step starts
    const stepAdvanced = events.some(
      e => e.type === 'STEP_ADVANCED' || e.type === 'DRAFT_STARTED',
    )

    let timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    let completedAt = await this.ctx.storage.get<number | null>('completedAt')
    let cancelledAt = await this.ctx.storage.get<number | null>('cancelledAt')
    let swapState: LeaderSwapState | null = null

    const nextState = this.assignDealtCivIds(newState, config ?? null)
    if (nextState !== newState) {
      newState = nextState
      await this.ctx.storage.put('state', newState)
    }

    if (stepAdvanced && newState.status === 'active') {
      const step = getCurrentStep(newState)
      if (step && step.timer > 0) {
        timerEndsAt = Date.now() + step.timer * 1000
        await this.ctx.storage.put('alarmStepIndex', newState.currentStepIndex)
        await this.ctx.storage.setAlarm(timerEndsAt)
      }
      else {
        timerEndsAt = null
        await this.ctx.storage.deleteAlarm()
      }
      await this.ctx.storage.put('timerEndsAt', timerEndsAt)
      if (format) {
        this.scheduleDebugActiveBotActions(newState, format.blindBans)
      }
    }

    if (newState.status === 'complete') {
      timerEndsAt = null
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.put('alarmStepIndex', -1)
      await this.ctx.storage.put('timerEndsAt', null)
      if (completedAt == null) {
        completedAt = Date.now()
        await this.ctx.storage.put('completedAt', completedAt)
      }

      if (this.shouldOpenSwapWindow(newState)) {
        swapState = createEmptySwapState()
        await this.ctx.storage.put('swapWindowOpen', true)
        await this.ctx.storage.put('swapState', swapState)
        await this.ctx.storage.put('swapDisconnectFinalizeAt', null)
        await this.ctx.storage.put('swapSafetyEndsAt', completedAt + SWAP_WINDOW_TIMEOUT_MS)
        await this.scheduleSwapAlarm()
        if (config) immediateSwapWindowSyncTask = this.notifyDraftComplete(newState, config, completedAt)
      }
      else {
        await this.clearSwapWindowState()
        if (config) {
          webhookTask = this.notifyDraftComplete(newState, config, completedAt)
        }
      }
    }

    if (newState.status === 'cancelled') {
      timerEndsAt = null
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.put('alarmStepIndex', -1)
      await this.ctx.storage.put('timerEndsAt', null)
      if (cancelledAt == null) {
        cancelledAt = Date.now()
        await this.ctx.storage.put('cancelledAt', cancelledAt)
      }
      await this.clearSwapWindowState()
      if (config) {
        webhookTask = this.notifyDraftCancelled(newState, config, cancelledAt)
      }
    }

    if (newState.status !== 'complete') {
      await this.clearSwapWindowState()
    }

    if (newState.status === 'complete' && swapState == null && await this.isSwapWindowOpen()) {
      swapState = await this.getSwapState()
    }

    const hostId = config?.hostId ?? newState.seats[0]?.playerId ?? ''
    this.broadcastUpdate(newState, hostId, config?.leaderDataVersion ?? 'live', events, timerEndsAt ?? null, completedAt ?? null, previews, swapState)

    if (immediateSwapWindowSyncTask) {
      await immediateSwapWindowSyncTask
    }

    if ((newState.status === 'complete' && !swapState) || newState.status === 'cancelled') {
      this.closeAllConnections('Draft closed')
    }

    if (webhookTask) {
      this.ctx.waitUntil(webhookTask.catch((error) => {
        console.error(`Failed to deliver draft webhook for match ${newState.matchId}:`, error)
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

  private async runDebugActiveBotAction(stepIndex: number, seatIndex: number, blindBans: boolean) {
    const state = await this.ctx.storage.get<DraftState>('state')
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

  private shouldOpenSwapWindow(state: DraftState): boolean {
    return state.status === 'complete'
      && !isRedDeathDraftState(state)
      && state.seats.some(seat => seat.team != null)
  }

  private async isSwapWindowOpen(): Promise<boolean> {
    return await this.ctx.storage.get<boolean>('swapWindowOpen') === true
  }

  private async getSwapState(): Promise<LeaderSwapState> {
    const storedSwapState = await this.ctx.storage.get<unknown>('swapState')
    const legacyPendingExpiresAt = await this.ctx.storage.get<number | null>('swapPendingExpiresAt') ?? null
    return normalizeStoredSwapState(storedSwapState, legacyPendingExpiresAt)
  }

  private async clearSwapWindowState() {
    await this.ctx.storage.put('swapWindowOpen', false)
    await this.ctx.storage.put('swapState', null)
    await this.ctx.storage.put('swapPendingExpiresAt', null)
    await this.ctx.storage.put('swapDisconnectFinalizeAt', null)
    await this.ctx.storage.put('swapSafetyEndsAt', null)
  }

  private async clearSwapDisconnectFinalizeAt() {
    await this.ctx.storage.put('swapDisconnectFinalizeAt', null)
  }

  private async scheduleSwapAlarm() {
    if (!(await this.isSwapWindowOpen())) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    const swapState = await this.getSwapState()
    const disconnectFinalizeAt = await this.ctx.storage.get<number | null>('swapDisconnectFinalizeAt') ?? null
    const safetyEndsAt = await this.ctx.storage.get<number | null>('swapSafetyEndsAt') ?? null
    const nextAlarm = getNextSwapLifecycleAlarmAt({
      swapState,
      disconnectFinalizeAt,
      safetyEndsAt,
    })

    if (nextAlarm == null) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    await this.ctx.storage.setAlarm(nextAlarm)
  }

  private async finalizeCompletedDraft(state: DraftState) {
    if (!(await this.isSwapWindowOpen())) return

    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.put('alarmStepIndex', -1)
    await this.ctx.storage.put('timerEndsAt', null)

    let completedAt = await this.ctx.storage.get<number | null>('completedAt')
    if (completedAt == null) {
      completedAt = Date.now()
      await this.ctx.storage.put('completedAt', completedAt)
    }

    const config = await this.ctx.storage.get<RoomConfig>('config')
    await this.clearSwapWindowState()

    this.closeAllConnections('Draft closed')

    if (!config) return

    this.ctx.waitUntil(this.notifyDraftComplete(state, config, completedAt, { finalized: true }).catch((error) => {
      console.error(`Failed to deliver finalized draft webhook for match ${state.matchId}:`, error)
    }))
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
    }
    await this.sendDraftWebhook(state.matchId, config, payload)
  }

  private async sendDraftWebhook(
    matchId: string,
    config: RoomConfig,
    payload: DraftWebhookPayload,
  ) {
    if (!config.webhookUrl) {
      console.warn(`No draft webhook URL configured for match ${matchId}`)
      return
    }

    console.log(`Sending draft webhook (${payload.outcome}) for match ${matchId} -> ${config.webhookUrl}`)
    const body = JSON.stringify(payload)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.webhookSecret ? await createSignedWebhookHeaders(config.webhookSecret, body) : {}),
    }

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        await api.post(config.webhookUrl, body, { headers })
        console.log(`Draft webhook delivered (${payload.outcome}) for match ${matchId} on attempt ${attempt}`)
        return
      }
      catch (err) {
        const status = err instanceof ApiError ? err.status : 'Unknown'
        if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
          console.error(`Draft webhook failed for match ${matchId} after ${attempt} attempts (${status}):`, err)
          return
        }

        const retryDelay = Math.min(WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1), WEBHOOK_RETRY_MAX_MS)
        console.error(`Draft webhook attempt ${attempt} failed for match ${matchId} (${status}), retrying in ${retryDelay}ms`, err)
        await wait(retryDelay)
      }
    }
  }
}

// ── Utility ──────────────────────────────────────────────────

function isDebugActiveBotPlayerId(playerId: string | null | undefined): boolean {
  return typeof playerId === 'string' && playerId.startsWith(DEBUG_ACTIVE_BOT_PLAYER_ID_PREFIX)
}

function isSeatInStep(step: DraftState['steps'][number], seatIndex: number, totalSeats: number): boolean {
  if (step.seats === 'all') return seatIndex >= 0 && seatIndex < totalSeats
  return step.seats.includes(seatIndex)
}

function pickRandomDistinct<T>(items: T[], count: number): T[] {
  const pool = [...items]
  const picks: T[] = []
  const target = Math.max(0, Math.min(count, pool.length))
  for (let i = 0; i < target; i++) {
    const index = Math.floor(Math.random() * pool.length)
    const [next] = pool.splice(index, 1)
    if (next != null) picks.push(next)
  }
  return picks
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

function buildRandomDraftResult(state: DraftState): { state: DraftState, events: DraftEvent[] } {
  const shuffledIds = pickRandomDistinct(state.availableCivIds, state.availableCivIds.length)
  const picks = state.seats.map((_, seatIndex) => ({
    civId: shuffledIds[seatIndex]!,
    seatIndex,
    stepIndex: seatIndex,
  }))

  return {
    state: {
      ...state,
      currentStepIndex: state.steps.length,
      submissions: {},
      picks,
      availableCivIds: state.availableCivIds.filter(civId => !picks.some(pick => pick.civId === civId)),
      dealtCivIds: null,
      status: 'complete',
      cancelReason: null,
    },
    events: [
      { type: 'DRAFT_STARTED' },
      { type: 'DRAFT_COMPLETE' },
    ],
  }
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
