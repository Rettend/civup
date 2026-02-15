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

type StateKvRequest = StateKvGetRequest | StateKvPutRequest | StateKvDeleteRequest | StateKvListRequest

interface StateKvResponseGet {
  value: unknown
}

interface StateKvResponseList {
  keys: { name: string }[]
  list_complete: boolean
  cursor: string
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
  }

  return store as KVNamespace
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
