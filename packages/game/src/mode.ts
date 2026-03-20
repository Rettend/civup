import type { GameMode, LeaderboardMode } from './types.ts'
import { GAME_MODES, LEADERBOARD_MODES } from './types.ts'

export const GAME_MODE_CHOICES = [
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
  { name: '4v4', value: '4v4' },
  { name: 'FFA', value: 'ffa' },
] as const satisfies readonly { name: string, value: GameMode }[]

export const LEADERBOARD_MODE_CHOICES = [
  { name: 'Duel', value: 'duel' },
  { name: 'Duo', value: 'duo' },
  { name: 'Squad', value: 'squad' },
  { name: 'FFA', value: 'ffa' },
] as const satisfies readonly { name: string, value: LeaderboardMode }[]

export const LEADERBOARD_MODE_LABELS: Record<LeaderboardMode, string> = {
  duel: 'Duel',
  duo: 'Duo',
  squad: 'Squad',
  ffa: 'FFA',
}

const LEADERBOARD_MODE_GAME_MODES = {
  duel: ['1v1'],
  duo: ['2v2'],
  squad: ['3v3', '4v4'],
  ffa: ['ffa'],
} as const satisfies Record<LeaderboardMode, readonly GameMode[]>

function normalizeModeValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/^default-/i, '').toLowerCase()
}

/** Whether a string matches a supported game mode. */
export function isGameMode(value: string | null | undefined): value is GameMode {
  const normalized = normalizeModeValue(value)
  return normalized != null && GAME_MODES.includes(normalized as GameMode)
}

/** Parse a supported game mode from user or storage input. */
export function parseGameMode(value: string | null | undefined): GameMode | null {
  const normalized = normalizeModeValue(value)
  if (!normalized || !GAME_MODES.includes(normalized as GameMode)) return null
  return normalized as GameMode
}

/** Infer a game mode from a raw format or route token. */
export function inferGameMode(value: string | null | undefined, fallback: GameMode = 'ffa'): GameMode {
  const parsed = parseGameMode(value)
  if (parsed) return parsed

  const normalized = normalizeModeValue(value)
  if (!normalized) return fallback

  for (const mode of GAME_MODES) {
    if (normalized.endsWith(`-${mode}`)) return mode
  }

  return fallback
}

/** Format game mode for UI labels. */
export function formatModeLabel(mode: string | null | undefined, fallback = ''): string {
  if (!mode) return fallback

  const trimmed = mode.trim()
  if (!trimmed) return fallback

  const parsed = parseGameMode(trimmed)
  if (parsed) return parsed === 'ffa' ? 'FFA' : parsed
  return trimmed.replace(/^default-/i, '').replace(/-/g, ' ')
}

/** Whether a string matches a supported leaderboard mode. */
export function isLeaderboardMode(value: string | null | undefined): value is LeaderboardMode {
  const normalized = normalizeModeValue(value)
  return normalized != null && LEADERBOARD_MODES.includes(normalized as LeaderboardMode)
}

/** Parse a supported leaderboard mode from user or storage input. */
export function parseLeaderboardMode(value: string | null | undefined): LeaderboardMode | null {
  const normalized = normalizeModeValue(value)
  if (!normalized || !LEADERBOARD_MODES.includes(normalized as LeaderboardMode)) return null
  return normalized as LeaderboardMode
}

/** Format leaderboard mode for embeds and commands. */
export function formatLeaderboardModeLabel(mode: string | null | undefined, fallback = ''): string {
  const parsed = parseLeaderboardMode(mode)
  return parsed ? LEADERBOARD_MODE_LABELS[parsed] : fallback
}

/** Map game mode to its leaderboard track. */
export function toLeaderboardMode(mode: GameMode): LeaderboardMode {
  if (mode === '2v2') return 'duo'
  if (mode === '3v3' || mode === '4v4') return 'squad'
  if (mode === '1v1') return 'duel'
  return 'ffa'
}

/** Expand one leaderboard track into its underlying game modes. */
export function leaderboardModesToGameModes(mode: LeaderboardMode): readonly GameMode[] {
  return LEADERBOARD_MODE_GAME_MODES[mode]
}

/** Whether a game mode is team-based. */
export function isTeamMode(mode: GameMode): mode is '2v2' | '3v3' | '4v4' {
  return mode === '2v2' || mode === '3v3' || mode === '4v4'
}

/** Players on one side of a lobby, or null for FFA. */
export function teamSize(mode: GameMode): 1 | 2 | 3 | 4 | null {
  if (mode === 'ffa') return null
  if (mode === '1v1') return 1
  if (mode === '2v2') return 2
  if (mode === '3v3') return 3
  return 4
}

/** Number of teams for team or duel modes. */
export function teamCount(mode: GameMode): number {
  return teamSize(mode) == null ? 0 : 2
}

/** Players per team. */
export function playersPerTeam(mode: GameMode): number {
  return teamSize(mode) ?? 1
}

/** Maximum teammate mentions accepted by a mode. */
export function maxTeammatesForMode(mode: GameMode): number {
  const size = teamSize(mode)
  return size == null ? 0 : Math.max(0, size - 1)
}

/** Map a lobby slot to its team index for versus modes. */
export function slotToTeamIndex(mode: GameMode, slot: number): 0 | 1 | null {
  const size = teamSize(mode)
  if (size == null || slot < 0 || slot >= size * 2) return null
  return slot < size ? 0 : 1
}

/** Default player count for a mode. */
export function defaultPlayerCount(mode: GameMode): number {
  const size = teamSize(mode)
  return size == null ? 8 : size * 2
}

/** Maximum player count allowed for a lobby mode. */
export function maxPlayerCount(mode: GameMode): number {
  if (mode === 'ffa') return 10
  return defaultPlayerCount(mode)
}

/** Minimum players required before a lobby can start. */
export function minPlayerCount(mode: GameMode): number {
  if (mode === 'ffa') return 6
  return defaultPlayerCount(mode)
}

/** Whether a lobby can start with the current player count. */
export function canStartWithPlayerCount(mode: GameMode, playerCount: number): boolean {
  if (mode === 'ffa') return playerCount >= minPlayerCount(mode) && playerCount <= maxPlayerCount(mode)
  return playerCount === defaultPlayerCount(mode)
}
