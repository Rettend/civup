export type BrowserLaunchRoute
  = | { kind: 'session', sessionId: string }
    | { kind: 'channel', channelId: string }

export function parseBrowserLaunchRoute(pathname: string): BrowserLaunchRoute | null {
  const normalized = pathname.replace(/\/+$/, '')
  const match = normalized.match(/^\/web\/(session|channel)\/([^/]+)$/)
  if (!match?.[1] || !match[2]) return null
  try {
    const id = decodeURIComponent(match[2]).trim()
    if (!id) return null
    return match[1] === 'session' ? { kind: 'session', sessionId: id } : { kind: 'channel', channelId: id }
  }
  catch {
    return null
  }
}

export function browserSessionPath(sessionId: string): string {
  return `/web/session/${encodeURIComponent(sessionId)}`
}

export function browserChannelPath(channelId: string, returnSessionId?: string): string {
  const path = `/web/channel/${encodeURIComponent(channelId)}`
  return returnSessionId ? `${path}?returnTo=${encodeURIComponent(browserSessionPath(returnSessionId))}` : path
}

export function browserPracticePath(channelId: string, returnSessionId?: string): string {
  return `/practice/great-people?returnTo=${encodeURIComponent(browserChannelPath(channelId, returnSessionId))}`
}

export function parseBrowserReturnPath(search: string, expectedKind: BrowserLaunchRoute['kind']): string | null {
  const value = new URLSearchParams(search).get('returnTo')
  if (!value || !value.startsWith('/web/') || value.startsWith('//') || /[\r\n\\]/.test(value)) return null
  try {
    const url = new URL(value, 'https://civup.invalid')
    if (url.origin !== 'https://civup.invalid' || url.hash) return null
    const route = parseBrowserLaunchRoute(url.pathname)
    if (!route || route.kind !== expectedKind) return null
    if (route.kind === 'session') return url.search ? null : browserSessionPath(route.sessionId)

    const nestedSessionPath = parseBrowserReturnPath(url.search, 'session')
    const nestedSessionRoute = nestedSessionPath ? parseBrowserLaunchRoute(nestedSessionPath) : null
    return browserChannelPath(route.channelId, nestedSessionRoute?.kind === 'session' ? nestedSessionRoute.sessionId : undefined)
  }
  catch {
    return null
  }
}

export function shouldWatchChannelFeed(input: {
  directSessionId: string | null
  status: 'loading' | 'error' | 'overview' | 'lobby-waiting' | 'authenticated'
}): boolean {
  return input.directSessionId == null && (input.status === 'overview' || input.status === 'lobby-waiting')
}
