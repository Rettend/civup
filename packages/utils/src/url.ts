export function normalizeHost(host: string | undefined, fallback: string): string {
  const raw = (host && host.trim()) || fallback
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `${isLocalHost(raw) ? 'http' : 'https'}://${raw}`
  return withProtocol.replace(/\/$/, '')
}

export interface IsDevOptions {
  viteDev?: boolean
  host?: string | URL | null
  configuredHosts?: Array<string | URL | null | undefined>
}

function hostnameFrom(value: string | URL): string {
  if (value instanceof URL) return value.hostname.trim().toLowerCase()

  const raw = value.trim().toLowerCase()
  if (!raw) return ''

  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return new URL(raw).hostname.toLowerCase()
    }
  }
  catch {}

  const withoutPath = raw.split('/')[0] ?? raw
  return withoutPath.replace(/:\d+$/, '')
}

export function isLocalHost(host: string | URL): boolean {
  const raw = hostnameFrom(host)
  return raw === 'localhost' || raw === '127.0.0.1' || raw.endsWith('.localhost')
}

export function isDevHost(host: string | URL): boolean {
  const raw = hostnameFrom(host)
  return raw.length > 0 && (isLocalHost(raw) || raw.includes('-dev.'))
}

export function isDev(options: IsDevOptions = {}): boolean {
  if (options.viteDev) return true
  if (options.host && isDevHost(options.host)) return true

  for (const host of options.configuredHosts ?? []) {
    if (host && isDevHost(host)) return true
  }

  return false
}
