import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { parseAutosaveZipIndex, parseCiv6SaveMetadata, parseZipEntries, pickLatestAutosaveZipEntry, readZipEntryData } from '@civup/civ6-save-metadata'
import { autosaveUploads, createDb } from '@civup/db'
import { betaLeaderDataVersionLabel, liveLeaderDataVersionLabel } from '@civup/game'
import { desc, eq, sql } from 'drizzle-orm'
import { inflateSync } from 'fflate'
import { requireAuthenticatedActivity } from './auth.ts'

const MAX_AUTOSAVE_UPLOAD_BYTES = 100 * 1024 * 1024
const UPLOAD_FILE_NAME_HEADER = 'x-civup-upload-filename'
const UPLOAD_CHANNEL_ID_HEADER = 'x-civup-upload-channel-id'
const UPLOAD_MATCH_ID_HEADER = 'x-civup-upload-match-id'
const DEFAULT_AUTOSAVE_ADMIN_USER_IDS = new Set(['361534796830081024'])

interface AutosaveUploadCatalogRow {
  id: string
  uploadedAt: number
  uploaderUserId: string
  uploaderDisplayName: string | null
  channelId: string | null
  matchId: string | null
  fileName: string
  fileSizeBytes: number
  etag: string | null
  status: string
  downloadCount: number
  parseStatus: string
  parseError: string | null
  saveCount: number | null
  maxTurn: number | null
  latestSaveName: string | null
  playerCount: number | null
  gameMode: string | null
  leadersJson: string | null
  civsJson: string | null
  playersJson: string | null
  mapFile: string | null
  modsJson: string | null
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
  notes: string | null
}

