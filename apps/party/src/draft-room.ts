import type { ClientMessage, DraftEvent, DraftState, RoomConfig, ServerMessage } from '@civup/game'
import type * as Party from 'partykit/server'
import {
  createDraft,
  draftFormatMap,
  getCurrentStep,
  isDraftError,
  processDraftInput,
} from '@civup/game'

// ── Connection State ─────────────────────────────────────────

interface ConnectionState {
  playerId: string | null
}

// ── Draft Room Server ────────────────────────────────────────

export default class DraftRoom implements Party.Server {
  readonly options: Party.ServerOptions = {
    hibernate: true,
  }

  constructor(readonly room: Party.Room) {}

  // ── HTTP: Room initialization & status ─────────────────────

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === 'POST') {
      return this.handleCreate(req)
    }
    if (req.method === 'GET') {
      return this.handleStatus()
    }
    return new Response('Method not allowed', { status: 405 })
  }

  private async handleCreate(req: Party.Request): Promise<Response> {
    const existing = await this.room.storage.get<DraftState>('state')
    if (existing) {
      return json({ error: 'Room already initialized' }, 409)
    }

    const config: RoomConfig = await req.json()

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

    const state = createDraft(config.matchId, format, config.seats, config.civPool)

    await this.room.storage.put('config', config)
    await this.room.storage.put('state', state)
    await this.room.storage.put('timerEndsAt', null)
    await this.room.storage.put('alarmStepIndex', -1)

    return json({ ok: true, matchId: config.matchId }, 201)
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.room.storage.get<DraftState>('state')
    if (!state) {
      return json({ error: 'Room not initialized' }, 404)
    }
    const timerEndsAt = await this.room.storage.get<number | null>('timerEndsAt')
    return json({ state, timerEndsAt })
  }

  // ── WebSocket: Connection ──────────────────────────────────

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url)
    const playerId = url.searchParams.get('playerId')

    connection.setState({ playerId } satisfies ConnectionState)

    const state = await this.room.storage.get<DraftState>('state')
    if (!state) {
      this.send(connection, { type: 'error', message: 'Room not initialized' })
      connection.close(4000, 'Room not initialized')
      return
    }

    const timerEndsAt = await this.room.storage.get<number | null>('timerEndsAt')
    const seatIndex = playerId
      ? state.seats.findIndex(s => s.playerId === playerId)
      : -1

    this.send(connection, {
      type: 'init',
      state: this.censorState(state, seatIndex),
      seatIndex: seatIndex >= 0 ? seatIndex : null,
      timerEndsAt: timerEndsAt ?? null,
    })
  }

  // ── WebSocket: Messages ────────────────────────────────────

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== 'string')
      return

    let msg: ClientMessage
    try {
      msg = JSON.parse(message)
    }
    catch {
      this.send(sender, { type: 'error', message: 'Invalid JSON' })
      return
    }

    const state = await this.room.storage.get<DraftState>('state')
    if (!state) {
      this.send(sender, { type: 'error', message: 'Room not initialized' })
      return
    }

    const config = await this.room.storage.get<RoomConfig>('config')
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
        if (seatIndex < 0) {
          this.send(sender, { type: 'error', message: 'Only participants can start the draft' })
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

      default:
        this.send(sender, { type: 'error', message: 'Unknown message type' })
    }
  }

  // ── WebSocket: Disconnect ──────────────────────────────────

  async onClose(_connection: Party.Connection) {
    // No action needed — timer continues server-side.
    // If the disconnected player's turn expires, TIMEOUT auto-fills.
  }

  async onError(_connection: Party.Connection, _error: Error) {
    // Same as onClose — no special handling needed.
  }

  // ── Timer: Alarm ───────────────────────────────────────────

  async onAlarm() {
    const state = await this.room.storage.get<DraftState>('state')
    if (!state || state.status !== 'active')
      return

    // Guard against stale alarms (step already advanced)
    const alarmStepIndex = await this.room.storage.get<number>('alarmStepIndex')
    if (alarmStepIndex !== state.currentStepIndex)
      return

    const config = await this.room.storage.get<RoomConfig>('config')
    if (!config)
      return

    const format = draftFormatMap.get(config.formatId)
    if (!format)
      return

    const result = processDraftInput(state, { type: 'TIMEOUT' }, format.blindBans)
    if (isDraftError(result))
      return

    await this.applyResult(result.state, result.events)
  }

  // ── Internal: Apply result & broadcast ─────────────────────

  private async applyResult(newState: DraftState, events: DraftEvent[]) {
    await this.room.storage.put('state', newState)

    // Set timer when a new step starts
    const stepAdvanced = events.some(
      e => e.type === 'STEP_ADVANCED' || e.type === 'DRAFT_STARTED',
    )

    let timerEndsAt = await this.room.storage.get<number | null>('timerEndsAt')

    if (stepAdvanced && newState.status === 'active') {
      const step = getCurrentStep(newState)
      if (step && step.timer > 0) {
        timerEndsAt = Date.now() + step.timer * 1000
        await this.room.storage.put('alarmStepIndex', newState.currentStepIndex)
        await this.room.storage.setAlarm(timerEndsAt)
      }
      else {
        timerEndsAt = null
        await this.room.storage.deleteAlarm()
      }
      await this.room.storage.put('timerEndsAt', timerEndsAt)
    }

    if (newState.status === 'complete') {
      timerEndsAt = null
      await this.room.storage.deleteAlarm()
      await this.room.storage.put('timerEndsAt', null)
      // TODO: notify bot via webhook when draft completes
    }

    this.broadcastUpdate(newState, events, timerEndsAt ?? null)
  }

  private broadcastUpdate(
    state: DraftState,
    events: DraftEvent[],
    timerEndsAt: number | null,
  ) {
    // During blind ban phases, each player sees only their own pending bans
    if (state.pendingBlindBans.length > 0) {
      for (const conn of this.room.getConnections()) {
        const connState = conn.state as ConnectionState | null
        const playerId = connState?.playerId
        const seatIndex = playerId
          ? state.seats.findIndex(s => s.playerId === playerId)
          : -1

        this.send(conn, {
          type: 'update',
          state: this.censorState(state, seatIndex),
          events: this.censorEvents(events, seatIndex),
          timerEndsAt,
        })
      }
    }
    else {
      // No censoring needed — broadcast identical state to everyone
      this.room.broadcast(JSON.stringify({
        type: 'update',
        state,
        events,
        timerEndsAt,
      } satisfies ServerMessage))
    }
  }

  // ── Internal: Censoring for blind bans ─────────────────────

  /**
   * During blind ban phases, a player sees only their own pending
   * blind bans — not what other players banned.
   */
  private censorState(state: DraftState, seatIndex: number): DraftState {
    if (state.pendingBlindBans.length === 0)
      return state
    return {
      ...state,
      pendingBlindBans: state.pendingBlindBans.filter(
        b => b.seatIndex === seatIndex,
      ),
    }
  }

  /**
   * During blind ban phases, hide other players' ban selections.
   * They see that a ban was submitted, but not which civs.
   */
  private censorEvents(events: DraftEvent[], seatIndex: number): DraftEvent[] {
    return events.map((e) => {
      if (e.type === 'BAN_SUBMITTED' && e.blind && e.seatIndex !== seatIndex) {
        return { ...e, civIds: [] }
      }
      return e
    })
  }

  // ── Internal: Send message ─────────────────────────────────

  private send(connection: Party.Connection, message: ServerMessage) {
    connection.send(JSON.stringify(message))
  }
}

// ── Utility ──────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
