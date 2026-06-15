import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import type { ZipByteReader } from '@civup/civ6-save-metadata'
import { createAutosaveZipIndex, parseCiv6SaveMetadata, parseZipEntriesFromReader, pickLatestAutosaveZipEntry, readZipEntryDataFromReader } from '@civup/civ6-save-metadata'
import { autosaveUploads, createDb } from '@civup/db'
import { betaLeaderDataVersionLabel, liveLeaderDataVersionLabel } from '@civup/game'
import { desc, eq, sql } from 'drizzle-orm'
import { inflateSync } from 'fflate'
import { requireAuthenticatedActivity } from './auth.ts'

const MAX_AUTOSAVE_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_DIRECT_AUTOSAVE_UPLOAD_BYTES = 512 * 1024 * 1024
const MAX_SINGLE_DIRECT_AUTOSAVE_UPLOAD_BYTES = 80 * 1024 * 1024
const MULTIPART_AUTOSAVE_PART_BYTES = 80 * 1024 * 1024
const UPLOAD_FILE_NAME_HEADER = 'x-civup-upload-filename'
const UPLOAD_CHANNEL_ID_HEADER = 'x-civup-upload-channel-id'
const UPLOAD_MATCH_ID_HEADER = 'x-civup-upload-match-id'
const DEFAULT_AUTOSAVE_ADMIN_USER_IDS = new Set(['361534796830081024'])
const DIRECT_UPLOAD_URL_TTL_SECONDS = 15 * 60

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

interface DirectAutosaveUploadInitPayload {
  fileName?: unknown
  fileSizeBytes?: unknown
  contentType?: unknown
  channelId?: unknown
  matchId?: unknown
}

interface DirectAutosaveUploadCompletePayload {
  multipartUploadId?: unknown
  parts?: unknown
}

interface R2DirectUploadConfig {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
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
      .where(eq(autosaveUploads.status, 'uploaded'))
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

