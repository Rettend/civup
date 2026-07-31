export const CIVUP_ACTIVITY_SESSION_HEADER = 'X-CivUp-Activity-Session'
export const CIVUP_ACTIVITY_SESSION_QUERY_PARAM = 'activitySession'
export const CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM = 'civBlitzDownloadTicket'
export const CIVUP_INTERNAL_SECRET_HEADER = 'X-CivUp-Internal-Secret'
export const CIVUP_ACTIVITY_USER_ID_HEADER = 'X-CivUp-Activity-User-Id'
export const CIVUP_ACTIVITY_DISPLAY_NAME_HEADER = 'X-CivUp-Activity-Display-Name'
export const CIVUP_ACTIVITY_AVATAR_URL_HEADER = 'X-CivUp-Activity-Avatar-Url'
export const CIVUP_ACTIVITY_GUILD_ID_HEADER = 'X-CivUp-Activity-Guild-Id'
export const CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER = 'X-CivUp-Activity-Guild-Permissions'

const ACTIVITY_SESSION_VERSION = 'session.v2'
const SESSION_ACCESS_VERSION = 'session-access.v1'
const CIVBLITZ_DOWNLOAD_TICKET_VERSION = 'civblitz-download.v1'
const DEFAULT_ACTIVITY_SESSION_TTL_SECONDS = 8 * 60 * 60
const DEFAULT_SESSION_ACCESS_TTL_SECONDS = 8 * 60 * 60
const DEFAULT_CIVBLITZ_DOWNLOAD_TICKET_TTL_SECONDS = 2 * 60

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ActivitySessionClaims {
  sub: string
  name: string
  avatarUrl: string | null
  guildId: string | null
  guildPermissions: string | null
  iat: number
  exp: number
}

export interface ActivityIdentity {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  guildId?: string | null
  guildPermissions?: string | null
}

export interface SessionAccessClaims {
  sub: string
  sessionId: string
  channelId: string
  iat: number
  exp: number
}

export interface CivBlitzDownloadTicketClaims {
  sub: string
  matchId: string
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
    guildId: identity.guildId ?? null,
    guildPermissions: identity.guildPermissions ?? null,
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

export async function createSessionAccessToken(
  secret: string,
  access: {
    userId: string
    sessionId: string
    channelId: string
  },
  options?: {
    ttlSeconds?: number
    nowMs?: number
  },
): Promise<string> {
  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  const ttlSeconds = normalizePositiveInteger(options?.ttlSeconds) ?? DEFAULT_SESSION_ACCESS_TTL_SECONDS
  const claims: SessionAccessClaims = {
    sub: access.userId,
    sessionId: access.sessionId,
    channelId: access.channelId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  }

  const payload = toBase64Url(JSON.stringify(claims))
  const signature = await signString(secret, `${SESSION_ACCESS_VERSION}.${payload}`)
  return `${SESSION_ACCESS_VERSION}.${payload}.${signature}`
}

export async function verifySessionAccessToken(
  secret: string | undefined,
  token: string | null,
  options?: {
    nowMs?: number
    sessionId?: string
    channelId?: string
    userId?: string
  },
): Promise<SessionAccessClaims | null> {
  const claims = await verifySignedClaimsToken(secret, token, SESSION_ACCESS_VERSION)
  if (!claims || !isSessionAccessClaims(claims)) return null

  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  if (claims.exp <= nowSeconds) return null
  if (claims.iat > nowSeconds + 30) return null
  if (options?.sessionId && claims.sessionId !== options.sessionId) return null
  if (options?.channelId && claims.channelId !== options.channelId) return null
  if (options?.userId && claims.sub !== options.userId) return null

  return claims
}

export async function createCivBlitzDownloadTicket(
  secret: string,
  input: { userId: string, matchId: string },
  options?: { ttlSeconds?: number, nowMs?: number },
): Promise<string> {
  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000)
  const ttlSeconds = normalizePositiveInteger(options?.ttlSeconds) ?? DEFAULT_CIVBLITZ_DOWNLOAD_TICKET_TTL_SECONDS
  const claims: CivBlitzDownloadTicketClaims = {
    sub: input.userId,
    matchId: input.matchId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  }
  const payload = toBase64Url(JSON.stringify(claims))
  const signature = await signString(secret, `${CIVBLITZ_DOWNLOAD_TICKET_VERSION}.${payload}`)
  return `${CIVBLITZ_DOWNLOAD_TICKET_VERSION}.${payload}.${signature}`
}

export async function verifyCivBlitzDownloadTicket(
  secret: string | undefined,
  token: string | null,
  options: { matchId: string, nowMs?: number },
): Promise<CivBlitzDownloadTicketClaims | null> {
  const claims = await verifySignedClaimsToken(secret, token, CIVBLITZ_DOWNLOAD_TICKET_VERSION)
  if (!claims || !isCivBlitzDownloadTicketClaims(claims)) return null

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000)
  if (claims.exp <= nowSeconds) return null
  if (claims.iat > nowSeconds + 30) return null
  if (claims.matchId !== options.matchId) return null
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
  const guildId = normalizeOptionalHeaderValue(headers.get(CIVUP_ACTIVITY_GUILD_ID_HEADER))
  const guildPermissions = normalizeOptionalHeaderValue(headers.get(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER))

  return {
    userId,
    displayName,
    avatarUrl,
    guildId,
    guildPermissions,
  }
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
}

function isActivitySessionClaims(value: unknown): value is ActivitySessionClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<ActivitySessionClaims>
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) return false
  if (typeof claims.name !== 'string') return false
  if (claims.avatarUrl !== null && claims.avatarUrl !== undefined && typeof claims.avatarUrl !== 'string') return false
  if (claims.guildId !== null && typeof claims.guildId !== 'string') return false
  if (claims.guildPermissions !== null && typeof claims.guildPermissions !== 'string') return false
  if ((claims.guildId === null) !== (claims.guildPermissions === null)) return false
  if (typeof claims.guildId === 'string' && claims.guildId.trim().length === 0) return false
  if (typeof claims.guildPermissions === 'string' && !/^\d+$/.test(claims.guildPermissions)) return false
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return false
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
  return true
}

function isSessionAccessClaims(value: unknown): value is SessionAccessClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<SessionAccessClaims>
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) return false
  if (typeof claims.sessionId !== 'string' || claims.sessionId.trim().length === 0) return false
  if (typeof claims.channelId !== 'string' || claims.channelId.trim().length === 0) return false
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return false
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
  return true
}

function isCivBlitzDownloadTicketClaims(value: unknown): value is CivBlitzDownloadTicketClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<CivBlitzDownloadTicketClaims>
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) return false
  if (typeof claims.matchId !== 'string' || claims.matchId.trim().length === 0) return false
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
