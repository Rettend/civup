import type { GameMode, LeaderboardMode } from '@civup/game'
import { formatModeLabel, parseGameMode, toLeaderboardMode } from '@civup/game'

interface ParsedDraftData {
  completedAt?: unknown
  hostId?: unknown
  redDeath?: unknown
  state?: {
    seats?: Array<{ playerId?: unknown }>
  }
}

export interface StoredGameModeContext {
  mode: GameMode
  redDeath: boolean
  leaderboardMode: LeaderboardMode
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
  return {
    mode,
    redDeath,
    leaderboardMode: toLeaderboardMode(mode, { redDeath }),
    label: formatModeLabel(mode, mode, { redDeath, targetSize: seatCount }),
  }
}
