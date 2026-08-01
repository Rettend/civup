export type RouteSurface = 'activity' | 'public'

const DISCORD_ACTIVITY_PLATFORMS = new Set(['desktop', 'mobile'])

export interface RouteSurfaceInput {
  pathname: string
  search: string
  framed: boolean
  development?: boolean
}

export function resolveRouteSurface(input: RouteSurfaceInput): RouteSurface {
  if (input.pathname === '/') {
    return isEmbeddedDiscordLaunch(input.search, input.framed)
      || isDevelopmentActivityEscape(input.search, input.development === true)
      ? 'activity'
      : 'public'
  }
  return isActivityRoute(input.pathname) ? 'activity' : 'public'
}

export function isEmbeddedDiscordLaunch(search: string, framed: boolean): boolean {
  if (!framed) return false
  const params = new URLSearchParams(search)
  return hasSingleNonEmptyParam(params, 'frame_id')
    && hasSingleNonEmptyParam(params, 'instance_id')
    && hasAcceptedPlatform(params)
}

export function isActivityRoute(pathname: string): boolean {
  if (pathname === '/overview' || pathname === '/uploads') return true
  return /^\/(?:lobby|draft)\/[^/]+\/?$/.test(pathname)
    || /^\/web\/(?:session|channel)\/[^/]+\/?$/.test(pathname)
    || /^\/practice(?:\/[^/]+)?\/?$/.test(pathname)
}

function hasSingleNonEmptyParam(params: URLSearchParams, key: string): boolean {
  const values = params.getAll(key)
  return values.length === 1 && values[0]!.trim().length > 0
}

function hasAcceptedPlatform(params: URLSearchParams): boolean {
  const values = params.getAll('platform')
  return values.length === 1 && DISCORD_ACTIVITY_PLATFORMS.has(values[0]!.trim().toLowerCase())
}

function isDevelopmentActivityEscape(search: string, development: boolean): boolean {
  if (!development) return false
  const params = new URLSearchParams(search)
  return params.getAll('activity_dev').length === 1 && params.get('activity_dev') === '1'
}
