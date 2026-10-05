export const WIDE_WANG_QUERY = 'wide wang'
export const WIDE_WANG_AUDIO_URL = '/assets/easter-eggs/wide-wang.mp3'

export const WIDE_WANG_TRANSCRIPT = [
  { text: 'my wang is wider', revealDelayMs: 0 },
  { text: "your wang is wider? i don't know about that", revealDelayMs: 1900 },
] as const

export function normalizeWideWangQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isWideWangQuery(value: string): boolean {
  return normalizeWideWangQuery(value) === WIDE_WANG_QUERY
}
