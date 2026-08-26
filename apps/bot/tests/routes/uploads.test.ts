import type { Env } from '../../src/env.ts'
import { MAX_CIV6_SAVE_UNCOMPRESSED_BYTES } from '@civup/civ6-save-metadata'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerUploadRoutes } from '../../src/routes/uploads.ts'
import { recoverStaleAutosaveUploads } from '../../src/services/uploads/multipart.ts'
import { MAX_AUTOSAVE_OBJECTS_PER_USER, MAX_AUTOSAVE_STORAGE_BYTES_PER_USER, MAX_AUTOSAVE_UPLOAD_BYTES } from '../../src/services/uploads/policy.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'upload-test-secret'
const GUILD_ID = '1234044388733095946'
const MIB = 1024 * 1024
const PART_SIZE = 80 * MIB
const openDatabases: Array<Awaited<ReturnType<typeof createTestDatabase>>['sqlite']> = []
const backgroundTasks: Promise<unknown>[] = []

afterEach(async () => {
  await Promise.allSettled(backgroundTasks.splice(0))
  for (const sqlite of openDatabases.splice(0)) sqlite.close()
})

describe('autosave upload routes', () => {
  test('rejects unauthenticated initialization before touching R2', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    }, { authenticated: false })
    expect(response.status).toBe(401)
    expect(bucket.createdKeys).toEqual([])
  })

  test('returns a friendly 503 when optional R2 is absent', async () => {
    const harness = await createHarness()
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    })
    expect(response.status).toBe(503)
    expect(await response.json() as unknown).toEqual({ error: 'Saved game uploads are not configured' })
  })

  test('allows only one sequential active multipart upload per uploader', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    expect((await initializeResponse(harness, 1, 'first.zip')).status).toBe(200)

    const second = await initializeResponse(harness, 1, 'second.zip')
    expect(second.status).toBe(429)
    expect(await second.json<any>()).toEqual({
      error: 'Finish or cancel your current saved-game upload before starting another',
    })
    expect(bucket.createdKeys).toHaveLength(1)
    expect(harness.rowCount()).toBe(1)
  })

  test('enforces the active-upload limit across concurrent initialization attempts', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const responses = await Promise.all([
      initializeResponse(harness, 1, 'concurrent-a.zip'),
      initializeResponse(harness, 1, 'concurrent-b.zip'),
    ])

    expect(responses.map(response => response.status).sort()).toEqual([200, 429])
    expect(bucket.createdKeys).toHaveLength(1)
    expect(harness.rowCount()).toBe(1)
  })

  test('enforces storage and object limits inside D1 against bypasses', async () => {
    const harness = await createHarness(new MultipartBucketMock(1))

    const uploadsToFillStorage = MAX_AUTOSAVE_STORAGE_BYTES_PER_USER / MAX_AUTOSAVE_UPLOAD_BYTES
    for (let index = 0; index < uploadsToFillStorage; index++) {
      harness.insertUpload(`quota-${index}`, 'bypass-quota', MAX_AUTOSAVE_UPLOAD_BYTES, 'uploaded')
    }
    expect(() => harness.insertUpload('quota-over', 'bypass-quota', 1, 'uploaded')).toThrow(/autosave_upload_quota_exceeded/i)

    for (let index = 0; index < MAX_AUTOSAVE_OBJECTS_PER_USER; index++) {
      harness.insertUpload(`count-${index}`, 'bypass-count', 1, 'uploaded')
    }
    expect(() => harness.insertUpload('count-over', 'bypass-count', 1, 'uploaded')).toThrow(/autosave_upload_count_quota_exceeded/i)
  })

  test('enforces the 2 GiB permanent quota and admin deletion frees it', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const uploadsToFillStorage = MAX_AUTOSAVE_STORAGE_BYTES_PER_USER / MAX_AUTOSAVE_UPLOAD_BYTES
    for (let index = 0; index < uploadsToFillStorage; index++) {
      harness.insertUpload(`stored-${index}`, 'owner-user', MAX_AUTOSAVE_UPLOAD_BYTES, 'uploaded')
    }

    const full = await initializeResponse(harness, 1, 'over-quota.zip')
    expect(full.status).toBe(413)
    expect(await full.json<any>()).toEqual({
      error: 'Your 2 GiB saved-game storage quota is full; ask an admin to delete an older upload',
    })

    const deleted = await harness.request('/api/uploads/autosaves/stored-0', { method: 'DELETE' }, {
      userId: 'catalog-admin',
      permissions: '8',
    })
    expect(deleted.status).toBe(200)
    expect((await initializeResponse(harness, 1, 'after-delete.zip')).status).toBe(200)
  })

  test('rejects initialization over the 100-object retained upload limit', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    for (let index = 0; index < MAX_AUTOSAVE_OBJECTS_PER_USER; index++) {
      harness.insertUpload(`retained-${index}`, 'owner-user', 1, 'uploaded')
    }

    const response = await initializeResponse(harness, 1, 'object-101.zip')
    expect(response.status).toBe(413)
    expect(await response.json<any>()).toEqual({
      error: 'Your 100 saved-game upload limit is full; ask an admin to delete an older upload',
    })
    expect(bucket.createdKeys).toEqual([])
    expect(harness.rowCount()).toBe(MAX_AUTOSAVE_OBJECTS_PER_USER)
  })

  test('concurrent initialization at 99 objects cannot bypass the object quota', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    for (let index = 0; index < MAX_AUTOSAVE_OBJECTS_PER_USER - 1; index++) {
      harness.insertUpload(
        `retained-${index}`,
        'owner-user',
        1,
        'uploaded',
        index % 2 === 0 ? 'parse_failed' : 'parsed',
      )
    }

    const responses = await Promise.all([
      initializeResponse(harness, 1, 'concurrent-object-a.zip'),
      initializeResponse(harness, 1, 'concurrent-object-b.zip'),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 413])
    expect(harness.rowCount()).toBe(MAX_AUTOSAVE_OBJECTS_PER_USER)
    expect(bucket.createdKeys).toHaveLength(1)
  })

  test('does not create multipart state when the initializing catalog insert fails', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket, { failCatalogInsert: true })
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    })
    expect(response.status).toBe(500)
    expect(bucket.createdKeys).toEqual([])
    expect(bucket.abortAttempts).toBe(0)
    expect(harness.rowCount()).toBe(0)
  })

  test('removes the initializing row when R2 creation fails', async () => {
    const bucket = new MultipartBucketMock(1, { createFailures: 1 })
    const harness = await createHarness(bucket)
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    })
    expect(response.status).toBe(502)
    expect(harness.rowCount()).toBe(0)
  })

  test('persists the R2 upload id for server-owned recovery when initialization recording fails', async () => {
    const bucket = new MultipartBucketMock(1, { abortFailures: 2 })
    const harness = await createHarness(bucket, { failMultipartRecordUpdates: 3 })
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    })
    expect(response.status).toBe(502)
    const row = harness.onlyRow()
    expect(row).toMatchObject({ status: 'cleanup_pending', multipart_upload_id: 'r2-upload-1' })

    await harness.drainBackground()
    expect(harness.rowCount()).toBe(0)
    expect(bucket.abortAttempts).toBe(3)
  })

  test('retains an unrecorded R2 upload handle for background compensation', async () => {
    const bucket = new MultipartBucketMock(1, { abortFailures: 4 })
    const harness = await createHarness(bucket, { failMultipartRecordUpdates: 20 })
    const response = await harness.request('/api/uploads/autosaves/init', {
      method: 'POST', body: JSON.stringify({ fileName: 'save.zip', fileSizeBytes: 1 }),
    })
    expect(response.status).toBe(502)
    expect(harness.onlyRow()).toMatchObject({ status: 'initializing', multipart_upload_id: null })

    await harness.drainBackground()
    expect(bucket.abortAttempts).toBe(5)
    expect(harness.rowCount()).toBe(0)
  })

  test('uses multipart for small files and preserves upload ownership', async () => {
    const bucket = new MultipartBucketMock(10 * MIB)
    const harness = await createHarness(bucket)
    const init = await initialize(harness, 10 * MIB, 'small.zip')
    expect(init).toEqual({ ok: true, id: expect.any(String), partSizeBytes: PART_SIZE })
    expect(bucket.createdKeys).toHaveLength(1)

    const forbidden = await harness.request(`/api/uploads/autosaves/${init.id}/parts/1`, {
      method: 'PUT', body: new Uint8Array([1]),
    }, { userId: 'other-user' })
    expect(forbidden.status).toBe(403)
    expect(bucket.uploadedParts).toHaveLength(0)
    expect(harness.row(init.id)?.status).toBe('pending_upload')
  })

  test('rejects and aborts an excessive multipart part number', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'part-number.zip')

    const response = await harness.request(`/api/uploads/autosaves/${id}/parts/2`, {
      method: 'PUT', body: new Uint8Array([1]),
    })
    expect(response.status).toBe(400)
    expect(bucket.uploadedParts).toEqual([])
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('counts a missing-content-length body and aborts a short part', async () => {
    const bucket = new MultipartBucketMock(10)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 10, 'short-part.zip')

    const response = await putSizedPart(harness, id, 1, 9)
    expect(response.status).toBe(400)
    expect(await response.json<any>()).toEqual({ error: 'Upload part is smaller than expected' })
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('counts a missing-content-length body and aborts a long part', async () => {
    const bucket = new MultipartBucketMock(10)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 10, 'long-part.zip')

    const response = await putSizedPart(harness, id, 1, 11)
    expect(response.status).toBe(413)
    expect(await response.json<any>()).toEqual({ error: 'Upload part is larger than expected' })
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('accepts an exact 80 MiB final part at the multipart boundary', async () => {
    const bucket = new MultipartBucketMock(PART_SIZE)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, PART_SIZE, 'boundary.zip')

    const response = await putSizedPart(harness, id, 1, PART_SIZE)
    expect(response.status).toBe(200)
    expect(bucket.uploadedPartSizes).toEqual([PART_SIZE])
  })

  test('does not trust a false content length when the streamed body is short', async () => {
    const bucket = new MultipartBucketMock(10)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 10, 'false-length.zip')

    const response = await putSizedPart(harness, id, 1, 9, 10)
    expect(response.status).toBe(400)
    expect(await response.json<any>()).toEqual({ error: 'Upload part is smaller than expected' })
    expect(bucket.abortAttempts).toBe(1)
  })

  test('aborts and removes catalog state after a part upload failure', async () => {
    const bucket = new MultipartBucketMock(1, { partFailures: 1 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'part-failure.zip')
    const response = await harness.request(`/api/uploads/autosaves/${id}/parts/1`, {
      method: 'PUT', body: new Uint8Array([1]),
    })
    expect(response.status).toBe(502)
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('uploads a 100 MiB save in two mocked parts and completes the row', async () => {
    const size = 100 * MIB
    const bucket = new MultipartBucketMock(size)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, size, 'large.zip')

    for (const partNumber of [1, 2]) {
      const part = await putSizedPart(harness, id, partNumber, partNumber === 1 ? PART_SIZE : 20 * MIB)
      expect(part.status).toBe(200)
    }
    const complete = await completeUpload(harness, id, 2)

    expect(complete.status).toBe(200)
    expect(bucket.completedParts).toEqual([{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }])
    expect(harness.row(id)).toMatchObject({
      status: 'uploaded', multipart_upload_id: null, multipart_operation_id: null, file_size_bytes: size,
    })
  })

  test('deletes a completed object and catalog row when uploaded size exceeds the declared size', async () => {
    const bucket = new MultipartBucketMock(2)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'size-mismatch.zip')
    const complete = await completeUpload(harness, id)
    expect(complete.status).toBe(400)
    expect(await complete.json<any>()).toEqual({ error: 'Completed upload size does not match the declared size' })
    expect(bucket.completeAttempts).toBe(1)
    expect(bucket.deleteAttempts).toBe(1)
    expect(bucket.abortAttempts).toBe(0)
    expect(bucket.object).toBeNull()
    expect(harness.row(id)).toBeNull()
  })

  test('keeps invalid completed-object cleanup retryable across repeated server failures', async () => {
    const bucket = new MultipartBucketMock(2, { deleteFailures: 2 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'size-mismatch-retry.zip')

    const complete = await completeUpload(harness, id)
    expect(complete.status).toBe(502)
    expect(harness.row(id)).toMatchObject({
      status: 'cleanup_pending', multipart_upload_id: null, multipart_operation_id: null,
    })
    expect(bucket.object).not.toBeNull()

    await harness.drainBackground()
    expect(bucket.deleteAttempts).toBe(3)
    expect(bucket.object).toBeNull()
    expect(harness.row(id)).toBeNull()
  })

  test('keeps completion retriable after a definite R2 completion failure', async () => {
    const bucket = new MultipartBucketMock(1, { completeFailures: 1 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'retry.zip')

    const failed = await completeUpload(harness, id)
    expect(failed.status).toBe(502)
    expect(harness.row(id)).toMatchObject({ status: 'pending_upload', multipart_operation_id: null })
    expect(bucket.abortAttempts).toBe(0)

    const retried = await completeUpload(harness, id)
    expect(retried.status).toBe(200)
    expect(harness.row(id)?.status).toBe('uploaded')
    expect(bucket.object).not.toBeNull()
  })

  test('reconciles R2 when completion succeeds but its response is lost', async () => {
    const bucket = new MultipartBucketMock(1, { completeResponseLosses: 1 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'response-loss.zip')

    const response = await completeUpload(harness, id)
    expect(response.status).toBe(200)
    expect(await response.json<any>()).toMatchObject({ ok: true, id, size: 1, etag: 'complete-etag' })
    expect(bucket.completeAttempts).toBe(1)
    expect(harness.row(id)?.status).toBe('uploaded')
  })

  test('makes duplicate completion and response-loss retry idempotent', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'duplicate.zip')

    const first = await completeUpload(harness, id)
    expect(first.status).toBe(200)
    await harness.drainBackground()
    expect(bucket.getAttempts).toBe(1)
    const retry = await completeUpload(harness, id)
    expect(retry.status).toBe(200)
    await harness.drainBackground()
    expect(await retry.json<any>()).toMatchObject({ ok: true, id, size: 1, etag: 'complete-etag' })
    expect(bucket.completeAttempts).toBe(1)
    expect(bucket.getAttempts).toBe(1)
    expect(harness.row(id)?.status).toBe('uploaded')
    expect(bucket.object).not.toBeNull()
  })

  test('marks crafted zips with oversized declared saves as parse failures', async () => {
    const zipBytes = buildZipWithDeclaredSaveSize(MAX_CIV6_SAVE_UNCOMPRESSED_BYTES + 1)
    const bucket = new MultipartBucketMock(zipBytes.length, { metadataBytes: zipBytes })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, zipBytes.length, 'oversized-save.zip')

    expect((await completeUpload(harness, id)).status).toBe(200)
    await harness.drainBackground()

    expect(harness.row(id)).toMatchObject({ status: 'uploaded', parse_status: 'parse_failed' })
    expect(String(harness.row(id)?.parse_error)).toContain('Zip entry uncompressed size exceeds')
  })

  test('serializes overlapping duplicate completions onto one R2 completion', async () => {
    const bucket = new MultipartBucketMock(1)
    const completeGate = bucket.blockCompletion()
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'overlap-complete.zip')

    const firstPromise = completeUpload(harness, id)
    await completeGate.started
    const secondPromise = completeUpload(harness, id)
    setTimeout(completeGate.release, 10)
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(bucket.completeAttempts).toBe(1)
    expect(harness.row(id)?.status).toBe('uploaded')
    expect(bucket.object).not.toBeNull()
  })

  test('does not let abort race with an in-flight successful completion', async () => {
    const bucket = new MultipartBucketMock(1)
    const completeGate = bucket.blockCompletion()
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'complete-wins.zip')

    const completePromise = completeUpload(harness, id)
    await completeGate.started
    const abortPromise = harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    const abort = await abortPromise
    expect(abort.status).toBe(409)
    expect(bucket.abortAttempts).toBe(0)

    completeGate.release()
    expect((await completePromise).status).toBe(200)
    expect(harness.row(id)?.status).toBe('uploaded')
    expect(bucket.object).not.toBeNull()
  })

  test('does not let completion race with an in-flight abort', async () => {
    const bucket = new MultipartBucketMock(1)
    const abortGate = bucket.blockAbort()
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'abort-wins.zip')

    const abortPromise = harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    await abortGate.started
    const complete = await completeUpload(harness, id)
    expect(complete.status).toBe(409)
    expect(bucket.completeAttempts).toBe(0)

    abortGate.release()
    expect((await abortPromise).status).toBe(200)
    expect(harness.row(id)).toBeNull()
    expect(bucket.object).toBeNull()
  })

  test('preserves a successful object and catalog row when abort arrives afterward', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'preserve.zip')
    expect((await completeUpload(harness, id)).status).toBe(200)

    const abort = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    expect(abort.status).toBe(200)
    expect(await abort.json<any>()).toEqual({ ok: true, completed: true })
    expect(bucket.abortAttempts).toBe(0)
    expect(bucket.deleteAttempts).toBe(0)
    expect(bucket.object).not.toBeNull()
    expect(harness.row(id)?.status).toBe('uploaded')
  })

  test('reports abort failure, preserves cleanup state, and retries it in the background', async () => {
    const bucket = new MultipartBucketMock(1, { abortFailures: 1 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'abort-retry.zip')

    const failed = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    expect(failed.status).toBe(502)
    expect(harness.row(id)).toMatchObject({ status: 'cleanup_pending', multipart_operation_id: null })

    await harness.drainBackground()
    expect(bucket.abortAttempts).toBe(2)
    expect(harness.row(id)).toBeNull()
  })

  test('retries only catalog cleanup when R2 abort already succeeded', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket, { failCatalogDeletes: 3 })
    const { id } = await initialize(harness, 1, 'catalog-cleanup-retry.zip')

    const failed = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    expect(failed.status).toBe(502)
    expect(harness.row(id)).toMatchObject({
      status: 'cleanup_pending', multipart_upload_id: null, multipart_operation_id: null,
    })

    await harness.drainBackground()
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()

    const duplicate = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    expect(duplicate.status).toBe(200)
  })

  test('server recovery owns repeated multipart abort retries', async () => {
    const bucket = new MultipartBucketMock(1, { abortFailures: 2 })
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'server-abort-retry.zip')

    expect((await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })).status).toBe(502)
    await harness.drainBackground()
    expect(bucket.abortAttempts).toBe(3)
    expect(harness.row(id)).toBeNull()
  })

  test('allows abort to recover an expired completion claim', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'stale-completion.zip')
    harness.setState(id, 'completing', 'stale-completion', 0)

    const response = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('server recovery resumes interrupted cleanup claims', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'stale-cleanup.zip')
    harness.setState(id, 'cleaning', 'stale-cleanup', 0)

    expect((await harness.recover()).cleaned).toBe(1)
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('server recovery finalizes a valid object from an interrupted completion without deleting it', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'stale-valid-completion.zip')
    harness.setState(id, 'completing', 'stale-completion', 0)
    bucket.seedCompletedObject(1)

    const recovery = await harness.recover()
    expect(recovery.completed).toHaveLength(1)
    expect(bucket.deleteAttempts).toBe(0)
    expect(bucket.object).not.toBeNull()
    expect(harness.row(id)?.status).toBe('uploaded')
  })

  test('server recovery finalizes an object that appears between its fenced completion checks', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'between-checks.zip')
    harness.setState(id, 'completing', 'stale-completion', 0)
    bucket.seedCompletedObjectOnHead(2, 1)

    const recovery = await harness.recover()
    expect(recovery.completed).toHaveLength(1)
    expect(bucket.abortAttempts).toBe(1)
    expect(bucket.deleteAttempts).toBe(0)
    expect(bucket.object).not.toBeNull()
    expect(harness.row(id)?.status).toBe('uploaded')
  })

  test('late completion wins safely against stale cleanup without object deletion', async () => {
    const bucket = new MultipartBucketMock(1)
    const completeGate = bucket.blockCompletion()
    const abortGate = bucket.blockAbort()
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'late-complete.zip')

    const completePromise = completeUpload(harness, id)
    await completeGate.started
    const operationId = String(harness.row(id)?.multipart_operation_id)
    harness.setState(id, 'completing', operationId, 0)

    const recoveryPromise = harness.recover()
    await abortGate.started
    completeGate.release()
    expect((await completePromise).status).toBe(200)
    abortGate.release()
    await recoveryPromise

    expect(bucket.deleteAttempts).toBe(0)
    expect(bucket.object).not.toBeNull()
    expect(harness.row(id)?.status).toBe('uploaded')
  })

  test('server recovery expires abandoned pending uploads without a client abort', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'abandoned-pending.zip')
    harness.setState(id, 'pending_upload', null, 0)

    expect((await harness.recover()).cleaned).toBe(1)
    expect(bucket.abortAttempts).toBe(1)
    expect(harness.row(id)).toBeNull()
  })

  test('authenticates abort ownership', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'abort-owner.zip')
    const forbidden = await harness.request(`/api/uploads/autosaves/${id}/abort`, { method: 'POST' }, { userId: 'other-user' })
    expect(forbidden.status).toBe(403)
    expect(harness.row(id)).not.toBeNull()
  })

  test('generic admin delete cannot discard an active multipart upload id', async () => {
    const bucket = new MultipartBucketMock(1)
    const harness = await createHarness(bucket)
    const { id } = await initialize(harness, 1, 'active-delete.zip')

    const response = await harness.request(`/api/uploads/autosaves/${id}`, { method: 'DELETE' }, {
      userId: 'catalog-admin',
      permissions: '8',
    })
    expect(response.status).toBe(409)
    expect(harness.row(id)).toMatchObject({ status: 'pending_upload', multipart_upload_id: 'r2-upload-1' })
    expect(bucket.abortAttempts).toBe(0)
    expect(bucket.deleteAttempts).toBe(0)
  })
})

