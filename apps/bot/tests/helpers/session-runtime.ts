import { SessionDO } from '../../src/session-runtime/session-do.ts'

export function createTestSessionNamespace(env: Partial<Cloudflare.Env> = {}): DurableObjectNamespace {
  const rooms = new Map<string, SessionDO>()
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const sessionId = String(id)
      let room = rooms.get(sessionId)
      if (!room) {
        room = new SessionDO(createFakeDurableObjectState(), env as Cloudflare.Env)
        rooms.set(sessionId, room)
      }
      const sessionRoom = room
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          return sessionRoom.fetch(request)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

export function createFakeDurableObjectState(): DurableObjectState {
  const storage = new Map<string, unknown>()
  let alarmAt: number | null = null
  return {
    async blockConcurrencyWhile(callback: () => Promise<void> | void) {
      await callback()
    },
    getWebSockets() {
      return []
    },
    acceptWebSocket() {},
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
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
