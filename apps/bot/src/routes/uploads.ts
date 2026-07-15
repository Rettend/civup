<<<<<<< New base: fix: mod resolve
<<<<<<< New base: chore: update leader desc
import type { Context, Hono } from 'hono'
import type { Env } from '../env.ts'
import { autosaveUploads, createDb } from '@civup/db'
import { desc, eq, sql } from 'drizzle-orm'
<<<<<<< New base: chore: cleanup and simplify setup
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'
import { parseAndStoreAutosaveUploadMetadata } from '../services/uploads/metadata.ts'
import {
  claimMultipartOperation,
  cleanupAutosaveUpload,
  finalizeCompletedMultipartRow,
  getMultipartUploadRow,
  multipartOperationLeaseExpired,
  reconcileCompletedMultipartObject,
  recordInitializedMultipartUpload,
  recoverStaleMultipartCompletion,
  recoverUnrecordedInitializedMultipartUpload,
  releaseMultipartCompletionClaim,
  retryAutosaveUploadCleanup,
  type MultipartCleanupRecovery,
  type MultipartUploadRow,
  type UploadDb,
  waitForCompletedMultipartObject,
} from '../services/uploads/multipart.ts'
import {
  MAX_AUTOSAVE_OBJECTS_PER_USER,
  MAX_AUTOSAVE_STORAGE_BYTES_PER_USER,
  MAX_AUTOSAVE_UPLOAD_BYTES,
  MAX_PLAYER_DATA_EXPORT_BYTES,
  MULTIPART_AUTOSAVE_PART_BYTES,
} from '../services/uploads/policy.ts'

const UPLOADS_NOT_CONFIGURED_ERROR = 'Saved game uploads are not configured'
const EXPORTS_NOT_CONFIGURED_ERROR = 'Data exports are not configured'
const PLAYER_DATA_EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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

interface AutosaveUploadInitPayload {
  fileName?: unknown
  fileSizeBytes?: unknown
  contentType?: unknown
  channelId?: unknown
  matchId?: unknown
}

interface AutosaveUploadCompletePayload {
  parts?: unknown
}

