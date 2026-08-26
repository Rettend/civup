import type { Database as SqliteDatabase } from 'bun:sqlite'
import type { Env } from '../../src/env.ts'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerUploadRoutes } from '../../src/routes/uploads.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'player-data-export-test-secret'
const GUILD_ID = '1234044388733095946'
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const openDatabases: SqliteDatabase[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('player data export download', () => {
  test('requires a server administrator before storing a workbook', async () => {
    const harness = await createHarness()

    const unauthenticated = await harness.request('POST', undefined, 'xlsx')
    expect(unauthenticated.status).toBe(401)

    const forbidden = await harness.request('POST', '0', 'xlsx')
    expect(forbidden.status).toBe(403)
    expect(harness.bucket.putCount).toBe(0)
  })

  test('stores only the latest workbook per administrator and streams it externally', async () => {
    const harness = await createHarness()
    const first = await harness.request('POST', '32', 'first-workbook', 'admin-one', 'admin-one-old.xlsx')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, filename: 'admin-one-old.xlsx', size: 14 })

    const second = await harness.request('POST', '32', 'second-workbook', 'admin-one', 'admin-one-latest.xlsx')
    expect(second.status).toBe(200)
    const otherAdmin = await harness.request('POST', '32', 'other-workbook', 'admin-two', 'admin-two-latest.xlsx')
    expect(otherAdmin.status).toBe(200)
    expect(harness.bucket.putCount).toBe(3)
    expect(new Set(harness.bucket.keys())).toEqual(new Set([
      'player-data-exports/admin-one/latest.xlsx',
      'player-data-exports/admin-two/latest.xlsx',
    ]))

    const firstAdminDownload = await harness.request('GET', '32', undefined, 'admin-one')
    expect(firstAdminDownload.status).toBe(200)
    expect(firstAdminDownload.headers.get('Content-Type')).toBe(CONTENT_TYPE)
    expect(firstAdminDownload.headers.get('Content-Disposition')).toContain('admin-one-latest.xlsx')
    expect(firstAdminDownload.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await firstAdminDownload.text()).toBe('second-workbook')

    const secondAdminDownload = await harness.request('GET', '32', undefined, 'admin-two')
    expect(secondAdminDownload.status).toBe(200)
    expect(secondAdminDownload.headers.get('Content-Disposition')).toContain('admin-two-latest.xlsx')
    expect(await secondAdminDownload.text()).toBe('other-workbook')
  })

  test('reports unavailable storage without accepting the workbook', async () => {
    const harness = await createHarness(false)
    const response = await harness.request('POST', '8', 'xlsx')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Data exports are not configured' })
  })
})

async function createHarness(withBucket = true) {
  const { sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const app = new Hono<Env>()
  registerUploadRoutes(app)
  const bucket = new ExportBucketMock()
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: createTestKv(),
    AUTOSAVE_UPLOADS: withBucket ? bucket as unknown as R2Bucket : undefined,
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
  }

  return {
    bucket,
    request(method: 'GET' | 'POST', permissions?: string, body?: string, userId = 'admin-user', filename = 'export-2026-07-15.xlsx') {
      const url = method === 'POST'
        ? `https://bot.test/api/uploads/player-data-export?filename=${encodeURIComponent(filename)}`
        : 'https://bot.test/api/uploads/player-data-export/download'
      const headers = new Headers()
      if (permissions !== undefined) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, userId)
        headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, GUILD_ID)
        headers.set(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER, permissions)
      }
      if (method === 'POST') headers.set('Content-Type', CONTENT_TYPE)
      return app.fetch(new Request(url, { method, headers, body: method === 'POST' ? body : undefined }), env)
    },
  }
}

interface StoredExport {
  bytes: Uint8Array
  contentType: string
  filename: string
}

class ExportBucketMock {
  private readonly objects = new Map<string, StoredExport>()
  putCount = 0

  keys(): string[] {
    return [...this.objects.keys()]
  }

  async put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object> {
    this.putCount += 1
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer())
    const stored = {
      bytes,
      contentType: options?.httpMetadata && 'contentType' in options.httpMetadata
        ? options.httpMetadata.contentType ?? CONTENT_TYPE
        : CONTENT_TYPE,
      filename: options?.customMetadata?.filename ?? 'export.xlsx',
    }
    this.objects.set(key, stored)
    return this.object(key, stored)
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key)
    if (!stored) return null
    const object = this.object(key, stored)
    return {
      ...object,
      body: new Blob([stored.bytes]).stream(),
      async arrayBuffer() {
        return stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength)
      },
    } as R2ObjectBody
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  private object(key: string, stored: StoredExport): R2Object {
    return {
      key,
      size: stored.bytes.byteLength,
      etag: 'export-etag',
      httpEtag: '"export-etag"',
      uploaded: new Date('2026-07-15T00:00:00.000Z'),
      customMetadata: { filename: stored.filename },
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', stored.contentType)
      },
    } as R2Object
  }
}
