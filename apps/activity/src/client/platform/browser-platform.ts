<<<<<<< New base: feat: save file analyzer
import type { ActivityIdentity } from '@civup/utils'
import type { ActivityLaunchSelection, ActivityLaunchSnapshot } from '../stores'
import { configureClientPlatform } from './runtime'

export type BrowserSessionContext
  = | {
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

export async function bootstrapBrowserSession(sessionId: string): Promise<BrowserBootstrapResponse<BrowserSessionContext>> {
  return browserBootstrap(`/api/browser/session/${encodeURIComponent(sessionId)}`)
}

export async function bootstrapBrowserChannel(channelId: string): Promise<BrowserBootstrapResponse<BrowserChannelContext>> {
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
  const payload = await response.json().catch(() => null) as (BrowserBootstrapResponse<T> & { error?: string }) | null
  if (!response.ok || !payload) throw new Error(payload?.error ?? `Browser context failed (${response.status})`)
  return payload
}
|||||||
=======
import type { ActivityIdentity } from '@civup/utils'
import type { ActivityLaunchSelection, ActivityLaunchSnapshot } from '../stores'
import { configureClientPlatform } from './runtime'

export type BrowserSessionContext
  = | {
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

export async function bootstrapBrowserSession(sessionId: string): Promise<BrowserBootstrapResponse<BrowserSessionContext>> {
  return browserBootstrap(`/api/browser/session/${encodeURIComponent(sessionId)}`)
}

export async function bootstrapBrowserChannel(channelId: string): Promise<BrowserBootstrapResponse<BrowserChannelContext>> {
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
  const payload = await response.json().catch(() => null) as (BrowserBootstrapResponse<T> & { error?: string }) | null
  if (!response.ok || !payload) throw new Error(payload?.error ?? `Browser context failed (${response.status})`)
  return payload
}
>>>>>>> Current commit: feat: external browser draft WIP
