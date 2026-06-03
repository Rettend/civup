declare const __ASSET_REVISION_MAP__: Record<string, string>

const resolvedAssetUrls = new Map<string, string>()

export function resolveAssetUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/assets/')) return url

  const cached = resolvedAssetUrls.get(url)
  if (cached) return cached

  const revision = getAssetRevision(url)
  const resolved = revision ? `${url}${url.includes('?') ? '&' : '?'}v=${revision}` : url
  resolvedAssetUrls.set(url, resolved)
  return resolved
}

function getAssetRevision(url: string): string | undefined {
  const directRevision = __ASSET_REVISION_MAP__[url]
  if (directRevision) return directRevision

  try {
    return __ASSET_REVISION_MAP__[decodeURI(url)]
  }
  catch {
    return undefined
  }
}
