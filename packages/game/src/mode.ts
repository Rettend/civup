/** Format game mode for UI labels. */
export function formatModeLabel(mode: string | null | undefined, fallback = ''): string {
  if (!mode) return fallback

  const trimmed = mode.trim()
  if (!trimmed) return fallback

  const withoutDefaultPrefix = trimmed.replace(/^default-/i, '')
  const normalized = withoutDefaultPrefix.toLowerCase()
  if (normalized === 'ffa') return 'FFA'
  if (normalized === '1v1') return '1v1'
  if (normalized === '2v2') return '2v2'
  if (normalized === '3v3') return '3v3'
  return withoutDefaultPrefix.replace(/-/g, ' ')
}