export function registerUploadRoutes(app: Hono<Env>) {
  app.get('/api/uploads/autosaves', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!isAutosaveAdmin(c.env, auth.identity.userId)) return c.json({ error: 'Forbidden' }, 403)

    const uploads: AutosaveUploadCatalogRow[] = await createDb(c.env.DB)
      .select({
        id: autosaveUploads.id,
        uploadedAt: autosaveUploads.uploadedAt,
        uploaderUserId: autosaveUploads.uploaderUserId,
        uploaderDisplayName: autosaveUploads.uploaderDisplayName,
        channelId: autosaveUploads.channelId,
        matchId: autosaveUploads.matchId,
        fileName: autosaveUploads.fileName,
        fileSizeBytes: autosaveUploads.fileSizeBytes,
        etag: autosaveUploads.etag,
        status: autosaveUploads.status,
        downloadCount: autosaveUploads.downloadCount,
        parseStatus: autosaveUploads.parseStatus,
        parseError: autosaveUploads.parseError,
        saveCount: autosaveUploads.saveCount,
        maxTurn: autosaveUploads.maxTurn,
        latestSaveName: autosaveUploads.latestSaveName,
        playerCount: autosaveUploads.playerCount,
        gameMode: autosaveUploads.gameMode,
        leadersJson: autosaveUploads.leadersJson,
        civsJson: autosaveUploads.civsJson,
        playersJson: autosaveUploads.playersJson,
        mapFile: autosaveUploads.mapFile,
        modsJson: autosaveUploads.modsJson,
        bbgDetected: autosaveUploads.bbgDetected,
        bbgTitle: autosaveUploads.bbgTitle,
        bbgVersion: autosaveUploads.bbgVersion,
        notes: autosaveUploads.notes,
      })
      .from(autosaveUploads)
      .orderBy(desc(autosaveUploads.uploadedAt))
      .limit(1000)

    return c.json({ uploads })
  })

  app.get('/api/uploads/autosaves/:id/download', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!isAutosaveAdmin(c.env, auth.identity.userId)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    const id = c.req.param('id')
    // eslint-disable-next-line no-console
    console.log('[autosave-download] request', { id, userId: auth.identity.userId })
    const [row] = await createDb(c.env.DB)
      .select({
        fileName: autosaveUploads.fileName,
        r2Key: autosaveUploads.r2Key,
      })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) {
      console.warn('[autosave-download] missing catalog row', { id })
      return c.json({ error: 'Upload not found' }, 404)
    }

    const object = await bucket.get(row.r2Key)
    if (!object) {
      console.warn('[autosave-download] missing R2 object', { id, key: row.r2Key })
      return c.json({ error: 'Upload object not found' }, 404)
    }

    await createDb(c.env.DB)
      .update(autosaveUploads)
      .set({ downloadCount: sql`${autosaveUploads.downloadCount} + 1` })
      .where(eq(autosaveUploads.id, id))

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Disposition': buildAttachmentDisposition(row.fileName),
      'Content-Length': String(object.size),
      'Content-Type': 'application/zip',
      ETag: object.httpEtag,
    })
    object.writeHttpMetadata(headers)
    // eslint-disable-next-line no-console
    console.log('[autosave-download] streaming', { id, key: row.r2Key, size: object.size })
    return new Response(object.body, { headers })
  })

  app.post('/api/uploads/autosaves/:id/reparse', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!isAutosaveAdmin(c.env, auth.identity.userId)) return c.json({ error: 'Forbidden' }, 403)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const [row] = await db
      .select({ r2Key: autosaveUploads.r2Key })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)

    await db
      .update(autosaveUploads)
      .set({ parseStatus: 'pending', parseError: null })
      .where(eq(autosaveUploads.id, id))

    c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, id, row.r2Key))
    return c.json({ ok: true })
  })

  app.delete('/api/uploads/autosaves/:id', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!isAutosaveAdmin(c.env, auth.identity.userId)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const [row] = await db
      .select({ r2Key: autosaveUploads.r2Key })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)

    await bucket.delete(row.r2Key)
    await db.delete(autosaveUploads).where(eq(autosaveUploads.id, id))
    return c.json({ ok: true })
  })

  app.post('/api/uploads/autosaves', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    const contentLength = parseContentLength(c.req.header('content-length'))
    if (contentLength != null && contentLength > MAX_AUTOSAVE_UPLOAD_BYTES) {
      return c.json({ error: 'Autosave zip is too large for the current upload path' }, 413)
    }

    const originalFileName = readEncodedHeader(c.req.raw.headers, UPLOAD_FILE_NAME_HEADER) ?? 'autosaves.zip'
    if (!isZipFileName(originalFileName)) return c.json({ error: 'Please upload one .zip file' }, 400)

    const body = c.req.raw.body
    if (!body) return c.json({ error: 'Missing upload body' }, 400)

    const now = new Date()
    const uploadId = crypto.randomUUID()
    const safeFileName = sanitizeFileName(originalFileName)
    const userId = auth.identity.userId
    const channelId = normalizeMetadataValue(c.req.header(UPLOAD_CHANNEL_ID_HEADER))
    const matchId = normalizeMetadataValue(c.req.header(UPLOAD_MATCH_ID_HEADER))
    const key = [
      'autosaves',
      now.toISOString().slice(0, 10),
      sanitizeKeySegment(userId),
      `${uploadId}-${safeFileName}`,
    ].join('/')

    const object = await bucket.put(key, body, {
      httpMetadata: {
        contentType: normalizeContentType(c.req.header('content-type')),
      },
      customMetadata: {
        discordUserId: userId,
        discordDisplayName: normalizeMetadataValue(auth.identity.displayName) ?? '',
        channelId: channelId ?? '',
        matchId: matchId ?? '',
        originalFileName: normalizeMetadataValue(originalFileName) ?? 'autosaves.zip',
        uploadedAt: now.toISOString(),
      },
    })

    try {
      await createDb(c.env.DB).insert(autosaveUploads).values({
        id: uploadId,
        uploadedAt: now.getTime(),
        uploaderUserId: userId,
        uploaderDisplayName: normalizeMetadataValue(auth.identity.displayName),
        channelId,
        matchId,
        fileName: safeFileName,
        fileSizeBytes: object.size,
        r2Key: key,
        etag: object.etag,
        status: 'uploaded',
      })
    }
    catch (error) {
      try {
        await bucket.delete(key)
      }
      catch (deleteError) {
        console.error('[autosave-upload] failed to delete orphaned object after catalog insert failure', { key }, deleteError)
      }
      throw error
    }

    c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, uploadId, key))

    return c.json({
      ok: true,
      id: uploadId,
      key,
      size: object.size,
      etag: object.etag,
    })
  })
}