  app.post('/api/uploads/autosaves/init', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    let body: DirectAutosaveUploadInitPayload
    try {
      body = await c.req.json<DirectAutosaveUploadInitPayload>()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const originalFileName = typeof body.fileName === 'string' ? body.fileName : 'autosaves.zip'
    if (!isZipFileName(originalFileName)) return c.json({ error: 'Please upload one .zip file' }, 400)

    const fileSizeBytes = normalizeUploadSize(body.fileSizeBytes)
    if (fileSizeBytes == null) return c.json({ error: 'Invalid upload size' }, 400)
    if (fileSizeBytes > MAX_DIRECT_AUTOSAVE_UPLOAD_BYTES) {
      return c.json({ error: 'Autosave zip is too large for the current upload limit' }, 413)
    }

    const now = new Date()
    const uploadId = crypto.randomUUID()
    const safeFileName = sanitizeFileName(originalFileName)
    const userId = auth.identity.userId
    const channelId = normalizeMetadataValue(typeof body.channelId === 'string' ? body.channelId : null)
    const matchId = normalizeMetadataValue(typeof body.matchId === 'string' ? body.matchId : null)
    const contentType = normalizeContentType(typeof body.contentType === 'string' ? body.contentType : undefined)
    const key = buildAutosaveUploadKey(now, userId, uploadId, safeFileName)
    const uploadMode = fileSizeBytes > MAX_SINGLE_DIRECT_AUTOSAVE_UPLOAD_BYTES ? 'multipart' : 'single'
    const directConfig = uploadMode === 'single' ? getR2DirectUploadConfig(c.env) : null
    if (uploadMode === 'single' && !directConfig) {
      console.error('[autosave-upload] direct R2 upload config is missing', { missing: getMissingR2DirectUploadConfigKeys(c.env) })
      return c.json({ error: 'Saved game uploads are not available right now' }, 503)
    }

    console.log('[autosave-upload] init direct upload', {
      id: uploadId,
      userId,
      fileSizeBytes,
      contentType,
      uploadMode,
      origin: c.req.header('origin') ?? null,
      bucket: directConfig?.bucketName ?? c.env.AUTOSAVE_UPLOAD_BUCKET ?? null,
    })

    await createDb(c.env.DB).insert(autosaveUploads).values({
      id: uploadId,
      uploadedAt: now.getTime(),
      uploaderUserId: userId,
      uploaderDisplayName: normalizeMetadataValue(auth.identity.displayName),
      channelId,
      matchId,
      fileName: safeFileName,
      fileSizeBytes,
      r2Key: key,
      etag: null,
      status: 'pending_upload',
      parseStatus: 'pending',
      parseError: null,
    })

    if (uploadMode === 'multipart') {
      const multipartUpload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType },
      })
      console.log('[autosave-upload] init multipart upload created', {
        id: uploadId,
        key,
        uploadId: multipartUpload.uploadId,
        partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
      })
      return c.json({
        ok: true,
        id: uploadId,
        uploadMode,
        multipartUploadId: multipartUpload.uploadId,
        partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
      })
    }

    const uploadUrl = await createR2PresignedPutUrl(directConfig!, key, DIRECT_UPLOAD_URL_TTL_SECONDS)
    console.log('[autosave-upload] init direct upload signed', {
      id: uploadId,
      key,
      expiresInSeconds: DIRECT_UPLOAD_URL_TTL_SECONDS,
    })
    return c.json({
      ok: true,
      id: uploadId,
      uploadMode,
      uploadUrl,
      headers: {
        'Content-Type': contentType,
      },
      expiresInSeconds: DIRECT_UPLOAD_URL_TTL_SECONDS,
    })
  })

  app.put('/api/uploads/autosaves/:id/parts/:partNumber', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    const id = c.req.param('id')
    const partNumber = parseMultipartPartNumber(c.req.param('partNumber'))
    if (partNumber == null) return c.json({ error: 'Invalid upload part number' }, 400)

    const multipartUploadId = normalizeMultipartUploadId(c.req.query('uploadId'))
    if (!multipartUploadId) return c.json({ error: 'Invalid multipart upload id' }, 400)

    const contentLength = parseContentLength(c.req.header('content-length'))
    if (contentLength != null && contentLength > MULTIPART_AUTOSAVE_PART_BYTES) {
      return c.json({ error: 'Upload part is too large' }, 413)
    }

    const body = c.req.raw.body
    if (!body) return c.json({ error: 'Upload part is empty' }, 400)

    const db = createDb(c.env.DB)
    const [row] = await db
      .select({
        uploaderUserId: autosaveUploads.uploaderUserId,
        r2Key: autosaveUploads.r2Key,
        status: autosaveUploads.status,
      })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !isAutosaveAdmin(c.env, auth.identity.userId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (row.status !== 'pending_upload') return c.json({ error: 'Upload is not accepting parts' }, 409)

    console.log('[autosave-upload] multipart part upload start', {
      id,
      key: row.r2Key,
      partNumber,
      contentLength,
    })

    try {
      const upload = bucket.resumeMultipartUpload(row.r2Key, multipartUploadId)
      const part = await upload.uploadPart(partNumber, body)
      console.log('[autosave-upload] multipart part upload accepted', {
        id,
        partNumber: part.partNumber,
        etag: part.etag,
      })
      return c.json({ ok: true, partNumber: part.partNumber, etag: part.etag })
    }
    catch (error) {
      console.warn('[autosave-upload] multipart part upload failed', { id, partNumber }, error)
      return c.json({ error: 'Upload part failed' }, 502)
    }
  })

  app.post('/api/uploads/autosaves/:id/complete', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: 'Autosave upload storage is not configured' }, 503)

    const id = c.req.param('id')
    let completePayload: DirectAutosaveUploadCompletePayload | null = null
    if (c.req.header('content-type')?.toLowerCase().includes('application/json')) {
      try {
        completePayload = await c.req.json<DirectAutosaveUploadCompletePayload>()
      }
      catch {
        return c.json({ error: 'Invalid JSON payload' }, 400)
      }
    }
    console.log('[autosave-upload] complete direct upload start', {
      id,
      userId: auth.identity.userId,
      origin: c.req.header('origin') ?? null,
      multipart: completePayload != null,
    })
    const db = createDb(c.env.DB)
    const [row] = await db
      .select({
        uploaderUserId: autosaveUploads.uploaderUserId,
        r2Key: autosaveUploads.r2Key,
        status: autosaveUploads.status,
      })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !isAutosaveAdmin(c.env, auth.identity.userId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (row.status === 'uploaded') {
      console.log('[autosave-upload] complete direct upload already uploaded', { id })
      return c.json({ ok: true, id })
    }

    if (completePayload) {
      const multipartUploadId = normalizeMultipartUploadId(completePayload.multipartUploadId)
      if (!multipartUploadId) return c.json({ error: 'Invalid multipart upload id' }, 400)

      const parts = normalizeMultipartUploadedParts(completePayload.parts)
      if (!parts) return c.json({ error: 'Invalid multipart upload parts' }, 400)

      try {
        const upload = bucket.resumeMultipartUpload(row.r2Key, multipartUploadId)
        const object = await upload.complete(parts)
        console.log('[autosave-upload] complete multipart upload accepted', {
          id,
          key: row.r2Key,
          size: object.size,
          etag: object.etag,
          partCount: parts.length,
        })

        await db
          .update(autosaveUploads)
          .set({
            status: 'uploaded',
            fileSizeBytes: object.size,
            etag: object.etag,
            parseStatus: 'pending',
            parseError: null,
          })
          .where(eq(autosaveUploads.id, id))

        c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, id, row.r2Key))
        return c.json({ ok: true, id, size: object.size, etag: object.etag })
      }
      catch (error) {
        console.warn('[autosave-upload] complete multipart upload failed', { id, key: row.r2Key }, error)
        return c.json({ error: 'Multipart upload could not be completed' }, 400)
      }
    }

    const object = await bucket.head(row.r2Key)
    if (!object) {
      console.warn('[autosave-upload] complete direct upload missing R2 object', { id, key: row.r2Key })
      await db
        .update(autosaveUploads)
        .set({ status: 'upload_failed', parseStatus: 'parse_failed', parseError: 'Upload object not found' })
        .where(eq(autosaveUploads.id, id))
      return c.json({ error: 'Upload object not found' }, 404)
    }

    console.log('[autosave-upload] complete direct upload found R2 object', {
      id,
      key: row.r2Key,
      size: object.size,
      etag: object.etag,
    })

    await db
      .update(autosaveUploads)
      .set({
        status: 'uploaded',
        fileSizeBytes: object.size,
        etag: object.etag,
        parseStatus: 'pending',
        parseError: null,
      })
      .where(eq(autosaveUploads.id, id))

    c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, id, row.r2Key))
    console.log('[autosave-upload] complete direct upload accepted', { id })
    return c.json({ ok: true, id, size: object.size, etag: object.etag })
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
    const key = buildAutosaveUploadKey(now, userId, uploadId, safeFileName)

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

    const object = await bucket.head(key)
    if (!object) throw new Error('Upload object not found')

    const reader = createR2ZipReader(bucket, key, object.size)
    const zipEntries = await parseZipEntriesFromReader(reader)
    const zipIndex = createAutosaveZipIndex(zipEntries)
    const latestSave = pickLatestAutosaveZipEntry(zipEntries)
    if (!latestSave) throw new Error('No .Civ6Save entries found in zip')

    const saveBytes = await readZipEntryDataFromReader(reader, latestSave, inflateRaw)
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

