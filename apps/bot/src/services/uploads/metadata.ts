import type { Env } from '../../env.ts'
import type { ZipByteReader } from '@civup/civ6-save-metadata'
import { createAutosaveZipIndex, parseCiv6SaveMetadata, parseZipEntriesFromReader, pickLatestAutosaveZipEntry, readZipEntryDataFromReader } from '@civup/civ6-save-metadata'
import { autosaveUploads, createDb } from '@civup/db'
import { betaLeaderDataVersionLabel, liveLeaderDataVersionLabel } from '@civup/game'
import { eq } from 'drizzle-orm'

export const AUTOSAVE_METADATA_PARSE_CONCURRENCY = 1

export interface RecoveredAutosaveUpload {
  id: string
  key: string
}

export async function parseRecoveredAutosaveUploadMetadata(
  env: Env['Bindings'],
  uploads: readonly RecoveredAutosaveUpload[],
): Promise<void> {
  await runAutosaveMetadataParseQueue(uploads, upload =>
    parseAndStoreAutosaveUploadMetadata(env, upload.id, upload.key),
  )
}

export async function runAutosaveMetadataParseQueue(
  uploads: readonly RecoveredAutosaveUpload[],
  parseUpload: (upload: RecoveredAutosaveUpload) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < uploads.length) {
      const upload = uploads[nextIndex]
      nextIndex += 1
      if (upload) await parseUpload(upload)
    }
  }
  const workerCount = Math.min(AUTOSAVE_METADATA_PARSE_CONCURRENCY, uploads.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
}

export async function parseAndStoreAutosaveUploadMetadata(env: Env['Bindings'], uploadId: string, key: string): Promise<void> {
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

    const saveBytes = await readZipEntryDataFromReader(reader, latestSave)
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
      .set({ parseStatus: 'parse_failed', parseError: normalizeMetadataValue(message) })
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

function resolveBbgVersion(detected: boolean, title: string | null, parsedVersion: string | null): string | null {
  if (parsedVersion) return parsedVersion
  if (!detected) return null
  if (title?.toLowerCase().includes('beta')) return betaLeaderDataVersionLabel
  return liveLeaderDataVersionLabel
}

function normalizeMetadataValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/[^\x20-\x7E]/g, '_').slice(0, 200) ?? ''
  return normalized.length > 0 ? normalized : null
}
