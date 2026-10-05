import type { ActivityLaunchSelection, ActivityLaunchSnapshot } from '../stores'
import type { ActivityIdentity } from '@civup/utils'
import { ApiError } from '@civup/utils'
import { configureClientPlatform } from './runtime'

export type BrowserSessionContext =
  | {
      status: 'available'
      sessionId: string
      matchId: string | null
      phase: 'open' | 'draft' | 'swap' | 'active' | 'reported'
      selection: ActivityLaunchSelection
    }
  | {
      status: 'ended'
      sessionId: string
      matchId: string | null
      phase: 'cancelled'
    }

export interface BrowserChannelContext {
  status: 'available'
  channelId: string
  snapshot: ActivityLaunchSnapshot
}

interface BrowserBootstrapResponse<T> {
  identity: ActivityIdentity
  context: T
}

export class BrowserLaunchValidationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'BrowserLaunchValidationError'
  }
}

export async function bootstrapBrowserSession(
  sessionId: string,
): Promise<BrowserBootstrapResponse<BrowserSessionContext>> {
  return browserBootstrap(`/api/browser/session/${encodeURIComponent(sessionId)}`)
}

export async function bootstrapBrowserChannel(
  channelId: string,
): Promise<BrowserBootstrapResponse<BrowserChannelContext>> {
  return browserBootstrap(`/api/browser/channel/${encodeURIComponent(channelId)}`)
}

async function browserBootstrap<T>(url: string): Promise<BrowserBootstrapResponse<T>> {
  configureClientPlatform('web', 'cookie')
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (response.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.location.assign(`/api/auth/discord?returnTo=${encodeURIComponent(returnTo)}`)
    return new Promise<BrowserBootstrapResponse<T>>(() => {})
  }
  const payload = (await response.json().catch(() => null)) as
    | (BrowserBootstrapResponse<T> & { error?: unknown })
    | null
  if (!response.ok || !payload) {
    const message = typeof payload?.error === 'string' && payload.error.trim().length > 0 ? payload.error : null
    if (message && isBrowserLaunchValidation(response.status, message))
      throw new BrowserLaunchValidationError(message, response.status)
    throw new ApiError(
      message ?? `Browser context failed (${response.status})`,
      response.status,
      payload,
      response.headers,
    )
  }
  return payload
}

function isBrowserLaunchValidation(status: number, message: string): boolean {
  // These are deliberate responses from the browser/session endpoints, not
  // arbitrary exception text. Access settings use 503 rather than 4xx.
  if (status === 403) {
    return (
      message === 'Session is not in the configured Discord server' ||
      message === 'This activity is only available in the configured Discord server'
    )
  }
  if (status === 404) return message === 'Session not found' || message === 'Session is unavailable'
  if (status === 503) return message === 'Browser access is disabled' || message === 'Browser access is not configured'
  return false
}
