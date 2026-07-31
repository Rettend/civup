import type { Connection, ConnectionContext } from 'partyserver'
import type { StoredActivityFollowTargetSelection, StoredActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import type { ActivityOverviewSnapshot, ActivitySupportedServerSnapshot, LobbySnapshot } from '../services/activity/session-state.ts'
import type { SessionRecord } from './session-record.ts'
import { createDb } from '@civup/db'
import { ACTIVITY_FEED_ROOM, CIVUP_ACTIVITY_GUILD_ID_HEADER, CIVUP_ACTIVITY_USER_ID_HEADER, isAuthorizedInternalRequest, resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { Server } from 'partyserver'
import { parseStoredActivityFollowTargetSelection, parseStoredActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import { attachTournamentLobbySnapshot, buildActivityOverviewSnapshotFromDirectory, buildLobbySnapshotFromSessionRecord, mergeActivityOverviewSnapshotForSessionUpdate } from '../services/activity/session-state.ts'
import { getKnownGuildIdentities } from '../services/discord/guild-metadata.ts'

interface ActivityFeedEnv extends Cloudflare.Env {
  DB?: D1Database
  KV?: KVNamespace
  CIVUP_SECRET?: string
  ALLOWED_DISCORD_GUILD_ID?: string
  ALLOWED_DISCORD_GUILD_IDS?: string
  DISCORD_TOKEN?: string
}

export type ActivityFeedMessage
  = | { type: 'overview', snapshot: ActivityOverviewSnapshot | null }
    | { type: 'lobby', lobbyId: string, snapshot: LobbySnapshot | null }
    | { type: 'error', message: string }

interface PublishSessionUpdateRequest {
  record?: SessionRecord
}

interface ActivityConnectionState {
  guildId: string
}

const ACTIVITY_OVERVIEW_STORAGE_KEY = 'activity-overview-snapshot'
const ACTIVITY_LAUNCH_TARGET_STORAGE_KEY = 'activity-launch-target'
const ACTIVITY_FOLLOW_TARGET_STORAGE_KEY = 'activity-follow-target'
const SOCKET_GUILD_RECHECK_INTERVAL_MS = 60 * 1000

export class Activity extends Server<ActivityFeedEnv> {
  static override options = {
    hibernate: true,
  }

  override async onRequest(req: Request): Promise<Response> {
    if (!isAuthorizedInternalRequest(req.headers, this.env.CIVUP_SECRET)) return json({ error: 'Unauthorized' }, 401)

    const pathname = new URL(req.url).pathname
    if (pathname === '/activity-launch-target') return this.handleActivityLaunchTargetRequest(req)
    if (pathname === '/activity-follow-target') return this.handleActivityFollowTargetRequest(req)
    if (pathname.endsWith('/rebuild') || pathname === '/rebuild') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      const overview = await this.rebuildOverviewSnapshot(ACTIVITY_FEED_ROOM)
      this.broadcastFeedMessage(Array.from(this.getConnections()), { type: 'overview', snapshot: overview })
      return json({ ok: true })
    }

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

    const guildId = readActivityGuildId(ctx.request.headers)
    if (!guildId || !isAllowedActivityGuild(guildId, this.env)) {
      connection.close(4403, 'Forbidden')
      return
    }

    connection.setState({ guildId } satisfies ActivityConnectionState)
    await this.sendInitialState(connection, readActivityChannelId(ctx.request))
    await this.rescheduleSocketGuildRecheck()
  }

  override async onAlarm(): Promise<void> {
    const closedConnections = this.closeUnsupportedConnections()
    if (closedConnections > 0) {
      try {
        const cached = await this.ctx.storage.get<ActivityOverviewSnapshot | null>(ACTIVITY_OVERVIEW_STORAGE_KEY)
        const overview = await this.rebuildOverviewSnapshot(cached?.channelId ?? ACTIVITY_FEED_ROOM)
        this.broadcastFeedMessage(Array.from(this.getConnections()), { type: 'overview', snapshot: overview })
      }
      catch (error) {
        console.error('[activity-feed] failed to rebuild overview after supported-server change', error)
      }
    }
    await this.rescheduleSocketGuildRecheck()
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
    if (!isAllowedActivityGuild(record.guildId, this.env)) return
    const connections = Array.from(this.getConnections())
    if (connections.length === 0) return

    const baseOverview = await this.getOverviewSnapshot(ACTIVITY_FEED_ROOM)
    const overview = mergeActivityOverviewSnapshotForSessionUpdate(baseOverview, record)
    await this.ctx.storage.put(ACTIVITY_OVERVIEW_STORAGE_KEY, overview)
    this.broadcastFeedMessage(connections, { type: 'overview', snapshot: overview })
    this.broadcastFeedMessage(connections, await this.buildLobbyFeedMessage(record))
  }

  private async buildLobbyFeedMessage(record: SessionRecord): Promise<ActivityFeedMessage> {
    if (record.phase !== 'open') return { type: 'lobby', lobbyId: record.id, snapshot: null }
    if (!this.env.KV) return { type: 'error', message: 'Activity lobby snapshots are not configured' }
    const snapshot = await buildLobbySnapshotFromSessionRecord(this.env.KV, record, undefined, undefined, { legacyGuildId: this.env.ALLOWED_DISCORD_GUILD_ID })
    return {
      type: 'lobby',
      lobbyId: record.id,
      snapshot: this.env.DB ? await attachTournamentLobbySnapshot(createDb(this.env.DB), snapshot) : snapshot,
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
    const guildConfig = resolveApprovedDiscordGuildConfiguration(this.env)
    if (!guildConfig.ok) return null
    const supportedServers = await this.loadSupportedServers(guildConfig.guildIds)
    return buildActivityOverviewSnapshotFromDirectory(createDb(this.env.DB), channelId, {
      guildIds: guildConfig.guildIds,
      sharedFeed: true,
      supportedServers,
    })
  }

  private async loadSupportedServers(guildIds: readonly string[]): Promise<ActivitySupportedServerSnapshot[]> {
    if (!this.env.KV) return guildIds.map(id => ({ id, name: null, iconUrl: null }))
    const identities = await getKnownGuildIdentities(this.env.KV, this.env.DISCORD_TOKEN, guildIds)
    const byId = new Map(identities.map(identity => [identity.id, identity]))
    return guildIds.map((id) => {
      const identity = byId.get(id)
      return { id, name: identity?.name ?? null, iconUrl: identity?.iconUrl ?? null }
    })
  }

  private send(connection: Connection, message: ActivityFeedMessage): void {
    sendConnectionMessage(connection, JSON.stringify(message))
  }

  private broadcastFeedMessage(connections: readonly Connection[], message: ActivityFeedMessage): void {
    const encoded = JSON.stringify(message)
    for (const connection of connections) {
      if (!this.isAllowedConnection(connection)) {
        if (connection.readyState < 2) connection.close(4403, 'Forbidden')
        continue
      }
      sendConnectionMessage(connection, encoded)
    }
  }

  private closeUnsupportedConnections(): number {
    let closed = 0
    for (const connection of this.getConnections()) {
      if (this.isAllowedConnection(connection)) continue
      connection.close(4403, 'Forbidden')
      closed += 1
    }
    return closed
  }

  private isAllowedConnection(connection: Connection): boolean {
    const state = connection.state as ActivityConnectionState | null
    return isAllowedActivityGuild(state?.guildId ?? null, this.env)
  }

  private async rescheduleSocketGuildRecheck(): Promise<void> {
    const storage = this.ctx.storage as DurableObjectStorage & {
      setAlarm?: (scheduledTime: number | Date) => Promise<void>
      deleteAlarm?: () => Promise<void>
    }
    const hasConnections = Array.from(this.getConnections()).some(connection => connection.readyState < 2)
    if (!hasConnections) {
      if (typeof storage.deleteAlarm === 'function') await storage.deleteAlarm()
      return
    }
    if (typeof storage.setAlarm === 'function') await storage.setAlarm(Date.now() + SOCKET_GUILD_RECHECK_INTERVAL_MS)
  }
}

function isAllowedActivityGuild(sessionGuildId: string | null, env: ActivityFeedEnv): boolean {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  return config.ok && sessionGuildId != null && config.guildIds.includes(sessionGuildId)
}

function sendConnectionMessage(connection: Connection, message: string): boolean {
  if (connection.readyState >= 2) return false

  try {
    connection.send(message)
    return true
  }
  catch (error) {
    if (error instanceof Error && error.message.includes("Can't call WebSocket send() after close")) return false
    throw error
  }
}

function readActivityUserId(headers: Headers): string | null {
  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  return userId.length > 0 ? userId : null
}

function readActivityGuildId(headers: Headers): string | null {
  const guildId = headers.get(CIVUP_ACTIVITY_GUILD_ID_HEADER)?.trim() ?? ''
  return guildId.length > 0 ? guildId : null
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
