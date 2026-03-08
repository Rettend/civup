export interface StateCoordinatorHarness {
  host: string
  secret: string
  requests: () => number
  sqliteRowsRead: () => number
  sqliteRowsWritten: () => number
  restore: () => void
}

export function installStateCoordinatorHarness(): StateCoordinatorHarness {
  const host = 'https://state-coordinator.test'
  const secret = 'capacity-test-secret'
  const storage = new Map<string, { value: string, expiresAt: number | null }>()
  let requestCount = 0
  let sqliteRowsRead = 0
  let sqliteRowsWritten = 0

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url)

    if (requestUrl.origin !== host || requestUrl.pathname !== '/parties/state/global') {
      return originalFetch(input as any, init)
    }

    requestCount += 1
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const providedSecret = resolveHeader(init?.headers, 'X-CivUp-State-Secret')
    if (providedSecret !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const rawBody = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.text()
        : ''

    let payload: {
      op?: string
      key?: unknown
      type?: unknown
      value?: unknown
      expirationTtl?: unknown
      prefix?: unknown
      entries?: unknown
      keys?: unknown
    }
    try {
      payload = JSON.parse(rawBody) as typeof payload
    }
    catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const readValue = (key: string, type?: unknown): unknown => {
      const hadStored = storage.has(key)
      if (hadStored) sqliteRowsRead += 1
      const value = getValue(storage, key)
      if (hadStored && !storage.has(key)) sqliteRowsWritten += 1

      if (value == null) return null
      if (type === 'json') {
        try {
          return JSON.parse(value)
        }
        catch {
          return null
        }
      }

      return value
    }

    const writeValue = (key: string, value: string, expirationTtl: unknown): void => {
      const hadStored = storage.has(key)
      if (hadStored) sqliteRowsRead += 1
      getValue(storage, key)
      if (hadStored && !storage.has(key)) sqliteRowsWritten += 1

      const ttlSeconds = typeof expirationTtl === 'number' && Number.isFinite(expirationTtl)
        ? Math.max(0, Math.round(expirationTtl))
        : 0
      const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
      storage.set(key, { value, expiresAt })
      sqliteRowsWritten += 1
    }

    const deleteValue = (key: string): void => {
      const hadStored = storage.has(key)
      if (hadStored) sqliteRowsRead += 1
      getValue(storage, key)
      if (hadStored && !storage.has(key)) sqliteRowsWritten += 1
      if (storage.delete(key)) sqliteRowsWritten += 1
    }

    if (payload.op === 'get') {
      const key = typeof payload.key === 'string' ? payload.key : null
      if (!key) return jsonError('Invalid key')
      return jsonResponse({ value: readValue(key, payload.type) })
    }

    if (payload.op === 'put') {
      const key = typeof payload.key === 'string' ? payload.key : null
      const value = typeof payload.value === 'string' ? payload.value : null
      if (!key) return jsonError('Invalid key')
      if (value == null) return jsonError('Invalid value')

      writeValue(key, value, payload.expirationTtl)
      return jsonResponse({ ok: true })
    }

    if (payload.op === 'delete') {
      const key = typeof payload.key === 'string' ? payload.key : null
      if (!key) return jsonError('Invalid key')

      deleteValue(key)
      return jsonResponse({ ok: true })
    }

    if (payload.op === 'mget') {
      if (!Array.isArray(payload.entries)) return jsonError('Invalid entries')

      const values: unknown[] = []
      for (const rawEntry of payload.entries) {
        if (!rawEntry || typeof rawEntry !== 'object') return jsonError('Invalid entry')
        const entry = rawEntry as { key?: unknown, type?: unknown }
        const key = typeof entry.key === 'string' ? entry.key : null
        if (!key) return jsonError('Invalid key')
        values.push(readValue(key, entry.type))
      }

      return jsonResponse({ values })
    }

    if (payload.op === 'mput') {
      if (!Array.isArray(payload.entries)) return jsonError('Invalid entries')

      for (const rawEntry of payload.entries) {
        if (!rawEntry || typeof rawEntry !== 'object') return jsonError('Invalid entry')
        const entry = rawEntry as { key?: unknown, value?: unknown, expirationTtl?: unknown }
        const key = typeof entry.key === 'string' ? entry.key : null
        const value = typeof entry.value === 'string' ? entry.value : null
        if (!key) return jsonError('Invalid key')
        if (value == null) return jsonError('Invalid value')
        writeValue(key, value, entry.expirationTtl)
      }

      return jsonResponse({ ok: true })
    }

    if (payload.op === 'mdelete') {
      if (!Array.isArray(payload.keys)) return jsonError('Invalid keys')

      for (const rawKey of payload.keys) {
        const key = typeof rawKey === 'string' ? rawKey : null
        if (!key) return jsonError('Invalid key')
        deleteValue(key)
      }

      return jsonResponse({ ok: true })
    }

    if (payload.op === 'list') {
      const prefix = typeof payload.prefix === 'string' ? payload.prefix : ''
      const keys: { name: string }[] = []
      for (const key of [...storage.keys()]) {
        if (!key.startsWith(prefix)) continue

        const value = readValue(key)
        if (value == null) continue
        keys.push({ name: key })
      }
      return jsonResponse({
        keys,
        list_complete: true,
        cursor: '',
      })
    }

    return jsonError('Unknown operation')
  }) as unknown as typeof fetch

  return {
    host,
    secret,
    requests: () => requestCount,
    sqliteRowsRead: () => sqliteRowsRead,
    sqliteRowsWritten: () => sqliteRowsWritten,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function resolveHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null

  const target = name.toLowerCase()
  if (headers instanceof Headers) {
    return headers.get(name)
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([headerName]) => headerName.toLowerCase() === target)
    return entry?.[1] ?? null
  }

  const record = headers as Record<string, string | string[] | undefined>
  const value = record[name] ?? record[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

function getValue(storage: Map<string, { value: string, expiresAt: number | null }>, key: string): string | null {
  const stored = storage.get(key)
  if (!stored) return null
  if (stored.expiresAt != null && stored.expiresAt <= Date.now()) {
    storage.delete(key)
    return null
  }
  return stored.value
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}
