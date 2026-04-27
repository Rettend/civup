import type { Connection, ConnectionContext } from 'partyserver'
import type { ActivityOverviewSnapshot } from '../services/activity/session-state.ts'
import type { SessionRecord } from './session-record.ts'
import { createDb } from '@civup/db'
import { CIVUP_ACTIVITY_USER_ID_HEADER, isAuthorizedInternalRequest } from '@civup/utils'
import { Server } from 'partyserver'
import { buildActivityOverviewOptionsFromSessionRecord, buildActivityOverviewSnapshotFromDirectory, compareActivityOverviewOptions } from '../services/activity/session-state.ts'

interface ActivityFeedEnv extends Cloudflare.Env {
  DB?: D1Database
  KV?: KVNamespace
  CIVUP_SECRET?: string
}

interface ActivityFeedConnectionState {
  userId: string
}

export type ActivityFeedMessage
  = | { type: 'overview', snapshot: ActivityOverviewSnapshot | null }
    | { type: 'error', message: string }

interface PublishSessionUpdateRequest {
  record?: SessionRecord
}

const ACTIVITY_OVERVIEW_STORAGE_KEY = 'activity-overview-snapshot'

export class Activity extends Server<ActivityFeedEnv> {
  static override options = {
    hibernate: true,
  }

  override async onRequest(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (!isAuthorizedInternalRequest(req.headers, this.env.CIVUP_SECRET)) return json({ error: 'Unauthorized' }, 401)

    let body: PublishSessionUpdateRequest
    try {
      body = await req.json<PublishSessionUpdateRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    const record = body.record
    if (!record || typeof record.id !== 'string') return json({ error: 'record is required' }, 400)

    await this.broadcastSessionUpdate(record)
    return json({ ok: true })
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    if (!isAuthorizedInternalRequest(ctx.request.headers, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    const userId = readActivityUserId(ctx.request.headers)
    if (!userId) {
      connection.close(4401, 'Unauthorized')
      return
    }

    connection.setState({ userId } satisfies ActivityFeedConnectionState)
    await this.sendInitialState(connection, readActivityChannelId(ctx.request))
  }

  private async sendInitialState(connection: Connection, channelId: string | null): Promise<void> {
    if (!channelId) {
      this.send(connection, { type: 'error', message: 'Activity channel is missing' })
      return
    }
    if (!this.env.DB) {
      this.send(connection, { type: 'error', message: 'Activity feed is not configured' })
      return
    }

    const overview = await this.rebuildOverviewSnapshot(channelId)
    this.send(connection, { type: 'overview', snapshot: overview })
  }

  private async broadcastSessionUpdate(record: SessionRecord): Promise<void> {
    const channelId = record.projectionState.channelId
    const current = await this.getOverviewSnapshot(channelId)
    const options = [
      ...(current?.options ?? []).filter(option => option.lobbyId !== record.id),
      ...buildActivityOverviewOptionsFromSessionRecord(record),
    ].sort(compareActivityOverviewOptions)
    const overview = options.length > 0 ? { channelId, options } satisfies ActivityOverviewSnapshot : null
    await this.ctx.storage.put(ACTIVITY_OVERVIEW_STORAGE_KEY, overview)
    this.broadcastFeedMessage({ type: 'overview', snapshot: overview })
  }

  private async getOverviewSnapshot(channelId: string): Promise<ActivityOverviewSnapshot | null> {
    const cached = await this.ctx.storage.get<ActivityOverviewSnapshot | null>(ACTIVITY_OVERVIEW_STORAGE_KEY)
    if (cached === null || cached?.channelId === channelId) return cached ?? null
    return await this.rebuildOverviewSnapshot(channelId)
  }

  private async rebuildOverviewSnapshot(channelId: string): Promise<ActivityOverviewSnapshot | null> {
    if (!this.env.DB) return null
    const overview = await buildActivityOverviewSnapshotFromDirectory(createDb(this.env.DB), channelId)
    await this.ctx.storage.put(ACTIVITY_OVERVIEW_STORAGE_KEY, overview)
    return overview
  }

  private send(connection: Connection, message: ActivityFeedMessage): void {
    connection.send(JSON.stringify(message))
  }

  private broadcastFeedMessage(message: ActivityFeedMessage): void {
    const encoded = JSON.stringify(message)
    for (const connection of this.getConnections()) {
      connection.send(encoded)
    }
  }
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}

function readActivityChannelId(request: Request): string | null {
  const pathname = new URL(request.url).pathname
  const match = pathname.match(/\/parties\/activity\/([^/?#]+)/)
  const encoded = match?.[1] ?? ''
  if (!encoded) return null
  try {
    const channelId = decodeURIComponent(encoded).trim()
    return channelId.length > 0 ? channelId : null
  }
  catch {
    return null
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
