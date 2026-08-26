import { describe, expect, test } from 'bun:test'
import { runAutosaveMetadataParseQueue } from '../../src/services/uploads/metadata.ts'

describe('recovered autosave metadata parsing', () => {
  test('processes every recovered upload without overlapping parses', async () => {
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

    expect(maxActive).toBe(1)
    expect(parsed).toHaveLength(uploads.length)
    expect(new Set(parsed)).toEqual(new Set(uploads.map(upload => upload.id)))
  })
})
