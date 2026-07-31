export type WSMessage = ArrayBuffer | ArrayBufferView | string

export interface ConnectionContext {
  request: Request
}

export type Connection<TState = unknown> = WebSocket & {
  id: string
  state: TState | null
  setState: (state: TState | null) => TState | null
}

type SessionConnectionKind = 'open-lobby' | 'draft'

interface SessionSocketAttachment {
  id: string
  sessionId: string | null
  playerId: string | null
  guildId: string | null
  kind: SessionConnectionKind | null
  connectedAt: number
}

export class SessionSocketServer<Env extends Cloudflare.Env = Cloudflare.Env> {
  static options: { hibernate?: boolean } = { hibernate: true }

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // PartySocket probes this endpoint; selected-session routing itself is bot-owned.
    if (url.pathname === '/cdn-cgi/partyserver/set-name/') return Response.json({ ok: true })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return this.onRequest(request)

    const pair = new WebSocketPair()
    const connection = this.acceptConnection(pair[1], {
      id: url.searchParams.get('_pk') ?? crypto.randomUUID(),
      sessionId: readSessionIdFromUrl(url),
    })
    await this.onConnect(connection, { request })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    await this.onMessage(this.hydrateConnection(ws), message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.onClose(this.hydrateConnection(ws), code, reason, wasClean)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.onError(this.hydrateConnection(ws), error)
  }

  getConnections<TState = unknown>(): Iterable<Connection<TState>> {
    const getWebSockets = (this.ctx as Partial<DurableObjectState>).getWebSockets
    if (typeof getWebSockets !== 'function') return []
    return getWebSockets.call(this.ctx)
      .map(socket => this.hydrateConnection<TState>(socket))
      .filter(connection => connection.readyState < 2)
  }

  onRequest(_request: Request): Response | Promise<Response> {
    return new Response('Not found', { status: 404 })
  }

  onConnect(_connection: Connection, _ctx: ConnectionContext): void | Promise<void> {}

  onMessage(_connection: Connection, _message: WSMessage): void | Promise<void> {}

  onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean): void | Promise<void> {}

  onError(_connection: Connection, _error: unknown): void | Promise<void> {}

  onAlarm(): void | Promise<void> {}

  protected sendConnectionMessage<TState>(connection: Connection<TState>, message: WSMessage): boolean {
    if (connection.readyState >= 2) return false

    try {
      connection.send(message)
      return true
    }
    catch (error) {
      if (isClosedWebSocketSendError(error)) return false
      throw error
    }
  }

  async alarm(): Promise<void> {
    await this.onAlarm()
  }

  private acceptConnection(socket: WebSocket, options: { id: string, sessionId: string | null }): Connection {
    this.ctx.acceptWebSocket(socket)
    writeConnectionAttachment(socket, {
      id: options.id,
      sessionId: options.sessionId,
      playerId: null,
      guildId: null,
      kind: null,
      connectedAt: Date.now(),
    })
    return this.hydrateConnection(socket)
  }

  private hydrateConnection<TState = unknown>(socket: WebSocket): Connection<TState> {
    const existingSetState = (socket as Partial<Connection<TState>>).setState
    const attachment = readConnectionAttachment(socket)
    const connection = socket as Connection<TState>
    let state: TState | null = connectionStateFromAttachment<TState>(attachment) ?? (connection.state ?? null)

    Object.defineProperties(connection, {
      id: {
        configurable: true,
        enumerable: true,
        value: attachment?.id ?? connection.id ?? crypto.randomUUID(),
        writable: true,
      },
      state: {
        configurable: true,
        enumerable: true,
        get() {
          return state
        },
        set(nextState: TState | null) {
          state = nextState
        },
      },
      setState: {
        configurable: true,
        enumerable: true,
        value(nextState: TState | null) {
          state = nextState
          const nextAttachment = attachmentFromConnectionState(connection, nextState)
          writeConnectionAttachment(connection, nextAttachment)
          if (existingSetState && existingSetState !== connection.setState) existingSetState.call(connection, nextState)
          return state
        },
        writable: true,
      },
    })

    return connection
  }
}

function readConnectionAttachment(socket: WebSocket): SessionSocketAttachment | null {
  const value = typeof socket.deserializeAttachment === 'function'
    ? socket.deserializeAttachment()
    : null
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<SessionSocketAttachment>
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null
  if (!id) return null

  const kind = raw.kind === 'open-lobby' || raw.kind === 'draft' ? raw.kind : null
  return {
    id,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null,
    playerId: typeof raw.playerId === 'string' && raw.playerId.length > 0 ? raw.playerId : null,
    guildId: typeof raw.guildId === 'string' && raw.guildId.length > 0 ? raw.guildId : null,
    kind,
    connectedAt: typeof raw.connectedAt === 'number' && Number.isFinite(raw.connectedAt) ? raw.connectedAt : Date.now(),
  }
}

function writeConnectionAttachment(socket: WebSocket, attachment: SessionSocketAttachment): void {
  if (typeof socket.serializeAttachment === 'function') socket.serializeAttachment(attachment)
}

function connectionStateFromAttachment<TState>(attachment: SessionSocketAttachment | null): TState | null {
  if (!attachment?.playerId) return null
  return {
    playerId: attachment.playerId,
    ...(attachment.guildId ? { guildId: attachment.guildId } : {}),
    ...(attachment.kind === 'open-lobby' ? { openLobby: true } : {}),
  } as TState
}

function attachmentFromConnectionState<TState>(connection: Connection<TState>, state: TState | null): SessionSocketAttachment {
  const current = readConnectionAttachment(connection)
  const stateRecord = state && typeof state === 'object' ? state as Record<string, unknown> : null
  const playerId = typeof stateRecord?.playerId === 'string' && stateRecord.playerId.length > 0 ? stateRecord.playerId : null
  const guildId = typeof stateRecord?.guildId === 'string' && stateRecord.guildId.length > 0 ? stateRecord.guildId : null
  const openLobby = stateRecord?.openLobby === true
  return {
    id: current?.id ?? connection.id ?? crypto.randomUUID(),
    sessionId: current?.sessionId ?? null,
    playerId,
    guildId,
    kind: playerId ? openLobby ? 'open-lobby' : 'draft' : null,
    connectedAt: current?.connectedAt ?? Date.now(),
  }
}

function readSessionIdFromUrl(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean)
  const raw = parts[2]
  if (!raw) return null
  try {
    const sessionId = decodeURIComponent(raw).trim()
    return sessionId.length > 0 ? sessionId : null
  }
  catch {
    return raw
  }
}

function isClosedWebSocketSendError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Can't call WebSocket send() after close")
}
