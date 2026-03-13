import { CIVUP_ACTIVITY_SESSION_HEADER } from '@civup/utils'

const ACTIVITY_SESSION_CACHE_KEY = 'civup.activity.session-token'
const DEFAULT_ACTIVITY_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000

interface CachedActivitySession {
  token: string
  expiresAt: number
}

function getStorage(type: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    return type === 'local' ? window.localStorage : window.sessionStorage
  }
  catch {
    return null
  }
}

function readCachedSessionFromStorage(storage: Storage | null): CachedActivitySession | null {
  if (!storage) return null

  try {
    const raw = storage.getItem(ACTIVITY_SESSION_CACHE_KEY)
    if (!raw) return null

    const cached = JSON.parse(raw) as CachedActivitySession
    if (typeof cached.token !== 'string' || cached.token.length === 0 || typeof cached.expiresAt !== 'number') {
      storage.removeItem(ACTIVITY_SESSION_CACHE_KEY)
      return null
    }

    if (Date.now() >= cached.expiresAt) {
      storage.removeItem(ACTIVITY_SESSION_CACHE_KEY)
      return null
    }

    return cached
  }
  catch {
    storage.removeItem(ACTIVITY_SESSION_CACHE_KEY)
    return null
  }
}

function writeCachedSessionToStorage(storage: Storage | null, payload: CachedActivitySession) {
  if (!storage) return

  try {
    storage.setItem(ACTIVITY_SESSION_CACHE_KEY, JSON.stringify(payload))
  }
  catch {}
}

function clearCachedSessionFromStorage(storage: Storage | null) {
  if (!storage) return

  try {
    storage.removeItem(ACTIVITY_SESSION_CACHE_KEY)
  }
  catch {}
}

export function getActivitySessionToken(): string | null {
  const sessionToken = readCachedSessionFromStorage(getStorage('session'))
  if (sessionToken) return sessionToken.token

  const localToken = readCachedSessionFromStorage(getStorage('local'))
  if (!localToken) return null

  writeCachedSessionToStorage(getStorage('session'), localToken)
  return localToken.token
}

export function cacheActivitySessionToken(token: string, expiresInSeconds?: number) {
  const expiresAt = Date.now() + (
    typeof expiresInSeconds === 'number' && expiresInSeconds > 0
      ? expiresInSeconds * 1000
      : DEFAULT_ACTIVITY_SESSION_LIFETIME_MS
  )

  const payload: CachedActivitySession = { token, expiresAt }
  writeCachedSessionToStorage(getStorage('session'), payload)
  writeCachedSessionToStorage(getStorage('local'), payload)
}

export function clearActivitySessionToken() {
  clearCachedSessionFromStorage(getStorage('session'))
  clearCachedSessionFromStorage(getStorage('local'))
}

export function buildActivitySessionHeaders(headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers)
  const token = getActivitySessionToken()
  if (token) {
    nextHeaders.set(CIVUP_ACTIVITY_SESSION_HEADER, token)
  }
  return nextHeaders
}
