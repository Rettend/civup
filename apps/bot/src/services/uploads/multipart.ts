import type { Env } from '../../env.ts'
import { autosaveUploads, createDb } from '@civup/db'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'

export type UploadDb = ReturnType<typeof createDb>

export interface MultipartUploadRow {
  id: string
  uploaderUserId: string
  r2Key: string
  multipartUploadId: string | null
  multipartOperationId: string | null
  multipartStateUpdatedAt: number | null
  fileSizeBytes: number
  etag: string | null
  status: string
}

export type ReconciledMultipartObject
  = | { kind: 'absent' }
    | { kind: 'completed', object: R2Object, newlyFinalized: boolean }
    | { kind: 'mismatch', object: R2Object }
    | { kind: 'state_changed' }

export interface MultipartCleanupFailure {
  ok: false
  error: string
  status: 409 | 502
  recovery?: MultipartCleanupRecovery
}

export type MultipartCleanupResult
  = | { ok: true }
    | MultipartCleanupFailure

export type StaleMultipartCompletionRecovery
  = | { kind: 'completed', object: R2Object, newlyFinalized: boolean }
    | { kind: 'cleaned', invalidObject: boolean }
    | { kind: 'cleanup_failed', cleanup: MultipartCleanupFailure, invalidObject: boolean }
    | { kind: 'in_progress' | 'pending' | 'state_changed' }

export interface MultipartCleanupRecovery {
  operationId: string
  storageAlreadyCleaned: boolean
}

export interface UploadCleanupRecoveryResult {
  cleaned: number
  completed: Array<{ id: string, key: string }>
  pending: number
}

const MULTIPART_OPERATION_LEASE_MS = 30_000
const ABANDONED_PENDING_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000
const MULTIPART_RECONCILE_ATTEMPTS = 5
const MULTIPART_RECONCILE_DELAY_MS = 25
const DATABASE_WRITE_ATTEMPTS = 3
const CLEANUP_BATCH_SIZE = 50

export async function getMultipartUploadRow(db: UploadDb, id: string): Promise<MultipartUploadRow | null> {
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
  return row ?? null
}

export async function claimMultipartOperation(
  db: UploadDb,
  row: MultipartUploadRow,
  status: 'completing' | 'cleaning',
): Promise<string | null> {
  const operationId = crypto.randomUUID()
  const [claimed] = await db
    .update(autosaveUploads)
    .set({ status, multipartOperationId: operationId, multipartStateUpdatedAt: Date.now() })
    .where(and(
      eq(autosaveUploads.id, row.id),
      eq(autosaveUploads.status, row.status),
      operationIdPredicate(row.multipartOperationId),
    ))
    .returning({ id: autosaveUploads.id })
  return claimed ? operationId : null
}

export async function recordInitializedMultipartUpload(
  db: UploadDb,
  id: string,
  initializationOperationId: string,
  multipartUploadId: string,
  status: 'pending_upload' | 'cleanup_pending',
): Promise<boolean> {
  for (let attempt = 0; attempt < DATABASE_WRITE_ATTEMPTS; attempt++) {
    try {
      const [updated] = await db
        .update(autosaveUploads)
        .set({
          status,
          multipartUploadId,
          multipartOperationId: null,
          multipartStateUpdatedAt: Date.now(),
        })
        .where(and(
          eq(autosaveUploads.id, id),
          eq(autosaveUploads.status, 'initializing'),
          eq(autosaveUploads.multipartOperationId, initializationOperationId),
        ))
        .returning({ id: autosaveUploads.id })
      if (updated) return true
    }
    catch {}

    let current: MultipartUploadRow | null
    try {
      current = await getMultipartUploadRow(db, id)
    }
    catch {
      continue
    }
    if (current?.status === status && current.multipartUploadId === multipartUploadId) return true
    if (!current || current.status !== 'initializing' || current.multipartOperationId !== initializationOperationId) return false
  }
  return false
}

export async function releaseMultipartCompletionClaim(db: UploadDb, id: string, operationId: string): Promise<void> {
  await db
    .update(autosaveUploads)
    .set({ status: 'pending_upload', multipartOperationId: null, multipartStateUpdatedAt: Date.now() })
    .where(and(
      eq(autosaveUploads.id, id),
      eq(autosaveUploads.status, 'completing'),
      eq(autosaveUploads.multipartOperationId, operationId),
    ))
}

