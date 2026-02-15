import { Server } from 'partyserver'
import type { Connection, WSMessage } from 'partyserver'

interface StateStoreEnv extends Cloudflare.Env {
  CIVUP_SECRET?: string
}

interface StoredValue {
  value: string
  expiresAt: number | null
}

interface StateConnectionState {
  keySubscriptions: readonly string[]
  prefixSubscriptions: readonly string[]
}

type StateKvRequest
  = | {
    op: 'get'
    key: string
    type?: 'json'
  }
    | {
      op: 'put'
      key: string
      value: string
      expirationTtl?: number
    }
    | {
      op: 'delete'
      key: string
    }
    | {
      op: 'list'
      prefix?: string
    }

type StateSocketRequest
  = | {
    type: 'subscribe-key'
    key: string
  }
    | {
      type: 'subscribe-prefix'
      prefix: string
    }
    | {
      type: 'unsubscribe-key'
      key: string
    }
    | {
      type: 'unsubscribe-prefix'
      prefix: string
    }

type StateSocketResponse
  = | {
    type: 'state-changed'
    key: string
    op: 'put' | 'delete'
  }
    | {
      type: 'error'
      message: string
    }

const STORAGE_PREFIX = 'kv:'
const ALLOWED_SUBSCRIPTION_KEY_PREFIXES = ['activity:', 'activity-user:']
const ALLOWED_SUBSCRIPTION_PREFIXES = ['lobby:mode:']

export class State extends Server<StateStoreEnv> {
  static override options = {
    hibernate: true,
  }

  override async onRequest(req: Request): Promise<Response> {
    if (!isAuthorizedRequest(req, this.env.CIVUP_SECRET)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    let payload: StateKvRequest
    try {
      payload = await req.json<StateKvRequest>()
    }
    catch {
      return json({ error: 'Invalid JSON payload' }, 400)
    }

    switch (payload.op) {
      case 'get': {
        if (!isValidKey(payload.key)) return json({ error: 'Invalid key' }, 400)
        const value = await this.getValue(payload.key, payload.type)
        return json({ value })
      }

      case 'put': {
        if (!isValidKey(payload.key)) return json({ error: 'Invalid key' }, 400)
        if (typeof payload.value !== 'string') return json({ error: 'Invalid value' }, 400)

        const ttlSeconds = normalizeTtlSeconds(payload.expirationTtl)
        const existing = await this.ctx.storage.get<StoredValue>(storageKey(payload.key))
        const previous = await this.ensureFreshValue(payload.key, existing)
        await this.putValue(payload.key, payload.value, ttlSeconds)
        if (!previous || previous.value !== payload.value) {
          this.broadcastStateChanged(payload.key, 'put')
        }
        return json({ ok: true })
      }

      case 'delete': {
        if (!isValidKey(payload.key)) return json({ error: 'Invalid key' }, 400)
        const existing = await this.ctx.storage.get<StoredValue>(storageKey(payload.key))
        const previous = await this.ensureFreshValue(payload.key, existing)
        await this.ctx.storage.delete(storageKey(payload.key))
        if (previous) {
          this.broadcastStateChanged(payload.key, 'delete')
        }
        return json({ ok: true })
      }

      case 'list': {
        const prefix = typeof payload.prefix === 'string' ? payload.prefix : ''
        if (!isValidPrefix(prefix)) return json({ error: 'Invalid prefix' }, 400)
        const result = await this.listValues(prefix)
        return json(result)
      }

      default:
        return json({ error: 'Unknown operation' }, 400)
    }
  }

  override async onConnect(connection: Connection<StateConnectionState>): Promise<void> {
    connection.setState({
      keySubscriptions: [],
      prefixSubscriptions: [],
    })
  }

  override async onMessage(connection: Connection<StateConnectionState>, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return

    let payload: StateSocketRequest
    try {
      payload = JSON.parse(message) as StateSocketRequest
    }
    catch {
      this.sendSocketMessage(connection, { type: 'error', message: 'Invalid JSON payload' })
      return
    }

    const state = connection.state ?? { keySubscriptions: [], prefixSubscriptions: [] }

    switch (payload.type) {
      case 'subscribe-key': {
        if (!isValidKey(payload.key)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Invalid key' })
          return
        }
        if (!isAllowedSubscriptionKey(payload.key)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Forbidden subscription key' })
          return
        }
        if (state.keySubscriptions.includes(payload.key)) return
        connection.setState({
          keySubscriptions: [...state.keySubscriptions, payload.key],
          prefixSubscriptions: state.prefixSubscriptions,
        })
        return
      }

      case 'subscribe-prefix': {
        if (!isValidPrefix(payload.prefix)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Invalid prefix' })
          return
        }
        if (!isAllowedSubscriptionPrefix(payload.prefix)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Forbidden subscription prefix' })
          return
        }
        if (state.prefixSubscriptions.includes(payload.prefix)) return
        connection.setState({
          keySubscriptions: state.keySubscriptions,
          prefixSubscriptions: [...state.prefixSubscriptions, payload.prefix],
        })
        return
      }

      case 'unsubscribe-key': {
        if (!isValidKey(payload.key)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Invalid key' })
          return
        }
        connection.setState({
          keySubscriptions: state.keySubscriptions.filter(key => key !== payload.key),
          prefixSubscriptions: state.prefixSubscriptions,
        })
        return
      }

      case 'unsubscribe-prefix': {
        if (!isValidPrefix(payload.prefix)) {
          this.sendSocketMessage(connection, { type: 'error', message: 'Invalid prefix' })
          return
        }
        connection.setState({
          keySubscriptions: state.keySubscriptions,
          prefixSubscriptions: state.prefixSubscriptions.filter(prefix => prefix !== payload.prefix),
        })
        return
      }

      default:
        this.sendSocketMessage(connection, { type: 'error', message: 'Unknown socket message type' })
    }
  }

  private async getValue(key: string, type?: 'json'): Promise<unknown> {
    const stored = await this.ctx.storage.get<StoredValue>(storageKey(key))
    const valid = await this.ensureFreshValue(key, stored)
    if (!valid) return null

    if (type === 'json') {
      try {
        return JSON.parse(valid.value)
      }
      catch {
        return null
      }
    }

    return valid.value
  }

  private async putValue(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const now = Date.now()
    const expiresAt = ttlSeconds == null ? null : now + ttlSeconds * 1000
    const stored: StoredValue = {
      value,
      expiresAt,
    }
    await this.ctx.storage.put(storageKey(key), stored)
  }

  private async listValues(prefix: string): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor: string
  }> {
    const keys: { name: string }[] = []
    const entries = await this.ctx.storage.list<StoredValue>({ prefix: storageKey(prefix) })

    for (const [fullKey, stored] of entries.entries()) {
      const userKey = fullKey.slice(STORAGE_PREFIX.length)
      const valid = await this.ensureFreshValue(userKey, stored)
      if (!valid) continue
      keys.push({ name: userKey })
    }

    return {
      keys,
      list_complete: true,
      cursor: '',
    }
  }

