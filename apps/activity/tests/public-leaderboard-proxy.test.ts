import { CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import activityWorker from '../src/server'

const SECRET = 'public-proxy-secret'
const PRIMARY = '1234044388733095946'
const PARTNER = '2234044388733095946'
const REMOVED = '3234044388733095946'
type ActivityEnv = Parameters<typeof activityWorker.fetch>[1]

const originalCachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')

afterEach(() => {
  if (originalCachesDescriptor) Object.defineProperty(globalThis, 'caches', originalCachesDescriptor)
  else Reflect.deleteProperty(globalThis, 'caches')
})

describe('public leaderboard Activity proxy', () => {
  test('normalizes the primary server and forwards only fixed safe headers', async () => {
    const forwarded: Request[] = []
    const response = await activityWorker.fetch(new Request('https://activity.example/api/public/leaderboards', {
      headers: {
        'Accept': 'text/html',
        'Cookie': 'private=session',
        'X-CivUp-Activity-User': 'private-user',
        'X-Other': 'private',
      },
    }), createEnv(forwarded, jsonResponse({ ok: true }, 200, { ETag: 'public-v1' })))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300')
    expect(response.headers.get('ETag')).toBe('public-v1')
    expect(await response.json() as unknown).toEqual({ ok: true })
    const upstream = forwarded[0]!
    expect(new URL(upstream.url).searchParams.get('server')).toBe(PRIMARY)
    expect(upstream.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe(SECRET)
    expect(upstream.headers.get('Accept')).toBe('application/json')
    expect(upstream.headers.get('Cookie')).toBeNull()
    expect(upstream.headers.get('X-CivUp-Activity-User')).toBeNull()
    expect(upstream.headers.get('X-Other')).toBeNull()
    expect([...upstream.headers.keys()].sort()).toEqual(['accept', CIVUP_INTERNAL_SECRET_HEADER.toLowerCase()].sort())
  })

  test('rejects unsupported methods, duplicate or extra parameters, and removed servers before cache access', async () => {
    const fakeCache = new MemoryCache()
    installDefaultCache(fakeCache)
    const env = createEnv([], jsonResponse({ ok: true }))

    const method = await activityWorker.fetch(new Request('https://activity.example/api/public/leaderboards', { method: 'POST' }), env)
    const duplicate = await activityWorker.fetch(new Request(`https://activity.example/api/public/leaderboards?server=${PRIMARY}&server=${PARTNER}`), env)
    const extra = await activityWorker.fetch(new Request(`https://activity.example/api/public/leaderboards?server=${PRIMARY}&mode=duel`), env)
    const removed = await activityWorker.fetch(new Request(`https://activity.example/api/public/leaderboards?server=${REMOVED}`), env)

    expect(method.status).toBe(405)
    expect(duplicate.status).toBe(400)
    expect(extra.status).toBe(400)
    expect(removed.status).toBe(403)
    expect(removed.headers.get('Cache-Control')).toBe('no-store')
    expect(fakeCache.matchCount).toBe(0)
  })

  test('uses the optional canonical edge cache without relying on it for correctness', async () => {
    const fakeCache = new MemoryCache()
    installDefaultCache(fakeCache)
    const forwarded: Request[] = []
    const env = createEnv(forwarded, jsonResponse({ version: 1, source: 'origin' }))
    const context = createContext()
    const url = `https://activity.example/api/public/leaderboards?server=${PARTNER}`

    const first = await activityWorker.fetch(new Request(url), env, context.executionCtx)
    expect(await first.json() as unknown).toEqual({ version: 1, source: 'origin' })
    await context.flush()
    expect(forwarded).toHaveLength(1)
    expect(fakeCache.putCount).toBe(1)

    const second = await activityWorker.fetch(new Request(url), {
      ...env,
      BOT: { async fetch() { throw new Error('Origin should not be read on an edge hit') } } as unknown as Fetcher,
    })
    expect(await second.json() as unknown).toEqual({ version: 1, source: 'origin' })
    expect(fakeCache.matchCount).toBe(2)
  })

  test('streams successful origin JSON and never caches errors', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        streamController.enqueue(new TextEncoder().encode('{"chunk":'))
      },
    })
    const env = createEnv([], new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    const response = await Promise.race([
      activityWorker.fetch(new Request('https://activity.example/api/public/leaderboards'), env),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Proxy buffered the upstream body')), 100)),
    ])
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"chunk":')
    controller!.enqueue(new TextEncoder().encode('true}'))
    controller!.close()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('true}')

    const fakeCache = new MemoryCache()
    installDefaultCache(fakeCache)
    const context = createContext()
    const error = await activityWorker.fetch(new Request('https://activity.example/api/public/leaderboards'), createEnv([], jsonResponse({ error: 'upstream' }, 502)), context.executionCtx)
    expect(error.status).toBe(502)
    expect(error.headers.get('Cache-Control')).toBe('no-store')
    await context.flush()
    expect(fakeCache.putCount).toBe(0)
  })
})

function createEnv(forwarded: Request[], response: Response): ActivityEnv {
  return {
    BOT: {
      async fetch(request: Request) {
        forwarded.push(request)
        return response.clone()
      },
    } as unknown as Fetcher,
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: PRIMARY,
    ALLOWED_DISCORD_GUILD_IDS: `${PRIMARY},${PARTNER}`,
    DISCORD_CLIENT_ID: 'client',
    DISCORD_CLIENT_SECRET: 'client-secret',
  }
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  })
}

class MemoryCache {
  readonly responses = new Map<string, Response>()
  matchCount = 0
  putCount = 0

  async match(request: Request): Promise<Response | undefined> {
    this.matchCount += 1
    return this.responses.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putCount += 1
    this.responses.set(request.url, response.clone())
  }
}

function installDefaultCache(cache: MemoryCache): void {
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: cache as unknown as Cache },
  })
}

function createContext() {
  const pending: Promise<unknown>[] = []
  return {
    executionCtx: {
      waitUntil(promise: Promise<unknown>) { pending.push(promise) },
      passThroughOnException() {},
    } as ExecutionContext,
    async flush() { await Promise.all(pending) },
  }
}
