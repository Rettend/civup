import { describe, expect, test } from 'bun:test'
import { getAutosaveUploadErrorMessage, planAutosaveMultipartParts, uploadAutosaveMultipart } from '../src/client/lib/autosave-upload'

const MIB = 1024 * 1024
const PART_SIZE = 80 * MIB

describe('autosave multipart upload', () => {
  test('plans boundaries without allocating upload-sized buffers', () => {
    expect(planAutosaveMultipartParts(PART_SIZE - 1, PART_SIZE)).toEqual([
      { partNumber: 1, start: 0, end: PART_SIZE - 1 },
    ])
    expect(planAutosaveMultipartParts(PART_SIZE, PART_SIZE)).toEqual([
      { partNumber: 1, start: 0, end: PART_SIZE },
    ])
    expect(planAutosaveMultipartParts(PART_SIZE + 1, PART_SIZE)).toEqual([
      { partNumber: 1, start: 0, end: PART_SIZE },
      { partNumber: 2, start: PART_SIZE, end: PART_SIZE + 1 },
    ])
    expect(planAutosaveMultipartParts(100 * MIB, PART_SIZE)).toEqual([
      { partNumber: 1, start: 0, end: PART_SIZE },
      { partNumber: 2, start: PART_SIZE, end: 100 * MIB },
    ])
  })

  test('uploads planned parts and completes with returned etags', async () => {
    const calls: Array<{ url: string, body: unknown }> = []
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body })
      const partMatch = url.match(/\/parts\/(\d+)$/)
      if (partMatch) {
        const partNumber = Number(partMatch[1])
        return Response.json({ partNumber, etag: `etag-${partNumber}` })
      }
      return Response.json({ ok: true })
    }) as typeof fetch
    const slices: Array<{ start?: number, end?: number }> = []
    const file = {
      size: 100 * MIB,
      slice(start?: number, end?: number) {
        slices.push({ start, end })
        return { size: (end ?? 0) - (start ?? 0) } as Blob
      },
    }

    await uploadAutosaveMultipart({ file, uploadId: 'upload-1', partSizeBytes: PART_SIZE, fetch: fetchMock })

    expect(slices).toEqual([{ start: 0, end: PART_SIZE }, { start: PART_SIZE, end: 100 * MIB }])
    expect(calls.map(call => call.url)).toEqual([
      '/api/uploads/autosaves/upload-1/parts/1',
      '/api/uploads/autosaves/upload-1/parts/2',
      '/api/uploads/autosaves/upload-1/complete',
    ])
    expect(JSON.parse(String(calls[2]!.body))).toEqual({
      parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }],
    })
  })

  test('retries completion when the first response is lost without aborting', async () => {
    const calls: string[] = []
    let completionAttempts = 0
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/parts/1')) return Response.json({ partNumber: 1, etag: 'etag-1' })
      if (url.endsWith('/complete') && completionAttempts++ === 0) throw new TypeError('connection closed')
      return Response.json({ ok: true })
    }) as typeof fetch

    await uploadAutosaveMultipart({
      file: { size: 1, slice: () => ({ size: 1 }) as Blob },
      uploadId: 'upload-retry',
      partSizeBytes: PART_SIZE,
      fetch: fetchMock,
    })

    expect(calls).toEqual([
      '/api/uploads/autosaves/upload-retry/parts/1',
      '/api/uploads/autosaves/upload-retry/complete',
      '/api/uploads/autosaves/upload-retry/complete',
    ])
  })

  test('aborts after a failed part and keeps the not-configured message', async () => {
    const calls: string[] = []
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/abort')) return Response.json({ ok: true })
      return Response.json({ error: 'Upload part failed' }, { status: 502 })
    }) as typeof fetch

    await expect(uploadAutosaveMultipart({
      file: { size: 1, slice: () => ({ size: 1 }) as Blob },
      uploadId: 'upload-2',
      partSizeBytes: PART_SIZE,
      fetch: fetchMock,
    })).rejects.toThrow('Upload part failed')
    expect(calls).toEqual([
      '/api/uploads/autosaves/upload-2/parts/1',
      '/api/uploads/autosaves/upload-2/abort',
    ])
    expect(getAutosaveUploadErrorMessage(503, 'Saved game uploads are not configured')).toBe('Saved game uploads are not configured')
    expect(getAutosaveUploadErrorMessage(413, 'Your 2 GiB saved-game storage quota is full')).toBe('Your 2 GiB saved-game storage quota is full')
  })
})