export async function finalizeCompletedMultipartRow(
  db: UploadDb,
  row: MultipartUploadRow,
  object: R2Object,
  operationId: string,
): Promise<boolean> {
  if (object.size !== row.fileSizeBytes) return false
  const [updated] = await db
    .update(autosaveUploads)
    .set({
      status: 'uploaded',
      multipartUploadId: null,
      multipartOperationId: null,
      multipartStateUpdatedAt: Date.now(),
      etag: object.etag,
      parseStatus: 'pending',
      parseError: null,
    })
    .where(and(
      eq(autosaveUploads.id, row.id),
      eq(autosaveUploads.status, 'completing'),
      eq(autosaveUploads.multipartOperationId, operationId),
    ))
    .returning({ id: autosaveUploads.id })
  return Boolean(updated)
}

export async function reconcileCompletedMultipartObject(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
): Promise<ReconciledMultipartObject> {
  const object = await bucket.head(row.r2Key)
  if (!object) return { kind: 'absent' }
  if (object.size !== row.fileSizeBytes) return { kind: 'mismatch', object }
  if (row.status === 'uploaded') return { kind: 'completed', object, newlyFinalized: false }
  if (row.status !== 'completing' || !row.multipartOperationId) return { kind: 'state_changed' }

  if (await finalizeCompletedMultipartRow(db, row, object, row.multipartOperationId)) {
    return { kind: 'completed', object, newlyFinalized: true }
  }
  const current = await getMultipartUploadRow(db, row.id)
  return current?.status === 'uploaded'
    ? { kind: 'completed', object, newlyFinalized: false }
    : { kind: 'state_changed' }
}

export async function waitForCompletedMultipartObject(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
): Promise<ReconciledMultipartObject> {
  for (let attempt = 0; attempt < MULTIPART_RECONCILE_ATTEMPTS; attempt++) {
    const result = await reconcileCompletedMultipartObject(bucket, db, row)
    if (result.kind !== 'absent') return result
    if (attempt + 1 < MULTIPART_RECONCILE_ATTEMPTS) await delay(MULTIPART_RECONCILE_DELAY_MS)
  }
  return { kind: 'absent' }
}

export function multipartOperationLeaseExpired(row: MultipartUploadRow, now = Date.now()): boolean {
  return row.multipartStateUpdatedAt == null || row.multipartStateUpdatedAt <= now - MULTIPART_OPERATION_LEASE_MS
}

export async function recoverStaleMultipartCompletion(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  now = Date.now(),
): Promise<StaleMultipartCompletionRecovery> {
  if (row.status !== 'completing' || !row.multipartOperationId) return { kind: 'state_changed' }
  if (!multipartOperationLeaseExpired(row, now)) return { kind: 'in_progress' }

  const beforeAbort = await reconcileCompletedMultipartObject(bucket, db, row)
  const reconciledBeforeAbort = await resolveStaleCompletionReconciliation(bucket, db, row, beforeAbort)
  if (reconciledBeforeAbort) return reconciledBeforeAbort

  let storageAlreadyCleaned = !row.multipartUploadId
  if (row.multipartUploadId) {
    try {
      await bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId).abort()
      storageAlreadyCleaned = true
      if (!await recordAbortedStaleCompletion(db, row)) return { kind: 'state_changed' }
    }
    catch (error) {
      console.warn('[autosave-upload] stale completion abort did not win', { id: row.id, key: row.r2Key }, error)
    }
  }

  const afterAbort = await waitForCompletedMultipartObject(bucket, db, row)
  const reconciledAfterAbort = await resolveStaleCompletionReconciliation(bucket, db, row, afterAbort)
  if (reconciledAfterAbort) return reconciledAfterAbort
  if (!storageAlreadyCleaned) return { kind: 'pending' }

  const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
    forceCompletingOperationId: row.multipartOperationId,
    storageAlreadyCleaned: true,
    now,
  })
  return cleanup.ok
    ? { kind: 'cleaned', invalidObject: false }
    : { kind: 'cleanup_failed', cleanup, invalidObject: false }
}

async function recordAbortedStaleCompletion(db: UploadDb, row: MultipartUploadRow): Promise<boolean> {
  for (let attempt = 0; attempt < DATABASE_WRITE_ATTEMPTS; attempt++) {
    try {
      const [updated] = await db
        .update(autosaveUploads)
        .set({ multipartUploadId: null, multipartStateUpdatedAt: Date.now() })
        .where(and(
          eq(autosaveUploads.id, row.id),
          eq(autosaveUploads.status, 'completing'),
          eq(autosaveUploads.multipartOperationId, row.multipartOperationId!),
        ))
        .returning({ id: autosaveUploads.id })
      if (updated) return true
    }
    catch {}

    let current: MultipartUploadRow | null
    try {
      current = await getMultipartUploadRow(db, row.id)
    }
    catch {
      continue
    }
    if (current?.status === 'completing'
      && current.multipartOperationId === row.multipartOperationId
      && !current.multipartUploadId) return true
    if (!current || current.status !== 'completing' || current.multipartOperationId !== row.multipartOperationId) return false
  }
  return false
}

