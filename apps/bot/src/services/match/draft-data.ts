import type { DraftState, GameMode, LeaderboardMode, ResolvedMapVoteResult } from '@civup/game'
import type { MatchReporterIdentity } from './types.ts'
import { formatModeLabel, parseGameMode, toLeaderboardMode } from '@civup/game'

interface ParsedDraftData {
  manualReport?: unknown
  completedAt?: unknown
  hostId?: unknown
  reportedById?: unknown
  mapVoteResult?: unknown
  redDeath?: unknown
  permanentAlly?: unknown
  hiddenDraft?: unknown
  state?: {
    seats?: Array<{ playerId?: unknown, displayName?: unknown, avatarUrl?: unknown, team?: unknown }>
  }
}

export interface StoredGameModeContext {
  mode: GameMode
  redDeath: boolean
  permanentAlly: boolean
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

export function getHiddenDraftFromDraftData(draftData: string | null): boolean {
  const parsed = parseDraftData(draftData)
  return parsed?.hiddenDraft === true
}

export function getPermanentAllyFromDraftData(gameMode: string, draftData: string | null): boolean {
  const mode = parseGameMode(gameMode)
  const parsed = parseDraftData(draftData)
  if (mode !== 'ffa' || parsed?.redDeath === true) return false
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
  const permanentAlly = getPermanentAllyFromDraftData(mode, draftData)
  const seatCount = Array.isArray(parsed?.state?.seats) ? parsed.state.seats.length : undefined
  const leaderboardMode = toLeaderboardMode(mode, { redDeath })
  return {
    mode,
    redDeath,
    permanentAlly,
    leaderboardMode,
    ranked: leaderboardMode != null,
    label: formatModeLabel(mode, mode, { redDeath, targetSize: seatCount }),
  }
}
