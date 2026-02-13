export function normalizeHost(host: string | undefined, fallback: string): string {
  const raw = (host && host.trim()) || fallback
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `${isLocalHost(raw) ? 'http' : 'https'}://${raw}`
  return withProtocol.replace(/\/$/, '')
}

export function isLocalHost(host: string): boolean {
  const raw = host.trim().toLowerCase()
  return raw.includes('localhost') || raw.includes('127.0.0.1')
}
