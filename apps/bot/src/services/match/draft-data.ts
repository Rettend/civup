import type { DraftDoublePickMetrics, DraftState, GameMode, LeaderboardMode, LeaderDataVersion, ResolvedMapVoteResult } from '@civup/game'
import type { MatchReporterIdentity } from './types.ts'
import { formatModeLabel, normalizeAvailableLeaderDataVersion, parseGameMode, toLeaderboardMode } from '@civup/game'

interface ParsedDraftData {
  manualReport?: unknown
  completedAt?: unknown
  hostId?: unknown
  reportedById?: unknown
  mapVoteResult?: unknown
  redDeath?: unknown
  civBlitz?: unknown
  permanentAlly?: unknown
  hiddenDraft?: unknown
  leaderDataVersion?: unknown
  doublePickMetrics?: unknown
  state?: {
    seats?: Array<{ playerId?: unknown, displayName?: unknown, avatarUrl?: unknown, team?: unknown }>
  }
}

export interface StoredGameModeContext {
  mode: GameMode
  redDeath: boolean
  civBlitz: boolean
  permanentAlly: boolean
  leaderDataVersion: LeaderDataVersion
  leaderboardMode: LeaderboardMode | null
  ranked: boolean
  label: string
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    return JSON.parse(draftData) as ParsedDraftData
  }
  catch {
    return null
  }
}

export function getHostIdFromDraftData(draftData: string | null): string | null {
  const parsed = parseDraftData(draftData)
  if (!parsed) return null

  if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
    return parsed.hostId
  }

  const hostId = parsed.state?.seats?.[0]?.playerId
  return typeof hostId === 'string' && hostId.length > 0 ? hostId : null
}

export function getCompletedAtFromDraftData(draftData: string | null): number | null {
  const parsed = parseDraftData(draftData)
  if (!parsed) return null
  return typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
    ? Math.round(parsed.completedAt)
    : null
}

export function getReporterIdentityFromDraftData(draftData: string | null): MatchReporterIdentity | null {
  const parsed = parseDraftData(draftData)
  const userId = typeof parsed?.reportedById === 'string' && parsed.reportedById.trim().length > 0
    ? parsed.reportedById.trim()
    : null
  if (!userId) return null

  const seat = parsed?.state?.seats?.find(candidate => candidate?.playerId === userId)
  const displayName = typeof seat?.displayName === 'string' && seat.displayName.trim().length > 0
    ? seat.displayName.trim()
    : null
  const avatarUrl = typeof seat?.avatarUrl === 'string' && seat.avatarUrl.trim().length > 0
    ? seat.avatarUrl.trim()
    : null

  return {
    userId,
    displayName,
    avatarUrl,
  }
}

export function getRedDeathFromDraftData(draftData: string | null): boolean {
  const parsed = parseDraftData(draftData)
  return parsed?.redDeath === true
}

export function getCivBlitzFromDraftData(draftData: string | null): boolean {
  const parsed = parseDraftData(draftData)
  return parsed?.civBlitz === true
}

export function getHiddenDraftFromDraftData(draftData: string | null): boolean {
  const parsed = parseDraftData(draftData)
  return parsed?.hiddenDraft === true
}

export function getLeaderDataVersionFromDraftData(draftData: string | null, fallback: LeaderDataVersion = 'live'): LeaderDataVersion {
  const parsed = parseDraftData(draftData)
  return normalizeStoredLeaderDataVersion(parsed?.leaderDataVersion, fallback)
}

export function getPermanentAllyFromDraftData(gameMode: string, draftData: string | null): boolean {
  const mode = parseGameMode(gameMode)
  const parsed = parseDraftData(draftData)
  return getPermanentAllyFromParsedDraftData(mode, parsed)
}

function getPermanentAllyFromParsedDraftData(mode: GameMode | null, parsed: ParsedDraftData | null): boolean {
  if (mode !== 'ffa' || parsed?.redDeath === true || parsed?.civBlitz === true) return false
  if (typeof parsed?.permanentAlly === 'boolean') return parsed.permanentAlly
  if (parsed?.manualReport === true) return false
  if (Array.isArray(parsed?.state?.seats) && parsed.state.seats.some(seat => seat?.team != null)) return true
  return true
}

export function isManualReportDraftData(draftData: string | null): boolean {
  const parsed = parseDraftData(draftData)
  return parsed?.manualReport === true
}

export function getDraftStateFromDraftData(draftData: string | null): DraftState | null {
  const parsed = parseDraftData(draftData)
  return parsed?.state && typeof parsed.state === 'object'
    ? parsed.state as DraftState
    : null
}

export function getDoublePickMetricsFromDraftData(draftData: string | null): DraftDoublePickMetrics | undefined {
  const parsed = parseDraftData(draftData)
  const raw = parsed?.doublePickMetrics
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const metrics = raw as Partial<DraftDoublePickMetrics>
  const normalized = {
    groups: normalizeMetricCount(metrics.groups),
    fallbackStarted: normalizeMetricCount(metrics.fallbackStarted),
    fallbackResolved: normalizeMetricCount(metrics.fallbackResolved),
    bothMissedTimeouts: normalizeMetricCount(metrics.bothMissedTimeouts),
    fallbackTimeouts: normalizeMetricCount(metrics.fallbackTimeouts),
  }
  return normalized.groups > 0 ? normalized : undefined
}

export function getMapVoteResultFromDraftData(draftData: string | null): ResolvedMapVoteResult | null {
  const parsed = parseDraftData(draftData)
  const result = parsed?.mapVoteResult
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null

  const candidate = result as Partial<ResolvedMapVoteResult>
  if (typeof candidate.mapType !== 'string') return null
  if (typeof candidate.mapScript !== 'string') return null
  if (typeof candidate.winningSeatCount !== 'number' || !Number.isFinite(candidate.winningSeatCount)) return null

  return candidate as ResolvedMapVoteResult
}

export function getStoredGameModeContext(gameMode: string, draftData: string | null): StoredGameModeContext | null {
  const mode = parseGameMode(gameMode)
  if (!mode) return null

  const parsed = parseDraftData(draftData)
  const redDeath = parsed?.redDeath === true
  const civBlitz = parsed?.civBlitz === true
  const permanentAlly = getPermanentAllyFromParsedDraftData(mode, parsed)
  const leaderDataVersion = normalizeStoredLeaderDataVersion(parsed?.leaderDataVersion)
  const seatCount = Array.isArray(parsed?.state?.seats) ? parsed.state.seats.length : undefined
  const leaderboardMode = civBlitz ? null : toLeaderboardMode(mode, { redDeath })
  return {
    mode,
    redDeath,
    civBlitz,
    permanentAlly: civBlitz ? false : permanentAlly,
    leaderDataVersion,
    leaderboardMode,
    ranked: leaderboardMode != null,
    label: formatModeLabel(mode, mode, { redDeath, civBlitz, targetSize: seatCount }),
  }
}

function normalizeMetricCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function normalizeStoredLeaderDataVersion(value: unknown, fallback: LeaderDataVersion = 'live'): LeaderDataVersion {
  if (value === 'beta') return normalizeAvailableLeaderDataVersion('beta')
  if (value === 'live') return 'live'
  return normalizeAvailableLeaderDataVersion(fallback)
}