function createR2ZipReader(bucket: R2Bucket, key: string, size: number): ZipByteReader {
  return {
    size,
    async read(offset, length) {
      if (length === 0) return new Uint8Array()

      const object = await bucket.get(key, { range: { offset, length } })
      if (!object) throw new Error('Upload object range not found')

      return new Uint8Array(await object.arrayBuffer())
    },
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

function getR2DirectUploadConfig(env: Env['Bindings']): R2DirectUploadConfig | null {
  const accountId = env.R2_ACCOUNT_ID?.trim() ?? ''
  const bucketName = env.AUTOSAVE_UPLOAD_BUCKET?.trim() ?? ''
  const accessKeyId = env.R2_UPLOAD_ACCESS_KEY_ID?.trim() ?? ''
  const secretAccessKey = env.R2_UPLOAD_SECRET_ACCESS_KEY?.trim() ?? ''
  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) return null
  return { accountId, bucketName, accessKeyId, secretAccessKey }
}

function getMissingR2DirectUploadConfigKeys(env: Env['Bindings']): string[] {
  const entries: Array<[string, string | undefined]> = [
    ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID],
    ['AUTOSAVE_UPLOAD_BUCKET', env.AUTOSAVE_UPLOAD_BUCKET],
    ['R2_UPLOAD_ACCESS_KEY_ID', env.R2_UPLOAD_ACCESS_KEY_ID],
    ['R2_UPLOAD_SECRET_ACCESS_KEY', env.R2_UPLOAD_SECRET_ACCESS_KEY],
  ]
  return entries
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key)
}

