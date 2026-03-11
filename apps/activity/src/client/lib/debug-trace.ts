type TraceMeta = Record<string, unknown> | undefined

const OVERLAY_ID = '__activity_debug_overlay'

function canTrace() {
  return typeof window !== 'undefined'
}

export function postDevTrace(message: string, meta?: unknown) {
  if (!canTrace() || typeof window === 'undefined') return

  const payload = {
    timestamp: new Date().toISOString(),
    level: 'warn',
    message,
    href: window.location.href,
    userAgent: window.navigator.userAgent,
    meta,
  }

  console.warn('[activity-trace]', message, meta)

  void fetch('/api/dev-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined)
}

export function updateDevOverlay(title: string, meta?: TraceMeta) {
  if (!canTrace() || typeof document === 'undefined') return

  let node = document.getElementById(OVERLAY_ID) as HTMLPreElement | null
  if (!node) {
    node = document.createElement('pre')
    node.id = OVERLAY_ID
    node.style.position = 'fixed'
    node.style.left = '8px'
    node.style.bottom = '8px'
    node.style.zIndex = '999999'
    node.style.maxWidth = 'min(420px, calc(100vw - 16px))'
    node.style.maxHeight = '40vh'
    node.style.overflow = 'auto'
    node.style.margin = '0'
    node.style.padding = '8px 10px'
    node.style.borderRadius = '8px'
    node.style.background = 'rgba(0, 0, 0, 0.82)'
    node.style.color = '#9ef7b1'
    node.style.font = '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    node.style.pointerEvents = 'none'
    node.style.whiteSpace = 'pre-wrap'
    document.body.appendChild(node)
  }

  const lines = [title]
  for (const [key, value] of Object.entries(meta ?? {})) {
    lines.push(`${key}: ${formatValue(value)}`)
  }
  node.textContent = lines.join('\n')
}

function formatValue(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  }
  catch {
    return '[unserializable]'
  }
}
