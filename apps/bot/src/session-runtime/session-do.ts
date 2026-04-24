import type { QueueEntry } from '@civup/game'
import type { LobbyState } from '../services/lobby/types.ts'
import type { SessionRecord } from './session-record.ts'
import { syncSessionRecordFromLobby } from './session-record.ts'

interface SessionDOEnv extends Cloudflare.Env {
  DB?: D1Database
}

interface CreateSessionFromLobbyRequest {
  lobby: LobbyState
  queueEntries?: QueueEntry[]
}

type SyncSessionFromLobbyRequest = CreateSessionFromLobbyRequest

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
      return await this.handleSyncFromLobby(request, { requireOpenCreate: true })
    }

    if (request.method === 'POST' && url.pathname === '/commands/sync-from-lobby') {
      return await this.handleSyncFromLobby(request, { requireOpenCreate: false })
    }

    if (request.method === 'POST' && url.pathname === '/commands/prepare-draft-start') {
      return await this.handlePrepareDraftStart()
    }

    return json({ error: 'Not found' }, 404)
  }

  private async getRecord(): Promise<SessionRecord | null> {
    return await this.state.storage.get<SessionRecord>(SESSION_RECORD_STORAGE_KEY) ?? null
  }

  private async handleSyncFromLobby(
    request: Request,
    options: { requireOpenCreate: boolean },
  ): Promise<Response> {
    let body: SyncSessionFromLobbyRequest
    try {
      body = await request.json<SyncSessionFromLobbyRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body?.lobby || typeof body.lobby.id !== 'string') {
      return json({ error: 'lobby is required' }, 400)
    }
    if (options.requireOpenCreate && body.lobby.status !== 'open') {
      return json({ error: 'create-from-lobby requires an open lobby' }, 400)
    }

    const existing = await this.getRecord()
    let record: SessionRecord
    try {
      record = syncSessionRecordFromLobby(existing, body.lobby, body.queueEntries ?? [])
    }
    catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }

    if (!existing || record.version > existing.version) {
      await this.state.storage.put(SESSION_RECORD_STORAGE_KEY, record)
    }

    return json({ ok: true, record })
  }

  private async handlePrepareDraftStart(): Promise<Response> {
    const record = await this.getRecord()
    if (!record) return json({ error: 'Session not found' }, 404)
    if (record.phase !== 'open') {
      return json({ error: `Session is not open (phase: ${record.phase})` }, 409)
    }

    return json({ ok: true, record })
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
