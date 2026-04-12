import { describe, expect, test } from 'bun:test'
import {
  canStartWithPlayerCount,
  defaultPlayerCount,
  formatLeaderboardModeLabel,
  formatModeLabel,
  inferGameMode,
  isUnrankedMode,
  leaderboardModesToGameModes,
  maxPlayerCount,
  maxTeammatesForMode,
  minPlayerCount,
  parseGameMode,
  playerCountOptions,
  requiresRedDeathDuplicateFactions,
  slotToTeamIndex,
  startPlayerCountOptions,
  teamCount,
  teamSize,
  toBalanceLeaderboardMode,
  toLeaderboardMode,
} from '../src/mode.ts'

describe('formatModeLabel', () => {
  test('uses fallback for nullish or blank values', () => {
    expect(formatModeLabel(null, 'N/A')).toBe('N/A')
    expect(formatModeLabel(undefined, 'N/A')).toBe('N/A')
    expect(formatModeLabel('   ', 'N/A')).toBe('N/A')
  })

  test('normalizes default prefix and FFA casing', () => {
    expect(formatModeLabel('default-ffa')).toBe('FFA')
    expect(formatModeLabel('FFA')).toBe('FFA')
  })

  test('normalizes canonical mode casing', () => {
    expect(formatModeLabel('1V1')).toBe('1v1')
    expect(formatModeLabel('default-2V2')).toBe('2v2')
    expect(formatModeLabel('3V3')).toBe('3v3')
    expect(formatModeLabel('4V4')).toBe('4v4')
    expect(formatModeLabel('5V5')).toBe('5v5')
    expect(formatModeLabel('6V6')).toBe('6v6')
    expect(formatModeLabel('2v2', '', { targetSize: 6 })).toBe('2v2v2')
    expect(formatModeLabel('2v2', '', { redDeath: true, targetSize: 6 })).toBe('Red Death 2v2v2')
    expect(formatModeLabel('2v2', '', { targetSize: 8 })).toBe('2v2v2v2')
    expect(formatModeLabel('2v2', '', { redDeath: true, targetSize: 8 })).toBe('Red Death 2v2v2v2')
    expect(formatModeLabel('4V4', '', { redDeath: true })).toBe('Red Death 4v4')
    expect(formatModeLabel('3V3', '', { redDeath: true, compactRedDeath: true })).toBe('RD 3v3')
  })

  test('replaces dashes with spaces for other modes', () => {
    expect(formatModeLabel('default-2v2')).toBe('2v2')
    expect(formatModeLabel('duel-ranked')).toBe('duel ranked')
  })
})

describe('parseGameMode', () => {
  test('parses canonical game modes', () => {
    expect(parseGameMode('ffa')).toBe('ffa')
    expect(parseGameMode('1V1')).toBe('1v1')
    expect(parseGameMode(' default-2V2 ')).toBe('2v2')
    expect(parseGameMode('3v3')).toBe('3v3')
    expect(parseGameMode('4v4')).toBe('4v4')
    expect(parseGameMode('5v5')).toBe('5v5')
    expect(parseGameMode('6v6')).toBe('6v6')
  })

  test('rejects unknown modes', () => {
    expect(parseGameMode('duel')).toBeNull()
    expect(parseGameMode('blind-ffa')).toBeNull()
    expect(parseGameMode('')).toBeNull()
  })
})

describe('inferGameMode', () => {
  test('extracts mode suffixes from format ids', () => {
    expect(inferGameMode('snake-ffa')).toBe('ffa')
    expect(inferGameMode('default-ffa-simultaneous')).toBe('ffa')
    expect(inferGameMode('draft-1v1')).toBe('1v1')
    expect(inferGameMode('ranked-2v2')).toBe('2v2')
    expect(inferGameMode('blind-3v3')).toBe('3v3')
    expect(inferGameMode('captains-4v4')).toBe('4v4')
    expect(inferGameMode('default-5v5')).toBe('5v5')
    expect(inferGameMode('default-6v6')).toBe('6v6')
  })

  test('falls back when no mode can be inferred', () => {
    expect(inferGameMode('custom', '1v1')).toBe('1v1')
    expect(inferGameMode(null)).toBe('ffa')
  })
})

describe('formatLeaderboardModeLabel', () => {
  test('formats supported leaderboard modes', () => {
    expect(formatLeaderboardModeLabel('ffa')).toBe('FFA')
    expect(formatLeaderboardModeLabel('DUEL')).toBe('Duel')
    expect(formatLeaderboardModeLabel('duo')).toBe('Duo')
    expect(formatLeaderboardModeLabel('squad')).toBe('Squad')
    expect(formatLeaderboardModeLabel('red-death')).toBe('Red Death')
  })

  test('uses fallback for unknown modes', () => {
    expect(formatLeaderboardModeLabel('all', 'All')).toBe('All')
  })
})