  private async ensureFreshValue(key: string, stored: unknown): Promise<StoredValue | null> {
    if (!isStoredValue(stored)) {
      if (stored != null) await this.ctx.storage.delete(storageKey(key))
      return null
    }

    if (stored.expiresAt != null && stored.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(storageKey(key))
      return null
    }

    return stored
  }

  private broadcastStateChanged(key: string, op: 'put' | 'delete'): void {
    for (const connection of this.getConnections<StateConnectionState>()) {
      const state = connection.state
      if (!state) continue

      if (!state.keySubscriptions.includes(key)
        && !state.prefixSubscriptions.some(prefix => key.startsWith(prefix))) {
        continue
      }

      this.sendSocketMessage(connection, { type: 'state-changed', key, op })
    }
  }

  private sendSocketMessage(connection: Connection, message: StateSocketResponse): void {
    connection.send(JSON.stringify(message))
  }
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

function isAuthorizedRequest(req: Request, expectedSecret: string | undefined): boolean {
  if (!expectedSecret || expectedSecret.trim().length === 0) return true
  const providedSecret = req.headers.get('X-CivUp-State-Secret')
  return providedSecret === expectedSecret
}

function isValidKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 512
}

function isValidPrefix(prefix: string): boolean {
  return prefix.length <= 512
}

function normalizeTtlSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

function isAllowedSubscriptionKey(key: string): boolean {
  return ALLOWED_SUBSCRIPTION_KEY_PREFIXES.some(prefix => key.startsWith(prefix))
}

function isAllowedSubscriptionPrefix(prefix: string): boolean {
  return ALLOWED_SUBSCRIPTION_PREFIXES.includes(prefix)
}

function isStoredValue(value: unknown): value is StoredValue {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredValue>
  if (typeof candidate.value !== 'string') return false
  if (candidate.expiresAt === null || candidate.expiresAt === undefined) return true
  return typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
