import type { GameMode, LeaderboardMode } from './types.ts'
import { GAME_MODES, LEADERBOARD_MODES } from './types.ts'

type BaseLeaderboardMode = Exclude<LeaderboardMode, 'red-death'>

interface GameModeDefinition {
  label: string
  playerCountOptions: readonly number[]
  teamSize: 1 | 2 | 3 | 4 | 5 | 6 | null
  leaderboardMode: BaseLeaderboardMode | null
  balanceLeaderboardMode: BaseLeaderboardMode | null
  unranked: boolean
}

const GAME_MODE_DEFINITIONS = {
  '1v1': { label: '1v1', playerCountOptions: [2], teamSize: 1, leaderboardMode: 'duel', balanceLeaderboardMode: null, unranked: false },
  '2v2': { label: '2v2', playerCountOptions: [4, 8], teamSize: 2, leaderboardMode: 'duo', balanceLeaderboardMode: null, unranked: false },
  '3v3': { label: '3v3', playerCountOptions: [6], teamSize: 3, leaderboardMode: 'squad', balanceLeaderboardMode: null, unranked: false },
  '4v4': { label: '4v4', playerCountOptions: [8], teamSize: 4, leaderboardMode: 'squad', balanceLeaderboardMode: null, unranked: false },
  '5v5': { label: '5v5', playerCountOptions: [10], teamSize: 5, leaderboardMode: null, balanceLeaderboardMode: 'squad', unranked: true },
  '6v6': { label: '6v6', playerCountOptions: [12], teamSize: 6, leaderboardMode: null, balanceLeaderboardMode: 'squad', unranked: true },
  'ffa': { label: 'FFA', playerCountOptions: [8], teamSize: null, leaderboardMode: 'ffa', balanceLeaderboardMode: null, unranked: false },
} as const satisfies Record<GameMode, GameModeDefinition>

export const GAME_MODE_CHOICES = [
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
  { name: '4v4', value: '4v4' },
  { name: '5v5', value: '5v5' },
  { name: '6v6', value: '6v6' },
  { name: 'FFA', value: 'ffa' },
] as const satisfies readonly { name: string, value: GameMode }[]

export const LEADERBOARD_MODE_CHOICES = [
  { name: 'Duel', value: 'duel' },
  { name: 'Duo', value: 'duo' },
  { name: 'Squad', value: 'squad' },
  { name: 'FFA', value: 'ffa' },
  { name: 'Red Death', value: 'red-death' },
] as const satisfies readonly { name: string, value: LeaderboardMode }[]

export const LEADERBOARD_MODE_LABELS: Record<LeaderboardMode, string> = {
  'duel': 'Duel',
  'duo': 'Duo',
  'squad': 'Squad',
  'ffa': 'FFA',
  'red-death': 'Red Death',
}

const RED_DEATH_FFA_START_PLAYER_COUNTS = [4, 6, 8, 10] as const
const RED_DEATH_GAME_MODES = ['ffa', '1v1', '2v2', '3v3', '4v4'] as const satisfies readonly GameMode[]