export function registerUploadRoutes(app: Hono<Env>) {
  app.post('/api/uploads/player-data-export', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: EXPORTS_NOT_CONFIGURED_ERROR }, 503)
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== PLAYER_DATA_EXPORT_CONTENT_TYPE) {
      return c.json({ error: 'Expected an XLSX workbook' }, 415)
    }

    const contentLength = parseContentLength(c.req.header('content-length'))
    if (contentLength != null && contentLength > MAX_PLAYER_DATA_EXPORT_BYTES) {
      return c.json({ error: 'Export workbook is too large' }, 413)
    }
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'Export workbook is empty' }, 400)

    const filename = sanitizePlayerDataExportFileName(c.req.query('filename'))
    const key = playerDataExportKey(auth.identity.userId)
    let object: R2Object
    try {
      object = await bucket.put(key, body, {
        httpMetadata: { contentType: PLAYER_DATA_EXPORT_CONTENT_TYPE },
        customMetadata: { filename },
      })
    }
    catch (error) {
      console.error('[player-data-export] failed to store workbook', { key, userId: auth.identity.userId }, error)
      return c.json({ error: 'Export workbook could not be prepared for download' }, 502)
    }

    if (object.size > MAX_PLAYER_DATA_EXPORT_BYTES) {
      await bucket.delete(key).catch(error => console.error('[player-data-export] failed to remove oversized workbook', { key }, error))
      return c.json({ error: 'Export workbook is too large' }, 413)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true, filename, size: object.size })
  })

  app.get('/api/uploads/player-data-export/download', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: EXPORTS_NOT_CONFIGURED_ERROR }, 503)
    const object = await bucket.get(playerDataExportKey(auth.identity.userId))
    if (!object) return c.json({ error: 'Export workbook not found' }, 404)

    const filename = sanitizePlayerDataExportFileName(object.customMetadata?.filename)
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': buildPlayerDataExportDisposition(filename),
      'Content-Length': String(object.size),
      'Content-Type': PLAYER_DATA_EXPORT_CONTENT_TYPE,
      ETag: object.httpEtag,
    })
    object.writeHttpMetadata(headers)
    return new Response(object.body, { headers })
  })

  app.get('/api/uploads/autosaves', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

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
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

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
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    let body: AutosaveUploadInitPayload
    try {
      body = await c.req.json<AutosaveUploadInitPayload>()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const originalFileName = typeof body.fileName === 'string' ? body.fileName : 'autosaves.zip'
    if (!isZipFileName(originalFileName)) return c.json({ error: 'Please upload one .zip file' }, 400)

    const fileSizeBytes = normalizeUploadSize(body.fileSizeBytes)
    if (fileSizeBytes == null) return c.json({ error: 'Invalid upload size' }, 400)
    if (fileSizeBytes > MAX_AUTOSAVE_UPLOAD_BYTES) {
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
    const db = createDb(c.env.DB)
    const initializationOperationId = crypto.randomUUID()
    console.log('[autosave-upload] init multipart upload', {
      id: uploadId,
      userId,
      fileSizeBytes,
      contentType,
      origin: c.req.header('origin') ?? null,
    })

    let storedBytes = 0
    let storedObjectCount = 0
    let activeUploadCount = 0
    try {
      const [usage] = await db
        .select({
          storedBytes: sql<number>`COALESCE(SUM(${autosaveUploads.fileSizeBytes}), 0)`,
          storedObjectCount: sql<number>`COUNT(*)`,
          activeUploadCount: sql<number>`COALESCE(SUM(CASE WHEN ${autosaveUploads.status} <> 'uploaded' THEN 1 ELSE 0 END), 0)`,
        })
        .from(autosaveUploads)
        .where(eq(autosaveUploads.uploaderUserId, userId))
      storedBytes = Number(usage?.storedBytes ?? 0)
      storedObjectCount = Number(usage?.storedObjectCount ?? 0)
      activeUploadCount = Number(usage?.activeUploadCount ?? 0)
    }
    catch (error) {
      console.error('[autosave-upload] failed to check uploader limits', { userId }, error)
      return c.json({ error: 'Saved game upload limits could not be checked' }, 500)
    }

    if (activeUploadCount > 0) {
      return c.json({ error: 'Finish or cancel your current saved-game upload before starting another' }, 429)
    }
    if (storedObjectCount >= MAX_AUTOSAVE_OBJECTS_PER_USER) {
      return c.json({ error: 'Your 100 saved-game upload limit is full; ask an admin to delete an older upload' }, 413)
    }
    if (storedBytes + fileSizeBytes > MAX_AUTOSAVE_STORAGE_BYTES_PER_USER) {
      return c.json({ error: 'Your 2 GiB saved-game storage quota is full; ask an admin to delete an older upload' }, 413)
    }

    try {
      await db.insert(autosaveUploads).values({
        id: uploadId,
        uploadedAt: now.getTime(),
        uploaderUserId: userId,
        uploaderDisplayName: normalizeMetadataValue(auth.identity.displayName),
        channelId,
        matchId,
        fileName: safeFileName,
        fileSizeBytes,
        r2Key: key,
        multipartUploadId: null,
        multipartOperationId: initializationOperationId,
        multipartStateUpdatedAt: now.getTime(),
        etag: null,
        status: 'initializing',
        parseStatus: 'pending',
        parseError: null,
      })
    }
    catch (error) {
      const limit = classifyAutosaveUploadInitLimitError(error)
      if (limit === 'active') {
        return c.json({ error: 'Finish or cancel your current saved-game upload before starting another' }, 429)
      }
      if (limit === 'count') {
        return c.json({ error: 'Your 100 saved-game upload limit is full; ask an admin to delete an older upload' }, 413)
      }
      if (limit === 'quota') {
        return c.json({ error: 'Your 2 GiB saved-game storage quota is full; ask an admin to delete an older upload' }, 413)
      }
      console.error('[autosave-upload] failed to create initializing catalog row', { id: uploadId, key }, error)
      return c.json({ error: 'Saved game upload could not be started' }, 500)
    }

    let multipartUpload: R2MultipartUpload
    try {
      multipartUpload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType },
      })
    }
    catch (error) {
      console.warn('[autosave-upload] multipart initialization failed', { id: uploadId, key }, error)
      const row = await getMultipartUploadRow(db, uploadId)
      if (row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, { forceInitializingOperationId: initializationOperationId })
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      return c.json({ error: 'Saved game upload could not be started' }, 502)
    }

    if (!await recordInitializedMultipartUpload(db, uploadId, initializationOperationId, multipartUpload.uploadId, 'pending_upload')) {
      console.error('[autosave-upload] failed to record initialized multipart upload', { id: uploadId, key })
      let abortedLocally = false
      let cleanupPersisted = await recordInitializedMultipartUpload(
        db,
        uploadId,
        initializationOperationId,
        multipartUpload.uploadId,
        'cleanup_pending',
      )

      if (!cleanupPersisted) {
        abortedLocally = await abortMultipartUpload(multipartUpload, { id: uploadId, key, action: 'initialization recovery' }, 3)
        if (!abortedLocally) {
          cleanupPersisted = await recordInitializedMultipartUpload(
            db,
            uploadId,
            initializationOperationId,
            multipartUpload.uploadId,
            'cleanup_pending',
          )
        }
      }

      const row = await getMultipartUploadRow(db, uploadId).catch(() => null)
      if (cleanupPersisted && row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row)
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      else if (abortedLocally && row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
          forceInitializingOperationId: initializationOperationId,
          storageAlreadyCleaned: true,
        })
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      else if (row) {
        console.error('[autosave-upload] could not persist or abort initialized multipart upload', { id: uploadId, key })
        c.executionCtx.waitUntil(recoverUnrecordedInitializedMultipartUpload(
          c.env,
          uploadId,
          initializationOperationId,
          multipartUpload,
        ).catch(backgroundError =>
          console.error('[autosave-upload] unrecorded initialization cleanup failed', { id: uploadId, key }, backgroundError),
        ))
      }
      return c.json({ error: 'Saved game upload initialization cleanup failed' }, 502)
    }

    console.log('[autosave-upload] init multipart upload created', {
      id: uploadId,
      key,
      uploadId: multipartUpload.uploadId,
      partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
    })
    return c.json({
      ok: true,
      id: uploadId,
      partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
    })
  })

  app.put('/api/uploads/autosaves/:id/parts/:partNumber', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const partNumber = parseMultipartPartNumber(c.req.param('partNumber'))
    const contentLength = parseContentLength(c.req.header('content-length'))
    const body = c.req.raw.body
    const db = createDb(c.env.DB)
    const [row] = await db
      .select({
        id: autosaveUploads.id,
        uploaderUserId: autosaveUploads.uploaderUserId,
        r2Key: autosaveUploads.r2Key,
        multipartUploadId: autosaveUploads.multipartUploadId,
        multipartOperationId: autosaveUploads.multipartOperationId,
        multipartStateUpdatedAt: autosaveUploads.multipartStateUpdatedAt,
        fileSizeBytes: autosaveUploads.fileSizeBytes,
        etag: autosaveUploads.etag,
        status: autosaveUploads.status,
      })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (row.status !== 'pending_upload') return c.json({ error: 'Upload is not accepting parts' }, 409)
    if (!row.multipartUploadId) return c.json({ error: 'Upload is missing multipart state' }, 409)
    const expectedPartSize = partNumber == null ? null : expectedMultipartPartSize(row.fileSizeBytes, partNumber)
    if (partNumber == null || expectedPartSize == null) {
      return cleanupInvalidMultipartPart(c, bucket, db, row, 'Invalid upload part number', 400)
    }
    if (!body) return cleanupInvalidMultipartPart(c, bucket, db, row, 'Upload part is empty', 400)
    if (contentLength != null && contentLength !== expectedPartSize) {
      return cleanupInvalidMultipartPart(
        c,
        bucket,
        db,
        row,
        contentLength > expectedPartSize ? 'Upload part is larger than expected' : 'Upload part is smaller than expected',
        contentLength > expectedPartSize ? 413 : 400,
      )
    }

    const countedBody = createExactLengthUploadStream(body, expectedPartSize)

    console.log('[autosave-upload] multipart part upload start', {
      id,
      key: row.r2Key,
      partNumber,
      contentLength,
      expectedPartSize,
    })

    try {
      const upload = bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId)
      const part = await upload.uploadPart(partNumber, countedBody.stream)
      if (countedBody.bytesRead !== expectedPartSize) {
        countedBody.mismatch = countedBody.bytesRead > expectedPartSize ? 'long' : 'short'
        throw new Error('R2 accepted an upload part without consuming its declared bytes')
      }
      console.log('[autosave-upload] multipart part upload accepted', {
        id,
        partNumber: part.partNumber,
        etag: part.etag,
      })
      return c.json({ ok: true, partNumber: part.partNumber, etag: part.etag })
    }
    catch (error) {
      console.warn('[autosave-upload] multipart part upload failed', {
        id,
        partNumber,
        expectedPartSize,
        bytesRead: countedBody.bytesRead,
      }, error)
      const cleanup = await cleanupAutosaveUpload(bucket, db, row)
      if (!cleanup.ok) {
        if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
        return c.json({ error: cleanup.error }, cleanup.status)
      }
      if (countedBody.mismatch === 'long') return c.json({ error: 'Upload part is larger than expected' }, 413)
      if (countedBody.mismatch === 'short') return c.json({ error: 'Upload part is smaller than expected' }, 400)
      return c.json({ error: 'Upload part failed' }, 502)
    }
  })

  app.post('/api/uploads/autosaves/:id/complete', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    console.log('[autosave-upload] complete multipart upload start', {
      id,
      userId: auth.identity.userId,
      origin: c.req.header('origin') ?? null,
    })
    const db = createDb(c.env.DB)
    let row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (row.status === 'uploaded') return completedUploadResponse(c, row)

    let operationId: string | null = null
    if (row.status === 'pending_upload') operationId = await claimMultipartOperation(db, row, 'completing')
    else if (row.status === 'completing') return respondToExistingMultipartCompletion(c, bucket, db, row)
    else return c.json({ error: 'Upload is not accepting completion' }, 409)

    if (!operationId) {
      row = await getMultipartUploadRow(db, id)
      if (!row) return c.json({ error: 'Upload not found' }, 404)
      if (row.status === 'uploaded') return completedUploadResponse(c, row)
      if (row.status === 'completing') return respondToExistingMultipartCompletion(c, bucket, db, row)
      return c.json({ error: 'Upload completion is in progress' }, 409)
    }

    row = await getMultipartUploadRow(db, id)
    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.status !== 'completing' || row.multipartOperationId !== operationId) {
      return c.json({ error: 'Upload state changed; retry completion' }, 409)
    }
    if (!row.multipartUploadId) return c.json({ error: 'Upload is missing multipart state' }, 409)

    let completePayload: AutosaveUploadCompletePayload
    try {
      completePayload = await c.req.json<AutosaveUploadCompletePayload>()
    }
    catch {
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const parts = normalizeMultipartUploadedParts(completePayload.parts, row.fileSizeBytes)
    if (!parts) {
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Invalid multipart upload parts' }, 400)
    }

    try {
      const upload = bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId)
      const object = await upload.complete(parts)
      if (object.size !== row.fileSizeBytes) return cleanupInvalidCompletedUpload(c, bucket, db, row)
      if (!await finalizeCompletedMultipartRow(db, row, object, operationId)) {
        const reconciled = await reconcileCompletedMultipartObject(bucket, db, row)
        if (reconciled.kind === 'completed') return reconciledUploadResponse(c, row, reconciled)
        if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
        return c.json({ error: 'Upload state changed; retry completion' }, 409)
      }

      console.log('[autosave-upload] complete multipart upload accepted', {
        id,
        key: row.r2Key,
        size: object.size,
        etag: object.etag,
        partCount: parts.length,
      })
      c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, id, row.r2Key))
      return c.json({ ok: true, id, size: object.size, etag: object.etag })
    }
    catch (error) {
      console.warn('[autosave-upload] complete multipart upload failed', { id, key: row.r2Key }, error)
      let reconciled
      try {
        reconciled = await reconcileCompletedMultipartObject(bucket, db, row)
      }
      catch (reconcileError) {
        console.error('[autosave-upload] could not reconcile failed multipart completion', { id, key: row.r2Key }, reconcileError)
        return c.json({ error: 'Multipart upload completion is being recovered' }, 502)
      }
      if (reconciled.kind === 'completed') {
        return reconciledUploadResponse(c, row, reconciled)
      }
      if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
      if (reconciled.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry completion' }, 409)
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Multipart upload could not be completed' }, 502)
    }
  })

  app.post('/api/uploads/autosaves/:id/abort', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    let row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ ok: true })
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (row.status === 'uploaded') return c.json({ ok: true, completed: true })

    if (row.status === 'completing') {
      const existingObject = await waitForCompletedMultipartObject(bucket, db, row)
      if (existingObject.kind === 'completed') {
        scheduleMetadataParseIfNewlyFinalized(c, row, existingObject.newlyFinalized)
        return c.json({ ok: true, completed: true })
      }
      if (existingObject.kind === 'mismatch') {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, { forceCompletingOperationId: row.multipartOperationId ?? undefined })
        if (!cleanup.ok) {
          if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
          return c.json({ error: cleanup.error }, cleanup.status)
        }
        return c.json({ ok: true, aborted: true })
      }
      if (existingObject.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry abort' }, 409)
      if (!multipartOperationLeaseExpired(row)) return c.json({ error: 'Upload completion is in progress' }, 409)

      const recovered = await recoverStaleMultipartCompletion(bucket, db, row)
      if (recovered.kind === 'completed') {
        scheduleMetadataParseIfNewlyFinalized(c, row, recovered.newlyFinalized)
        return c.json({ ok: true, completed: true })
      }
      if (recovered.kind === 'cleaned') return c.json({ ok: true, aborted: true })
      if (recovered.kind === 'cleanup_failed') {
        if (recovered.cleanup.status === 502) scheduleUploadCleanup(c, id, recovered.cleanup.recovery)
        return c.json({ error: recovered.cleanup.error }, recovered.cleanup.status)
      }
      if (recovered.kind === 'pending') return c.json({ error: 'Upload completion is still being recovered' }, 502)
      return c.json({ error: 'Upload state changed; retry abort' }, 409)
    }

    const cleanup = await cleanupAutosaveUpload(bucket, db, row)
    if (!cleanup.ok) {
      if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
      if (cleanup.status === 409) {
        row = await getMultipartUploadRow(db, id)
        if (!row) return c.json({ ok: true })
        if (row.status === 'uploaded') return c.json({ ok: true, completed: true })
      }
      return c.json({ error: cleanup.error }, cleanup.status)
    }
    return c.json({ ok: true, aborted: true })
  })

  app.post('/api/uploads/autosaves/:id/reparse', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    if (!c.env.AUTOSAVE_UPLOADS) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

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
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.status !== 'uploaded') {
      return c.json({ error: 'Active uploads must be aborted before they can be deleted' }, 409)
    }

    await bucket.delete(row.r2Key)
    await db.delete(autosaveUploads).where(eq(autosaveUploads.id, id))
    return c.json({ ok: true })
  })

}

