import { Server } from 'partyserver'

interface StateStoreEnv extends Cloudflare.Env {
  STATE_KV_SECRET?: string
}

interface StoredValue {
  value: string
  expiresAt: number | null
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

const STORAGE_PREFIX = 'kv:'

export class State extends Server<StateStoreEnv> {
  static override options = {
    hibernate: true,
  }

  override async onRequest(req: Request): Promise<Response> {
    if (!isAuthorizedRequest(req, this.env.STATE_KV_SECRET)) {
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
        await this.putValue(payload.key, payload.value, ttlSeconds)
        return json({ ok: true })
      }

      case 'delete': {
        if (!isValidKey(payload.key)) return json({ error: 'Invalid key' }, 400)
        await this.ctx.storage.delete(storageKey(payload.key))
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
