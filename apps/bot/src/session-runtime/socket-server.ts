export type WSMessage = ArrayBuffer | ArrayBufferView | string

export interface ConnectionContext {
  request: Request
}

export type Connection<TState = unknown> = WebSocket & {
  id: string
  state: TState | null
  setState: (state: TState | null) => TState | null
}

export class SessionSocketServer<Env extends Cloudflare.Env = Cloudflare.Env> {
  // Selected-session sockets keep per-connection state in memory, so this runtime is intentionally non-hibernating.
  static options: { hibernate?: boolean } = { hibernate: false }

  private readonly connections = new Set<Connection>()

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // PartySocket probes this endpoint; selected-session routing itself is bot-owned.
    if (url.pathname === '/cdn-cgi/partyserver/set-name/') return Response.json({ ok: true })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return await this.onRequest(request)

    const pair = new WebSocketPair()
    const connection = this.acceptConnection(pair[1], url.searchParams.get('_pk') ?? crypto.randomUUID())
    await this.onConnect(connection, { request })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    await this.onMessage(ws as Connection, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const connection = ws as Connection
    this.connections.delete(connection)
    await this.onClose(connection, code, reason, wasClean)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.onError(ws as Connection, error)
  }

  getConnections<TState = unknown>(): Iterable<Connection<TState>> {
    return this.connections as Iterable<Connection<TState>>
  }

  onRequest(_request: Request): Response | Promise<Response> {
    return new Response('Not found', { status: 404 })
  }

  onConnect(_connection: Connection, _ctx: ConnectionContext): void | Promise<void> {}

  onMessage(_connection: Connection, _message: WSMessage): void | Promise<void> {}

  onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean): void | Promise<void> {}

  onError(_connection: Connection, _error: unknown): void | Promise<void> {}

  onAlarm(): void | Promise<void> {}

  async alarm(): Promise<void> {
    await this.onAlarm()
  }

  private acceptConnection(socket: WebSocket, id: string): Connection {
    const connection = Object.assign(socket, {
      id,
      state: null as unknown | null,
      setState(state: unknown | null) {
        this.state = state
        return this.state
      },
    }) as Connection

    socket.accept()
    this.connections.add(connection)
    socket.addEventListener('message', (event) => {
      Promise.resolve(this.onMessage(connection, event.data as WSMessage)).catch(error => this.onError(connection, error))
    })
    socket.addEventListener('close', (event) => {
      this.connections.delete(connection)
      Promise.resolve(this.onClose(connection, event.code, event.reason, event.wasClean)).catch(error => this.onError(connection, error))
    })
    socket.addEventListener('error', (event) => {
      Promise.resolve(this.onError(connection, event)).catch(error => console.error('[session-socket] error handler failed', error))
    })
    return connection
  }
}
