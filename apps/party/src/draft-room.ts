import type {
  ClientMessage,
  DraftEvent,
  DraftState,
  DraftWebhookPayload,
  RoomConfig,
  ServerMessage,
} from '@civup/game'
import { createDraft, draftFormatMap, getCurrentStep, isDraftError, MAX_TIMER_SECONDS, processDraftInput } from '@civup/game'
import { api, ApiError } from '@civup/utils'
import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver'

// ── Connection State ─────────────────────────────────────────

interface ConnectionState {
  playerId: string | null
}

const WEBHOOK_MAX_ATTEMPTS = 4
const WEBHOOK_RETRY_BASE_MS = 250
const WEBHOOK_RETRY_MAX_MS = 1500

// ── Draft Room Server ────────────────────────────────────────

export class Main extends Server {
  static override options = {
    hibernate: true,
  }

  // ── HTTP: Room initialization & status ─────────────────────

  override async onRequest(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      return this.handleCreate(req)
    }
    if (req.method === 'GET') {
      return this.handleStatus()
    }
    return new Response('Method not allowed', { status: 405 })
  }

  private async handleCreate(req: Request): Promise<Response> {
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

    const baseState = createDraft(config.matchId, format, config.seats, config.civPool)
    const state = withWaitingTimerConfig(format, baseState, config.timerConfig)

    await this.ctx.storage.put('config', config)
    await this.ctx.storage.put('state', state)
    await this.ctx.storage.put('timerEndsAt', null)
    await this.ctx.storage.put('alarmStepIndex', -1)
    await this.ctx.storage.put('completedAt', null)
    await this.ctx.storage.put('cancelledAt', null)

    return json({ ok: true, matchId: config.matchId }, 201)
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) {
      return json({ error: 'Room not initialized' }, 404)
    }
    const timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    const completedAt = await this.ctx.storage.get<number | null>('completedAt')
    const cancelledAt = await this.ctx.storage.get<number | null>('cancelledAt')
    return json({ state, timerEndsAt, completedAt, cancelledAt })
  }

  // ── WebSocket: Connection ──────────────────────────────────

  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url)
    const playerId = url.searchParams.get('playerId')

    connection.setState({ playerId } satisfies ConnectionState)

    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state) {
      this.send(connection, { type: 'error', message: 'Room not initialized' })
      connection.close(4000, 'Room not initialized')
      return
    }

    const config = await this.ctx.storage.get<RoomConfig>('config')
    const hostId = config?.hostId ?? state.seats[0]?.playerId ?? ''

    const timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    const completedAt = await this.ctx.storage.get<number | null>('completedAt')
    const seatIndex = playerId
      ? state.seats.findIndex(s => s.playerId === playerId)
      : -1

    this.send(connection, {
      type: 'init',
      state: this.censorState(state, seatIndex),
      hostId,
      seatIndex: seatIndex >= 0 ? seatIndex : null,
      timerEndsAt: timerEndsAt ?? null,
      completedAt: completedAt ?? null,
    })

    if (state.status === 'complete' || state.status === 'cancelled') {
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
      this.send(sender, { type: 'error', message: 'Not identified — reconnect with ?playerId' })
      return
    }

    const seatIndex = state.seats.findIndex(s => s.playerId === playerId)

    switch (msg.type) {
      case 'start': {
        if (playerId !== config.hostId) {
          this.send(sender, { type: 'error', message: 'Only the host can start the draft' })
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
        const result = processDraftInput(
          state,
          { type: 'PICK', seatIndex, civId: msg.civId },
          format.blindBans,
        )
        if (isDraftError(result)) {
          this.send(sender, { type: 'error', message: result.error })
          return
        }
        await this.applyResult(result.state, result.events)
        break
      }

      case 'cancel': {
        if (playerId !== config.hostId) {
          this.send(sender, { type: 'error', message: 'Only the host can cancel or scrub the draft' })
          return
        }

        if (msg.reason !== 'cancel' && msg.reason !== 'scrub') {
          this.send(sender, { type: 'error', message: 'Invalid cancel reason' })
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
        this.broadcastUpdate(nextState, config.hostId, [], timerEndsAt ?? null, completedAt ?? null)
        break
      }

      default:
        this.send(sender, { type: 'error', message: 'Unknown message type' })
    }
  }

  // ── WebSocket: Disconnect ──────────────────────────────────

  override async onClose(_connection: Connection) {
    // No action needed — timer continues server-side.
    // If the disconnected player's turn expires during picks, TIMEOUT auto-cancels.
  }

  override async onError(_connection: Connection, _error: unknown) {
    // Same as onClose — no special handling needed.
  }

  // ── Timer: Alarm ───────────────────────────────────────────

  override async onAlarm() {
    const state = await this.ctx.storage.get<DraftState>('state')
    if (!state || state.status !== 'active') return

    // Guard against stale alarms (step already advanced)
    const alarmStepIndex = await this.ctx.storage.get<number>('alarmStepIndex')
    if (alarmStepIndex !== state.currentStepIndex) return

    const config = await this.ctx.storage.get<RoomConfig>('config')
    if (!config) return

    const format = draftFormatMap.get(config.formatId)
    if (!format) return

    const result = processDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
    if (isDraftError(result)) return

    await this.applyResult(result.state, result.events)
  }

  // ── Internal: Apply result & broadcast ─────────────────────

  private async applyResult(newState: DraftState, events: DraftEvent[]) {
    await this.ctx.storage.put('state', newState)
    const config = await this.ctx.storage.get<RoomConfig>('config')
    let webhookTask: Promise<void> | null = null

    // Set timer when a new step starts
    const stepAdvanced = events.some(
      e => e.type === 'STEP_ADVANCED' || e.type === 'DRAFT_STARTED',
    )

    let timerEndsAt = await this.ctx.storage.get<number | null>('timerEndsAt')
    let completedAt = await this.ctx.storage.get<number | null>('completedAt')
    let cancelledAt = await this.ctx.storage.get<number | null>('cancelledAt')

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
      if (config) {
        webhookTask = this.notifyDraftComplete(newState, config, completedAt)
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
      if (config) {
        webhookTask = this.notifyDraftCancelled(newState, config, cancelledAt)
      }
    }

    const hostId = config?.hostId ?? newState.seats[0]?.playerId ?? ''
    this.broadcastUpdate(newState, hostId, events, timerEndsAt ?? null, completedAt ?? null)

    if (newState.status === 'complete' || newState.status === 'cancelled') {
      this.closeAllConnections('Draft closed')
    }

    if (webhookTask) {
      this.ctx.waitUntil(webhookTask.catch((error) => {
        console.error(`Failed to deliver draft webhook for match ${newState.matchId}:`, error)
      }))
    }
  }

  private broadcastUpdate(
    state: DraftState,
    hostId: string,
    events: DraftEvent[],
    timerEndsAt: number | null,
    completedAt: number | null,
  ) {
    // During blind ban phases, each player sees only their own pending bans
    if (state.pendingBlindBans.length > 0) {
      for (const conn of this.getConnections()) {
        const connState = conn.state as ConnectionState | null
        const playerId = connState?.playerId
        const seatIndex = playerId
          ? state.seats.findIndex(s => s.playerId === playerId)
          : -1

        this.send(conn, {
          type: 'update',
          state: this.censorState(state, seatIndex),
          hostId,
          events: this.censorEvents(events, seatIndex),
          timerEndsAt,
          completedAt,
        })
      }
    }
    else {
      // No censoring needed — broadcast identical state to everyone
      this.broadcast(JSON.stringify({
        type: 'update',
        state,
        hostId,
        events,
        timerEndsAt,
        completedAt,
      } satisfies ServerMessage))
    }
  }

  // ── Internal: Censoring for blind bans ─────────────────────

  /** Filters state for blind bans: players only see their own pending bans */
  private censorState(state: DraftState, seatIndex: number): DraftState {
    if (state.pendingBlindBans.length === 0) return state
    return {
      ...state,
      pendingBlindBans: state.pendingBlindBans.filter(
        b => b.seatIndex === seatIndex,
      ),
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

  private closeAllConnections(reason: string) {
    for (const conn of this.getConnections()) {
      conn.close(1000, reason)
    }
  }

  private async notifyDraftComplete(state: DraftState, config: RoomConfig, completedAt: number) {
    const hostId = config.hostId || state.seats[0]?.playerId || undefined
    const payload: DraftWebhookPayload = {
      outcome: 'complete',
      matchId: state.matchId,
      hostId,
      completedAt,
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (config.webhookSecret) {
      headers['X-CivUp-Webhook-Secret'] = config.webhookSecret
    }

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        await api.post(config.webhookUrl, payload, { headers })
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
