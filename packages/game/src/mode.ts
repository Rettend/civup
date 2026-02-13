/** Format game mode for UI labels. */
export function formatModeLabel(mode: string | null | undefined, fallback = ''): string {
  if (!mode) return fallback

  const trimmed = mode.trim()
  if (!trimmed) return fallback

  const withoutDefaultPrefix = trimmed.replace(/^default-/i, '')
  if (withoutDefaultPrefix.toLowerCase() === 'ffa') return 'FFA'
  return withoutDefaultPrefix.replace(/-/g, ' ')
}