async function abortMultipartUpload(
  upload: R2MultipartUpload,
  context: { id: string, key: string, action: string },
  attempts = 1,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await upload.abort()
      return true
    }
    catch (error) {
      console.error(`[autosave-upload] failed to abort multipart upload after ${context.action}`, { id: context.id, key: context.key }, error)
    }
  }
  return false
}

function completedUploadResponse(c: Context<Env>, row: MultipartUploadRow) {
  console.log('[autosave-upload] complete multipart upload already uploaded', { id: row.id })
  return c.json({ ok: true, id: row.id, size: row.fileSizeBytes, etag: row.etag })
}

function reconciledUploadResponse(
  c: Context<Env>,
  row: MultipartUploadRow,
  reconciled: { object: R2Object, newlyFinalized: boolean },
) {
  scheduleMetadataParseIfNewlyFinalized(c, row, reconciled.newlyFinalized)
  return c.json({ ok: true, id: row.id, size: reconciled.object.size, etag: reconciled.object.etag })
}

async function respondToExistingMultipartCompletion(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
): Promise<Response> {
  const reconciled = await waitForCompletedMultipartObject(bucket, db, row)
  if (reconciled.kind === 'completed') return reconciledUploadResponse(c, row, reconciled)
  if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
  if (reconciled.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry completion' }, 409)
  if (!multipartOperationLeaseExpired(row)) return c.json({ error: 'Upload completion is in progress' }, 409)

  const recovered = await recoverStaleMultipartCompletion(bucket, db, row)
  if (recovered.kind === 'completed') return reconciledUploadResponse(c, row, recovered)
  if (recovered.kind === 'cleaned') {
    return recovered.invalidObject
      ? c.json({ error: 'Completed upload size does not match the declared size' }, 400)
      : c.json({ error: 'Upload completion expired; please start the upload again' }, 409)
  }
  if (recovered.kind === 'cleanup_failed') {
    if (recovered.cleanup.status === 502) scheduleUploadCleanup(c, row.id, recovered.cleanup.recovery)
    return c.json({ error: recovered.cleanup.error }, recovered.cleanup.status)
  }
  if (recovered.kind === 'pending') return c.json({ error: 'Multipart upload completion is being recovered' }, 502)
  return c.json({ error: 'Upload state changed; retry completion' }, 409)
}

function scheduleMetadataParseIfNewlyFinalized(c: Context<Env>, row: MultipartUploadRow, newlyFinalized: boolean): void {
  if (newlyFinalized) c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, row.id, row.r2Key))
}

