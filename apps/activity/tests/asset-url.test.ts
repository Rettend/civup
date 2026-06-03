import { describe, expect, test } from 'bun:test'
import { resolveAssetUrl } from '../src/client/lib/asset-url'

describe('resolveAssetUrl', () => {
  test('uses decoded asset paths when appending cache-busting revisions', () => {
    const globalWithAssets = globalThis as unknown as { __ASSET_REVISION_MAP__: Record<string, string> }
    const previousMap = globalWithAssets.__ASSET_REVISION_MAP__

    try {
      globalWithAssets.__ASSET_REVISION_MAP__ = {
        '/assets/bbg/leaders/Austria Maria Theresa.webp': 'asset-rev',
      }

      expect(resolveAssetUrl('/assets/bbg/leaders/Austria%20Maria%20Theresa.webp')).toBe('/assets/bbg/leaders/Austria%20Maria%20Theresa.webp?v=asset-rev')
    }
    finally {
      globalWithAssets.__ASSET_REVISION_MAP__ = previousMap
    }
  })
})
