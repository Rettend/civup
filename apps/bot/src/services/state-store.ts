import { normalizeHost } from '@civup/utils'

interface StateStoreEnv {
  KV: KVNamespace
  PARTY_HOST?: string
  CIVUP_SECRET?: string
}

type StateKvGetRequest = {
  op: 'get'
  key: string
  type?: 'json'
}

type StateKvPutRequest = {
  op: 'put'
  key: string
  value: string
  expirationTtl?: number
}

type StateKvDeleteRequest = {
  op: 'delete'
  key: string
}

type StateKvListRequest = {
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

type StateKvMgetRequest = {
  op: 'mget'
  entries: StateStoreBatchGetEntry[]
}

type StateKvMputRequest = {
  op: 'mput'
  entries: StateStoreBatchPutEntry[]
}

type StateKvMdeleteRequest = {
  op: 'mdelete'
  keys: string[]
}

type StateKvRequest =
  | StateKvGetRequest
  | StateKvPutRequest
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

interface StateStoreBatchCapableKv extends KVNamespace {
  mget?: (entries: StateStoreBatchGetEntry[]) => Promise<unknown[]>
  mput?: (entries: StateStoreBatchPutEntry[]) => Promise<void>
  mdelete?: (keys: string[]) => Promise<void>
}

const DEFAULT_PARTY_HOST = 'http://localhost:1999'
const STATE_ROOM_NAME = 'global'
const HOT_KEY_PREFIXES = [
  'queue:',
  'player-queue:',
  'lobby:mode:',
  'lobby:match:',
  'activity:',
  'activity-match:',
  'activity-user:',
]

export function createStateStore(env: StateStoreEnv): KVNamespace {
  if (!env.PARTY_HOST) return env.KV

  const partyHost = normalizeHost(env.PARTY_HOST, DEFAULT_PARTY_HOST)
  const endpoint = `${partyHost}/parties/state/${STATE_ROOM_NAME}`
  const secret = env.CIVUP_SECRET?.trim() ?? ''

  const store = {
    async get(key: string, type?: string) {
      if (!shouldRouteHotKey(key)) {
        return env.KV.get(key, type as any)
      }

      const response = await stateKvRequest<StateKvResponseGet>(endpoint, secret, {
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

      await stateKvRequest(endpoint, secret, {
        op: 'put',
        key,
        value,
        expirationTtl: options?.expirationTtl,
      })
    },

    async delete(key: string) {
      if (!shouldRouteHotKey(key)) {
        await env.KV.delete(key)
        return
      }

      await stateKvRequest(endpoint, secret, {
        op: 'delete',
        key,
      })
    },

    async list(options?: KVNamespaceListOptions) {
      const prefix = options?.prefix ?? undefined
      if (!shouldRouteHotPrefix(prefix)) {
        return env.KV.list(options as any)
      }

      const response = await stateKvRequest<StateKvResponseList>(endpoint, secret, {
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
        const response = await stateKvRequest<StateKvResponseMget>(endpoint, secret, {
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
        await stateKvRequest(endpoint, secret, {
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
        await stateKvRequest(endpoint, secret, {
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
  endpoint: string,
  secret: string,
  payload: StateKvRequest,
): Promise<T> {
  const headers = new Headers({
    'Content-Type': 'application/json',
  })
  if (secret) {
    headers.set('X-CivUp-State-Secret', secret)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new StateStoreRequestError(response.status, detail)
  }

  return await response.json<T>()
}