async function cleanupInvalidCompletedUpload(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
) {
  const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
    forceCompletingOperationId: row.multipartOperationId ?? undefined,
  })
  if (!cleanup.ok) {
    if (cleanup.status === 502) scheduleUploadCleanup(c, row.id, cleanup.recovery)
    return c.json({ error: cleanup.error }, cleanup.status)
  }
  return c.json({ error: 'Completed upload size does not match the declared size' }, 400)
}

function scheduleUploadCleanup(c: Context<Env>, id: string, recovery?: MultipartCleanupRecovery): void {
  c.executionCtx.waitUntil(retryAutosaveUploadCleanup(c.env, id, 3, recovery).catch(error =>
    console.error('[autosave-upload] background cleanup retry failed', { id }, error),
  ))
}

async function cleanupInvalidMultipartPart(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  error: string,
  status: 400 | 413,
): Promise<Response> {
  const cleanup = await cleanupAutosaveUpload(bucket, db, row)
  if (!cleanup.ok) {
    if (cleanup.status === 502) scheduleUploadCleanup(c, row.id, cleanup.recovery)
    return c.json({ error: cleanup.error }, cleanup.status)
  }
  return c.json({ error }, status)
}

function buildAttachmentDisposition(fileName: string): string {
  const asciiFileName = sanitizeFileName(fileName).replace(/["\\]/g, '_')
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function buildPlayerDataExportDisposition(fileName: string): string {
  const asciiFileName = sanitizePlayerDataExportFileName(fileName).replace(/["\\]/g, '_')
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function expectedMultipartPartSize(fileSizeBytes: number, partNumber: number): number | null {
  const partCount = Math.ceil(fileSizeBytes / MULTIPART_AUTOSAVE_PART_BYTES)
  if (partNumber < 1 || partNumber > partCount) return null
  if (partNumber < partCount) return MULTIPART_AUTOSAVE_PART_BYTES
  return fileSizeBytes - (partCount - 1) * MULTIPART_AUTOSAVE_PART_BYTES
}

interface CountedUploadStream {
  stream: ReadableStream<Uint8Array>
  bytesRead: number
  mismatch: 'short' | 'long' | null
}

function createExactLengthUploadStream(body: ReadableStream<Uint8Array>, expectedBytes: number): CountedUploadStream {
  const counted: CountedUploadStream = {
    stream: null as unknown as ReadableStream<Uint8Array>,
    bytesRead: 0,
    mismatch: null,
  }
  counted.stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      counted.bytesRead += chunk.byteLength
      if (counted.bytesRead > expectedBytes) {
        counted.mismatch = 'long'
        throw new Error(`Upload part exceeds expected size ${expectedBytes}`)
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (counted.bytesRead !== expectedBytes) {
        counted.mismatch = counted.bytesRead > expectedBytes ? 'long' : 'short'
        throw new Error(`Upload part size ${counted.bytesRead} does not match expected size ${expectedBytes}`)
      }
    },
  }))
  return counted
}

function parseMultipartPartNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null
}

function normalizeMultipartUploadedParts(value: unknown, fileSizeBytes: number): R2UploadedPart[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return null
  const expectedPartCount = Math.ceil(fileSizeBytes / MULTIPART_AUTOSAVE_PART_BYTES)
  if (value.length !== expectedPartCount) return null

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

  const sorted = parts.sort((left, right) => left.partNumber - right.partNumber)
  if (sorted.some((part, index) => part.partNumber !== index + 1)) return null
  return sorted
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

function playerDataExportKey(userId: string): string {
  return `player-data-exports/${sanitizeKeySegment(userId)}/latest.xlsx`
}

function sanitizePlayerDataExportFileName(value: string | null | undefined): string {
  const sanitized = value
    ?.trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120) ?? ''
  if (sanitized.toLowerCase().endsWith('.xlsx')) return sanitized
  return `export-${new Date().toISOString().slice(0, 10)}.xlsx`
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

function classifyAutosaveUploadInitLimitError(error: unknown): 'active' | 'count' | 'quota' | null {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : null
  }
  const message = messages.join(' ').toLowerCase()
  if (message.includes('autosave_upload_count_quota_exceeded')) return 'count'
  if (message.includes('autosave_upload_quota_exceeded')) return 'quota'
  if (
    message.includes('autosave_uploads_active_uploader_idx')
    || message.includes('unique constraint failed: autosave_uploads.uploader_user_id')
  ) return 'active'
  return null
}
|||||||
=======
import type { Hono } from 'hono'
||||||| Common ancestor
import type { Hono } from 'hono'
=======
import type { Context, Hono } from 'hono'
>>>>>>> Current commit: chore: cleanup and simplify setup
import type { Env } from '../env.ts'
import { autosaveUploads, createDb } from '@civup/db'
import { desc, eq, sql } from 'drizzle-orm'
import { requireAuthenticatedActivity } from './auth.ts'
import { isActivityDataAdmin } from '../services/activity/data-admin.ts'
||||||| Common ancestor
import { requireAuthenticatedActivity } from './auth.ts'
import { isActivityDataAdmin } from '../services/activity/data-admin.ts'
=======
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'
>>>>>>> Current commit: fix: refresh ranked role colors
import { parseAndStoreAutosaveUploadMetadata } from '../services/uploads/metadata.ts'
import {
  claimMultipartOperation,
  cleanupAutosaveUpload,
  finalizeCompletedMultipartRow,
  getMultipartUploadRow,
  multipartOperationLeaseExpired,
  reconcileCompletedMultipartObject,
  recordInitializedMultipartUpload,
  recoverStaleMultipartCompletion,
  recoverUnrecordedInitializedMultipartUpload,
  releaseMultipartCompletionClaim,
  retryAutosaveUploadCleanup,
  type MultipartCleanupRecovery,
  type MultipartUploadRow,
  type UploadDb,
  waitForCompletedMultipartObject,
} from '../services/uploads/multipart.ts'
import {
  MAX_AUTOSAVE_OBJECTS_PER_USER,
  MAX_AUTOSAVE_STORAGE_BYTES_PER_USER,
  MAX_AUTOSAVE_UPLOAD_BYTES,
  MULTIPART_AUTOSAVE_PART_BYTES,
} from '../services/uploads/policy.ts'

const UPLOADS_NOT_CONFIGURED_ERROR = 'Saved game uploads are not configured'

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

interface AutosaveUploadInitPayload {
  fileName?: unknown
  fileSizeBytes?: unknown
  contentType?: unknown
  channelId?: unknown
  matchId?: unknown
}

interface AutosaveUploadCompletePayload {
  parts?: unknown
}

export function registerUploadRoutes(app: Hono<Env>) {
  app.get('/api/uploads/autosaves', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

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
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

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
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    let body: AutosaveUploadInitPayload
    try {
      body = await c.req.json<AutosaveUploadInitPayload>()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const originalFileName = typeof body.fileName === 'string' ? body.fileName : 'autosaves.zip'
    if (!isZipFileName(originalFileName)) return c.json({ error: 'Please upload one .zip file' }, 400)

    const fileSizeBytes = normalizeUploadSize(body.fileSizeBytes)
    if (fileSizeBytes == null) return c.json({ error: 'Invalid upload size' }, 400)
    if (fileSizeBytes > MAX_AUTOSAVE_UPLOAD_BYTES) {
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
    const db = createDb(c.env.DB)
    const initializationOperationId = crypto.randomUUID()
    console.log('[autosave-upload] init multipart upload', {
      id: uploadId,
      userId,
      fileSizeBytes,
      contentType,
      origin: c.req.header('origin') ?? null,
    })

    let storedBytes = 0
    let storedObjectCount = 0
    let activeUploadCount = 0
    try {
      const [usage] = await db
        .select({
          storedBytes: sql<number>`COALESCE(SUM(${autosaveUploads.fileSizeBytes}), 0)`,
          storedObjectCount: sql<number>`COUNT(*)`,
          activeUploadCount: sql<number>`COALESCE(SUM(CASE WHEN ${autosaveUploads.status} <> 'uploaded' THEN 1 ELSE 0 END), 0)`,
        })
        .from(autosaveUploads)
        .where(eq(autosaveUploads.uploaderUserId, userId))
      storedBytes = Number(usage?.storedBytes ?? 0)
      storedObjectCount = Number(usage?.storedObjectCount ?? 0)
      activeUploadCount = Number(usage?.activeUploadCount ?? 0)
    }
    catch (error) {
      console.error('[autosave-upload] failed to check uploader limits', { userId }, error)
      return c.json({ error: 'Saved game upload limits could not be checked' }, 500)
    }

    if (activeUploadCount > 0) {
      return c.json({ error: 'Finish or cancel your current saved-game upload before starting another' }, 429)
    }
    if (storedObjectCount >= MAX_AUTOSAVE_OBJECTS_PER_USER) {
      return c.json({ error: 'Your 100 saved-game upload limit is full; ask an admin to delete an older upload' }, 413)
    }
    if (storedBytes + fileSizeBytes > MAX_AUTOSAVE_STORAGE_BYTES_PER_USER) {
      return c.json({ error: 'Your 2 GiB saved-game storage quota is full; ask an admin to delete an older upload' }, 413)
    }

    try {
      await db.insert(autosaveUploads).values({
        id: uploadId,
        uploadedAt: now.getTime(),
        uploaderUserId: userId,
        uploaderDisplayName: normalizeMetadataValue(auth.identity.displayName),
        channelId,
        matchId,
        fileName: safeFileName,
        fileSizeBytes,
        r2Key: key,
        multipartUploadId: null,
        multipartOperationId: initializationOperationId,
        multipartStateUpdatedAt: now.getTime(),
        etag: null,
        status: 'initializing',
        parseStatus: 'pending',
        parseError: null,
      })
    }
    catch (error) {
      const limit = classifyAutosaveUploadInitLimitError(error)
      if (limit === 'active') {
        return c.json({ error: 'Finish or cancel your current saved-game upload before starting another' }, 429)
      }
      if (limit === 'count') {
        return c.json({ error: 'Your 100 saved-game upload limit is full; ask an admin to delete an older upload' }, 413)
      }
      if (limit === 'quota') {
        return c.json({ error: 'Your 2 GiB saved-game storage quota is full; ask an admin to delete an older upload' }, 413)
      }
      console.error('[autosave-upload] failed to create initializing catalog row', { id: uploadId, key }, error)
      return c.json({ error: 'Saved game upload could not be started' }, 500)
    }

    let multipartUpload: R2MultipartUpload
    try {
      multipartUpload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType },
      })
    }
    catch (error) {
      console.warn('[autosave-upload] multipart initialization failed', { id: uploadId, key }, error)
      const row = await getMultipartUploadRow(db, uploadId)
      if (row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, { forceInitializingOperationId: initializationOperationId })
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      return c.json({ error: 'Saved game upload could not be started' }, 502)
    }

    if (!await recordInitializedMultipartUpload(db, uploadId, initializationOperationId, multipartUpload.uploadId, 'pending_upload')) {
      console.error('[autosave-upload] failed to record initialized multipart upload', { id: uploadId, key })
      let abortedLocally = false
      let cleanupPersisted = await recordInitializedMultipartUpload(
        db,
        uploadId,
        initializationOperationId,
        multipartUpload.uploadId,
        'cleanup_pending',
      )

      if (!cleanupPersisted) {
        abortedLocally = await abortMultipartUpload(multipartUpload, { id: uploadId, key, action: 'initialization recovery' }, 3)
        if (!abortedLocally) {
          cleanupPersisted = await recordInitializedMultipartUpload(
            db,
            uploadId,
            initializationOperationId,
            multipartUpload.uploadId,
            'cleanup_pending',
          )
        }
      }

      const row = await getMultipartUploadRow(db, uploadId).catch(() => null)
      if (cleanupPersisted && row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row)
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      else if (abortedLocally && row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
          forceInitializingOperationId: initializationOperationId,
          storageAlreadyCleaned: true,
        })
        if (!cleanup.ok) scheduleUploadCleanup(c, uploadId, cleanup.recovery)
      }
      else if (row) {
        console.error('[autosave-upload] could not persist or abort initialized multipart upload', { id: uploadId, key })
        c.executionCtx.waitUntil(recoverUnrecordedInitializedMultipartUpload(
          c.env,
          uploadId,
          initializationOperationId,
          multipartUpload,
        ).catch(backgroundError =>
          console.error('[autosave-upload] unrecorded initialization cleanup failed', { id: uploadId, key }, backgroundError),
        ))
      }
      return c.json({ error: 'Saved game upload initialization cleanup failed' }, 502)
    }

    console.log('[autosave-upload] init multipart upload created', {
      id: uploadId,
      key,
      uploadId: multipartUpload.uploadId,
      partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
    })
    return c.json({
      ok: true,
      id: uploadId,
      partSizeBytes: MULTIPART_AUTOSAVE_PART_BYTES,
    })
  })

  app.put('/api/uploads/autosaves/:id/parts/:partNumber', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const partNumber = parseMultipartPartNumber(c.req.param('partNumber'))
    const contentLength = parseContentLength(c.req.header('content-length'))
    const body = c.req.raw.body
    const db = createDb(c.env.DB)
    const [row] = await db
      .select({
        id: autosaveUploads.id,
        uploaderUserId: autosaveUploads.uploaderUserId,
        r2Key: autosaveUploads.r2Key,
        multipartUploadId: autosaveUploads.multipartUploadId,
        multipartOperationId: autosaveUploads.multipartOperationId,
        multipartStateUpdatedAt: autosaveUploads.multipartStateUpdatedAt,
        fileSizeBytes: autosaveUploads.fileSizeBytes,
        etag: autosaveUploads.etag,
        status: autosaveUploads.status,
      })
      .from(autosaveUploads)
      .where(eq(autosaveUploads.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (row.status !== 'pending_upload') return c.json({ error: 'Upload is not accepting parts' }, 409)
    if (!row.multipartUploadId) return c.json({ error: 'Upload is missing multipart state' }, 409)
    const expectedPartSize = partNumber == null ? null : expectedMultipartPartSize(row.fileSizeBytes, partNumber)
    if (partNumber == null || expectedPartSize == null) {
      return cleanupInvalidMultipartPart(c, bucket, db, row, 'Invalid upload part number', 400)
    }
    if (!body) return cleanupInvalidMultipartPart(c, bucket, db, row, 'Upload part is empty', 400)
    if (contentLength != null && contentLength !== expectedPartSize) {
      return cleanupInvalidMultipartPart(
        c,
        bucket,
        db,
        row,
        contentLength > expectedPartSize ? 'Upload part is larger than expected' : 'Upload part is smaller than expected',
        contentLength > expectedPartSize ? 413 : 400,
      )
    }

    const countedBody = createExactLengthUploadStream(body, expectedPartSize)

    console.log('[autosave-upload] multipart part upload start', {
      id,
      key: row.r2Key,
      partNumber,
      contentLength,
      expectedPartSize,
    })

    try {
      const upload = bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId)
      const part = await upload.uploadPart(partNumber, countedBody.stream)
      if (countedBody.bytesRead !== expectedPartSize) {
        countedBody.mismatch = countedBody.bytesRead > expectedPartSize ? 'long' : 'short'
        throw new Error('R2 accepted an upload part without consuming its declared bytes')
      }
      console.log('[autosave-upload] multipart part upload accepted', {
        id,
        partNumber: part.partNumber,
        etag: part.etag,
      })
      return c.json({ ok: true, partNumber: part.partNumber, etag: part.etag })
    }
    catch (error) {
      console.warn('[autosave-upload] multipart part upload failed', {
        id,
        partNumber,
        expectedPartSize,
        bytesRead: countedBody.bytesRead,
      }, error)
      const cleanup = await cleanupAutosaveUpload(bucket, db, row)
      if (!cleanup.ok) {
        if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
        return c.json({ error: cleanup.error }, cleanup.status)
      }
      if (countedBody.mismatch === 'long') return c.json({ error: 'Upload part is larger than expected' }, 413)
      if (countedBody.mismatch === 'short') return c.json({ error: 'Upload part is smaller than expected' }, 400)
      return c.json({ error: 'Upload part failed' }, 502)
    }
  })

  app.post('/api/uploads/autosaves/:id/complete', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    console.log('[autosave-upload] complete multipart upload start', {
      id,
      userId: auth.identity.userId,
      origin: c.req.header('origin') ?? null,
    })
    const db = createDb(c.env.DB)
    let row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (row.status === 'uploaded') return completedUploadResponse(c, row)

    let operationId: string | null = null
    if (row.status === 'pending_upload') operationId = await claimMultipartOperation(db, row, 'completing')
    else if (row.status === 'completing') return respondToExistingMultipartCompletion(c, bucket, db, row)
    else return c.json({ error: 'Upload is not accepting completion' }, 409)

    if (!operationId) {
      row = await getMultipartUploadRow(db, id)
      if (!row) return c.json({ error: 'Upload not found' }, 404)
      if (row.status === 'uploaded') return completedUploadResponse(c, row)
      if (row.status === 'completing') return respondToExistingMultipartCompletion(c, bucket, db, row)
      return c.json({ error: 'Upload completion is in progress' }, 409)
    }

    row = await getMultipartUploadRow(db, id)
    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.status !== 'completing' || row.multipartOperationId !== operationId) {
      return c.json({ error: 'Upload state changed; retry completion' }, 409)
    }
    if (!row.multipartUploadId) return c.json({ error: 'Upload is missing multipart state' }, 409)

    let completePayload: AutosaveUploadCompletePayload
    try {
      completePayload = await c.req.json<AutosaveUploadCompletePayload>()
    }
    catch {
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const parts = normalizeMultipartUploadedParts(completePayload.parts, row.fileSizeBytes)
    if (!parts) {
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Invalid multipart upload parts' }, 400)
    }

    try {
      const upload = bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId)
      const object = await upload.complete(parts)
      if (object.size !== row.fileSizeBytes) return cleanupInvalidCompletedUpload(c, bucket, db, row)
      if (!await finalizeCompletedMultipartRow(db, row, object, operationId)) {
        const reconciled = await reconcileCompletedMultipartObject(bucket, db, row)
        if (reconciled.kind === 'completed') return reconciledUploadResponse(c, row, reconciled)
        if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
        return c.json({ error: 'Upload state changed; retry completion' }, 409)
      }

      console.log('[autosave-upload] complete multipart upload accepted', {
        id,
        key: row.r2Key,
        size: object.size,
        etag: object.etag,
        partCount: parts.length,
      })
      c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, id, row.r2Key))
      return c.json({ ok: true, id, size: object.size, etag: object.etag })
    }
    catch (error) {
      console.warn('[autosave-upload] complete multipart upload failed', { id, key: row.r2Key }, error)
      let reconciled
      try {
        reconciled = await reconcileCompletedMultipartObject(bucket, db, row)
      }
      catch (reconcileError) {
        console.error('[autosave-upload] could not reconcile failed multipart completion', { id, key: row.r2Key }, reconcileError)
        return c.json({ error: 'Multipart upload completion is being recovered' }, 502)
      }
      if (reconciled.kind === 'completed') {
        return reconciledUploadResponse(c, row, reconciled)
      }
      if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
      if (reconciled.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry completion' }, 409)
      await releaseMultipartCompletionClaim(db, id, operationId)
      return c.json({ error: 'Multipart upload could not be completed' }, 502)
    }
  })

  app.post('/api/uploads/autosaves/:id/abort', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    let row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ ok: true })
    if (row.uploaderUserId !== auth.identity.userId && !hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (row.status === 'uploaded') return c.json({ ok: true, completed: true })

    if (row.status === 'completing') {
      const existingObject = await waitForCompletedMultipartObject(bucket, db, row)
      if (existingObject.kind === 'completed') {
        scheduleMetadataParseIfNewlyFinalized(c, row, existingObject.newlyFinalized)
        return c.json({ ok: true, completed: true })
      }
      if (existingObject.kind === 'mismatch') {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, { forceCompletingOperationId: row.multipartOperationId ?? undefined })
        if (!cleanup.ok) {
          if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
          return c.json({ error: cleanup.error }, cleanup.status)
        }
        return c.json({ ok: true, aborted: true })
      }
      if (existingObject.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry abort' }, 409)
      if (!multipartOperationLeaseExpired(row)) return c.json({ error: 'Upload completion is in progress' }, 409)

      const recovered = await recoverStaleMultipartCompletion(bucket, db, row)
      if (recovered.kind === 'completed') {
        scheduleMetadataParseIfNewlyFinalized(c, row, recovered.newlyFinalized)
        return c.json({ ok: true, completed: true })
      }
      if (recovered.kind === 'cleaned') return c.json({ ok: true, aborted: true })
      if (recovered.kind === 'cleanup_failed') {
        if (recovered.cleanup.status === 502) scheduleUploadCleanup(c, id, recovered.cleanup.recovery)
        return c.json({ error: recovered.cleanup.error }, recovered.cleanup.status)
      }
      if (recovered.kind === 'pending') return c.json({ error: 'Upload completion is still being recovered' }, 502)
      return c.json({ error: 'Upload state changed; retry abort' }, 409)
    }

    const cleanup = await cleanupAutosaveUpload(bucket, db, row)
    if (!cleanup.ok) {
      if (cleanup.status === 502) scheduleUploadCleanup(c, id, cleanup.recovery)
      if (cleanup.status === 409) {
        row = await getMultipartUploadRow(db, id)
        if (!row) return c.json({ ok: true })
        if (row.status === 'uploaded') return c.json({ ok: true, completed: true })
      }
      return c.json({ error: cleanup.error }, cleanup.status)
    }
    return c.json({ ok: true, aborted: true })
  })

  app.post('/api/uploads/autosaves/:id/reparse', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    if (!c.env.AUTOSAVE_UPLOADS) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

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
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const bucket = c.env.AUTOSAVE_UPLOADS
    if (!bucket) return c.json({ error: UPLOADS_NOT_CONFIGURED_ERROR }, 503)

    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const row = await getMultipartUploadRow(db, id)

    if (!row) return c.json({ error: 'Upload not found' }, 404)
    if (row.status !== 'uploaded') {
      return c.json({ error: 'Active uploads must be aborted before they can be deleted' }, 409)
    }

    await bucket.delete(row.r2Key)
    await db.delete(autosaveUploads).where(eq(autosaveUploads.id, id))
    return c.json({ ok: true })
  })

}