export async function cleanupAutosaveUpload(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  options: {
    forceCompletingOperationId?: string
    forceCleaningOperationId?: string
    forceInitializingOperationId?: string
    storageAlreadyCleaned?: boolean
    now?: number
  } = {},
): Promise<MultipartCleanupResult> {
  const claimError = cleanupClaimError(row, options)
  if (claimError) return claimError

  const operationId = await claimMultipartOperation(db, row, 'cleaning')
  if (!operationId) return { ok: false, error: 'Upload state changed; retry cleanup', status: 409 }

  return executeClaimedCleanup(
    bucket,
    db,
    { ...row, status: 'cleaning', multipartOperationId: operationId },
    operationId,
    options.storageAlreadyCleaned ?? false,
  )
}

export async function retryAutosaveUploadCleanup(
  env: Env['Bindings'],
  id: string,
  attempts = 3,
  initialRecovery?: MultipartCleanupRecovery,
): Promise<void> {
  await delay(100)
  const bucket = env.AUTOSAVE_UPLOADS
  if (!bucket) return
  const db = createDb(env.DB)
  let recovery = initialRecovery
  for (let attempt = 0; attempt < attempts; attempt++) {
    const row = await getMultipartUploadRow(db, id)
    if (!row || row.status === 'uploaded') return
    const result = await cleanupAutosaveUpload(bucket, db, row, {
      forceCleaningOperationId: recovery?.operationId,
      storageAlreadyCleaned: recovery?.storageAlreadyCleaned,
    })
    if (result.ok) return
    if (result.status === 409) return
    recovery = result.recovery
    if (attempt + 1 < attempts) await delay(100)
  }
}

export async function recoverUnrecordedInitializedMultipartUpload(
  env: Env['Bindings'],
  id: string,
  initializationOperationId: string,
  multipartUpload: R2MultipartUpload,
  attempts = 5,
): Promise<void> {
  const bucket = env.AUTOSAVE_UPLOADS
  if (!bucket) return
  const db = createDb(env.DB)
  await delay(100)

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await recordInitializedMultipartUpload(
      db,
      id,
      initializationOperationId,
      multipartUpload.uploadId,
      'cleanup_pending',
    )) {
      const row = await getMultipartUploadRow(db, id)
      if (row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row)
        if (!cleanup.ok && cleanup.status === 502) await retryAutosaveUploadCleanup(env, id, 3, cleanup.recovery)
      }
      return
    }

    try {
      await multipartUpload.abort()
      const row = await getMultipartUploadRow(db, id)
      if (row) {
        const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
          forceInitializingOperationId: initializationOperationId,
          storageAlreadyCleaned: true,
        })
        if (!cleanup.ok && cleanup.status === 502) await retryAutosaveUploadCleanup(env, id, 3, cleanup.recovery)
      }
      return
    }
    catch (error) {
      console.error('[autosave-upload] background initialization abort failed', { id }, error)
    }

    if (attempt + 1 < attempts) await delay(100)
  }
  console.error('[autosave-upload] exhausted background initialization cleanup retries', { id })
}

export async function recoverStaleAutosaveUploads(
  env: Env['Bindings'],
  options: { now?: number, pendingUploadAgeMs?: number, limit?: number } = {},
): Promise<UploadCleanupRecoveryResult> {
  const bucket = env.AUTOSAVE_UPLOADS
  if (!bucket) return { cleaned: 0, completed: [], pending: 0 }

  const now = options.now ?? Date.now()
  const leaseCutoff = now - MULTIPART_OPERATION_LEASE_MS
  const pendingCutoff = now - (options.pendingUploadAgeMs ?? ABANDONED_PENDING_UPLOAD_AGE_MS)
  const db = createDb(env.DB)
  const rows = await db
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
    .where(or(
      eq(autosaveUploads.status, 'cleanup_pending'),
      staleStatus('cleaning', leaseCutoff),
      staleStatus('completing', leaseCutoff),
      staleStatus('initializing', leaseCutoff),
      staleStatus('pending_upload', pendingCutoff),
    ))
    .orderBy(asc(autosaveUploads.multipartStateUpdatedAt))
    .limit(options.limit ?? CLEANUP_BATCH_SIZE)

  const result: UploadCleanupRecoveryResult = { cleaned: 0, completed: [], pending: 0 }
  for (const row of rows) {
    if (row.status === 'completing') {
      try {
        const recovered = await recoverStaleMultipartCompletion(bucket, db, row, now)
        if (recovered.kind === 'completed') {
          if (recovered.newlyFinalized) result.completed.push({ id: row.id, key: row.r2Key })
          continue
        }
        if (recovered.kind === 'cleaned') result.cleaned += 1
        else result.pending += 1
      }
      catch {
        result.pending += 1
      }
      continue
    }

    const cleanup = await cleanupAutosaveUpload(bucket, db, row, { now })
    if (cleanup.ok) result.cleaned += 1
    else result.pending += 1
  }
  return result
}

