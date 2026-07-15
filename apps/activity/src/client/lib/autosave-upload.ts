<<<<<<< New base: fix: mod resolve
import { buildActivitySessionHeaders } from './activity-session'

export interface AutosaveMultipartPart {
  partNumber: number
  start: number
  end: number
}

interface MultipartFile {
  size: number
  slice: (start?: number, end?: number) => Blob
}

interface MultipartPartResponse {
  partNumber?: number
  etag?: string
  error?: string
}

interface UploadErrorResponse {
  error?: string
}

const COMPLETE_ATTEMPTS = 3
const COMPLETE_RETRY_DELAY_MS = 75

export function planAutosaveMultipartParts(fileSizeBytes: number, partSizeBytes: number): AutosaveMultipartPart[] {
  if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) throw new Error('Invalid file size')
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) throw new Error('Invalid upload part size')

  const parts: AutosaveMultipartPart[] = []
  const partCount = Math.ceil(fileSizeBytes / partSizeBytes)
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const start = (partNumber - 1) * partSizeBytes
    parts.push({ partNumber, start, end: Math.min(start + partSizeBytes, fileSizeBytes) })
  }
  return parts
}

export async function uploadAutosaveMultipart(options: {
  file: MultipartFile
  uploadId: string
  partSizeBytes: number
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const uploadedParts: Array<{ partNumber: number, etag: string }> = []

  try {
    for (const part of planAutosaveMultipartParts(options.file.size, options.partSizeBytes)) {
      const response = await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(options.uploadId)}/parts/${part.partNumber}`, {
        method: 'PUT',
        headers: buildActivitySessionHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: options.file.slice(part.start, part.end),
      })
      const payload = await response.json().catch(() => null) as MultipartPartResponse | null
      if (!response.ok) throw new Error(getAutosaveUploadErrorMessage(response.status, payload?.error))
      if (payload?.partNumber !== part.partNumber || !payload.etag) throw new Error('Upload part returned an invalid response')
      uploadedParts.push({ partNumber: part.partNumber, etag: payload.etag })
    }

    await completeAutosaveMultipart(fetchImpl, options.uploadId, uploadedParts)
  }
  catch (error) {
    await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(options.uploadId)}/abort`, {
      method: 'POST',
      headers: buildActivitySessionHeaders(),
    }).catch(() => null)
    throw error
  }
}

async function completeAutosaveMultipart(
  fetchImpl: typeof globalThis.fetch,
  uploadId: string,
  parts: Array<{ partNumber: number, etag: string }>,
): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
        headers: buildActivitySessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ parts }),
      })
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error('Upload completion failed')
      if (attempt + 1 < COMPLETE_ATTEMPTS) await delay(COMPLETE_RETRY_DELAY_MS)
      continue
    }

    const payload = await response.json().catch(() => null) as UploadErrorResponse | null
    if (response.ok) return
    lastError = new Error(getAutosaveUploadErrorMessage(response.status, payload?.error))
    if (response.status !== 409 && response.status < 500) throw lastError
    if (attempt + 1 < COMPLETE_ATTEMPTS) await delay(COMPLETE_RETRY_DELAY_MS)
  }
  throw lastError ?? new Error('Upload completion failed')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getAutosaveUploadErrorMessage(status: number, serverMessage: string | undefined): string {
  if (status === 400) return serverMessage?.trim() || 'That saved game zip could not be uploaded.'
  if (status === 401 || status === 403) return 'Please reopen the Activity in Discord and try again.'
  if (status === 413) return serverMessage?.trim() || 'That saved game zip is too large.'
  if (status === 503) return serverMessage?.trim() || 'Saved game uploads are not configured'
  if (status === 404) return 'Saved game uploads are not available right now. Please try again later.'
  return serverMessage?.trim() || 'Upload failed. Please try again later.'
}
|||||||
=======
import { buildActivitySessionHeaders } from './activity-session'

export interface AutosaveMultipartPart {
  partNumber: number
  start: number
  end: number
}

interface MultipartFile {
  size: number
  slice: (start?: number, end?: number) => Blob
}

interface MultipartPartResponse {
  partNumber?: number
  etag?: string
  error?: string
}

interface UploadErrorResponse {
  error?: string
}

const COMPLETE_ATTEMPTS = 3
const COMPLETE_RETRY_DELAY_MS = 75

export function planAutosaveMultipartParts(fileSizeBytes: number, partSizeBytes: number): AutosaveMultipartPart[] {
  if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) throw new Error('Invalid file size')
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) throw new Error('Invalid upload part size')

  const parts: AutosaveMultipartPart[] = []
  const partCount = Math.ceil(fileSizeBytes / partSizeBytes)
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const start = (partNumber - 1) * partSizeBytes
    parts.push({ partNumber, start, end: Math.min(start + partSizeBytes, fileSizeBytes) })
  }
  return parts
}

export async function uploadAutosaveMultipart(options: {
  file: MultipartFile
  uploadId: string
  partSizeBytes: number
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const uploadedParts: Array<{ partNumber: number, etag: string }> = []

  try {
    for (const part of planAutosaveMultipartParts(options.file.size, options.partSizeBytes)) {
      const response = await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(options.uploadId)}/parts/${part.partNumber}`, {
        method: 'PUT',
        headers: buildActivitySessionHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: options.file.slice(part.start, part.end),
      })
      const payload = await response.json().catch(() => null) as MultipartPartResponse | null
      if (!response.ok) throw new Error(getAutosaveUploadErrorMessage(response.status, payload?.error))
      if (payload?.partNumber !== part.partNumber || !payload.etag) throw new Error('Upload part returned an invalid response')
      uploadedParts.push({ partNumber: part.partNumber, etag: payload.etag })
    }

    await completeAutosaveMultipart(fetchImpl, options.uploadId, uploadedParts)
  }
  catch (error) {
    await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(options.uploadId)}/abort`, {
      method: 'POST',
      headers: buildActivitySessionHeaders(),
    }).catch(() => null)
    throw error
  }
}

async function completeAutosaveMultipart(
  fetchImpl: typeof globalThis.fetch,
  uploadId: string,
  parts: Array<{ partNumber: number, etag: string }>,
): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(`/api/uploads/autosaves/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
        headers: buildActivitySessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ parts }),
      })
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error('Upload completion failed')
      if (attempt + 1 < COMPLETE_ATTEMPTS) await delay(COMPLETE_RETRY_DELAY_MS)
      continue
    }

    const payload = await response.json().catch(() => null) as UploadErrorResponse | null
    if (response.ok) return
    lastError = new Error(getAutosaveUploadErrorMessage(response.status, payload?.error))
    if (response.status !== 409 && response.status < 500) throw lastError
    if (attempt + 1 < COMPLETE_ATTEMPTS) await delay(COMPLETE_RETRY_DELAY_MS)
  }
  throw lastError ?? new Error('Upload completion failed')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getAutosaveUploadErrorMessage(status: number, serverMessage: string | undefined): string {
  if (status === 400) return serverMessage?.trim() || 'That saved game zip could not be uploaded.'
  if (status === 401 || status === 403) return 'Please reopen the Activity in Discord and try again.'
  if (status === 413) return serverMessage?.trim() || 'That saved game zip is too large.'
  if (status === 503) return serverMessage?.trim() || 'Saved game uploads are not configured'
  if (status === 404) return 'Saved game uploads are not available right now. Please try again later.'
  return serverMessage?.trim() || 'Upload failed. Please try again later.'
}
>>>>>>> Current commit: chore: cleanup and simplify setup