async function parseAndStoreAutosaveUploadMetadata(env: Env['Bindings'], uploadId: string, key: string): Promise<void> {
  const db = createDb(env.DB)
  try {
    const bucket = env.AUTOSAVE_UPLOADS
    if (!bucket) throw new Error('Autosave upload storage is not configured')

    const object = await bucket.get(key)
    if (!object) throw new Error('Upload object not found')

    const bytes = new Uint8Array(await object.arrayBuffer())
    const zipIndex = parseAutosaveZipIndex(bytes)
    const zipEntries = parseZipEntries(bytes)
    const latestSave = pickLatestAutosaveZipEntry(zipEntries)
    if (!latestSave) throw new Error('No .Civ6Save entries found in zip')

    const saveBytes = readZipEntryData(bytes, latestSave, inflateRaw)
    const metadata = parseCiv6SaveMetadata(saveBytes)
    const bbgVersion = resolveBbgVersion(metadata.bbgDetected, metadata.bbgTitle, metadata.bbgVersion)

    await db
      .update(autosaveUploads)
      .set({
        parseStatus: 'parsed',
        parseError: null,
        saveCount: zipIndex.saveCount,
        maxTurn: zipIndex.maxTurn,
        latestSaveName: latestSave.name,
        playerCount: metadata.playerCount,
        gameMode: metadata.gameMode,
        leadersJson: JSON.stringify(metadata.leaders),
        civsJson: JSON.stringify(metadata.civs),
        playersJson: JSON.stringify(metadata.players),
        mapFile: metadata.mapFile,
        modsJson: JSON.stringify(metadata.mods),
        bbgDetected: metadata.bbgDetected,
        bbgTitle: metadata.bbgTitle,
        bbgVersion,
      })
      .where(eq(autosaveUploads.id, uploadId))

    // eslint-disable-next-line no-console
    console.log('[autosave-parse] parsed upload', {
      id: uploadId,
      maxTurn: zipIndex.maxTurn,
      playerCount: metadata.playerCount,
      gameMode: metadata.gameMode,
      bbgTitle: metadata.bbgTitle,
      bbgVersion,
    })
  }
  catch (error) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : 'Parse failed'
    console.warn('[autosave-parse] failed', { id: uploadId, key, error: message })
    await db
      .update(autosaveUploads)
      .set({
        parseStatus: 'parse_failed',
        parseError: normalizeMetadataValue(message),
      })
      .where(eq(autosaveUploads.id, uploadId))
  }
}

function inflateRaw(bytes: Uint8Array): Uint8Array {
  return inflateSync(bytes)
}

function resolveBbgVersion(detected: boolean, title: string | null, parsedVersion: string | null): string | null {
  if (parsedVersion) return parsedVersion
  if (!detected) return null
  if (title?.toLowerCase().includes('beta')) return betaLeaderDataVersionLabel
  return liveLeaderDataVersionLabel
}

function isAutosaveAdmin(env: Env['Bindings'], userId: string): boolean {
  if (DEFAULT_AUTOSAVE_ADMIN_USER_IDS.has(userId)) return true
  const configuredIds = env.AUTOSAVE_ADMIN_USER_IDS?.split(',') ?? []
  return configuredIds.some(id => id.trim() === userId)
}

function buildAttachmentDisposition(fileName: string): string {
  const asciiFileName = sanitizeFileName(fileName).replace(/["\\]/g, '_')
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readEncodedHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)
  if (!value) return null
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function isZipFileName(value: string): boolean {
  return value.trim().toLowerCase().endsWith('.zip')
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 160)

  const fallback = sanitized.length > 0 ? sanitized : 'autosaves.zip'
  return fallback.toLowerCase().endsWith('.zip') ? fallback : `${fallback}.zip`
}

function sanitizeKeySegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return sanitized.length > 0 ? sanitized : 'unknown'
}

function normalizeContentType(value: string | undefined): string {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (normalized === 'application/zip' || normalized === 'application/x-zip-compressed') return normalized
  return 'application/zip'
}

function normalizeMetadataValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/[^\x20-\x7E]/g, '_').slice(0, 200) ?? ''
  return normalized.length > 0 ? normalized : null
}
