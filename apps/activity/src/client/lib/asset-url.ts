declare const __ASSET_REVISION_MAP__: Record<string, string>

const resolvedAssetUrls = new Map<string, string>()

export function resolveAssetUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/assets/')) return url

  const cached = resolvedAssetUrls.get(url)
  if (cached) return cached

  const revision = __ASSET_REVISION_MAP__[url]
  const resolved = revision ? `${url}${url.includes('?') ? '&' : '?'}v=${revision}` : url
  resolvedAssetUrls.set(url, resolved)
  return resolved
}