async function abortMultipartUpload(
  upload: R2MultipartUpload,
  context: { id: string, key: string, action: string },
  attempts = 1,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await upload.abort()
      return true
    }
    catch (error) {
      console.error(`[autosave-upload] failed to abort multipart upload after ${context.action}`, { id: context.id, key: context.key }, error)
    }
  }
  return false
}

function completedUploadResponse(c: Context<Env>, row: MultipartUploadRow) {
  console.log('[autosave-upload] complete multipart upload already uploaded', { id: row.id })
  return c.json({ ok: true, id: row.id, size: row.fileSizeBytes, etag: row.etag })
}

function reconciledUploadResponse(
  c: Context<Env>,
  row: MultipartUploadRow,
  reconciled: { object: R2Object, newlyFinalized: boolean },
) {
  scheduleMetadataParseIfNewlyFinalized(c, row, reconciled.newlyFinalized)
  return c.json({ ok: true, id: row.id, size: reconciled.object.size, etag: reconciled.object.etag })
}

async function respondToExistingMultipartCompletion(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
): Promise<Response> {
  const reconciled = await waitForCompletedMultipartObject(bucket, db, row)
  if (reconciled.kind === 'completed') return reconciledUploadResponse(c, row, reconciled)
  if (reconciled.kind === 'mismatch') return cleanupInvalidCompletedUpload(c, bucket, db, row)
  if (reconciled.kind === 'state_changed') return c.json({ error: 'Upload state changed; retry completion' }, 409)
  if (!multipartOperationLeaseExpired(row)) return c.json({ error: 'Upload completion is in progress' }, 409)

  const recovered = await recoverStaleMultipartCompletion(bucket, db, row)
  if (recovered.kind === 'completed') return reconciledUploadResponse(c, row, recovered)
  if (recovered.kind === 'cleaned') {
    return recovered.invalidObject
      ? c.json({ error: 'Completed upload size does not match the declared size' }, 400)
      : c.json({ error: 'Upload completion expired; please start the upload again' }, 409)
  }
  if (recovered.kind === 'cleanup_failed') {
    if (recovered.cleanup.status === 502) scheduleUploadCleanup(c, row.id, recovered.cleanup.recovery)
    return c.json({ error: recovered.cleanup.error }, recovered.cleanup.status)
  }
  if (recovered.kind === 'pending') return c.json({ error: 'Multipart upload completion is being recovered' }, 502)
  return c.json({ error: 'Upload state changed; retry completion' }, 409)
}

