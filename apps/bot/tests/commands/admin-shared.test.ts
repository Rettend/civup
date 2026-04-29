import { describe, expect, test } from 'bun:test'
import { parseSetupTarget, setupTargetLabel } from '../../src/commands/admin/shared.ts'

describe('admin setup target helpers', () => {
  test('supports the bot-commands setup target', () => {
    expect(parseSetupTarget('commands')).toBe('commands')
    expect(setupTargetLabel('commands')).toBe('Bot Commands')
  })

  test('supports the civ leaderboard setup target', () => {
    expect(parseSetupTarget('civ-leaderboard')).toBe('civ-leaderboard')
    expect(setupTargetLabel('civ-leaderboard')).toBe('Civ Leaderboard')
  })
})
