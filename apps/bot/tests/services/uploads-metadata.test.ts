import { describe, expect, test } from 'bun:test'
import {
  AUTOSAVE_METADATA_PARSE_CONCURRENCY,
  runAutosaveMetadataParseQueue,
} from '../../src/services/uploads/metadata.ts'

describe('recovered autosave metadata parsing', () => {
  test('runs recovered upload parses at the fixed bounded concurrency', async () => {
    const uploads = Array.from({ length: 8 }, (_, index) => ({ id: `upload-${index}`, key: `key-${index}` }))
    let active = 0
    let maxActive = 0
    const parsed: string[] = []

    await runAutosaveMetadataParseQueue(uploads, async (upload) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      parsed.push(upload.id)
      active -= 1
    })

    expect(AUTOSAVE_METADATA_PARSE_CONCURRENCY).toBe(1)
    expect(maxActive).toBe(AUTOSAVE_METADATA_PARSE_CONCURRENCY)
    expect(parsed).toEqual(uploads.map(upload => upload.id))
  })
})