function scheduleMetadataParseIfNewlyFinalized(c: Context<Env>, row: MultipartUploadRow, newlyFinalized: boolean): void {
  if (newlyFinalized) c.executionCtx.waitUntil(parseAndStoreAutosaveUploadMetadata(c.env, row.id, row.r2Key))
}

async function cleanupInvalidCompletedUpload(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
) {
  const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
    forceCompletingOperationId: row.multipartOperationId ?? undefined,
  })
  if (!cleanup.ok) {
    if (cleanup.status === 502) scheduleUploadCleanup(c, row.id, cleanup.recovery)
    return c.json({ error: cleanup.error }, cleanup.status)
  }
  return c.json({ error: 'Completed upload size does not match the declared size' }, 400)
}

function scheduleUploadCleanup(c: Context<Env>, id: string, recovery?: MultipartCleanupRecovery): void {
  c.executionCtx.waitUntil(retryAutosaveUploadCleanup(c.env, id, 3, recovery).catch(error =>
    console.error('[autosave-upload] background cleanup retry failed', { id }, error),
  ))
}

async function cleanupInvalidMultipartPart(
  c: Context<Env>,
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  error: string,
  status: 400 | 413,
): Promise<Response> {
  const cleanup = await cleanupAutosaveUpload(bucket, db, row)
  if (!cleanup.ok) {
    if (cleanup.status === 502) scheduleUploadCleanup(c, row.id, cleanup.recovery)
    return c.json({ error: cleanup.error }, cleanup.status)
  }
  return c.json({ error }, status)
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

function expectedMultipartPartSize(fileSizeBytes: number, partNumber: number): number | null {
  const partCount = Math.ceil(fileSizeBytes / MULTIPART_AUTOSAVE_PART_BYTES)
  if (partNumber < 1 || partNumber > partCount) return null
  if (partNumber < partCount) return MULTIPART_AUTOSAVE_PART_BYTES
  return fileSizeBytes - (partCount - 1) * MULTIPART_AUTOSAVE_PART_BYTES
}

interface CountedUploadStream {
  stream: ReadableStream<Uint8Array>
  bytesRead: number
  mismatch: 'short' | 'long' | null
}

function createExactLengthUploadStream(body: ReadableStream<Uint8Array>, expectedBytes: number): CountedUploadStream {
  const counted: CountedUploadStream = {
    stream: null as unknown as ReadableStream<Uint8Array>,
    bytesRead: 0,
    mismatch: null,
  }
  counted.stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      counted.bytesRead += chunk.byteLength
      if (counted.bytesRead > expectedBytes) {
        counted.mismatch = 'long'
        throw new Error(`Upload part exceeds expected size ${expectedBytes}`)
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (counted.bytesRead !== expectedBytes) {
        counted.mismatch = counted.bytesRead > expectedBytes ? 'long' : 'short'
        throw new Error(`Upload part size ${counted.bytesRead} does not match expected size ${expectedBytes}`)
      }
    },
  }))
  return counted
}

function parseMultipartPartNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null
}

function normalizeMultipartUploadedParts(value: unknown, fileSizeBytes: number): R2UploadedPart[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return null
  const expectedPartCount = Math.ceil(fileSizeBytes / MULTIPART_AUTOSAVE_PART_BYTES)
  if (value.length !== expectedPartCount) return null

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

  const sorted = parts.sort((left, right) => left.partNumber - right.partNumber)
  if (sorted.some((part, index) => part.partNumber !== index + 1)) return null
  return sorted
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
<<<<<<< New base: fix: mod resolve
>>>>>>> Current commit: feat: catalog
||||||| Common ancestor
=======

function classifyAutosaveUploadInitLimitError(error: unknown): 'active' | 'count' | 'quota' | null {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : null
  }
  const message = messages.join(' ').toLowerCase()
  if (message.includes('autosave_upload_count_quota_exceeded')) return 'count'
  if (message.includes('autosave_upload_quota_exceeded')) return 'quota'
  if (
    message.includes('autosave_uploads_active_uploader_idx')
    || message.includes('unique constraint failed: autosave_uploads.uploader_user_id')
  ) return 'active'
  return null
}
>>>>>>> Current commit: chore: cleanup and simplify setup
