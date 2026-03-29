export const CIVUP_ACTIVITY_SESSION_HEADER = 'X-CivUp-Activity-Session'
export const CIVUP_ACTIVITY_SESSION_QUERY_PARAM = 'activitySession'
export const CIVUP_INTERNAL_SECRET_HEADER = 'X-CivUp-Internal-Secret'
export const CIVUP_ACTIVITY_USER_ID_HEADER = 'X-CivUp-Activity-User-Id'
export const CIVUP_ACTIVITY_DISPLAY_NAME_HEADER = 'X-CivUp-Activity-Display-Name'
export const CIVUP_ACTIVITY_AVATAR_URL_HEADER = 'X-CivUp-Activity-Avatar-Url'
export const CIVUP_WEBHOOK_TIMESTAMP_HEADER = 'X-CivUp-Webhook-Timestamp'
export const CIVUP_WEBHOOK_SIGNATURE_HEADER = 'X-CivUp-Webhook-Signature'

const LEGACY_CIVUP_STATE_SECRET_HEADER = 'X-CivUp-State-Secret'
const LEGACY_CIVUP_WEBHOOK_SECRET_HEADER = 'X-CivUp-Webhook-Secret'
const ACTIVITY_SESSION_VERSION = 'session.v1'
const DRAFT_ROOM_ACCESS_VERSION = 'draft-room.v1'
const DEFAULT_ACTIVITY_SESSION_TTL_SECONDS = 8 * 60 * 60
const DEFAULT_DRAFT_ROOM_ACCESS_TTL_SECONDS = 8 * 60 * 60
const DEFAULT_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ActivitySessionClaims {
  sub: string
  name: string
  avatarUrl: string | null
  iat: number
  exp: number
}

export interface ActivityIdentity {
  userId: string
  displayName: string | null
  avatarUrl: string | null
}

export interface DraftRoomAccessClaims {
  sub: string
  roomId: string
  channelId: string
  iat: number
  exp: number
}

export async function createActivitySession(
  secret: string,
  identity: ActivityIdentity,
  options?: {
    ttlSeconds?: number
    nowMs?: number
  },
): Promise<string> {
  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  const ttlSeconds = normalizePositiveInteger(options?.ttlSeconds) ?? DEFAULT_ACTIVITY_SESSION_TTL_SECONDS
  const claims: ActivitySessionClaims = {
    sub: identity.userId,
    name: identity.displayName ?? '',
    avatarUrl: identity.avatarUrl ?? null,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  }

  const payload = toBase64Url(JSON.stringify(claims))
  const signature = await signString(secret, `${ACTIVITY_SESSION_VERSION}.${payload}`)
  return `${ACTIVITY_SESSION_VERSION}.${payload}.${signature}`
}

export async function verifyActivitySession(
  secret: string | undefined,
  token: string | null,
  nowMs = Date.now(),
): Promise<ActivitySessionClaims | null> {
  const claims = await verifySignedClaimsToken(secret, token, ACTIVITY_SESSION_VERSION)
  if (!claims) return null

  if (!isActivitySessionClaims(claims)) return null

  const nowSeconds = Math.floor(nowMs / 1000)
  if (claims.exp <= nowSeconds) return null
  if (claims.iat > nowSeconds + 30) return null

  return claims
}

export async function createDraftRoomAccessToken(
  secret: string,
  access: {
    userId: string
    roomId: string
    channelId: string
  },
  options?: {
    ttlSeconds?: number
    nowMs?: number
  },
): Promise<string> {
  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  const ttlSeconds = normalizePositiveInteger(options?.ttlSeconds) ?? DEFAULT_DRAFT_ROOM_ACCESS_TTL_SECONDS
  const claims: DraftRoomAccessClaims = {
    sub: access.userId,
    roomId: access.roomId,
    channelId: access.channelId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  }

  const payload = toBase64Url(JSON.stringify(claims))
  const signature = await signString(secret, `${DRAFT_ROOM_ACCESS_VERSION}.${payload}`)
  return `${DRAFT_ROOM_ACCESS_VERSION}.${payload}.${signature}`
}

export async function verifyDraftRoomAccessToken(
  secret: string | undefined,
  token: string | null,
  options?: {
    nowMs?: number
    roomId?: string
    channelId?: string
    userId?: string
  },
): Promise<DraftRoomAccessClaims | null> {
  const claims = await verifySignedClaimsToken(secret, token, DRAFT_ROOM_ACCESS_VERSION)
  if (!claims || !isDraftRoomAccessClaims(claims)) return null

  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  if (claims.exp <= nowSeconds) return null
  if (claims.iat > nowSeconds + 30) return null
  if (options?.roomId && claims.roomId !== options.roomId) return null
  if (options?.channelId && claims.channelId !== options.channelId) return null
  if (options?.userId && claims.sub !== options.userId) return null

  return claims
}

