import { CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'

interface StateStoreEnv {
  KV: KVNamespace
  State?: DurableObjectNamespace
  CIVUP_SECRET?: string
}

interface StateKvGetRequest {
  op: 'get'
  key: string
  type?: 'json'
}

interface StateKvPutRequest {
  op: 'put'
  key: string
  value: string
  expirationTtl?: number
}

interface StateKvPutIfAbsentRequest {
  op: 'putIfAbsent'
  key: string
  value: string
  expirationTtl?: number
}

interface StateKvDeleteRequest {
  op: 'delete'
  key: string
}

interface StateKvListRequest {
  op: 'list'
  prefix?: string
}

export interface StateStoreBatchGetEntry {
  key: string
  type?: 'json'
}

export interface StateStoreBatchPutEntry {
  key: string
  value: string
  expirationTtl?: number
}

interface StateKvMgetRequest {
  op: 'mget'
  entries: StateStoreBatchGetEntry[]
}

interface StateKvMputRequest {
  op: 'mput'
  entries: StateStoreBatchPutEntry[]
}

interface StateKvMdeleteRequest {
  op: 'mdelete'
  keys: string[]
}

type StateKvRequest
  = | StateKvGetRequest
    | StateKvPutRequest
    | StateKvPutIfAbsentRequest
    | StateKvDeleteRequest
    | StateKvListRequest
    | StateKvMgetRequest
    | StateKvMputRequest
    | StateKvMdeleteRequest

interface StateKvResponseGet {
  value: unknown
}

interface StateKvResponseList {
  keys: { name: string }[]
  list_complete: boolean
  cursor: string
}

interface StateKvResponseMget {
  values: unknown[]
}

interface StateKvResponsePutIfAbsent {
  inserted: boolean
}

interface StateStoreBatchCapableKv extends KVNamespace {
  mget?: (entries: StateStoreBatchGetEntry[]) => Promise<unknown[]>
  mput?: (entries: StateStoreBatchPutEntry[]) => Promise<void>
  mdelete?: (keys: string[]) => Promise<void>
  putIfAbsent?: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<boolean>
}

const STATE_ROOM_NAME = 'global'
const HOT_KEY_PREFIXES = [
  'leaderboard:snapshot:',
  'queue:',
  'player-queue:',
  'lobby:id:',
  'lobby:mode:',
  'lobby:channel:',
  'lobby:match:',
  'lobby:host:',
  'lobby:start-lock:',
  'lobby:bump:',
  'lobby:snapshot:',
  'activity:',
  'activity-match:',
  'activity-user:',
  'activity-lobby-user:',
  'activity-target-user:',
  'activity-target-match:',
  'activity-target-lobby:',
]

export function createStateStore(env: StateStoreEnv): KVNamespace {
  if (!env.State) return env.KV

  const secret = env.CIVUP_SECRET?.trim() ?? ''
  const stateStub = env.State.get(env.State.idFromName(STATE_ROOM_NAME))

  const store = {
    async get(key: string, type?: string) {
      if (!shouldRouteHotKey(key)) {
        return env.KV.get(key, type as any)
      }

      const response = await stateKvRequest<StateKvResponseGet>(stateStub, secret, {
        op: 'get',
        key,
        type: type === 'json' ? 'json' : undefined,
      })
      return response.value as any
    },

    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      if (!shouldRouteHotKey(key)) {
        await env.KV.put(key, value, options as any)
        return
      }

      await stateKvRequest(stateStub, secret, {
        op: 'put',
        key,
        value,
        expirationTtl: options?.expirationTtl,
      })
    },

    async putIfAbsent(key: string, value: string, options?: { expirationTtl?: number }) {
      if (!shouldRouteHotKey(key)) {
        const existing = await env.KV.get(key)
        if (existing != null) return false
        await env.KV.put(key, value, options as any)
        return true
      }

      const response = await stateKvRequest<StateKvResponsePutIfAbsent>(stateStub, secret, {
        op: 'putIfAbsent',
        key,
        value,
        expirationTtl: options?.expirationTtl,
      })
      return response.inserted
    },

    async delete(key: string) {
      if (!shouldRouteHotKey(key)) {
        await env.KV.delete(key)
        return
      }

      await stateKvRequest(stateStub, secret, {
        op: 'delete',
        key,
      })
    },

    async list(options?: KVNamespaceListOptions) {
      const prefix = options?.prefix ?? undefined
      if (!shouldRouteHotPrefix(prefix)) {
        return env.KV.list(options as any)
      }

      const response = await stateKvRequest<StateKvResponseList>(stateStub, secret, {
        op: 'list',
        prefix,
      })

      return {
        keys: response.keys,
        list_complete: response.list_complete,
        cursor: response.cursor,
      } as KVNamespaceListResult<unknown, string>
    },

    async mget(entries: StateStoreBatchGetEntry[]) {
      if (entries.length === 0) return []

      const values: unknown[] = Array.from({ length: entries.length }, () => null)
      const hotEntries: Array<{ index: number, entry: StateStoreBatchGetEntry }> = []
      const coldReads: Promise<void>[] = []

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (!entry) continue

        if (shouldRouteHotKey(entry.key)) {
          hotEntries.push({ index, entry })
          continue
        }

        coldReads.push((async () => {
          values[index] = await env.KV.get(entry.key, entry.type as any)
        })())
      }

      if (hotEntries.length > 0) {
          const response = await stateKvRequest<StateKvResponseMget>(stateStub, secret, {
            op: 'mget',
            entries: hotEntries.map(({ entry }) => ({
              key: entry.key,
              type: entry.type,
            })),
          })

        for (let index = 0; index < hotEntries.length; index++) {
          const hotEntry = hotEntries[index]
          if (!hotEntry) continue
          values[hotEntry.index] = response.values[index] ?? null
        }
      }

      if (coldReads.length > 0) {
        await Promise.all(coldReads)
      }

      return values
    },

    async mput(entries: StateStoreBatchPutEntry[]) {
      if (entries.length === 0) return

      const hotEntries: StateStoreBatchPutEntry[] = []
      const coldWrites: Promise<void>[] = []

      for (const entry of entries) {
        if (!entry) continue

        if (shouldRouteHotKey(entry.key)) {
          hotEntries.push(entry)
          continue
        }

        coldWrites.push(env.KV.put(entry.key, entry.value, { expirationTtl: entry.expirationTtl } as any))
      }

      if (hotEntries.length > 0) {
        await stateKvRequest(stateStub, secret, {
          op: 'mput',
          entries: hotEntries,
        })
      }

      if (coldWrites.length > 0) {
        await Promise.all(coldWrites)
      }
    },

    async mdelete(keys: string[]) {
      if (keys.length === 0) return

      const hotKeys: string[] = []
      const coldDeletes: Promise<void>[] = []

      for (const key of keys) {
        if (!key) continue

        if (shouldRouteHotKey(key)) {
          hotKeys.push(key)
          continue
        }

        coldDeletes.push(env.KV.delete(key))
      }

      if (hotKeys.length > 0) {
        await stateKvRequest(stateStub, secret, {
          op: 'mdelete',
          keys: hotKeys,
        })
      }

      if (coldDeletes.length > 0) {
        await Promise.all(coldDeletes)
      }
    },
  }

  return store as unknown as KVNamespace
}

