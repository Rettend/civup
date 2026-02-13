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
  if (!import.meta.env.DEV || typeof window === 'undefined') return

  const normalizedMeta = normalizeMeta(meta)
  const prefix = '[activity-dev]'
  if (level === 'error') console.error(prefix, message, normalizedMeta)
  else if (level === 'warn') console.warn(prefix, message, normalizedMeta)
  else if (level === 'debug') console.debug(prefix, message, normalizedMeta)
  else console.log(prefix, message, normalizedMeta)

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