describe('shared mode helpers', () => {
  test('maps game modes to leaderboard tracks', () => {
    expect(toLeaderboardMode('ffa')).toBe('ffa')
    expect(toLeaderboardMode('1v1')).toBe('duel')
    expect(toLeaderboardMode('2v2')).toBe('duo')
    expect(toLeaderboardMode('3v3')).toBe('squad')
    expect(toLeaderboardMode('4v4')).toBe('squad')
    expect(toLeaderboardMode('5v5')).toBeNull()
    expect(toLeaderboardMode('6v6')).toBeNull()
    expect(toLeaderboardMode('2v2', { redDeath: true })).toBe('red-death')
    expect(toLeaderboardMode('4v4', { redDeath: true })).toBe('red-death')
  })

  test('uses centralized balance and unranked metadata', () => {
    expect(toBalanceLeaderboardMode('3v3')).toBe('squad')
    expect(toBalanceLeaderboardMode('5v5')).toBe('squad')
    expect(toBalanceLeaderboardMode('6v6')).toBe('squad')
    expect(toBalanceLeaderboardMode('5v5', { redDeath: true })).toBe('squad')
    expect(toBalanceLeaderboardMode('4v4', { redDeath: true })).toBe('red-death')
    expect(isUnrankedMode('5v5')).toBe(true)
    expect(isUnrankedMode('6v6')).toBe(true)
    expect(isUnrankedMode('4v4')).toBe(false)
    expect(requiresRedDeathDuplicateFactions('5v5')).toBe(false)
    expect(requiresRedDeathDuplicateFactions('6v6')).toBe(true)
  })

  test('expands leaderboard tracks to game modes', () => {
    expect(leaderboardModesToGameModes('duel')).toEqual(['1v1'])
    expect(leaderboardModesToGameModes('duo')).toEqual(['2v2'])
    expect(leaderboardModesToGameModes('squad')).toEqual(['3v3', '4v4'])
    expect(leaderboardModesToGameModes('ffa')).toEqual(['ffa'])
    expect(leaderboardModesToGameModes('red-death')).toEqual(['ffa', '1v1', '2v2', '3v3', '4v4'])
  })

  test('derives shared team helpers', () => {
    expect(teamSize('ffa')).toBeNull()
    expect(teamSize('1v1')).toBe(1)
    expect(teamSize('2v2')).toBe(2)
    expect(teamSize('4v4')).toBe(4)
    expect(teamSize('5v5')).toBe(5)
    expect(teamSize('6v6')).toBe(6)
    expect(teamCount('2v2', 4)).toBe(2)
    expect(teamCount('2v2', 6)).toBe(3)
    expect(teamCount('2v2', 8)).toBe(4)
    expect(teamCount('5v5', 10)).toBe(2)
    expect(teamCount('6v6', 12)).toBe(2)
    expect(maxTeammatesForMode('ffa')).toBe(0)
    expect(maxTeammatesForMode('2v2')).toBe(1)
    expect(maxTeammatesForMode('3v3')).toBe(2)
    expect(maxTeammatesForMode('4v4')).toBe(3)
    expect(maxTeammatesForMode('5v5')).toBe(4)
    expect(maxTeammatesForMode('6v6')).toBe(5)
    expect(slotToTeamIndex('1v1', 0)).toBe(0)
    expect(slotToTeamIndex('1v1', 1)).toBe(1)
    expect(slotToTeamIndex('2v2', 3)).toBe(1)
    expect(slotToTeamIndex('2v2', 5, 6)).toBe(2)
    expect(slotToTeamIndex('2v2', 5, 8)).toBe(2)
    expect(slotToTeamIndex('2v2', 7, 8)).toBe(3)
    expect(slotToTeamIndex('4v4', 7)).toBe(1)
    expect(slotToTeamIndex('5v5', 5, 10)).toBe(1)
    expect(slotToTeamIndex('6v6', 6, 12)).toBe(1)
    expect(slotToTeamIndex('ffa', 0)).toBeNull()
  })

  test('uses strict mode player-count defaults', () => {
    expect(playerCountOptions('ffa')).toEqual([8])
    expect(playerCountOptions('2v2')).toEqual([4, 8])
    expect(playerCountOptions('5v5')).toEqual([10])
    expect(playerCountOptions('6v6')).toEqual([12])
    expect(defaultPlayerCount('ffa')).toBe(8)
    expect(defaultPlayerCount('5v5')).toBe(10)
    expect(defaultPlayerCount('6v6')).toBe(12)
    expect(minPlayerCount('ffa')).toBe(8)
    expect(minPlayerCount('2v2')).toBe(4)
    expect(minPlayerCount('5v5')).toBe(10)
    expect(minPlayerCount('6v6')).toBe(12)
    expect(maxPlayerCount('ffa')).toBe(8)
    expect(maxPlayerCount('2v2')).toBe(8)
    expect(maxPlayerCount('5v5')).toBe(10)
    expect(maxPlayerCount('6v6')).toBe(12)
    expect(startPlayerCountOptions('2v2', 4)).toEqual([4])
    expect(startPlayerCountOptions('2v2', 8)).toEqual([6, 8])
    expect(startPlayerCountOptions('5v5', 10)).toEqual([10])
    expect(startPlayerCountOptions('6v6', 12)).toEqual([12])
    expect(startPlayerCountOptions('ffa', 10, { redDeath: true })).toEqual([4, 6, 8, 10])
    expect(canStartWithPlayerCount('ffa', 8, 8)).toBe(true)
    expect(canStartWithPlayerCount('ffa', 6, 8)).toBe(false)
    expect(canStartWithPlayerCount('ffa', 10, 10)).toBe(false)
    expect(canStartWithPlayerCount('2v2', 6, 8)).toBe(true)
    expect(canStartWithPlayerCount('2v2', 4, 8)).toBe(false)
    expect(canStartWithPlayerCount('ffa', 6, 10, { redDeath: true })).toBe(true)
    expect(canStartWithPlayerCount('5v5', 10, 10)).toBe(true)
    expect(canStartWithPlayerCount('5v5', 10, 12)).toBe(false)
    expect(canStartWithPlayerCount('6v6', 12, 12)).toBe(true)
  })
})