interface Harness {
  request: (path: string, init: RequestInit, options?: { userId?: string, permissions?: string, authenticated?: boolean }) => Promise<Response>
  row: (id: string) => Record<string, unknown> | null
  onlyRow: () => Record<string, unknown> | null
  rowCount: () => number
  drainBackground: () => Promise<void>
  recover: () => ReturnType<typeof recoverStaleAutosaveUploads>
  setState: (id: string, status: string, operationId: string | null, updatedAt: number) => void
  insertUpload: (id: string, userId: string, size: number, status: string, parseStatus?: string) => void
}

async function createHarness(
  bucket?: MultipartBucketMock,
  options: { failCatalogInsert?: boolean, failCatalogDeletes?: number, failMultipartRecordUpdates?: number } = {},
): Promise<Harness> {
  const { sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const app = new Hono<Env>()
  registerUploadRoutes(app)
  const baseD1 = createSqliteD1Database(sqlite)
  let remainingCatalogDeleteFailures = options.failCatalogDeletes ?? 0
  let remainingMultipartRecordFailures = options.failMultipartRecordUpdates ?? 0
  const d1 = options.failCatalogInsert || remainingCatalogDeleteFailures > 0 || remainingMultipartRecordFailures > 0
    ? {
        ...baseD1,
        prepare(query: string) {
          if (options.failCatalogInsert && /insert\s+into\s+["`]autosave_uploads["`]/i.test(query)) {
            throw new Error('catalog insert failed')
          }
          if (remainingCatalogDeleteFailures > 0 && /delete\s+from\s+["`]autosave_uploads["`]/i.test(query)) {
            remainingCatalogDeleteFailures -= 1
            throw new Error('catalog delete failed')
          }
          if (remainingMultipartRecordFailures > 0
            && /update\s+["`]autosave_uploads["`]/i.test(query)
            && /["`]multipart_upload_id["`]/i.test(query)) {
            remainingMultipartRecordFailures -= 1
            throw new Error('multipart record update failed')
          }
          return baseD1.prepare(query)
        },
      } as D1Database
    : baseD1
  const env = {
    DB: d1,
    KV: createTestKv(),
    AUTOSAVE_UPLOADS: bucket as unknown as R2Bucket | undefined,
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
  }
  return {
    request(path, init, requestOptions = {}) {
      const headers = new Headers(init.headers)
      headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json')
      if (requestOptions.authenticated !== false) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, requestOptions.userId ?? 'owner-user')
        headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, GUILD_ID)
        headers.set(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER, requestOptions.permissions ?? '0')
      }
      return app.fetch(new Request(`https://bot.test${path}`, { ...init, headers }), env, {
        waitUntil(task) { backgroundTasks.push(task) },
        passThroughOnException() {},
      })
    },
    row(id) {
      return sqlite.prepare('SELECT * FROM autosave_uploads WHERE id = ?').get(id) as Record<string, unknown> | null
    },
    onlyRow() {
      return sqlite.prepare('SELECT * FROM autosave_uploads LIMIT 1').get() as Record<string, unknown> | null
    },
    rowCount() {
      return Number((sqlite.prepare('SELECT COUNT(*) AS count FROM autosave_uploads').get() as { count: number }).count)
    },
    async drainBackground() {
      await Promise.allSettled(backgroundTasks.splice(0))
    },
    recover() {
      return recoverStaleAutosaveUploads(env)
    },
    setState(id, status, operationId, updatedAt) {
      sqlite.prepare(`
        UPDATE autosave_uploads
        SET status = ?, multipart_operation_id = ?, multipart_state_updated_at = ?
        WHERE id = ?
      `).run(status, operationId, updatedAt, id)
    },
    insertUpload(id, userId, size, status, parseStatus = 'pending') {
      sqlite.prepare(`
        INSERT INTO autosave_uploads (
          id, uploaded_at, uploader_user_id, file_name, file_size_bytes, r2_key, status, parse_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, Date.now(), userId, `${id}.zip`, size, `autosaves/test/${id}.zip`, status, parseStatus)
    },
  }
}

async function initialize(harness: Harness, size: number, fileName: string): Promise<{ ok: true, id: string, partSizeBytes: number }> {
  const response = await initializeResponse(harness, size, fileName)
  expect(response.status).toBe(200)
  return response.json<any>()
}

function initializeResponse(harness: Harness, size: number, fileName: string): Promise<Response> {
  return harness.request('/api/uploads/autosaves/init', {
    method: 'POST', body: JSON.stringify({ fileName, fileSizeBytes: size }),
  })
}

function putSizedPart(
  harness: Harness,
  id: string,
  partNumber: number,
  actualSize: number,
  contentLength?: number,
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' })
  if (contentLength != null) headers.set('Content-Length', String(contentLength))
  return harness.request(`/api/uploads/autosaves/${id}/parts/${partNumber}`, {
    method: 'PUT',
    headers,
    body: createSizedBody(actualSize),
  })
}

function createSizedBody(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(MIB, Math.max(1, size)))
  let remaining = size
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close()
        return
      }
      const length = Math.min(remaining, chunk.length)
      controller.enqueue(length === chunk.length ? chunk : chunk.subarray(0, length))
      remaining -= length
    },
  })
}

function completeUpload(harness: Harness, id: string, partCount = 1): Promise<Response> {
  return harness.request(`/api/uploads/autosaves/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      parts: Array.from({ length: partCount }, (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` })),
    }),
  })
}

interface MockFailures {
  abortFailures?: number
  completeFailures?: number
  completeResponseLosses?: number
  createFailures?: number
  deleteFailures?: number
  metadataBytes?: Uint8Array
  partFailures?: number
}

class MultipartBucketMock {
  createdKeys: string[] = []
  uploadedParts: number[] = []
  uploadedPartSizes: number[] = []
  completedParts: R2UploadedPart[] = []
  abortAttempts = 0
  completeAttempts = 0
  deleteAttempts = 0
  getAttempts = 0
  headAttempts = 0
  object: R2Object | null = null
  private abortFailures: number
  private completeFailures: number
  private completeResponseLosses: number
  private createFailures: number
  private deleteFailures: number
  private partFailures: number
  private metadataBytes: Uint8Array | null
  private multipartActive = false
  private abortGate: Deferred | null = null
  private completeGate: Deferred | null = null
  private objectOnHead: { attempt: number, size: number } | null = null

  constructor(private readonly completedSize: number, failures: MockFailures = {}) {
    this.abortFailures = failures.abortFailures ?? 0
    this.completeFailures = failures.completeFailures ?? 0
    this.completeResponseLosses = failures.completeResponseLosses ?? 0
    this.createFailures = failures.createFailures ?? 0
    this.deleteFailures = failures.deleteFailures ?? 0
    this.partFailures = failures.partFailures ?? 0
    this.metadataBytes = failures.metadataBytes ?? null
  }

  blockCompletion(): Deferred {
    this.completeGate = createDeferred()
    return this.completeGate
  }

  blockAbort(): Deferred {
    this.abortGate = createDeferred()
    return this.abortGate
  }

  seedCompletedObject(size: number): void {
    this.multipartActive = false
    this.object = { key: this.createdKeys[0], size, etag: 'complete-etag' } as R2Object
  }

  seedCompletedObjectOnHead(attempt: number, size: number): void {
    this.objectOnHead = { attempt, size }
  }

  async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
    this.createdKeys.push(key)
    if (this.createFailures > 0) {
      this.createFailures -= 1
      throw new Error('create failed')
    }
    this.multipartActive = true
    return this.multipart(key)
  }

  resumeMultipartUpload(key: string): R2MultipartUpload {
    return this.multipart(key)
  }

  async delete(): Promise<void> {
    this.deleteAttempts += 1
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1
      throw new Error('delete failed')
    }
    this.object = null
  }

  async head(): Promise<R2Object | null> {
    this.headAttempts += 1
    if (this.objectOnHead?.attempt === this.headAttempts) {
      this.seedCompletedObject(this.objectOnHead.size)
      this.objectOnHead = null
    }
    return this.object
  }

  async get(_key: string, options?: { range?: { offset?: number, length?: number } }): Promise<R2ObjectBody | null> {
    this.getAttempts += 1
    if (!this.object || !this.metadataBytes) return null
    const range = options?.range
    const offset = range?.offset ?? 0
    const length = range?.length ?? this.metadataBytes.length - offset
    const bytes = this.metadataBytes.slice(offset, offset + length)
    return {
      ...this.object,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    } as R2ObjectBody
  }

  private multipart(key: string): R2MultipartUpload {
    return {
      key,
      uploadId: 'r2-upload-1',
      uploadPart: async (partNumber: number, value: unknown) => {
        if (!this.multipartActive) throw new Error('multipart upload is not active')
        if (this.partFailures > 0) {
          this.partFailures -= 1
          throw new Error('part failed')
        }
        const size = await readUploadBodySize(value)
        this.uploadedParts.push(partNumber)
        this.uploadedPartSizes.push(size)
        return { partNumber, etag: `etag-${partNumber}` }
      },
      complete: async (parts: R2UploadedPart[]) => {
        this.completeAttempts += 1
        if (!this.multipartActive) throw new Error('multipart upload is not active')
        if (this.completeGate) {
          this.completeGate.markStarted()
          await this.completeGate.wait
          this.completeGate = null
        }
        if (this.completeFailures > 0) {
          this.completeFailures -= 1
          throw new Error('complete failed')
        }
        this.completedParts = parts
        this.multipartActive = false
        this.object = { key, size: this.completedSize, etag: 'complete-etag' } as R2Object
        if (this.completeResponseLosses > 0) {
          this.completeResponseLosses -= 1
          throw new Error('completion response lost')
        }
        return this.object
      },
      abort: async () => {
        this.abortAttempts += 1
        if (this.abortGate) {
          this.abortGate.markStarted()
          await this.abortGate.wait
          this.abortGate = null
        }
        if (this.abortFailures > 0) {
          this.abortFailures -= 1
          throw new Error('abort failed')
        }
        if (!this.multipartActive) throw new Error('multipart upload is not active')
        this.multipartActive = false
      },
    } as R2MultipartUpload
  }
}

async function readUploadBodySize(value: unknown): Promise<number> {
  if (!value || typeof value !== 'object' || !('getReader' in value)) throw new Error('Expected a streamed upload body')
  const reader = (value as ReadableStream<Uint8Array>).getReader()
  let size = 0
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) return size
    size += chunk.byteLength
  }
}

function buildZipWithDeclaredSaveSize(uncompressedSize: number): Uint8Array {
  const name = new TextEncoder().encode('AutoSave_999.Civ6Save')
  const localSize = 30 + name.length + 1
  const centralSize = 46 + name.length
  const bytes = new Uint8Array(localSize + centralSize + 22)

  writeTestUint32(bytes, 0, 0x04034B50)
  writeTestUint16(bytes, 8, 0)
  writeTestUint32(bytes, 18, 1)
  writeTestUint32(bytes, 22, uncompressedSize)
  writeTestUint16(bytes, 26, name.length)
  bytes.set(name, 30)
  bytes[30 + name.length] = 0

  const centralOffset = localSize
  writeTestUint32(bytes, centralOffset, 0x02014B50)
  writeTestUint16(bytes, centralOffset + 10, 0)
  writeTestUint32(bytes, centralOffset + 20, 1)
  writeTestUint32(bytes, centralOffset + 24, uncompressedSize)
  writeTestUint16(bytes, centralOffset + 28, name.length)
  writeTestUint32(bytes, centralOffset + 42, 0)
  bytes.set(name, centralOffset + 46)

  const eocdOffset = centralOffset + centralSize
  writeTestUint32(bytes, eocdOffset, 0x06054B50)
  writeTestUint16(bytes, eocdOffset + 8, 1)
  writeTestUint16(bytes, eocdOffset + 10, 1)
  writeTestUint32(bytes, eocdOffset + 12, centralSize)
  writeTestUint32(bytes, eocdOffset + 16, centralOffset)
  return bytes
}

function writeTestUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xFF
  bytes[offset + 1] = (value >>> 8) & 0xFF
}

function writeTestUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xFF
  bytes[offset + 1] = (value >>> 8) & 0xFF
  bytes[offset + 2] = (value >>> 16) & 0xFF
  bytes[offset + 3] = (value >>> 24) & 0xFF
}

interface Deferred {
  started: Promise<void>
  wait: Promise<void>
  markStarted: () => void
  release: () => void
}

function createDeferred(): Deferred {
  let markStarted = () => {}
  let release = () => {}
  return {
    started: new Promise<void>((resolve) => { markStarted = resolve }),
    wait: new Promise<void>((resolve) => { release = resolve }),
    markStarted: () => markStarted(),
    release: () => release(),
  }
}