export async function stateStoreMget(kv: KVNamespace, entries: StateStoreBatchGetEntry[]): Promise<unknown[]> {
  if (entries.length === 0) return []
  const batchKv = kv as StateStoreBatchCapableKv
  if (typeof batchKv.mget === 'function') {
    return batchKv.mget(entries)
  }

  return Promise.all(entries.map(entry => kv.get(entry.key, entry.type as any)))
}

export async function stateStoreMput(kv: KVNamespace, entries: StateStoreBatchPutEntry[]): Promise<void> {
  if (entries.length === 0) return
  const batchKv = kv as StateStoreBatchCapableKv
  if (typeof batchKv.mput === 'function') {
    await batchKv.mput(entries)
    return
  }

  await Promise.all(entries.map(entry => kv.put(entry.key, entry.value, { expirationTtl: entry.expirationTtl } as any)))
}

export async function stateStoreMdelete(kv: KVNamespace, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const batchKv = kv as StateStoreBatchCapableKv
  if (typeof batchKv.mdelete === 'function') {
    await batchKv.mdelete(keys)
    return
  }

  await Promise.all(keys.map(key => kv.delete(key)))
}

export async function stateStorePutIfAbsent(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: { expirationTtl?: number },
): Promise<boolean> {
  const batchKv = kv as StateStoreBatchCapableKv
  if (typeof batchKv.putIfAbsent === 'function') {
    return batchKv.putIfAbsent(key, value, options)
  }

  const existing = await kv.get(key)
  if (existing != null) return false
  await kv.put(key, value, options as any)
  return true
}

class StateStoreRequestError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`State store request failed (${status}): ${detail}`)
    this.name = 'StateStoreRequestError'
  }
}

function shouldRouteHotKey(key: string): boolean {
  return HOT_KEY_PREFIXES.some(prefix => key.startsWith(prefix))
}

function shouldRouteHotPrefix(prefix: string | undefined | null): boolean {
  if (!prefix) return false
  return HOT_KEY_PREFIXES.some(hotPrefix => prefix.startsWith(hotPrefix) || hotPrefix.startsWith(prefix))
}

async function stateKvRequest<T = unknown>(
  stateStub: DurableObjectStub,
  secret: string,
  payload: StateKvRequest,
): Promise<T> {
  const response = await stateStub.fetch(new Request(`https://civup-bot.internal/parties/state/${STATE_ROOM_NAME}`, {
    method: 'POST',
    headers: buildStateStoreHeaders(secret),
    body: JSON.stringify(payload),
  }))

  if (!response.ok) {
    const detail = await response.text()
    throw new StateStoreRequestError(response.status, detail)
  }

  return await response.json<T>()
}

function buildStateStoreHeaders(secret: string): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-partykit-room': STATE_ROOM_NAME,
    'x-partykit-namespace': 'state',
  })
  if (secret) headers.set(CIVUP_INTERNAL_SECRET_HEADER, secret)
  return headers
}
