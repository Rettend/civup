import type { GameMode, LeaderboardMode } from '@civup/game'
import process from 'node:process'
import {
  GAME_MODE_CHOICES,
  GAME_MODES,
  LEADERBOARD_MODE_CHOICES,
  LEADERBOARD_MODES,
  parseGameMode,
  toLeaderboardMode,
} from '@civup/game'

interface EnabledGameModeSource {
  ENABLED_GAME_MODES?: string
}

type GameModeChoice = (typeof GAME_MODE_CHOICES)[number]
type LeaderboardModeChoice = (typeof LEADERBOARD_MODE_CHOICES)[number]

export function getEnabledGameModes(source?: EnabledGameModeSource | string | null): readonly GameMode[] {
  const raw = typeof source === 'string' || source == null
    ? source
    : source.ENABLED_GAME_MODES

  return parseEnabledGameModes(raw)
}

export function getEnabledLeaderboardModes(source?: EnabledGameModeSource | string | null): readonly LeaderboardMode[] {
  const enabled = new Set(getEnabledGameModes(source).map(mode => toLeaderboardMode(mode)))
  return LEADERBOARD_MODES.filter(mode => enabled.has(mode))
}

export function isGameModeEnabled(source: EnabledGameModeSource | string | null | undefined, mode: GameMode): boolean {
  return getEnabledGameModes(source).includes(mode)
}

export function isLeaderboardModeEnabled(source: EnabledGameModeSource | string | null | undefined, mode: LeaderboardMode): boolean {
  return getEnabledLeaderboardModes(source).includes(mode)
}

export function getDefaultEnabledLeaderboardMode(source?: EnabledGameModeSource | string | null, fallback: LeaderboardMode = 'ffa'): LeaderboardMode {
  const enabledModes = getEnabledLeaderboardModes(source)
  if (enabledModes.includes(fallback)) return fallback
  return enabledModes[0] ?? fallback
}

export function getRegisteredGameModeChoices(): readonly GameModeChoice[] {
  const enabled = new Set(getEnabledGameModes(process.env.ENABLED_GAME_MODES))
  return GAME_MODE_CHOICES.filter(choice => enabled.has(choice.value))
}

export function getRegisteredLeaderboardModeChoices(): readonly LeaderboardModeChoice[] {
  const enabled = new Set(getEnabledLeaderboardModes(process.env.ENABLED_GAME_MODES))
  return LEADERBOARD_MODE_CHOICES.filter(choice => enabled.has(choice.value))
}

function parseEnabledGameModes(raw: string | null | undefined): readonly GameMode[] {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'all') return GAME_MODES

  const enabled = new Set<GameMode>()
  for (const token of trimmed.split(/[\s,]+/)) {
    const mode = parseGameMode(token)
    if (mode) enabled.add(mode)
  }

  if (enabled.size === 0) return GAME_MODES
  return GAME_MODES.filter(mode => enabled.has(mode))
}
