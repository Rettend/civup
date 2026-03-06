/* eslint-disable no-console */
type DevLogLevel = 'debug' | 'info' | 'warn' | 'error'

interface DevLogPayload {
  timestamp: string
  level: DevLogLevel
  message: string
  href: string
  userAgent: string
  meta?: unknown
}

export function shouldRelayDevLog() {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return true

  const host = window.location.hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host.endsWith('.localhost')
    || host.includes('-dev.')
}

function normalizeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    }
  }

  return meta
}

export function relayDevLog(level: DevLogLevel, message: string, meta?: unknown) {
  if (!shouldRelayDevLog() || typeof window === 'undefined') return

  const normalizedMeta = normalizeMeta(meta)
  const prefix = '[activity-dev]'
  if (level === 'error') console.error(prefix, message, normalizedMeta)
  else if (level === 'warn') console.warn(prefix, message, normalizedMeta)
  else if (level === 'debug') console.debug(prefix, message, normalizedMeta)
  else console.log(prefix, message, normalizedMeta)

  if (level !== 'warn' && level !== 'error') return

  const payload: DevLogPayload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    href: window.location.href,
    userAgent: window.navigator.userAgent,
    meta: normalizedMeta,
  }

  const body = JSON.stringify(payload)

  try {
    if (navigator.sendBeacon) {
      const queued = navigator.sendBeacon('/api/dev-log', new Blob([body], { type: 'application/json' }))
      if (queued) return
    }
  }
  catch {}

  void fetch('/api/dev-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}
