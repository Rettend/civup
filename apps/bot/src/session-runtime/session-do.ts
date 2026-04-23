import type { QueueEntry } from '@civup/game'
import type { LobbyState } from '../services/lobby/types.ts'
import type { SessionRecord } from './session-record.ts'
import { buildOpenSessionRecordFromLobby } from './session-record.ts'

interface SessionDOEnv extends Cloudflare.Env {
  DB?: D1Database
}

interface CreateSessionFromLobbyRequest {
  lobby: LobbyState
  queueEntries?: QueueEntry[]
}

const SESSION_RECORD_STORAGE_KEY = 'session-record'

export class SessionDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: SessionDOEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/record') {
      const record = await this.getRecord()
      if (!record) return json({ error: 'Session not found' }, 404)
      return json({ record })
    }

    if (request.method === 'POST' && url.pathname === '/commands/create-from-lobby') {
      let body: CreateSessionFromLobbyRequest
      try {
        body = await request.json<CreateSessionFromLobbyRequest>()
      }
      catch {
        return json({ error: 'Invalid JSON payload' }, 400)
      }

      if (!body?.lobby || typeof body.lobby.id !== 'string') {
        return json({ error: 'lobby is required' }, 400)
      }

      const record = buildOpenSessionRecordFromLobby(body.lobby, body.queueEntries ?? [])
      const existing = await this.getRecord()
      if (existing && existing.id !== record.id) {
        return json({ error: 'Session id mismatch' }, 409)
      }

      if (!existing || record.version >= existing.version) {
        await this.state.storage.put(SESSION_RECORD_STORAGE_KEY, record)
      }

      return json({ ok: true, record })
    }

    return json({ error: 'Not found' }, 404)
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.state.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
