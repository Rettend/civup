import type { RoomConfig } from '@civup/game'
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

export function createCapturedMainNamespace(roomConfigs = new Map<string, RoomConfig>()): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const roomName = String(id)
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url)
          if (url.pathname === '/cdn-cgi/partyserver/set-name/') return Response.json({ ok: true })
          if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

          const body = await request.json() as RoomConfig
          if (body.matchId !== roomName) return new Response('Room name mismatch', { status: 409 })
          roomConfigs.set(body.matchId, body)
          return Response.json({ ok: true }, { status: 201 })
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

export function createFakeDurableObjectState(): DurableObjectState {
  const storage = new Map<string, unknown>()
  return {
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
      },
    },
  } as unknown as DurableObjectState
}
