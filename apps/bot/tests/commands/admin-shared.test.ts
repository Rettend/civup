import { describe, expect, test } from 'bun:test'
import { isLegacyPrimaryGuildInteraction, isPrimaryGuildSetupTarget, parseSetupTarget, setupTargetCivModeScope, setupTargetLabel } from '../../src/commands/admin/shared.ts'

describe('admin setup target helpers', () => {
  test('supports the bot-commands setup target', () => {
    expect(parseSetupTarget('commands')).toBe('commands')
    expect(setupTargetLabel('commands')).toBe('Bot Commands')
  })

  test('supports the civ leaderboard setup target', () => {
    expect(parseSetupTarget('civ-leaderboard')).toBe('civ-leaderboard')
    expect(setupTargetLabel('civ-leaderboard')).toBe('Civ Leaderboard (All)')
    expect(setupTargetCivModeScope('civ-leaderboard')).toBe('all')
  })

  test('supports scoped civ leaderboard setup targets', () => {
    expect(parseSetupTarget('civ-leaderboard-all')).toBe('civ-leaderboard-all')
    expect(parseSetupTarget('civ-leaderboard-duel')).toBe('civ-leaderboard-duel')
    expect(parseSetupTarget('civ-leaderboard-duo')).toBe('civ-leaderboard-duo')
    expect(parseSetupTarget('civ-leaderboard-squad')).toBe('civ-leaderboard-squad')
    expect(setupTargetLabel('civ-leaderboard-all')).toBe('Civ Leaderboard (All)')
    expect(setupTargetCivModeScope('civ-leaderboard-duel')).toBe('duel')
    expect(setupTargetCivModeScope('civ-leaderboard-duo')).toBe('duo')
    expect(setupTargetCivModeScope('civ-leaderboard-squad')).toBe('squad')
  })

  test('distinguishes partner-scoped setup from primary-guild publication', () => {
    expect(isPrimaryGuildSetupTarget('draft')).toBe(false)
    expect(isPrimaryGuildSetupTarget('archive')).toBe(false)
    expect(isPrimaryGuildSetupTarget('commands')).toBe(false)
    expect(isPrimaryGuildSetupTarget('leaderboard')).toBe(true)
    expect(isPrimaryGuildSetupTarget('civ-leaderboard-duel')).toBe(true)
    expect(isPrimaryGuildSetupTarget('tournament-leaderboard')).toBe(true)
  })
})

describe('primary-guild admin scope', () => {
  test('allows only the configured primary guild', () => {
    expect(isLegacyPrimaryGuildInteraction({
      interaction: { guild_id: '111111111111111111' },
      env: { ALLOWED_DISCORD_GUILD_ID: '111111111111111111' },
    })).toBe(true)
    expect(isLegacyPrimaryGuildInteraction({
      interaction: { guild_id: '222222222222222222' },
      env: { ALLOWED_DISCORD_GUILD_ID: '111111111111111111' },
    })).toBe(false)
  })
})
