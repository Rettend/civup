import { SessionDO } from '../../src/session-runtime/session-do.ts'

export type FakeSessionDurableObjectState = DurableObjectState & { __webSockets: WebSocket[] }

export interface TestSessionNamespace extends DurableObjectNamespace {
  __getRoom: (name: string) => SessionDO
  __evictRoom: (name: string) => SessionDO
  __replaceWebSockets: (name: string, sockets: WebSocket[]) => void
}

export interface FakeSessionWebSocket {
  connection: WebSocket
  messages: unknown[]
  attachment: unknown
  closed: { code: number, reason: string } | null
}

export function createTestSessionNamespace(env: Partial<Cloudflare.Env> = {}): TestSessionNamespace {
  const rooms = new Map<string, SessionDO>()
  const states = new Map<string, FakeSessionDurableObjectState>()

  const getState = (sessionId: string): FakeSessionDurableObjectState => {
    let state = states.get(sessionId)
    if (!state) {
      state = createFakeDurableObjectState()
      states.set(sessionId, state)
    }
    return state
  }

  const createRoom = (sessionId: string): SessionDO => new SessionDO(getState(sessionId), env as Cloudflare.Env)

  const getRoom = (sessionId: string): SessionDO => {
    let room = rooms.get(sessionId)
    if (!room) {
      room = createRoom(sessionId)
      rooms.set(sessionId, room)
    }
    return room
  }

  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const sessionId = String(id)
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          return getRoom(sessionId).fetch(request)
        },
      } as DurableObjectStub
    },
    __getRoom(name: string) {
      return getRoom(name)
    },
    __evictRoom(name: string) {
      const room = createRoom(name)
      rooms.set(name, room)
      return room
    },
    __replaceWebSockets(name: string, sockets: WebSocket[]) {
      const state = getState(name)
      state.__webSockets.splice(0, state.__webSockets.length, ...sockets)
    },
  } as unknown as TestSessionNamespace
}

export function createFakeSessionWebSocket(initialAttachment: unknown = null): FakeSessionWebSocket {
  const messages: unknown[] = []
  let attachment = initialAttachment
  let closed: { code: number, reason: string } | null = null
  let readyState = 1
  const connection = {
    send(message: string) {
      messages.push(JSON.parse(message))
    },
    close(code = 1000, reason = '') {
      readyState = 3
      closed = { code, reason }
    },
    serializeAttachment(value: unknown) {
      attachment = value
    },
    deserializeAttachment() {
      return attachment
    },
    get readyState() {
      return readyState
    },
  } as unknown as WebSocket

  return {
    connection,
    messages,
    get attachment() {
      return attachment
    },
    get closed() {
      return closed
    },
  }
}

export function createFakeDurableObjectState(): FakeSessionDurableObjectState {
  const storage = new Map<string, unknown>()
  const webSockets: WebSocket[] = []
  let alarmAt: number | null = null
  return {
    __webSockets: webSockets,
    async blockConcurrencyWhile(callback: () => Promise<void> | void) {
      await callback()
    },
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => {})
    },
    getWebSockets() {
      return webSockets
    },
    acceptWebSocket(socket: WebSocket) {
      webSockets.push(socket)
    },
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
      },
      async delete(key: string) {
        return storage.delete(key)
      },
      async setAlarm(scheduledTime: number | Date) {
        alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime
      },
      async deleteAlarm() {
        alarmAt = null
      },
      async getAlarm() {
        return alarmAt
      },
    },
  } as unknown as DurableObjectState
}