const LEADERBOARD_MODE_GAME_MODES = {
  'duel': ['1v1'],
  'duo': ['2v2'],
  'squad': ['3v3', '4v4'],
  'ffa': ['ffa'],
  'red-death': RED_DEATH_GAME_MODES,
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
export function formatModeLabel(
  mode: string | null | undefined,
  fallback = '',
  options: { redDeath?: boolean, targetSize?: number } = {},
): string {
  if (!mode) return fallback

  const trimmed = mode.trim()
  if (!trimmed) return fallback

  const baseLabel = (() => {
    const parsed = parseGameMode(trimmed)
    if (parsed) {
      if (parsed === '2v2' && typeof options.targetSize === 'number' && options.targetSize >= 6 && options.targetSize % 2 === 0) {
        return Array.from({ length: Math.floor(options.targetSize / 2) }, () => '2').join('v')
      }
      return GAME_MODE_DEFINITIONS[parsed].label
    }
    return trimmed.replace(/^default-/i, '').replace(/-/g, ' ')
  })()

  return options.redDeath ? `Red Death ${baseLabel}` : baseLabel
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

/** Whether a game mode is always unranked. */
export function isUnrankedMode(mode: GameMode): boolean {
  return GAME_MODE_DEFINITIONS[mode].unranked
}

/** Map game mode to its leaderboard track. */
export function toLeaderboardMode(mode: GameMode, options: { redDeath?: boolean } = {}): LeaderboardMode | null {
  if (isUnrankedMode(mode)) return null
  if (options.redDeath) return 'red-death'
  return GAME_MODE_DEFINITIONS[mode].leaderboardMode
}

/** Map a mode to the rating track used when balancing lobbies. */
export function toBalanceLeaderboardMode(mode: GameMode, options: { redDeath?: boolean } = {}): LeaderboardMode | null {
  if (options.redDeath && !isUnrankedMode(mode)) return 'red-death'
  const definition = GAME_MODE_DEFINITIONS[mode]
  return definition.balanceLeaderboardMode ?? definition.leaderboardMode
}

/** Expand one leaderboard track into its underlying game modes. */
export function leaderboardModesToGameModes(mode: LeaderboardMode): readonly GameMode[] {
  return LEADERBOARD_MODE_GAME_MODES[mode]
}

/** Whether a game mode is team-based. */
export function isTeamMode(mode: GameMode): mode is '2v2' | '3v3' | '4v4' | '5v5' | '6v6' {
  return mode === '2v2' || mode === '3v3' || mode === '4v4' || mode === '5v5' || mode === '6v6'
}

/** Players on one side of a lobby, or null for FFA. */
export function teamSize(mode: GameMode, _playerCount?: number): 1 | 2 | 3 | 4 | 5 | 6 | null {
  return GAME_MODE_DEFINITIONS[mode].teamSize
}

/** Number of teams for team or duel modes. */
export function teamCount(mode: GameMode, playerCount: number = defaultPlayerCount(mode)): number {
  if (mode === '2v2') return Math.max(2, Math.floor(Math.max(4, playerCount) / 2))
  return teamSize(mode, playerCount) == null ? 0 : 2
}

/** Players per team. */
export function playersPerTeam(mode: GameMode, playerCount: number = defaultPlayerCount(mode)): number {
  return teamSize(mode, playerCount) ?? 1
}

/** Supported player counts for a mode. */
export function playerCountOptions(mode: GameMode): readonly number[] {
  return GAME_MODE_DEFINITIONS[mode].playerCountOptions
}

/** Maximum teammate mentions accepted by a mode. */
export function maxTeammatesForMode(mode: GameMode, playerCount: number = maxPlayerCount(mode)): number {
  const size = teamSize(mode, playerCount)
  return size == null ? 0 : Math.max(0, size - 1)
}

/** Map a lobby slot to its team index for versus modes. */
export function slotToTeamIndex(mode: GameMode, slot: number, playerCount: number = defaultPlayerCount(mode)): 0 | 1 | 2 | 3 | null {
  const size = teamSize(mode, playerCount)
  if (size == null || slot < 0) return null

  const teams = teamCount(mode, playerCount)
  const maxSlots = teams * size
  if (slot >= maxSlots) return null
  return Math.floor(slot / size) as 0 | 1 | 2 | 3
}

/** Default player count for a mode. */
export function defaultPlayerCount(mode: GameMode): number {
  const options = playerCountOptions(mode)
  return options[0] ?? 0
}

/** Maximum player count allowed for a lobby mode. */
export function maxPlayerCount(mode: GameMode): number {
  return Math.max(...playerCountOptions(mode))
}

/** Minimum players required before a lobby can start. */
export function minPlayerCount(mode: GameMode): number {
  return Math.min(...playerCountOptions(mode))
}

/** Valid player counts that can start a lobby for the current target size. */
export function startPlayerCountOptions(
  mode: GameMode,
  targetSize: number = defaultPlayerCount(mode),
  options: { redDeath?: boolean } = {},
): readonly number[] {
  if (mode === 'ffa' && options.redDeath) {
    return RED_DEATH_FFA_START_PLAYER_COUNTS.filter(count => count <= targetSize)
  }

  if (mode === '2v2' && targetSize === 8) return [6, 8]
  return playerCountOptions(mode).includes(targetSize) ? [targetSize] : []
}

/** Whether a lobby can start with the current player count. */
export function canStartWithPlayerCount(
  mode: GameMode,
  playerCount: number,
  targetSize: number = playerCount,
  options: { redDeath?: boolean } = {},
): boolean {
  return startPlayerCountOptions(mode, targetSize, options).includes(playerCount)
}
