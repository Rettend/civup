import type { GameMode, LeaderboardMode } from '@civup/game'
import type { MatchReporterIdentity } from './types.ts'
import { formatModeLabel, parseGameMode, toLeaderboardMode } from '@civup/game'

interface ParsedDraftData {
  completedAt?: unknown
  hostId?: unknown
  reportedById?: unknown
  redDeath?: unknown
  state?: {
    seats?: Array<{ playerId?: unknown, displayName?: unknown, avatarUrl?: unknown }>
  }
}

export interface StoredGameModeContext {
  mode: GameMode
  redDeath: boolean
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

export function getStoredGameModeContext(gameMode: string, draftData: string | null): StoredGameModeContext | null {
  const mode = parseGameMode(gameMode)
  if (!mode) return null

  const parsed = parseDraftData(draftData)
  const redDeath = parsed?.redDeath === true
  const seatCount = Array.isArray(parsed?.state?.seats) ? parsed.state.seats.length : undefined
  const leaderboardMode = toLeaderboardMode(mode, { redDeath })
  return {
    mode,
    redDeath,
    leaderboardMode,
    ranked: leaderboardMode != null,
    label: formatModeLabel(mode, mode, { redDeath, targetSize: seatCount }),
  }
}
