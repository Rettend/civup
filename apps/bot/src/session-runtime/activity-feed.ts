import type { Connection, ConnectionContext } from 'partyserver'
import type { StoredActivityFollowTargetSelection, StoredActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import type { ActivityOverviewSnapshot, LobbySnapshot } from '../services/activity/session-state.ts'
import type { SessionRecord } from './session-record.ts'
import { createDb } from '@civup/db'
import { CIVUP_ACTIVITY_USER_ID_HEADER, isAuthorizedInternalRequest } from '@civup/utils'
import { Server } from 'partyserver'
import { parseStoredActivityFollowTargetSelection, parseStoredActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import { buildActivityOverviewSnapshotFromDirectory, buildLobbySnapshotFromSessionRecord, mergeActivityOverviewSnapshotForSessionUpdate } from '../services/activity/session-state.ts'

interface ActivityFeedEnv extends Cloudflare.Env {
  DB?: D1Database
  KV?: KVNamespace
  CIVUP_SECRET?: string
}

export type ActivityFeedMessage
  = | { type: 'overview', snapshot: ActivityOverviewSnapshot | null }
    | { type: 'lobby', lobbyId: string, snapshot: LobbySnapshot | null }
    | { type: 'error', message: string }

interface PublishSessionUpdateRequest {
  record?: SessionRecord
}

const ACTIVITY_OVERVIEW_STORAGE_KEY = 'activity-overview-snapshot'
const ACTIVITY_LAUNCH_TARGET_STORAGE_KEY = 'activity-launch-target'
const ACTIVITY_FOLLOW_TARGET_STORAGE_KEY = 'activity-follow-target'

export class Activity extends Server<ActivityFeedEnv> {
  static override options = {
    hibernate: true,
  }

  override async onRequest(req: Request): Promise<Response> {
    if (!isAuthorizedInternalRequest(req.headers, this.env.CIVUP_SECRET)) return json({ error: 'Unauthorized' }, 401)

    const pathname = new URL(req.url).pathname
    if (pathname === '/activity-launch-target') return this.handleActivityLaunchTargetRequest(req)
    if (pathname === '/activity-follow-target') return this.handleActivityFollowTargetRequest(req)

    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

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

  private async handleActivityLaunchTargetRequest(req: Request): Promise<Response> {
    switch (req.method) {
      case 'GET': {
        const stored = await this.ctx.storage.get<StoredActivityLaunchTargetSelection>(ACTIVITY_LAUNCH_TARGET_STORAGE_KEY)
        const target = parseStoredActivityLaunchTargetSelection(stored ?? null)
        if (!target && stored) await this.ctx.storage.delete(ACTIVITY_LAUNCH_TARGET_STORAGE_KEY)
        return json({ target })
      }
      case 'POST': {
        let body: unknown
        try {
          body = await req.json()
        }
        catch {
          return json({ error: 'Invalid JSON payload' }, 400)
        }
        const target = parseStoredActivityLaunchTargetSelection(body)
        if (!target) return json({ error: 'Invalid launch target' }, 400)
        await this.ctx.storage.put(ACTIVITY_LAUNCH_TARGET_STORAGE_KEY, target)
        return json({ ok: true })
      }
      case 'DELETE':
        await this.ctx.storage.delete(ACTIVITY_LAUNCH_TARGET_STORAGE_KEY)
        return json({ ok: true })
      default:
        return new Response('Method not allowed', { status: 405 })
    }
  }

  private async handleActivityFollowTargetRequest(req: Request): Promise<Response> {
    switch (req.method) {
      case 'GET': {
        const stored = await this.ctx.storage.get<StoredActivityFollowTargetSelection>(ACTIVITY_FOLLOW_TARGET_STORAGE_KEY)
        const target = parseStoredActivityFollowTargetSelection(stored ?? null)
        if (!target && stored) await this.ctx.storage.delete(ACTIVITY_FOLLOW_TARGET_STORAGE_KEY)
        return json({ target })
      }
      case 'POST': {
        let body: unknown
        try {
          body = await req.json()
        }
        catch {
          return json({ error: 'Invalid JSON payload' }, 400)
        }
        const target = parseStoredActivityFollowTargetSelection(body)
        if (!target) return json({ error: 'Invalid follow target' }, 400)
        await this.ctx.storage.put(ACTIVITY_FOLLOW_TARGET_STORAGE_KEY, target)
        return json({ ok: true })
      }
      case 'DELETE':
        await this.ctx.storage.delete(ACTIVITY_FOLLOW_TARGET_STORAGE_KEY)
        return json({ ok: true })
      default:
        return new Response('Method not allowed', { status: 405 })
    }
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    if (!isAuthorizedInternalRequest(ctx.request.headers, this.env.CIVUP_SECRET)) {
      connection.close(4401, 'Unauthorized')
      return
    }

    if (!readActivityUserId(ctx.request.headers)) {
      connection.close(4401, 'Unauthorized')
      return
    }

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

    const overview = await this.loadOverviewSnapshot(channelId)
    this.send(connection, { type: 'overview', snapshot: overview })
  }

  private async broadcastSessionUpdate(record: SessionRecord): Promise<void> {
    const connections = Array.from(this.getConnections())
    if (connections.length === 0) return

    const channelId = record.projectionState.channelId
    const baseOverview = this.env.DB
      ? await this.loadOverviewSnapshot(channelId)
      : await this.getOverviewSnapshot(channelId)
    const overview = mergeActivityOverviewSnapshotForSessionUpdate(baseOverview, record)
    await this.ctx.storage.put(ACTIVITY_OVERVIEW_STORAGE_KEY, overview)
    this.broadcastFeedMessage(connections, { type: 'overview', snapshot: overview })
    this.broadcastFeedMessage(connections, await this.buildLobbyFeedMessage(record))
  }

  private async buildLobbyFeedMessage(record: SessionRecord): Promise<ActivityFeedMessage> {
    if (record.phase !== 'open') return { type: 'lobby', lobbyId: record.id, snapshot: null }
    if (!this.env.KV) return { type: 'error', message: 'Activity lobby snapshots are not configured' }
    return {
      type: 'lobby',
      lobbyId: record.id,
      snapshot: await buildLobbySnapshotFromSessionRecord(this.env.KV, record),
    }
  }

  private async getOverviewSnapshot(channelId: string): Promise<ActivityOverviewSnapshot | null> {
    const cached = await this.ctx.storage.get<ActivityOverviewSnapshot | null>(ACTIVITY_OVERVIEW_STORAGE_KEY)
    if (cached === null || cached?.channelId === channelId) return cached ?? null
    return this.rebuildOverviewSnapshot(channelId)
  }

  private async rebuildOverviewSnapshot(channelId: string): Promise<ActivityOverviewSnapshot | null> {
    const overview = await this.loadOverviewSnapshot(channelId)
    await this.ctx.storage.put(ACTIVITY_OVERVIEW_STORAGE_KEY, overview)
    return overview
  }

  private async loadOverviewSnapshot(channelId: string): Promise<ActivityOverviewSnapshot | null> {
    if (!this.env.DB) return null
    return buildActivityOverviewSnapshotFromDirectory(createDb(this.env.DB), channelId)
  }

  private send(connection: Connection, message: ActivityFeedMessage): void {
    connection.send(JSON.stringify(message))
  }

  private broadcastFeedMessage(connections: readonly Connection[], message: ActivityFeedMessage): void {
    const encoded = JSON.stringify(message)
    for (const connection of connections) {
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