export function isAuthorizedInternalRequest(headers: Headers, expectedSecret: string | undefined): boolean {
  const normalizedSecret = normalizeSecret(expectedSecret)
  if (!normalizedSecret) return false
  return constantTimeEqual(readProvidedInternalSecret(headers) ?? '', normalizedSecret)
}

export function readAuthorizedActivityIdentity(headers: Headers, expectedSecret: string | undefined): ActivityIdentity | null {
  if (!isAuthorizedInternalRequest(headers, expectedSecret)) return null

  const userId = headers.get(CIVUP_ACTIVITY_USER_ID_HEADER)?.trim() ?? ''
  if (!userId) return null

  const displayName = decodeOptionalHeaderValue(headers.get(CIVUP_ACTIVITY_DISPLAY_NAME_HEADER))
  const avatarUrl = normalizeOptionalHeaderValue(headers.get(CIVUP_ACTIVITY_AVATAR_URL_HEADER))

  return {
    userId,
    displayName,
    avatarUrl,
  }
}

export async function createSignedWebhookHeaders(secret: string, body: string, nowMs = Date.now()): Promise<Record<string, string>> {
  const timestamp = String(nowMs)
  return {
    [CIVUP_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [CIVUP_WEBHOOK_SIGNATURE_HEADER]: await signString(secret, `${timestamp}.${body}`),
  }
}

export async function verifySignedWebhookRequest(
  headers: Headers,
  secret: string | undefined,
  body: string,
  nowMs = Date.now(),
  maxSkewMs = DEFAULT_WEBHOOK_MAX_SKEW_MS,
): Promise<boolean> {
  const normalizedSecret = normalizeSecret(secret)
  if (!normalizedSecret) return false

  const timestamp = headers.get(CIVUP_WEBHOOK_TIMESTAMP_HEADER)
  const signature = headers.get(CIVUP_WEBHOOK_SIGNATURE_HEADER)
  if (timestamp && signature) {
    const parsedTimestamp = Number(timestamp)
    if (!Number.isFinite(parsedTimestamp)) return false
    if (Math.abs(nowMs - parsedTimestamp) > maxSkewMs) return false

    const expectedSignature = await signString(normalizedSecret, `${timestamp}.${body}`)
    return constantTimeEqual(signature, expectedSignature)
  }

  const legacySecret = headers.get(LEGACY_CIVUP_WEBHOOK_SECRET_HEADER)
  return constantTimeEqual(legacySecret ?? '', normalizedSecret)
}

function normalizeSecret(secret: string | undefined): string | null {
  const normalized = secret?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

async function verifySignedClaimsToken(
  secret: string | undefined,
  token: string | null,
  version: string,
): Promise<unknown | null> {
  const normalizedSecret = normalizeSecret(secret)
  if (!normalizedSecret || !token) return null

  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [partA, partB, payload, signature] = parts
  const tokenVersion = `${partA}.${partB}`
  if (tokenVersion !== version || !payload || !signature) return null

  const expectedSignature = await signString(normalizedSecret, `${tokenVersion}.${payload}`)
  if (!constantTimeEqual(signature, expectedSignature)) return null

  try {
    return JSON.parse(fromBase64Url(payload))
  }
  catch {
    return null
  }
}

function normalizeOptionalHeaderValue(value: string | null): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function decodeOptionalHeaderValue(value: string | null): string | null {
  const normalized = normalizeOptionalHeaderValue(value)
  if (!normalized) return null
  try {
    return decodeURIComponent(normalized)
  }
  catch {
    return normalized
  }
}

function normalizePositiveInteger(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

async function signString(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))
  return toBase64Url(new Uint8Array(signature))
}

function readProvidedInternalSecret(headers: Headers): string | null {
  return headers.get(CIVUP_INTERNAL_SECRET_HEADER)
    ?? headers.get(LEGACY_CIVUP_STATE_SECRET_HEADER)
}

function isActivitySessionClaims(value: unknown): value is ActivitySessionClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<ActivitySessionClaims>
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) return false
  if (typeof claims.name !== 'string') return false
  if (claims.avatarUrl !== null && claims.avatarUrl !== undefined && typeof claims.avatarUrl !== 'string') return false
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return false
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
  return true
}

function isDraftRoomAccessClaims(value: unknown): value is DraftRoomAccessClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<DraftRoomAccessClaims>
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) return false
  if (typeof claims.roomId !== 'string' || claims.roomId.trim().length === 0) return false
  if (typeof claims.channelId !== 'string' || claims.channelId.trim().length === 0) return false
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return false
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
  return true
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const maxLength = Math.max(leftBytes.length, rightBytes.length)
  let mismatch = leftBytes.length ^ rightBytes.length

  for (let index = 0; index < maxLength; index++) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }

  return mismatch === 0
}

function toBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(value: string): string {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const binary = atob(`${normalized}${padding}`)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return textDecoder.decode(bytes)
}