async function resolveStaleCompletionReconciliation(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  reconciled: ReconciledMultipartObject,
): Promise<StaleMultipartCompletionRecovery | null> {
  if (reconciled.kind === 'completed') return reconciled
  if (reconciled.kind === 'state_changed') return { kind: 'state_changed' }
  if (reconciled.kind === 'absent') return null

  const cleanup = await cleanupAutosaveUpload(bucket, db, row, {
    forceCompletingOperationId: row.multipartOperationId ?? undefined,
  })
  return cleanup.ok
    ? { kind: 'cleaned', invalidObject: true }
    : { kind: 'cleanup_failed', cleanup, invalidObject: true }
}

async function executeClaimedCleanup(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  operationId: string,
  storageAlreadyCleaned: boolean,
): Promise<MultipartCleanupResult> {
  if (storageAlreadyCleaned) {
    if (row.multipartUploadId && !await recordMultipartStorageEnded(db, row.id, operationId)) {
      await markCleanupPending(db, row.id, operationId, true)
      return cleanupFailure('Upload catalog cleanup failed; retry scheduled', operationId, true)
    }
    return deleteCleanupCatalogRow(db, row.id, operationId)
  }

  let object: R2Object | null
  try {
    object = await bucket.head(row.r2Key)
  }
  catch (error) {
    console.error('[autosave-upload] failed to inspect R2 during cleanup', { id: row.id, key: row.r2Key }, error)
    await markCleanupPending(db, row.id, operationId)
    return cleanupFailure('Upload cleanup failed; retry scheduled', operationId, false)
  }

  if (object) return deleteCompletedObjectAndCatalog(bucket, db, row, operationId)

  if (row.multipartUploadId) {
    try {
      await bucket.resumeMultipartUpload(row.r2Key, row.multipartUploadId).abort()
    }
    catch (error) {
      console.error('[autosave-upload] failed to abort multipart upload during cleanup', { id: row.id, key: row.r2Key }, error)
      try {
        object = await bucket.head(row.r2Key)
      }
      catch (headError) {
        console.error('[autosave-upload] failed to reconcile R2 after abort failure', { id: row.id, key: row.r2Key }, headError)
        await markCleanupPending(db, row.id, operationId)
        return cleanupFailure('Upload cleanup failed; retry scheduled', operationId, false)
      }
      if (object) return deleteCompletedObjectAndCatalog(bucket, db, row, operationId)
      await markCleanupPending(db, row.id, operationId)
      return cleanupFailure('Upload cleanup failed; retry scheduled', operationId, false)
    }

    if (!await recordMultipartStorageEnded(db, row.id, operationId)) {
      await markCleanupPending(db, row.id, operationId, true)
      return cleanupFailure('Upload catalog cleanup failed; retry scheduled', operationId, true)
    }
  }

  return deleteCleanupCatalogRow(db, row.id, operationId)
}

async function deleteCompletedObjectAndCatalog(
  bucket: R2Bucket,
  db: UploadDb,
  row: MultipartUploadRow,
  operationId: string,
): Promise<MultipartCleanupResult> {
  if (row.multipartUploadId && !await recordMultipartStorageEnded(db, row.id, operationId)) {
    await markCleanupPending(db, row.id, operationId)
    return cleanupFailure('Upload catalog cleanup failed; retry scheduled', operationId, false)
  }

  try {
    await bucket.delete(row.r2Key)
  }
  catch (error) {
    console.error('[autosave-upload] failed to delete completed R2 object during cleanup', { id: row.id, key: row.r2Key }, error)
    await markCleanupPending(db, row.id, operationId, true)
    return cleanupFailure('Upload cleanup failed; retry scheduled', operationId, false)
  }
  return deleteCleanupCatalogRow(db, row.id, operationId)
}

