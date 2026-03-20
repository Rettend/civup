import { describe, expect, test } from 'bun:test'
import {
  getDefaultEnabledLeaderboardMode,
  getEnabledGameModes,
  getEnabledLeaderboardModes,
  isGameModeEnabled,
  isLeaderboardModeEnabled,
} from '../../src/services/game-modes.ts'

describe('game mode deployment config', () => {
  test('defaults to every mode when no env override is set', () => {
    expect(getEnabledGameModes(undefined)).toEqual(['ffa', '1v1', '2v2', '3v3', '4v4'])
    expect(getEnabledLeaderboardModes(undefined)).toEqual(['duel', 'duo', 'squad', 'ffa'])
  })

  test('filters game and leaderboard modes from env', () => {
    const env = { ENABLED_GAME_MODES: 'ffa, 2v2, 4v4' }

    expect(getEnabledGameModes(env)).toEqual(['ffa', '2v2', '4v4'])
    expect(getEnabledLeaderboardModes(env)).toEqual(['duo', 'squad', 'ffa'])
    expect(isGameModeEnabled(env, 'ffa')).toBe(true)
    expect(isGameModeEnabled(env, '1v1')).toBe(false)
    expect(isLeaderboardModeEnabled(env, 'ffa')).toBe(true)
    expect(isLeaderboardModeEnabled(env, 'duel')).toBe(false)
  })

  test('falls back safely when env only contains invalid modes', () => {
    expect(getEnabledGameModes({ ENABLED_GAME_MODES: 'banana' })).toEqual(['ffa', '1v1', '2v2', '3v3', '4v4'])
    expect(getDefaultEnabledLeaderboardMode({ ENABLED_GAME_MODES: 'ffa' })).toBe('ffa')
  })
})