async function createR2PresignedPutUrl(config: R2DirectUploadConfig, key: string, expiresInSeconds: number): Promise<string> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`
  const now = new Date()
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const signedHeaders = 'host'
  const canonicalUri = `/${awsEncodePath(config.bucketName)}/${awsEncodePath(key)}`
  const queryParams: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  const canonicalQuery = buildCanonicalQueryString(queryParams)
  const canonicalHeaders = `host:${host}\n`
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = await getAwsSigningKey(config.secretAccessKey, dateStamp)
  const signature = toHex(await hmacBytes(signingKey, stringToSign))
  const signedQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`
  return `https://${host}${canonicalUri}?${signedQuery}`
}

async function getAwsSigningKey(secretAccessKey: string, dateStamp: string): Promise<Uint8Array> {
  const dateKey = await hmacBytes(`AWS4${secretAccessKey}`, dateStamp)
  const regionKey = await hmacBytes(dateKey, 'auto')
  const serviceKey = await hmacBytes(regionKey, 's3')
  return hmacBytes(serviceKey, 'aws4_request')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toHex(new Uint8Array(digest))
}

async function hmacBytes(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value))
  return new Uint8Array(signature)
}

function formatAmzDate(value: Date): string {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function buildCanonicalQueryString(params: [string, string][]): string {
  return [...params]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyCompare = leftKey.localeCompare(rightKey)
      return keyCompare !== 0 ? keyCompare : leftValue.localeCompare(rightValue)
    })
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&')
}

function awsEncodePath(value: string): string {
  return value.split('/').map(awsEncode).join('/')
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
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

function parseMultipartPartNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null
}

function normalizeMultipartUploadId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 1024 ? normalized : null
}

function normalizeMultipartUploadedParts(value: unknown): R2UploadedPart[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return null

  const seen = new Set<number>()
  const parts: R2UploadedPart[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const partNumber = (item as { partNumber?: unknown }).partNumber
    const etag = (item as { etag?: unknown }).etag
    if (typeof partNumber !== 'number' || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return null
    if (typeof etag !== 'string' || etag.trim().length === 0) return null
    if (seen.has(partNumber)) return null
    seen.add(partNumber)
    parts.push({ partNumber, etag: etag.trim() })
  }

  return parts.sort((left, right) => left.partNumber - right.partNumber)
}

function normalizeUploadSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function buildAutosaveUploadKey(now: Date, userId: string, uploadId: string, safeFileName: string): string {
  return [
    'autosaves',
    now.toISOString().slice(0, 10),
    sanitizeKeySegment(userId),
    `${uploadId}-${safeFileName}`,
  ].join('/')
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