async function deleteCleanupCatalogRow(db: UploadDb, id: string, operationId: string): Promise<MultipartCleanupResult> {
  for (let attempt = 0; attempt < DATABASE_WRITE_ATTEMPTS; attempt++) {
    try {
      const [deleted] = await db
        .delete(autosaveUploads)
        .where(and(
          eq(autosaveUploads.id, id),
          eq(autosaveUploads.status, 'cleaning'),
          eq(autosaveUploads.multipartOperationId, operationId),
        ))
        .returning({ id: autosaveUploads.id })
      if (deleted) return { ok: true }
      if (!await getMultipartUploadRow(db, id)) return { ok: true }
      return { ok: false, error: 'Upload state changed; retry cleanup', status: 409 }
    }
    catch (error) {
      if (attempt + 1 === DATABASE_WRITE_ATTEMPTS) {
        console.error('[autosave-upload] failed to delete catalog row after storage cleanup', { id }, error)
      }
    }
  }
  await markCleanupPending(db, id, operationId, true)
  return cleanupFailure('Upload catalog cleanup failed; retry scheduled', operationId, true)
}

async function recordMultipartStorageEnded(db: UploadDb, id: string, operationId: string): Promise<boolean> {
  for (let attempt = 0; attempt < DATABASE_WRITE_ATTEMPTS; attempt++) {
    try {
      const [updated] = await db
        .update(autosaveUploads)
        .set({ multipartUploadId: null, multipartStateUpdatedAt: Date.now() })
        .where(and(
          eq(autosaveUploads.id, id),
          eq(autosaveUploads.status, 'cleaning'),
          eq(autosaveUploads.multipartOperationId, operationId),
        ))
        .returning({ id: autosaveUploads.id })
      if (updated) return true
    }
    catch {}

    const current = await getMultipartUploadRow(db, id).catch(() => null)
    if (current?.status === 'cleaning' && current.multipartOperationId === operationId && !current.multipartUploadId) return true
  }
  return false
}

async function markCleanupPending(
  db: UploadDb,
  id: string,
  operationId: string,
  multipartEnded = false,
): Promise<void> {
  for (let attempt = 0; attempt < DATABASE_WRITE_ATTEMPTS; attempt++) {
    try {
      await db
        .update(autosaveUploads)
        .set({
          status: 'cleanup_pending',
          multipartOperationId: null,
          multipartStateUpdatedAt: Date.now(),
          ...(multipartEnded ? { multipartUploadId: null } : {}),
        })
        .where(and(
          eq(autosaveUploads.id, id),
          eq(autosaveUploads.status, 'cleaning'),
          eq(autosaveUploads.multipartOperationId, operationId),
        ))
      return
    }
    catch {}
  }
}

function cleanupClaimError(
  row: MultipartUploadRow,
  options: {
    forceCompletingOperationId?: string
    forceCleaningOperationId?: string
    forceInitializingOperationId?: string
    storageAlreadyCleaned?: boolean
    now?: number
  },
): MultipartCleanupResult | null {
  if (row.status === 'uploaded') return { ok: false, error: 'Upload is already completed', status: 409 }
  if (row.status === 'pending_upload' || row.status === 'cleanup_pending') return null
  if (row.status === 'cleaning') {
    if (options.forceCleaningOperationId && row.multipartOperationId === options.forceCleaningOperationId) return null
    return multipartOperationLeaseExpired(row, options.now)
      ? null
      : { ok: false, error: 'Upload cleanup is in progress', status: 409 }
  }
  if (row.status === 'completing') {
    if (options.forceCompletingOperationId && row.multipartOperationId === options.forceCompletingOperationId) return null
    return multipartOperationLeaseExpired(row, options.now)
      ? null
      : { ok: false, error: 'Upload completion is in progress', status: 409 }
  }
  if (row.status === 'initializing') {
    if (options.forceInitializingOperationId && row.multipartOperationId === options.forceInitializingOperationId) return null
    return multipartOperationLeaseExpired(row, options.now)
      ? null
      : { ok: false, error: 'Upload initialization is in progress', status: 409 }
  }
  return { ok: false, error: 'Upload is not pending cleanup', status: 409 }
}

function cleanupFailure(error: string, operationId: string, storageAlreadyCleaned: boolean): MultipartCleanupResult {
  return {
    ok: false,
    error,
    status: 502,
    recovery: { operationId, storageAlreadyCleaned },
  }
}

function operationIdPredicate(operationId: string | null) {
  return operationId ? eq(autosaveUploads.multipartOperationId, operationId) : isNull(autosaveUploads.multipartOperationId)
}

function staleStatus(status: string, cutoff: number) {
  return and(
    eq(autosaveUploads.status, status),
    or(isNull(autosaveUploads.multipartStateUpdatedAt), lte(autosaveUploads.multipartStateUpdatedAt, cutoff)),
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
