import type { ApiRequestInit } from '@civup/utils'
import { api, ApiError, CIVUP_ACTIVITY_SESSION_HEADER } from '@civup/utils'
import { getAuthTransport } from '../platform/runtime'
import { buildActivitySessionHeaders, clearActivitySessionToken, getActivitySessionToken } from './activity-session'

const SESSION_REJECTED_HEADER = 'X-CivUp-Activity-Session-Rejected'
const RECONNECT_ERROR = 'Reopen the activity to sign in again.'

let renewSession: (() => Promise<unknown>) | null = null
let renewalInFlight: Promise<string> | null = null

export function configureActivitySessionRenewal(renew: (() => Promise<unknown>) | null) {
  renewSession = renew
}

/** A rejected token may already have been replaced by another request. */
export async function refreshActivitySession(rejectedToken: string | null): Promise<string | null> {
  if (getAuthTransport() !== 'token' || !renewSession) return getActivitySessionToken()
  if (renewalInFlight) return renewalInFlight
  const currentToken = getActivitySessionToken()
  if (currentToken && currentToken !== rejectedToken) return currentToken

  const renew = renewSession
  clearActivitySessionToken()
  renewalInFlight = Promise.resolve()
    .then(renew)
    .then(() => {
      const token = getActivitySessionToken()
      if (!token) throw new Error('Activity renewal returned no session token')
      return token
    })
    .catch(error => {
      clearActivitySessionToken()
      console.error('Activity session renewal failed:', error)
      throw new ApiError(RECONNECT_ERROR, 401)
    })
    .finally(() => {
      renewalInFlight = null
    })
  return renewalInFlight
}

export async function ensureActivitySession(): Promise<string | null> {
  if (getAuthTransport() !== 'token') return null
  if (renewalInFlight) return renewalInFlight
  return getActivitySessionToken() ?? refreshActivitySession(null)
}

async function withActivitySession<T>(request: (headers: Headers) => Promise<T>, headers?: HeadersInit): Promise<T> {
  await ensureActivitySession()
  const firstHeaders = buildActivitySessionHeaders(headers)
  try {
    return await request(firstHeaders)
  } catch (error) {
    // Only the Activity auth guard sets this header, before forwarding to the bot.
    // Never replay a mutation after an ambiguous network failure or a downstream error.
    if (
      getAuthTransport() !== 'token' ||
      !renewSession ||
      !(error instanceof ApiError) ||
      error.status !== 401 ||
      error.headers?.get(SESSION_REJECTED_HEADER) !== '1'
    )
      throw error

    await refreshActivitySession(firstHeaders.get(CIVUP_ACTIVITY_SESSION_HEADER))
    return request(buildActivitySessionHeaders(headers))
  }
}

export function activityApiGet<T>(url: string, init?: ApiRequestInit): Promise<T> {
  return withActivitySession(headers => api.get<T>(url, { ...init, headers }), init?.headers)
}

export function activityApiPost<T>(url: string, body: unknown, init?: ApiRequestInit): Promise<T> {
  return withActivitySession(headers => api.post<T>(url, body, { ...init, headers }), init?.headers)
}

/** Callers use replayable bodies (JSON, Blob, or ArrayBuffer), never a consumed stream. */
export function activityFetch(url: string, init?: RequestInit): Promise<Response> {
  return withActivitySession(async headers => {
    const response = await fetch(url, { ...init, headers })
    if (
      getAuthTransport() === 'token' &&
      renewSession &&
      response.status === 401 &&
      response.headers.get(SESSION_REJECTED_HEADER) === '1'
    )
      throw new ApiError(RECONNECT_ERROR, 401, undefined, response.headers)
    return response
  }, init?.headers)
}
